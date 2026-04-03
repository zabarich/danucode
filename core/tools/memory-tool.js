// core/tools/memory-tool.js — LLM-facing tools for graph memory.
// MemoryStore creates nodes; MemoryQuery searches them.

import { loadGraph, saveGraph, addNode, addEdge, findNodes, pruneGraph } from '../memory.js';

export const definitions = [
  {
    type: 'function',
    function: {
      name: 'MemoryStore',
      description: 'Store a memory for future sessions. Use for: project conventions, important decisions, user preferences, recurring patterns, non-obvious gotchas. Do NOT store obvious things or trivial facts.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to remember (minimum 10 characters)' },
          type: { type: 'string', enum: ['concept', 'file', 'pattern', 'preference', 'decision'], description: 'Category of memory' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for retrieval' },
          related_to: { type: 'string', description: 'Optional: node ID of an existing memory to link to' },
        },
        required: ['text', 'type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'MemoryQuery',
      description: 'Search memories for relevant context. Use when you need to recall project conventions, past decisions, or user preferences that might affect the current task.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for' },
          type: { type: 'string', enum: ['concept', 'file', 'pattern', 'preference', 'decision'], description: 'Filter by memory type' },
          project: { type: 'string', description: 'Filter by project path' },
        },
        required: ['query'],
      },
    },
  },
];

export async function execute(name, args) {
  switch (name) {
    case 'MemoryStore': {
      const nodeId = addNode({
        type: args.type || 'concept',
        text: args.text,
        tags: args.tags || [],
        project: process.cwd(),
      });

      if (!nodeId) {
        return 'Memory rejected: text too short or too few meaningful keywords.';
      }

      if (args.related_to) {
        const graph = loadGraph();
        if (graph.nodes[args.related_to]) {
          addEdge({ source: nodeId, target: args.related_to, type: 'relates-to' });
        }
      }

      pruneGraph();
      saveGraph();
      return `Stored memory ${nodeId}: "${args.text}"`;
    }

    case 'MemoryQuery': {
      const results = findNodes({
        query: args.query,
        type: args.type,
        project: args.project,
      });

      if (results.length === 0) return 'No matching memories found.';

      return results.slice(0, 10).map(n => {
        const tags = n.tags.length > 0 ? ` [${n.tags.join(', ')}]` : '';
        const pin = n.pinned ? ' (pinned)' : '';
        return `[${n.id}] (${n.type}) ${n.text}${tags}${pin}`;
      }).join('\n');
    }

    default:
      return `Unknown memory command: ${name}`;
  }
}
