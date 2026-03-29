import { execSync } from 'node:child_process';

// Detect bash path on Windows
let SHELL = '/bin/bash';
if (process.platform === 'win32') {
  try {
    const found = execSync('where bash', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
      .trim().split(/\r?\n/)[0];
    if (found) SHELL = found;
  } catch {
    SHELL = 'C:/Program Files/Git/usr/bin/bash.exe';
  }
}

export const definition = {
  type: 'function',
  function: {
    name: 'Bash',
    description: 'Executes a bash command and returns its output.\n\nThe shell is bash (even on Windows via Git Bash) — always use Unix syntax.\n\nIMPORTANT: Do not use this tool for file operations when a dedicated tool exists:\n- Read files: use Read (not cat/head/tail)\n- Edit files: use Edit (not sed/awk)\n- Create files: use Write (not echo/heredoc)\n- Search contents: use Grep (not grep/rg)\n- Find files: use Glob (not find/ls)\nReserve Bash for system commands: git, npm, docker, make, etc.\n\nInstructions:\n- If creating directories or files, first run ls to verify the parent exists.\n- Always quote file paths with spaces using double quotes.\n- Use absolute paths to maintain working directory.\n- Multiple commands: use && to chain dependent commands, ; when order matters but failure is OK. Make multiple Bash calls for independent commands.\n- For git: prefer new commits over amending, never skip hooks unless asked, never use -i flags.\n- Avoid sleep commands — diagnose issues instead of retry loops.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        description: { type: 'string', description: 'Brief description of what this command does' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (max 300000). Default: 120000' },
      },
      required: ['command'],
    },
  },
};

export async function execute({ command, timeout }) {
  const maxTimeout = Math.min(timeout ?? 120000, 300000);
  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      timeout: maxTimeout,
      cwd: process.cwd(),
      shell: SHELL,
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output || '(no output)';
  } catch (err) {
    const out = (err.stdout || '') + (err.stderr || '');
    return out || `Command failed with exit code ${err.status}`;
  }
}
