// core/memory.js — Graph memory system.
// Stores concepts, files, patterns, preferences, and decisions as nodes
// with typed edges between them. Zero terminal dependencies.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const GRAPH_DIR = join(homedir(), '.danu', 'memory');
const GRAPH_PATH = join(GRAPH_DIR, 'graph.json');
const LEGACY_PATH = join(GRAPH_DIR, 'memories.json');

const EDGE_TYPES = new Set(['relates-to', 'depends-on', 'caused-by', 'prefers', 'references']);
const NODE_TYPES = new Set(['concept', 'file', 'pattern', 'preference', 'decision']);
const AUTO_PIN_TYPES = new Set(['preference', 'decision']);

const DEGREE_CAP = 12;
const DEGREE_CAP_PINNED = 16;
const MAX_KEYWORDS = 8;
const MAX_NODES_DEFAULT = 200;

const STOP_WORDS = new Set([
  'the', 'is', 'a', 'an', 'in', 'to', 'for', 'of', 'and', 'or', 'but', 'not',
  'this', 'that', 'with', 'from', 'at', 'by', 'on', 'it', 'as', 'be', 'do',
  'if', 'so', 'no', 'up', 'we', 'he', 'my', 'are', 'was', 'has', 'had', 'have',
  'been', 'its', 'all', 'just', 'use', 'any', 'can', 'may', 'get', 'also', 'into',
  'when', 'before', 'after', 'always', 'never', 'should', 'would', 'could', 'about',
]);

const GENERIC_TOKENS = new Set([
  'api', 'config', 'file', 'data', 'test', 'app', 'run', 'set', 'get', 'add',
  'new', 'fix', 'bug', 'log', 'key', 'var', 'src', 'lib', 'dev', 'npm',
]);

let cachedGraph = null;

function genId(prefix) {
  return `${prefix}_${randomBytes(3).toString('hex')}`;
}

function emptyGraph() {
  return { version: 1, nodes: {}, edges: [], adjacency: {} };
}

function rebuildAdjacency(graph) {
  graph.adjacency = {};
  for (const edge of graph.edges) {
    if (!graph.adjacency[edge.source]) graph.adjacency[edge.source] = [];
    if (!graph.adjacency[edge.target]) graph.adjacency[edge.target] = [];
    graph.adjacency[edge.source].push(edge.id);
    graph.adjacency[edge.target].push(edge.id);
  }
}

function nodeDegree(graph, nodeId) {
  return (graph.adjacency[nodeId] || []).length;
}

function degreeCap(node) {
  return node.pinned ? DEGREE_CAP_PINNED : DEGREE_CAP;
}

// --- Keyword Extraction ---

export function extractKeywords(text) {
  const tokens = text
    .toLowerCase()
    .split(/[\s\-_.,;:!?'"()\[\]{}<>\/\\|@#$%^&*+=~`]+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));

  const seen = new Set();
  const unique = [];
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      unique.push(t);
    }
  }

  // Sample across full text: take from first half and second half alternately
  if (unique.length <= MAX_KEYWORDS) return unique;

  const mid = Math.ceil(unique.length / 2);
  const firstHalf = unique.slice(0, mid);
  const secondHalf = unique.slice(mid);
  const result = [];
  let fi = 0, si = 0;

  while (result.length < MAX_KEYWORDS) {
    // Slight bias toward first half (2:1 ratio)
    if (fi < firstHalf.length && (result.length % 3 !== 2 || si >= secondHalf.length)) {
      result.push(firstHalf[fi++]);
    } else if (si < secondHalf.length) {
      result.push(secondHalf[si++]);
    } else {
      break;
    }
  }

  return result;
}

function isGenericToken(token) {
  return token.length <= 4 && GENERIC_TOKENS.has(token);
}

function prefixMatch(a, b) {
  return a.startsWith(b) || b.startsWith(a);
}

// --- Graph I/O ---

export function loadGraph() {
  if (cachedGraph) return cachedGraph;

  if (existsSync(GRAPH_PATH)) {
    try {
      cachedGraph = JSON.parse(readFileSync(GRAPH_PATH, 'utf-8'));
      rebuildAdjacency(cachedGraph);
      return cachedGraph;
    } catch {
      cachedGraph = emptyGraph();
      return cachedGraph;
    }
  }

  // Auto-migrate from flat memories.json
  if (existsSync(LEGACY_PATH)) {
    cachedGraph = migrateFromFlat();
    return cachedGraph;
  }

  cachedGraph = emptyGraph();
  return cachedGraph;
}

