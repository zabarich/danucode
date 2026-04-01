import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isIgnored } from '../ignore.js';
import { trackChange } from '../filetracker.js';
import { addLinesChanged } from '../cost-tracker.js';

export const definition = {
  type: 'function',
  function: {
    name: 'Write',
    description: 'Writes content to a file, creating parent directories if needed. Use absolute paths.\n\nUsage:\n- This tool overwrites existing files. If the file already exists, you MUST use Read first.\n- Prefer the Edit tool for modifying existing files — it only sends the diff.\n- Only use Write for new files or complete rewrites.\n- NEVER proactively create documentation files (*.md) or README files unless the user explicitly asks.\n- Only use emojis in file content if the user explicitly requests it.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'The content to write' },
      },
      required: ['file_path', 'content'],
    },
  },
};

export async function execute({ file_path, content, _bypassIgnore }) {
  if (!_bypassIgnore && isIgnored(file_path)) {
    return `Blocked: ${file_path} is excluded by .danuignore`;
  }
  let oldLineCount = 0;
  let fileExisted = false;
  let oldContent = null;

  try {
    oldContent = await readFile(file_path, 'utf-8');
    oldLineCount = oldContent.split('\n').length;
    fileExisted = true;
  } catch {
    fileExisted = false;
  }

  await mkdir(dirname(file_path), { recursive: true });
  await writeFile(file_path, content, 'utf-8');
  const newLineCount = content.split('\n').length;

  trackChange(file_path, oldContent, content);

  const added = Math.max(0, newLineCount - oldLineCount);
  const removed = Math.max(0, oldLineCount - newLineCount);
  addLinesChanged(added, removed);

  if (fileExisted) {
    return `Overwrote ${file_path} (was ${oldLineCount} lines, now ${newLineCount} lines)`;
  }

  return `Wrote ${newLineCount} lines to ${file_path}`;
}
