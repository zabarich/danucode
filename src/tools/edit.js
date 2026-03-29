import { readFile, writeFile } from 'node:fs/promises';
import chalk from 'chalk';
import { isIgnored } from '../ignore.js';
import { trackChange } from '../filetracker.js';

export const definition = {
  type: 'function',
  function: {
    name: 'Edit',
    description: 'Performs exact string replacement in a file. The old_string must match exactly including whitespace and indentation.\n\nUsage:\n- You must use Read at least once before editing a file. Understand the contents first.\n- When copying text from Read output, preserve exact indentation after the line number prefix. Never include line numbers in old_string or new_string.\n- The edit FAILS if old_string appears more than once. Provide more surrounding context to make it unique.\n- Only change what needs changing. Don\'t reformat surrounding code.\n- ALWAYS prefer editing existing files over creating new ones.\n- Only use emojis if the user explicitly requests it.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit' },
        old_string: { type: 'string', description: 'The exact text to find and replace' },
        new_string: { type: 'string', description: 'The replacement text' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
};

export async function execute({ file_path, old_string, new_string, _bypassIgnore }) {
  if (!_bypassIgnore && isIgnored(file_path)) {
    return `Blocked: ${file_path} is excluded by .danuignore`;
  }
  const content = await readFile(file_path, 'utf-8');

  if (!content.includes(old_string)) {
    return `Error: old_string not found in ${file_path}. Make sure it matches exactly, including whitespace and indentation.`;
  }

  const occurrences = content.split(old_string).length - 1;
  if (occurrences > 1) {
    return `Error: old_string found ${occurrences} times in ${file_path}. It must be unique. Add more surrounding context.`;
  }

  const newContent = content.replace(old_string, new_string);

  trackChange(file_path, content, newContent);

  // Compute diff
  const oldLines = content.split('\n');
  const newLines = newContent.split('\n');

  // Find where old_string starts
  let startLine = 0;
  let currentPos = 0;
  for (let i = 0; i < oldLines.length; i++) {
    if (currentPos + oldLines[i].length >= content.indexOf(old_string)) {
      startLine = i;
      break;
    }
    currentPos += oldLines[i].length + 1;
  }

  const oldStringLines = old_string.split('\n');
  const newStringLines = new_string.split('\n');

  const contextBefore = Math.max(0, startLine - 2);
  const contextAfter = Math.min(oldLines.length - 1, startLine + oldStringLines.length + 1);

  let diffOutput = '\n' + chalk.dim('─'.repeat(60)) + '\n';
  diffOutput += chalk.dim('Diff:\n');

  // Context before
  for (let i = contextBefore; i < startLine; i++) {
    diffOutput += chalk.gray(`  ${oldLines[i]}\n`);
  }

  // Removed lines
  for (const line of oldStringLines) {
    diffOutput += chalk.red(`[-] ${line}\n`);
  }

  // Added lines
  for (const line of newStringLines) {
    diffOutput += chalk.green(`[+] ${line}\n`);
  }

  // Context after
  const endLine = startLine + oldStringLines.length;
  for (let i = endLine; i <= contextAfter && i < oldLines.length; i++) {
    diffOutput += chalk.gray(`  ${oldLines[i]}\n`);
  }

  diffOutput += chalk.dim('─'.repeat(60)) + '\n';

  await writeFile(file_path, newContent, 'utf-8');
  return diffOutput + `Edited ${file_path}: replaced 1 occurrence.`;
}