export function saveGraph(graph) {
  if (!graph) graph = cachedGraph;
  if (!graph) return;

  rebuildAdjacency(graph);
  graph.lastModified = new Date().toISOString();

  mkdirSync(GRAPH_DIR, { recursive: true });
  const tmpPath = GRAPH_PATH + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(graph, null, 2), 'utf-8');
  renameSync(tmpPath, GRAPH_PATH);

  cachedGraph = graph;
}

// Exposed for testing
export function resetCache() {
  cachedGraph = null;
}

// --- Node CRUD ---

export function addNode({ type, text, keywords, tags, project }) {
  const graph = loadGraph();

  if (!NODE_TYPES.has(type)) type = 'concept';
  if (!text || text.length < 10) return null;

  const kw = keywords && keywords.length > 0 ? keywords.slice(0, MAX_KEYWORDS) : extractKeywords(text);
  if (kw.length < 2) return null;

  // Duplicate detection: check same-project nodes for keyword overlap
  const projectNodes = Object.values(graph.nodes).filter(n => n.project === project);
  for (const existing of projectNodes) {
    const nonGenericOverlap = kw.filter(
      k => !isGenericToken(k) && existing.keywords.some(ek => prefixMatch(k, ek))
    );
    if (nonGenericOverlap.length >= 2) {
      // Update access on the existing node
      existing.lastAccessed = new Date().toISOString();
      existing.accessCount = (existing.accessCount || 0) + 1;
      return existing.id;
    }
  }

  const id = genId('n');
  const now = new Date().toISOString();
  graph.nodes[id] = {
    id,
    type,
    text,
    keywords: kw,
    tags: tags || [],
    project: project || process.cwd(),
    pinned: AUTO_PIN_TYPES.has(type),
    createdAt: now,
    lastAccessed: now,
    accessCount: 1,
  };

  return id;
}

export function getNode(id) {
  const graph = loadGraph();
  const node = graph.nodes[id];
  if (!node) return null;
  node.lastAccessed = new Date().toISOString();
  node.accessCount = (node.accessCount || 0) + 1;
  return node;
}

export function removeNode(id) {
  const graph = loadGraph();
  if (!graph.nodes[id]) return false;
  delete graph.nodes[id];
  graph.edges = graph.edges.filter(e => e.source !== id && e.target !== id);
  rebuildAdjacency(graph);
  return true;
}

// --- Edge CRUD ---

export function addEdge({ source, target, type }) {
  const graph = loadGraph();
  if (!graph.nodes[source] || !graph.nodes[target]) return null;
  if (!EDGE_TYPES.has(type)) type = 'relates-to';
  if (source === target) return null;

  // Degree cap check
  const srcNode = graph.nodes[source];
  const tgtNode = graph.nodes[target];
  if (nodeDegree(graph, source) >= degreeCap(srcNode)) return null;
  if (nodeDegree(graph, target) >= degreeCap(tgtNode)) return null;

  // Prevent duplicate edges
  const exists = graph.edges.some(
    e => (e.source === source && e.target === target && e.type === type)
      || (e.source === target && e.target === source && e.type === type)
  );
  if (exists) return null;

  const id = genId('e');
  const edge = { id, source, target, type, createdAt: new Date().toISOString() };
  graph.edges.push(edge);
  rebuildAdjacency(graph);
  return id;
}

export function removeEdge(id) {
  const graph = loadGraph();
  const idx = graph.edges.findIndex(e => e.id === id);
  if (idx === -1) return false;
  graph.edges.splice(idx, 1);
  rebuildAdjacency(graph);
  return true;
}

export function getEdges(nodeId, edgeType) {
  const graph = loadGraph();
  const edgeIds = graph.adjacency[nodeId] || [];
  let edges = edgeIds.map(eid => graph.edges.find(e => e.id === eid)).filter(Boolean);
  if (edgeType) edges = edges.filter(e => e.type === edgeType);
  return edges;
}

// --- Query ---

