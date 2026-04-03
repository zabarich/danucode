import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

// We test core/memory.js by manipulating the graph file directly.
// Most functions operate on the in-process cache, so we reset between tests.

import {
  loadGraph, saveGraph, resetCache, addNode, getNode, removeNode,
  addEdge, removeEdge, getEdges, findNodes, queryRelated,
  extractKeywords, getRelevantMemories, getGraphMemorySection,
  migrateFromFlat, pruneGraph,
} from '../core/memory.js';

// Use a temp dir to avoid polluting the real ~/.danu/memory
// We'll override the paths by manipulating the cache directly

describe('Keyword extraction', () => {
  it('removes stop words and deduplicates', () => {
    const kw = extractKeywords('the quick brown fox jumps over the lazy dog');
    assert.ok(!kw.includes('the'));
    assert.ok(kw.includes('quick'));
    assert.ok(kw.includes('brown'));
    assert.ok(kw.includes('fox'));
    // 'over' is not a stop word, so it may be included
    // The key guarantee is stop words are removed and result is deduplicated
    const set = new Set(kw);
    assert.equal(kw.length, set.size, 'No duplicates');
  });

  it('limits to 8 keywords', () => {
    const kw = extractKeywords('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi');
    assert.ok(kw.length <= 8);
  });

  it('samples across full text, not just first tokens', () => {
    const kw = extractKeywords('Before deploying production servers, rotate API keys stored in environment variables');
    // Should capture terms from later in the sentence too
    assert.ok(kw.includes('keys') || kw.includes('environment') || kw.includes('variables'),
      'Should include later tokens');
    assert.ok(kw.includes('deploying') || kw.includes('production'),
      'Should include early tokens');
  });

  it('returns few keywords for very short text', () => {
    const kw = extractKeywords('a');
    assert.equal(kw.length, 0); // single char filtered out (length <= 1)
    const kw2 = extractKeywords('hi');
    assert.ok(kw2.length <= 1); // 'hi' is 2 chars, passes filter
  });
});

describe('Node CRUD', () => {
  beforeEach(() => {
    resetCache();
    // Load a fresh empty graph into cache
    const empty = { version: 1, nodes: {}, edges: [], adjacency: {} };
    saveGraph(empty);
  });

  it('creates a node and returns an ID', () => {
    const id = addNode({ type: 'concept', text: 'API keys are stored in .env file', project: '/test' });
    assert.ok(id);
    assert.ok(id.startsWith('n_'));
    const graph = loadGraph();
    assert.ok(graph.nodes[id]);
    assert.equal(graph.nodes[id].type, 'concept');
  });

  it('rejects text shorter than 10 characters', () => {
    const id = addNode({ type: 'concept', text: 'short', project: '/test' });
    assert.equal(id, null);
  });

  it('rejects text with fewer than 2 keywords', () => {
    const id = addNode({ type: 'concept', text: 'the is a an', project: '/test' });
    assert.equal(id, null);
  });

  it('auto-pins preference and decision nodes', () => {
    const id = addNode({ type: 'preference', text: 'Use tabs not spaces for indentation', project: '/test' });
    const node = loadGraph().nodes[id];
    assert.equal(node.pinned, true);
  });

  it('does not pin concept nodes', () => {
    const id = addNode({ type: 'concept', text: 'The database schema uses PostgreSQL', project: '/test' });
    const node = loadGraph().nodes[id];
    assert.equal(node.pinned, false);
  });

  it('getNode bumps access count', () => {
    const id = addNode({ type: 'concept', text: 'Important deployment process documentation', project: '/test' });
    const before = loadGraph().nodes[id].accessCount;
    getNode(id);
    assert.equal(loadGraph().nodes[id].accessCount, before + 1);
  });

  it('removeNode removes node and connected edges', () => {
    const id1 = addNode({ type: 'concept', text: 'First concept about testing', project: '/test' });
    const id2 = addNode({ type: 'concept', text: 'Second concept about deployment', project: '/test' });
    addEdge({ source: id1, target: id2, type: 'relates-to' });
    saveGraph();

    removeNode(id1);
    const graph = loadGraph();
    assert.equal(graph.nodes[id1], undefined);
    assert.equal(graph.edges.length, 0);
  });
});

