// OpenCode adapter — wraps the `opencode` CLI binary as a subprocess.
// Standard supervision: parses ANSI text output for tool indicators.

import { spawn, execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  emitToolStart, emitToolOutput, emitToolDone,
  emitText, emitTextDone, emitInterrupted, emitError,
} from '../event-adapter.js';

// Resolve the opencode binary path once at import time
let opencodeBinary = 'opencode';
try {
  const found = execSync('where opencode', { stdio: 'pipe', encoding: 'utf-8' }).trim().split('\n')[0].trim();
  if (found && existsSync(found)) opencodeBinary = found;
} catch { /* fall back to bare 'opencode' */ }

// Strip ANSI escape codes from text
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\].*?\x07/g, '');
}

// Patterns for detecting tool activity in opencode output
const TOOL_PATTERNS = [
  { pattern: /^[←→]\s*(Read|Write|Edit|Patch|Bash|Grep|Glob|Agent)\s+(.*)$/i, type: 'tool-start' },
  { pattern: /^[←]\s*(.+)$/i, type: 'write-indicator' },
  { pattern: /^[✓✔]\s*(.*)$/i, type: 'success' },
  { pattern: /^[✗✘×]\s*(.*)$/i, type: 'failure' },
  { pattern: /^Error[:]\s*(.*)$/i, type: 'error' },
  { pattern: /^>\s*(.+)\s*·\s*(.+)$/i, type: 'session-header' },
];

// Known tool name keywords in opencode output
const TOOL_KEYWORDS = {
  'write': 'Write',
  'read': 'Read',
  'edit': 'Edit',
  'bash': 'Bash',
  'patch': 'Patch',
  'grep': 'Grep',
  'glob': 'Glob',
};

export const meta = {
  id: 'opencode',
  name: 'OpenCode',
  supervision: 'standard',
  description: 'OpenCode CLI with parsed text output (standard supervision)',
};

export function createSession(tabId, cwd, config) {
  return {
    id: tabId,
    backend: 'opencode',
    supervision: 'standard',
    cwd: resolve(cwd || process.cwd()),
    config: config || {},
    proc: null,
    busy: false,
    tokenEstimate: 0,
    filesEdited: 0,
    model: config?.model || 'default',
    currentTool: null,
  };
}

export async function sendMessage(session, message) {
  session.busy = true;

  const args = ['--prompt', message];

  if (session.config.model || session.model !== 'default') {
    args.push('-m', session.config.model || session.model);
  }

  const env = { ...process.env };
  if (session.config.api_key) {
    env.OPENAI_API_KEY = session.config.api_key;
    env.ANTHROPIC_API_KEY = session.config.api_key;
  }

  return new Promise((resolve) => {
    const cwd = existsSync(session.cwd) ? session.cwd : process.cwd();
    const proc = spawn(opencodeBinary, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    session.proc = proc;

    let buffer = '';

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        parseLine(session, line);
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = stripAnsi(chunk.toString()).trim();
      if (text) emitError(session.id, text);
    });

    proc.on('close', (code) => {
      if (buffer.trim()) parseLine(session, buffer);

      // Close any open tool
      if (session.currentTool) {
        emitToolDone(session.id, true);
        session.currentTool = null;
      }

      emitTextDone(session.id);
      session.proc = null;
      session.busy = false;

      if (code !== 0 && code !== null) {
        emitError(session.id, `opencode exited with code ${code}`);
      }
      resolve();
    });

    proc.on('error', (err) => {
      session.proc = null;
      session.busy = false;
      emitError(session.id, `Failed to start opencode: ${err.message}`);
      resolve();
    });
  });
}

function parseLine(session, rawLine) {
  const line = stripAnsi(rawLine).trim();
  if (!line) return;

  // Check for tool patterns
  for (const { pattern, type } of TOOL_PATTERNS) {
    const match = line.match(pattern);
    if (!match) continue;

    switch (type) {
      case 'tool-start': {
        // Close previous tool if open
        if (session.currentTool) emitToolDone(session.id, true);

        const toolName = match[1];
        const detail = match[2] || '';
        session.currentTool = toolName;
        emitToolStart(session.id, capitalizeToolName(toolName), { _raw: detail, file_path: detail });

        if (['Write', 'Edit', 'Patch'].includes(capitalizeToolName(toolName))) {
          session.filesEdited++;
        }
        return;
      }

      case 'write-indicator': {
        // Generic write indicator (← filename)
        if (session.currentTool) emitToolDone(session.id, true);

        const detail = match[1] || '';
        // Try to detect tool name from the detail
        let toolName = 'Write';
        for (const [keyword, name] of Object.entries(TOOL_KEYWORDS)) {
          if (detail.toLowerCase().startsWith(keyword)) {
            toolName = name;
            break;
          }
        }
        session.currentTool = toolName;
        emitToolStart(session.id, toolName, { _raw: detail, file_path: detail });
        if (['Write', 'Edit', 'Patch'].includes(toolName)) session.filesEdited++;
        return;
      }

      case 'success': {
        if (session.currentTool) {
          emitToolDone(session.id, true, match[1] || undefined);
          session.currentTool = null;
        }
        return;
      }

      case 'failure': {
        if (session.currentTool) {
          emitToolDone(session.id, false, match[1] || undefined);
          session.currentTool = null;
        }
        return;
      }

      case 'error': {
        emitError(session.id, match[1] || line);
        return;
      }

      case 'session-header':
        // Ignore session headers
        return;
    }
  }

  // If inside a tool, treat as tool output
  if (session.currentTool) {
    emitToolOutput(session.id, line, 0);
    return;
  }

  // Otherwise it's text response
  emitText(session.id, line);
}

function capitalizeToolName(name) {
  const lower = name.toLowerCase();
  return TOOL_KEYWORDS[lower] || name.charAt(0).toUpperCase() + name.slice(1);
}

export function stopSession(session) {
  if (session.proc) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(session.proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        session.proc.kill('SIGTERM');
      }
    } catch { /* best effort */ }
    session.proc = null;
    if (session.currentTool) {
      emitToolDone(session.id, false);
      session.currentTool = null;
    }
    emitInterrupted(session.id, 'user');
  }
  session.busy = false;
}

export function destroySession(session) {
  stopSession(session);
}

export function getStatus(session) {
  return {
    model: session.model || 'default',
    provider: 'opencode',
    mode: 'code',
    shellAllowed: true,
    editAllowed: true,
    tokenEstimate: session.tokenEstimate || 0,
    maxTokens: 128000,
    filesEdited: session.filesEdited || 0,
  };
}