export function findNodes({ type, query, tags, project } = {}) {
  const graph = loadGraph();
  let nodes = Object.values(graph.nodes);

  if (type) nodes = nodes.filter(n => n.type === type);
  if (project) nodes = nodes.filter(n => n.project === project || project.startsWith(n.project) || n.project.startsWith(project));
  if (tags && tags.length > 0) {
    nodes = nodes.filter(n => n.tags.some(t => tags.includes(t)));
  }

  if (query) {
    const queryTokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);

    // First pass: keyword prefix match
    const keywordMatches = nodes.filter(n =>
      queryTokens.some(qt =>
        n.keywords.some(kw => prefixMatch(kw, qt))
      )
    );

    if (keywordMatches.length > 0) return keywordMatches;

    // Fallback: text substring
    const lowerQuery = query.toLowerCase();
    return nodes.filter(n => n.text.toLowerCase().includes(lowerQuery));
  }

  return nodes;
}

export function queryRelated(nodeId, depth = 1, edgeTypes) {
  const graph = loadGraph();
  if (!graph.nodes[nodeId]) return [];

  const visited = new Set([nodeId]);
  const results = [];
  let frontier = [nodeId];

  for (let d = 0; d < depth; d++) {
    const nextFrontier = [];

    for (const nid of frontier) {
      const edgeIds = graph.adjacency[nid] || [];
      for (const eid of edgeIds) {
        const edge = graph.edges.find(e => e.id === eid);
        if (!edge) continue;
        if (edgeTypes && !edgeTypes.includes(edge.type)) continue;

        const neighborId = edge.source === nid ? edge.target : edge.source;
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighbor = graph.nodes[neighborId];
        if (!neighbor) continue;

        results.push({ node: neighbor, edge, depth: d + 1 });
        nextFrontier.push(neighborId);
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return results;
}

// --- Relevance Scoring ---

export function getRelevantMemories(cwd, limit = 15) {
  const graph = loadGraph();
  const nodes = Object.values(graph.nodes);
  if (nodes.length === 0) return [];

  const now = Date.now();
  const DAY_MS = 86400000;

  const scored = nodes.map(node => {
    let score = 0;

    // Project match
    const p = (node.project || '').replace(/\\/g, '/');
    const c = (cwd || '').replace(/\\/g, '/');
    if (p && c && (c.startsWith(p) || p.startsWith(c))) score += 10;

    // Recency
    if (node.pinned) {
      score += 5;
    } else {
      const daysSince = (now - new Date(node.lastAccessed || node.createdAt).getTime()) / DAY_MS;
      score += Math.max(0, 5 * (1 - daysSince / 90));
    }

    // Type boost
    if (node.type === 'preference' || node.type === 'decision') score += 2;

    // Connectivity (weak signal)
    const degree = (graph.adjacency[node.id] || []).length;
    score += Math.min(3, degree);

    // Weak access signal
    score += Math.min(2, (node.accessCount || 0) * 0.5);

    return { node, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Diversity enforcement
  const typeCounts = {};
  const selected = [];

  for (const { node, score } of scored) {
    if (selected.length >= limit) break;

    // Max 5 per type
    const tc = typeCounts[node.type] || 0;
    if (tc >= 5) continue;

    // Content dedupe: skip if 3+ keywords overlap with already-selected
    const dominated = selected.some(s =>
      s.node.keywords.filter(k => node.keywords.some(nk => prefixMatch(k, nk))).length >= 3
    );
    if (dominated) continue;

    typeCounts[node.type] = tc + 1;
    selected.push({ node, score });
  }

  return selected.map(s => s.node);
}

export function getGraphMemorySection(cwd) {
  const nodes = getRelevantMemories(cwd);
  if (nodes.length === 0) return '';

  const graph = loadGraph();
  const lines = nodes.map((n, i) => {
    const edges = (graph.adjacency[n.id] || []).length;
    const pin = n.pinned ? ' [pinned]' : '';
    let line = `- [${n.type}] ${n.text} (${n.createdAt.split('T')[0]}${pin})`;

    // For top 5, show edge info
    if (i < 5 && edges > 0) {
      const nodeEdges = getEdges(n.id);
      for (const e of nodeEdges.slice(0, 3)) {
        const otherId = e.source === n.id ? e.target : e.source;
        const other = graph.nodes[otherId];
        if (other) line += `\n  ${e.type}: "${other.text.slice(0, 60)}"`;
      }
    }

    return line;
  });

  let section = `\n\n## User Memories\n\n${lines.join('\n')}`;
  if (section.length > 2000) {
    section = section.slice(0, 1997) + '...';
  }
  return section;
}

// --- Migration ---

export function migrateFromFlat() {
  const graph = emptyGraph();

  try {
    const raw = readFileSync(LEGACY_PATH, 'utf-8');
    const memories = JSON.parse(raw);

    if (!Array.isArray(memories)) return graph;

    for (const m of memories) {
      if (!m.text) continue;

      let type = 'concept';
      const lower = m.text.toLowerCase();
      if (/\b(prefer|always use|never use|don't|do not)\b/.test(lower)) type = 'preference';
      else if (/\b(run|before|after|then|step|first|deploy)\b/.test(lower)) type = 'pattern';
      else if (/\b(decided|chose|because|switched|picked)\b/.test(lower)) type = 'decision';

      const kw = extractKeywords(m.text);
      if (kw.length < 2 || m.text.length < 10) continue;

      const id = genId('n');
      graph.nodes[id] = {
        id,
        type,
        text: m.text,
        keywords: kw,
        tags: [],
        project: m.cwd || '',
        pinned: AUTO_PIN_TYPES.has(type),
        createdAt: m.date || new Date().toISOString(),
        lastAccessed: m.date || new Date().toISOString(),
        accessCount: 1,
      };
    }

    // Zero edges on migration (prevents dense graph)

    mkdirSync(GRAPH_DIR, { recursive: true });
    const tmpPath = GRAPH_PATH + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(graph, null, 2), 'utf-8');
    renameSync(tmpPath, GRAPH_PATH);

    // Rename old file
    try {
      renameSync(LEGACY_PATH, LEGACY_PATH + '.bak');
    } catch {
      // Non-fatal
    }
  } catch {
    // Migration failed — return empty graph, leave memories.json alone
  }

  cachedGraph = graph;
  return graph;
}

// --- Pruning ---

export function pruneGraph(maxNodes = MAX_NODES_DEFAULT) {
  const graph = loadGraph();
  const nodes = Object.values(graph.nodes);
  if (nodes.length <= maxNodes) return 0;

  const now = Date.now();
  const DAY_MS = 86400000;
  const SEVEN_DAYS = 7 * DAY_MS;

  // Score non-pinned, non-recent nodes
  const candidates = nodes
    .filter(n => !n.pinned && (now - new Date(n.lastAccessed || n.createdAt).getTime()) > SEVEN_DAYS)
    .map(n => {
      const daysSince = (now - new Date(n.lastAccessed || n.createdAt).getTime()) / DAY_MS;
      const degree = (graph.adjacency[n.id] || []).length;
      const score = Math.max(0, 5 * (1 - daysSince / 90)) + Math.min(3, degree) + Math.min(2, (n.accessCount || 0) * 0.5);
      return { node: n, score };
    })
    .sort((a, b) => a.score - b.score);

  const toRemove = Math.ceil(nodes.length * 0.2);
  const removeCount = Math.min(toRemove, candidates.length);
  if (removeCount === 0) return 0;

  // 80% strict lowest, 20% random from lower half
  const strictCount = Math.floor(removeCount * 0.8);
  const randomCount = removeCount - strictCount;
  const lowerHalf = candidates.slice(0, Math.ceil(candidates.length / 2));

  const toDelete = new Set();
  for (let i = 0; i < strictCount && i < candidates.length; i++) {
    toDelete.add(candidates[i].node.id);
  }

  // Random selection from lower half (excluding already selected)
  const remaining = lowerHalf.filter(c => !toDelete.has(c.node.id));
  for (let i = 0; i < randomCount && remaining.length > 0; i++) {
    const idx = Math.floor(Math.random() * remaining.length);
    toDelete.add(remaining[idx].node.id);
    remaining.splice(idx, 1);
  }

  for (const id of toDelete) {
    delete graph.nodes[id];
  }

  // Clean orphaned edges
  graph.edges = graph.edges.filter(e => graph.nodes[e.source] && graph.nodes[e.target]);
  rebuildAdjacency(graph);

  return toDelete.size;
}