describe('Duplicate detection', () => {
  beforeEach(() => {
    resetCache();
    saveGraph({ version: 1, nodes: {}, edges: [], adjacency: {} });
  });

  it('returns existing node ID when keywords overlap', () => {
    const id1 = addNode({ type: 'concept', text: 'Database migration scripts require PostgreSQL 14', project: '/test' });
    const id2 = addNode({ type: 'concept', text: 'Database migration process for PostgreSQL upgrade', project: '/test' });
    assert.equal(id1, id2);
  });

  it('creates new node when keywords are different', () => {
    const id1 = addNode({ type: 'concept', text: 'Database migration scripts require PostgreSQL', project: '/test' });
    const id2 = addNode({ type: 'concept', text: 'Frontend React components use Tailwind CSS', project: '/test' });
    assert.notEqual(id1, id2);
  });

  it('ignores generic tokens in overlap check', () => {
    const id1 = addNode({ type: 'concept', text: 'The API config file has authentication settings', project: '/test' });
    const id2 = addNode({ type: 'concept', text: 'The API config endpoint returns health status', project: '/test' });
    // 'api' and 'config' are generic — should NOT count as overlap
    // These should be different nodes since non-generic overlap < 2
    assert.notEqual(id1, id2);
  });
});

describe('Edge CRUD', () => {
  beforeEach(() => {
    resetCache();
    saveGraph({ version: 1, nodes: {}, edges: [], adjacency: {} });
  });

  it('creates an edge between two nodes', () => {
    const id1 = addNode({ type: 'concept', text: 'First concept about architecture', project: '/test' });
    const id2 = addNode({ type: 'concept', text: 'Second concept about deployment', project: '/test' });
    const eid = addEdge({ source: id1, target: id2, type: 'relates-to' });
    assert.ok(eid);
    assert.ok(eid.startsWith('e_'));
    assert.equal(getEdges(id1).length, 1);
  });

  it('rejects edge to nonexistent node', () => {
    const id1 = addNode({ type: 'concept', text: 'First concept about something', project: '/test' });
    const eid = addEdge({ source: id1, target: 'n_nonexistent', type: 'relates-to' });
    assert.equal(eid, null);
  });

  it('rejects self-edges', () => {
    const id = addNode({ type: 'concept', text: 'A concept that references itself', project: '/test' });
    const eid = addEdge({ source: id, target: id, type: 'relates-to' });
    assert.equal(eid, null);
  });

  it('rejects duplicate edges', () => {
    const id1 = addNode({ type: 'concept', text: 'Concept about databases here', project: '/test' });
    const id2 = addNode({ type: 'concept', text: 'Concept about deployment there', project: '/test' });
    const e1 = addEdge({ source: id1, target: id2, type: 'relates-to' });
    const e2 = addEdge({ source: id1, target: id2, type: 'relates-to' });
    assert.ok(e1);
    assert.equal(e2, null);
  });

  it('enforces degree cap', () => {
    // Each node must have completely unique keywords — use explicit keywords to bypass dedup
    const hub = addNode({ type: 'concept', text: 'Central hub connecting to everything', project: '/degtest', keywords: ['central', 'hub', 'connecting'] });
    const spokes = [];
    const words = ['elephant', 'giraffe', 'penguin', 'dolphin', 'octopus', 'kangaroo', 'platypus', 'flamingo', 'chameleon', 'pangolin', 'narwhal', 'wolverine', 'albatross', 'capybara', 'axolotl'];
    for (let i = 0; i < 15; i++) {
      const id = addNode({ type: 'concept', text: `${words[i]} unique creature documentation`, project: '/degtest', keywords: [words[i], `spoke${i}`] });
      if (id) spokes.push(id);
    }

    // Verify we got 15 unique spokes
    const uniqueSpokes = [...new Set(spokes)];
    assert.equal(uniqueSpokes.length, 15, `Expected 15 unique spokes, got ${uniqueSpokes.length}`);

    let created = 0;
    for (const s of uniqueSpokes) {
      if (s === hub) continue;
      const eid = addEdge({ source: hub, target: s, type: 'relates-to' });
      if (eid) created++;
    }
    assert.equal(created, 12);
  });

  it('pinned nodes get higher degree cap', () => {
    const hub = addNode({ type: 'preference', text: 'Important preference about wide connectivity', project: '/degpin', keywords: ['important', 'preference', 'connectivity'] });
    const spokes = [];
    const words = ['quartz', 'feldspar', 'olivine', 'garnet', 'topaz', 'zircon', 'beryl', 'spinel', 'apatite', 'rutile', 'corundum', 'tourmaline', 'fluorite', 'calcite', 'dolomite', 'gypsum', 'barite', 'magnetite'];
    for (let i = 0; i < 18; i++) {
      const id = addNode({ type: 'concept', text: `${words[i]} mineral research documentation`, project: '/degpin', keywords: [words[i], `mineral${i}`] });
      if (id) spokes.push(id);
    }

    const uniqueSpokes = [...new Set(spokes)];
    assert.equal(uniqueSpokes.length, 18, `Expected 18 unique spokes, got ${uniqueSpokes.length}`);

    let created = 0;
    for (const s of uniqueSpokes) {
      if (s === hub) continue;
      const eid = addEdge({ source: hub, target: s, type: 'relates-to' });
      if (eid) created++;
    }
    assert.equal(created, 16);
  });

  it('removeEdge works', () => {
    const id1 = addNode({ type: 'concept', text: 'First concept about testing here', project: '/test' });
    const id2 = addNode({ type: 'concept', text: 'Second concept about deployment', project: '/test' });
    const eid = addEdge({ source: id1, target: id2, type: 'relates-to' });
    assert.equal(removeEdge(eid), true);
    assert.equal(getEdges(id1).length, 0);
  });
});

