import { glob as globFn } from 'glob';
import { stat } from 'node:fs/promises';
import { isIgnored } from '../ignore.js';

export const definition = {
  type: 'function',
  function: {
    name: 'Glob',
    description: 'Fast file pattern matching tool that works with any codebase size.\n\n- Supports glob patterns like "**/*.js" or "src/**/*.ts"\n- Returns matching file paths sorted by modification time (most recent first)\n- Use this when you need to find files by name or extension\n- When doing an open-ended search requiring multiple rounds, use the Agent tool instead\n- Speculatively perform multiple searches in parallel when useful',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.js", "src/**/*.ts")' },
        path: { type: 'string', description: 'Directory to search in. Defaults to cwd.' },
      },
      required: ['pattern'],
    },
  },
};

export async function execute({ pattern, path }) {
  const cwd = path || process.cwd();
  const files = await globFn(pattern, {
    cwd,
    absolute: true,
    nodir: true,
    ignore: ['**/node_modules/**', '**/.git/**', '**/.understand-anything/**'],
  });

  const filtered = files.filter(f => !isIgnored(f));

  const withStats = await Promise.all(
    filtered.slice(0, 500).map(async (f) => {
      try {
        const s = await stat(f);
        return { path: f, mtime: s.mtimeMs };
      } catch {
        return { path: f, mtime: 0 };
      }
    })
  );

  withStats.sort((a, b) => b.mtime - a.mtime);
  return withStats.map(f => f.path).join('\n') || 'No files matched.';
}
