import { readFile } from 'node:fs/promises';
import { glob as globFn } from 'glob';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { isIgnored } from '../ignore.js';

let hasRipgrep = null;

function checkRipgrep() {
  if (hasRipgrep !== null) return hasRipgrep;
  try {
    execSync('rg --version', { stdio: 'pipe' });
    hasRipgrep = true;
  } catch {
    hasRipgrep = false;
  }
  return hasRipgrep;
}

export const definition = {
  type: 'function',
  function: {
    name: 'Grep',
    description: 'Searches file contents for a regex pattern. Built on ripgrep when available, with JS fallback.\n\nUsage:\n- ALWAYS use this tool for content search. NEVER invoke grep or rg via Bash.\n- Supports full regex syntax (e.g., "log.*Error", "function\\\\s+\\\\w+").\n- Filter files with the include glob parameter (e.g., "*.js").\n- Output modes: "files_with_matches" returns file paths (default), "content" returns matching lines with line numbers.\n- Case insensitive: set case_insensitive to true.\n- For open-ended searches requiring multiple rounds, use the Agent tool instead.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory to search in. Defaults to cwd.' },
        include: { type: 'string', description: 'Glob pattern to filter files (e.g., "*.js")' },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches'],
          description: 'Output mode. Default: files_with_matches',
        },
        case_insensitive: { type: 'boolean', description: 'Case insensitive search. Default: false' },
      },
      required: ['pattern'],
    },
  },
};

export async function execute({ pattern, path, include, output_mode = 'files_with_matches', case_insensitive = false }) {
  const searchPath = path || process.cwd();

  if (checkRipgrep()) {
    return rgGrep({ pattern, searchPath, include, output_mode, case_insensitive });
  }
  return jsGrep({ pattern, searchPath, include, output_mode, case_insensitive });
}

function rgGrep({ pattern, searchPath, include, output_mode, case_insensitive }) {
  const args = [];
  if (case_insensitive) args.push('-i');
  if (output_mode === 'files_with_matches') args.push('-l');
  else args.push('-n');
  if (include) args.push('--glob', include);
  args.push('--', pattern, searchPath);

  try {
    const output = execSync(`rg ${args.map(a => `"${a}"`).join(' ')}`, {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Note: ripgrep does not check .danuignore patterns
    return output.trim() || 'No matches found.';
  } catch (err) {
    if (err.status === 1) return 'No matches found.';
    return err.stderr || 'Grep error.';
  }
}

async function jsGrep({ pattern, searchPath, include, output_mode, case_insensitive }) {
  const flags = case_insensitive ? 'i' : '';
  const regex = new RegExp(pattern, flags);
  const globPattern = include || '**/*';

  const files = await globFn(globPattern, {
    cwd: searchPath,
    absolute: true,
    nodir: true,
    ignore: ['**/node_modules/**', '**/.git/**', '**/.understand-anything/**'],
  });

  const filtered = files.filter(f => !isIgnored(f));

  const results = [];
  for (const file of filtered.slice(0, 1000)) {
    try {
      const content = await readFile(file, 'utf-8');
      const lines = content.split('\n');
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push({ line: i + 1, text: lines[i] });
        }
      }
      if (matches.length > 0) {
        if (output_mode === 'content') {
          for (const m of matches) {
            results.push(`${file}:${m.line}: ${m.text}`);
          }
        } else {
          results.push(file);
        }
      }
    } catch {
      // skip binary/unreadable files
    }
  }
  return results.join('\n') || 'No matches found.';
}