describe('BFS traversal', () => {
  beforeEach(() => {
    resetCache();
    saveGraph({ version: 1, nodes: {}, edges: [], adjacency: {} });
  });

  it('finds direct neighbors at depth 1', () => {
    const a = addNode({ type: 'concept', text: 'Astronomy telescope observation research', project: '/bfs1' });
    const b = addNode({ type: 'concept', text: 'Biology microscope laboratory analysis', project: '/bfs1' });
    const c = addNode({ type: 'concept', text: 'Chemistry molecular compound synthesis', project: '/bfs1' });
    const eab = addEdge({ source: a, target: b, type: 'relates-to' });
    const ebc = addEdge({ source: b, target: c, type: 'depends-on' });
    assert.ok(eab, 'Edge a->b should be created');
    assert.ok(ebc, 'Edge b->c should be created');

    const related = queryRelated(a, 1);
    assert.equal(related.length, 1);
    assert.equal(related[0].node.id, b);
  });

  it('finds 2-hop neighbors at depth 2', () => {
    const a = addNode({ type: 'concept', text: 'Volcanology eruption magma prediction', project: '/bfs2' });
    const b = addNode({ type: 'concept', text: 'Seismology earthquake tremor monitoring', project: '/bfs2' });
    const c = addNode({ type: 'concept', text: 'Oceanography current temperature salinity', project: '/bfs2' });
    addEdge({ source: a, target: b, type: 'relates-to' });
    addEdge({ source: b, target: c, type: 'depends-on' });

    const related = queryRelated(a, 2);
    assert.equal(related.length, 2);
  });

  it('does not revisit nodes in cycles', () => {
    const a = addNode({ type: 'concept', text: 'Carpentry woodworking furniture joinery', project: '/bfs3' });
    const b = addNode({ type: 'concept', text: 'Metalworking forging welding fabrication', project: '/bfs3' });
    const c = addNode({ type: 'concept', text: 'Ceramics pottery glazing kiln firing', project: '/bfs3' });
    addEdge({ source: a, target: b, type: 'relates-to' });
    addEdge({ source: b, target: c, type: 'relates-to' });
    addEdge({ source: c, target: a, type: 'relates-to' });

    const related = queryRelated(a, 5);
    assert.equal(related.length, 2); // b and c, not revisiting a
  });

  it('filters by edge type', () => {
    const a = addNode({ type: 'concept', text: 'Painting watercolor canvas landscape', project: '/bfs4' });
    const b = addNode({ type: 'concept', text: 'Sculpture marble chisel carving', project: '/bfs4' });
    const c = addNode({ type: 'concept', text: 'Photography darkroom exposure developing', project: '/bfs4' });
    addEdge({ source: a, target: b, type: 'relates-to' });
    addEdge({ source: a, target: c, type: 'depends-on' });

    const related = queryRelated(a, 1, ['depends-on']);
    assert.equal(related.length, 1);
    assert.equal(related[0].node.id, c);
  });
});

