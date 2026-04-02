// Claude Code adapter — wraps the `claude` CLI binary as a subprocess.
// Standard supervision: parses stream-json NDJSON output for tool events.

import { spawn, execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  emitToolStart, emitToolOutput, emitToolDone,
  emitText, emitTextDone, emitInterrupted, emitError,
  classifyToolRisk,
} from '../event-adapter.js';

// Resolve the claude binary path once at import time
let claudeBinary = 'claude';
try {
  const found = execSync('where claude', { stdio: 'pipe', encoding: 'utf-8' }).trim().split('\n')[0].trim();
  if (found && existsSync(found)) claudeBinary = found;
} catch { /* fall back to bare 'claude' */ }

export const meta = {
  id: 'claude-code',
  name: 'Claude Code',
  supervision: 'standard',
  description: 'Claude CLI with parsed tool events (standard supervision)',
};

export function createSession(tabId, cwd, config) {
  return {
    id: tabId,
    backend: 'claude-code',
    supervision: 'standard',
    cwd: resolve(cwd || process.cwd()),
    config: config || {},
    proc: null,
    busy: false,
    abort: null,
    tokenEstimate: 0,
    totalCost: 0,
    filesEdited: 0,
    model: config?.model || '',
    sessionUuid: randomUUID(),
    turnCount: 0,
  };
}

export async function sendMessage(session, message) {
  session.busy = true;
  session.turnCount++;

  const args = [
    '-p', message,
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  // First turn: assign a session ID. Subsequent turns: resume that session.
  if (session.turnCount === 1) {
    args.push('--session-id', session.sessionUuid);
  } else {
    args.push('--resume', session.sessionUuid);
  }

  const model = session.config.model || session.model;
  if (model) {
    args.push('--model', model);
  }

  const env = { ...process.env };
  if (session.config.api_key) {
    env.ANTHROPIC_API_KEY = session.config.api_key;
  }

  return new Promise((resolve, reject) => {
    const cwd = existsSync(session.cwd) ? session.cwd : process.cwd();
    const proc = spawn(claudeBinary, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    session.proc = proc;

    let buffer = '';
    let currentToolId = null;

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          processStreamEvent(session, event);
        } catch {
          // Non-JSON line — emit as text
          if (line.trim()) emitText(session.id, line.trim());
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) emitError(session.id, text);
    });

    proc.on('close', (code) => {
      // Flush remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          processStreamEvent(session, event);
        } catch {
          if (buffer.trim()) emitText(session.id, buffer.trim());
        }
      }
      emitTextDone(session.id);
      session.proc = null;
      session.busy = false;

      if (code !== 0 && code !== null) {
        emitError(session.id, `Claude exited with code ${code}`);
      }
      resolve();
    });

    proc.on('error', (err) => {
      session.proc = null;
      session.busy = false;
      emitError(session.id, `Failed to start claude: ${err.message}`);
      resolve();
    });
  });
}

function processStreamEvent(session, event) {
  if (!event || !event.type) return;

  switch (event.type) {
    case 'system':
      // Init event — extract model info
      if (event.model) session.model = event.model;
      break;

    case 'assistant': {
      const msg = event.message;
      if (!msg || !msg.content) break;

      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          // Tool invocation
          const toolName = block.name;
          const args = block.input || {};
          emitToolStart(session.id, toolName, args);

          // Track file edits
          if (['Edit', 'Write', 'Patch'].includes(toolName)) {
            session.filesEdited++;
          }
        } else if (block.type === 'text') {
          // Text response
          const lines = (block.text || '').split('\n');
          for (const line of lines) {
            if (line.trim()) emitText(session.id, line);
          }
        }
      }

      // Track usage
      if (msg.usage) {
        session.tokenEstimate = (msg.usage.input_tokens || 0) + (msg.usage.output_tokens || 0);
      }
      break;
    }

    case 'user': {
      // Tool result
      const msg = event.message;
      if (!msg || !msg.content) break;

      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          const isError = block.is_error;

          // Emit truncated output
          const lines = content.split('\n');
          const maxLines = 12;
          for (const line of lines.slice(0, maxLines)) {
            emitToolOutput(session.id, line, lines.length);
          }
          if (lines.length > maxLines) {
            emitToolOutput(session.id, `... ${lines.length - maxLines} more lines`, lines.length);
          }

          emitToolDone(session.id, !isError);
        }
      }
      break;
    }

    case 'result':
      // Final result — extract cost/usage
      if (event.total_cost_usd) session.totalCost = event.total_cost_usd;
      if (event.usage) {
        session.tokenEstimate = (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0);
      }
      break;

    case 'rate_limit_event':
      // Ignore rate limit events
      break;

    default:
      // Unknown event type — ignore
      break;
  }
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
    emitInterrupted(session.id, 'user');
  }
  session.busy = false;
}

export function destroySession(session) {
  stopSession(session);
}

export function getStatus(session) {
  return {
    model: session.model || '(default)',
    provider: 'anthropic',
    mode: 'code',
    shellAllowed: true,
    editAllowed: true,
    tokenEstimate: session.tokenEstimate || 0,
    maxTokens: 200000,
    filesEdited: session.filesEdited || 0,
  };
}
