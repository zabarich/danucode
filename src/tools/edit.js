import { readFile, writeFile } from 'node:fs/promises';
import chalk from 'chalk';
import { isIgnored } from '../ignore.js';
import { trackChange } from '../filetracker.js';
import { addLinesChanged } from '../cost-tracker.js';

export const definition = {
  type: 'function',
  function: {
    name: 'Edit',
    description: 'Edit a file. Two modes:\n\n1. String replacement (default): Set old_string and new_string. The old_string must match exactly including whitespace.\n2. Line range replacement: Set start_line, end_line, and new_string. Replaces those lines with new_string. Use this when exact string matching keeps failing.\n\nUsage:\n- You must use Read at least once before editing. Understand the contents first.\n- If exact-match Edit fails twice, switch to line-range mode or use Write to rewrite the whole file.\n- Only change what needs changing. Don\'t reformat surrounding code.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit' },
        old_string: { type: 'string', description: 'The exact text to find and replace (for string replacement mode)' },
        new_string: { type: 'string', description: 'The replacement text' },
        start_line: { type: 'number', description: 'First line to replace, 1-based (for line-range mode)' },
        end_line: { type: 'number', description: 'Last line to replace, inclusive, 1-based (for line-range mode)' },
      },
      required: ['file_path', 'new_string'],
    },
  },
};

export async function execute({ file_path, old_string, new_string, start_line, end_line, _bypassIgnore }) {
  if (!_bypassIgnore && isIgnored(file_path)) {
    return `Blocked: ${file_path} is excluded by .danuignore`;
  }
  const content = await readFile(file_path, 'utf-8');
  const lines = content.split('\n');

  // Line-range mode
  if (start_line && end_line) {
    const s = Math.max(1, Math.min(start_line, lines.length));
    const e = Math.max(s, Math.min(end_line, lines.length));

    const removedLines = lines.slice(s - 1, e);
    const newLines = new_string.split('\n');

    const result = [
      ...lines.slice(0, s - 1),
      ...newLines,
      ...lines.slice(e),
    ];

    const newContent = result.join('\n');
    trackChange(file_path, content, newContent);

    let diffOutput = '\n' + chalk.dim('─'.repeat(60)) + '\n';
    diffOutput += chalk.dim(`Lines ${s}-${e}:\n`);
    for (const line of removedLines.slice(0, 10)) {
      diffOutput += chalk.red(`[-] ${line}\n`);
    }
    if (removedLines.length > 10) diffOutput += chalk.dim(`  ... ${removedLines.length - 10} more removed\n`);
    for (const line of newLines.slice(0, 10)) {
      diffOutput += chalk.green(`[+] ${line}\n`);
    }
    if (newLines.length > 10) diffOutput += chalk.dim(`  ... ${newLines.length - 10} more added\n`);
    diffOutput += chalk.dim('─'.repeat(60)) + '\n';

    addLinesChanged(newLines.length, removedLines.length);
    await writeFile(file_path, newContent, 'utf-8');
    return diffOutput + `Edited ${file_path}: replaced lines ${s}-${e} (${removedLines.length} → ${newLines.length} lines).`;
  }

  // String replacement mode (original behaviour)
  if (!old_string) {
    return 'Error: Provide either old_string (string replacement) or start_line + end_line (line-range replacement).';
  }

  if (!content.includes(old_string)) {
    return `Error: old_string not found in ${file_path}. Try using start_line and end_line instead (line numbers from Read output).`;
  }

  const occurrences = content.split(old_string).length - 1;
  if (occurrences > 1) {
    return `Error: old_string found ${occurrences} times in ${file_path}. It must be unique. Add more surrounding context.`;
  }

  const newContent = content.replace(old_string, new_string);
  trackChange(file_path, content, newContent);

  // Compute diff
  let startLine = 0;
  let currentPos = 0;
  for (let i = 0; i < lines.length; i++) {
    if (currentPos + lines[i].length >= content.indexOf(old_string)) {
      startLine = i;
      break;
    }
    currentPos += lines[i].length + 1;
  }

  const oldStringLines = old_string.split('\n');
  const newStringLines = new_string.split('\n');
  addLinesChanged(newStringLines.length, oldStringLines.length);
  const contextBefore = Math.max(0, startLine - 2);
  const contextAfter = Math.min(lines.length - 1, startLine + oldStringLines.length + 1);

  let diffOutput = '\n' + chalk.dim('─'.repeat(60)) + '\n';
  diffOutput += chalk.dim('Diff:\n');
  for (let i = contextBefore; i < startLine; i++) {
    diffOutput += chalk.gray(`  ${lines[i]}\n`);
  }
  for (const line of oldStringLines) {
    diffOutput += chalk.red(`[-] ${line}\n`);
  }
  for (const line of newStringLines) {
    diffOutput += chalk.green(`[+] ${line}\n`);
  }
  const endLine = startLine + oldStringLines.length;
  for (let i = endLine; i <= contextAfter && i < lines.length; i++) {
    diffOutput += chalk.gray(`  ${lines[i]}\n`);
  }
  diffOutput += chalk.dim('─'.repeat(60)) + '\n';

  await writeFile(file_path, newContent, 'utf-8');
  return diffOutput + `Edited ${file_path}: replaced 1 occurrence.`;
}