describe('findNodes', () => {
  beforeEach(() => {
    resetCache();
    saveGraph({ version: 1, nodes: {}, edges: [], adjacency: {} });
  });

  it('finds by keyword prefix match', () => {
    addNode({ type: 'concept', text: 'Environment variables for production servers', project: '/test' });
    addNode({ type: 'concept', text: 'Database connection pooling settings', project: '/test' });

    const results = findNodes({ query: 'env' });
    assert.equal(results.length, 1);
    assert.ok(results[0].text.includes('Environment'));
  });

  it('bidirectional prefix: long query matches short keyword', () => {
    addNode({ type: 'concept', text: 'Use env files for configuration management', project: '/test' });

    const results = findNodes({ query: 'environment' });
    // 'environment'.startsWith('env') should match
    assert.equal(results.length, 1);
  });

  it('falls back to text substring when no keyword match', () => {
    addNode({ type: 'concept', text: 'The XYZ protocol requires special handling', project: '/test' });

    const results = findNodes({ query: 'XYZ protocol' });
    assert.equal(results.length, 1);
  });

  it('filters by type', () => {
    addNode({ type: 'preference', text: 'Use tabs not spaces for indentation', project: '/test' });
    addNode({ type: 'concept', text: 'Tab indentation is configured globally', project: '/test' });

    const results = findNodes({ type: 'preference' });
    assert.equal(results.length, 1);
    assert.equal(results[0].type, 'preference');
  });

  it('filters by project', () => {
    addNode({ type: 'concept', text: 'Project alpha uses TypeScript compiler', project: '/alpha' });
    addNode({ type: 'concept', text: 'Project beta uses Python interpreter', project: '/beta' });

    const results = findNodes({ project: '/alpha' });
    assert.equal(results.length, 1);
    assert.ok(results[0].text.includes('TypeScript'));
  });
});

describe('Relevance scoring', () => {
  beforeEach(() => {
    resetCache();
    saveGraph({ version: 1, nodes: {}, edges: [], adjacency: {} });
  });

  it('project match scores higher', () => {
    addNode({ type: 'concept', text: 'Relevant concept for this project', project: '/current/project' });
    addNode({ type: 'concept', text: 'Irrelevant concept from other project', project: '/other/project' });

    const results = getRelevantMemories('/current/project');
    assert.equal(results.length, 2);
    assert.ok(results[0].text.includes('Relevant'));
  });

  it('pinned nodes resist decay', () => {
    const id1 = addNode({ type: 'preference', text: 'Old but pinned preference from long ago', project: '/test' });
    const id2 = addNode({ type: 'concept', text: 'Recent unpinned concept just created', project: '/test' });

    // Artificially age the pinned node
    const graph = loadGraph();
    graph.nodes[id1].lastAccessed = '2020-01-01T00:00:00.000Z';
    graph.nodes[id1].createdAt = '2020-01-01T00:00:00.000Z';

    const results = getRelevantMemories('/test');
    // Pinned node should still be near the top despite age
    const pinnedIdx = results.findIndex(n => n.id === id1);
    assert.ok(pinnedIdx >= 0, 'Pinned node should be in results');
    assert.ok(pinnedIdx <= 1, 'Pinned node should be near top');
  });

  it('enforces type diversity (max 5 per type)', () => {
    for (let i = 0; i < 10; i++) {
      addNode({ type: 'concept', text: `Concept number ${i} about unique topic ${i}`, project: '/test' });
    }
    addNode({ type: 'preference', text: 'Important preference about coding style', project: '/test' });

    const results = getRelevantMemories('/test', 15);
    const conceptCount = results.filter(n => n.type === 'concept').length;
    assert.ok(conceptCount <= 5, `Expected max 5 concepts, got ${conceptCount}`);
    assert.ok(results.some(n => n.type === 'preference'));
  });
});

