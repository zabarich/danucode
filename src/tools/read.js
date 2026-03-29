import { readFile } from 'node:fs/promises';
import { isIgnored } from '../ignore.js';

export const definition = {
  type: 'function',
  function: {
    name: 'Read',
    description: 'Reads a file from the local filesystem and returns its contents with line numbers.\n\nUsage:\n- The file_path must be an absolute path.\n- By default reads up to 2000 lines from line 1. Use offset and limit for large files.\n- Results use cat -n format (line numbers starting at 1).\n- This tool reads files only, not directories. Use ls via Bash for directories.\n- Speculatively read multiple files in parallel when useful — it is better to read too many files than too few.\n- If a file exists but is empty, you will receive a warning.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
        offset: { type: 'number', description: 'Line number to start from (1-based). Default: 1' },
        limit: { type: 'number', description: 'Max lines to read. Default: 2000' },
      },
      required: ['file_path'],
    },
  },
};

export async function execute({ file_path, offset = 1, limit = 2000 }) {
  if (isIgnored(file_path)) {
    return `Blocked: ${file_path} is excluded by .danuignore`;
  }
  const content = await readFile(file_path, 'utf-8');
  const lines = content.split('\n');
  const start = Math.max(0, offset - 1);
  const slice = lines.slice(start, start + limit);

  return slice
    .map((line, i) => `${String(start + i + 1).padStart(6)}  ${line}`)
    .join('\n');
}
