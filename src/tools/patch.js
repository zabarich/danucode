import { readFile, writeFile } from 'node:fs/promises';
import { isIgnored } from '../ignore.js';
import { trackChange } from '../filetracker.js';

export const definition = {
  type: 'function',
  function: {
    name: 'Patch',
    description: 'Applies a unified diff patch to a file. Use standard unified diff format.\n\nUsage:\n- The patch must have @@ line markers (e.g., @@ -10,5 +10,7 @@).\n- Lines starting with - are removed, + are added, space are context.\n- Use Patch instead of Edit when making multiple scattered changes to the same file.\n- Use Edit instead of Patch for simple single-location replacements.\n- The file must already exist. Use absolute paths.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to patch' },
        patch: { type: 'string', description: 'The unified diff patch to apply (lines starting with - are removed, + are added, space are context)' },
      },
      required: ['file_path', 'patch'],
    },
  },
};

export async function execute({ file_path, patch }) {
  if (isIgnored(file_path)) {
    return `Blocked: ${file_path} is excluded by .danuignore`;
  }

  const content = await readFile(file_path, 'utf-8');
  const lines = content.split('\n');

  // Parse the patch
  const hunks = parseUnifiedDiff(patch);
  if (hunks.length === 0) {
    return 'Error: Could not parse patch. Use unified diff format with @@ markers.';
  }

  // Apply hunks in reverse order (so line numbers don't shift)
  const sortedHunks = hunks.sort((a, b) => b.startLine - a.startLine);

  let result = [...lines];
  for (const hunk of sortedHunks) {
    const applied = applyHunk(result, hunk);
    if (applied.error) {
      return `Error applying patch at line ${hunk.startLine}: ${applied.error}`;
    }
    result = applied.lines;
  }

  const newContent = result.join('\n');

  trackChange(file_path, content, newContent);

  await writeFile(file_path, newContent, 'utf-8');

  const added = hunks.reduce((sum, h) => sum + h.additions, 0);
  const removed = hunks.reduce((sum, h) => sum + h.removals, 0);
  return `Patched ${file_path}: ${hunks.length} hunk(s), +${added} -${removed} lines`;
}

function parseUnifiedDiff(patch) {
  const hunks = [];
  const lines = patch.split('\n');
  let i = 0;

  while (i < lines.length) {
    // Look for @@ markers
    const match = lines[i].match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (match) {
      const startLine = parseInt(match[1]) - 1; // 0-indexed
      const hunk = { startLine, changes: [], additions: 0, removals: 0 };
      i++;

      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff ')) {
        const line = lines[i];
        if (line.startsWith('+')) {
          hunk.changes.push({ type: 'add', text: line.slice(1) });
          hunk.additions++;
        } else if (line.startsWith('-')) {
          hunk.changes.push({ type: 'remove', text: line.slice(1) });
          hunk.removals++;
        } else if (line.startsWith(' ') || line === '') {
          hunk.changes.push({ type: 'context', text: line.startsWith(' ') ? line.slice(1) : '' });
        }
        i++;
      }

      hunks.push(hunk);
    } else {
      i++;
    }
  }

  return hunks;
}

function applyHunk(lines, hunk) {
  let lineIdx = hunk.startLine;
  const newLines = [];

  // Copy lines before the hunk
  for (let i = 0; i < lineIdx; i++) {
    newLines.push(lines[i]);
  }

  // Apply changes
  for (const change of hunk.changes) {
    if (change.type === 'context') {
      if (lineIdx >= lines.length) {
        return { error: 'Context line beyond end of file' };
      }
      newLines.push(lines[lineIdx]);
      lineIdx++;
    } else if (change.type === 'remove') {
      // Skip this line (don't add to output)
      lineIdx++;
    } else if (change.type === 'add') {
      newLines.push(change.text);
    }
  }

  // Copy remaining lines
  for (let i = lineIdx; i < lines.length; i++) {
    newLines.push(lines[i]);
  }

  return { lines: newLines };
}