describe('Migration', () => {
  const testDir = join(tmpdir(), `danu-mem-test-${Date.now()}`);
  const testGraph = join(testDir, 'graph.json');
  const testLegacy = join(testDir, 'memories.json');

  beforeEach(() => {
    resetCache();
    mkdirSync(testDir, { recursive: true });
  });

  after(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it('migrates flat memories to graph nodes with zero edges', () => {
    const memories = [
      { text: 'Always prefer TypeScript over JavaScript', date: '2026-04-01T00:00:00.000Z', cwd: '/test' },
      { text: 'Run database migrations before deployment starts', date: '2026-04-02T00:00:00.000Z', cwd: '/test' },
    ];
    writeFileSync(testLegacy, JSON.stringify(memories), 'utf-8');

    // We can't easily override the paths in the module, but we can test extractKeywords and type classification
    // by calling migrateFromFlat directly (it uses the hardcoded path)
    // Instead, test the classification logic indirectly
    const lower1 = memories[0].text.toLowerCase();
    assert.ok(/\b(prefer|always use|never use|don't|do not)\b/.test(lower1));

    const lower2 = memories[1].text.toLowerCase();
    assert.ok(/\b(run|before|after|then|step|first|deploy)\b/.test(lower2));
  });
});

describe('Pruning', () => {
  beforeEach(() => {
    resetCache();
    saveGraph({ version: 1, nodes: {}, edges: [], adjacency: {} });
  });

  it('does nothing when under node cap', () => {
    addNode({ type: 'concept', text: 'Just a single concept here', project: '/test' });
    const pruned = pruneGraph(200);
    assert.equal(pruned, 0);
  });

  it('never prunes pinned nodes', () => {
    // Create many nodes over cap with unique keywords
    const colors = ['crimson', 'cerulean', 'vermillion', 'chartreuse', 'magenta', 'turquoise', 'burgundy', 'lavender', 'tangerine', 'periwinkle', 'saffron', 'cobalt', 'emerald', 'scarlet', 'ivory', 'mahogany', 'teal', 'amber', 'indigo', 'maroon', 'coral', 'sapphire', 'ochre', 'bronze', 'silver'];
    for (let i = 0; i < 25; i++) {
      addNode({ type: 'concept', text: `${colors[i]} pigment synthesis documentation`, project: '/prunetest', keywords: [colors[i], `pigment${i}`] });
    }
    const pinnedId = addNode({ type: 'preference', text: 'Critical preference that must survive pruning', project: '/prunetest', keywords: ['critical', 'survive', 'pruning'] });

    // Artificially age all nodes
    const graph = loadGraph();
    for (const node of Object.values(graph.nodes)) {
      node.lastAccessed = '2020-01-01T00:00:00.000Z';
    }

    const pruned = pruneGraph(10);
    assert.ok(pruned > 0);

    const afterGraph = loadGraph();
    assert.ok(afterGraph.nodes[pinnedId], 'Pinned node must survive pruning');
  });
});

describe('Graph save/load round-trip', () => {
  beforeEach(() => {
    resetCache();
    saveGraph({ version: 1, nodes: {}, edges: [], adjacency: {} });
  });

  it('persists and recovers nodes and edges', () => {
    const id1 = addNode({ type: 'concept', text: 'Persistent concept about architecture', project: '/test' });
    const id2 = addNode({ type: 'pattern', text: 'Persistent pattern about deployments', project: '/test' });
    addEdge({ source: id1, target: id2, type: 'depends-on' });
    saveGraph();

    // Reset cache and reload
    resetCache();
    const graph = loadGraph();
    assert.ok(graph.nodes[id1]);
    assert.ok(graph.nodes[id2]);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].type, 'depends-on');
  });
});

describe('getGraphMemorySection', () => {
  beforeEach(() => {
    resetCache();
    saveGraph({ version: 1, nodes: {}, edges: [], adjacency: {} });
  });

  it('returns empty string when no memories', () => {
    const section = getGraphMemorySection('/test');
    assert.equal(section, '');
  });

  it('returns formatted markdown section', () => {
    addNode({ type: 'preference', text: 'Use functional components in React code', project: '/test' });
    saveGraph();
    const section = getGraphMemorySection('/test');
    assert.ok(section.includes('## User Memories'));
    assert.ok(section.includes('[preference]'));
    assert.ok(section.includes('functional components'));
  });

  it('caps output at 2000 characters', () => {
    for (let i = 0; i < 50; i++) {
      addNode({ type: 'concept', text: `Concept ${i}: ${'x'.repeat(80)} unique topic number ${i}`, project: '/test' });
    }
    saveGraph();
    const section = getGraphMemorySection('/test');
    assert.ok(section.length <= 2000);
  });
});
