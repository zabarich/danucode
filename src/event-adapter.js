// Event adapter — bridges loop.js output to structured DanuEvent objects.
// CLI and GUI are separate consumers of this adapter.

const DANGEROUS_BASH_PATTERNS = [
  'rm ', 'rm -', 'rmdir', 'git reset', 'git push --force', 'git push -f',
  'git checkout .', 'git clean', 'chmod', 'chown', 'mkfs', 'npm publish',
  'drop table', 'delete from',
];

const SAFE_BASH_PATTERNS = [
  'ls', 'cat ', 'pwd', 'git status', 'git log', 'git diff', 'git branch',
  'echo ', 'head ', 'tail ', 'wc ', 'which ', 'type ', 'where ', 'node -v',
  'npm -v', 'npm list', 'npm ls', 'npm outdated', 'npm run', 'npm test',
  'npx ', 'tsc --version',
];

function classifyBashRisk(command) {
  if (!command) return 'safe';
  const cmd = command.toLowerCase();
  for (const p of DANGEROUS_BASH_PATTERNS) {
    if (cmd.includes(p)) return 'danger';
  }
  for (const p of SAFE_BASH_PATTERNS) {
    if (cmd.startsWith(p) || cmd.includes(`&& ${p}`) || cmd.includes(`; ${p}`)) return 'safe';
  }
  return 'caution';
}

const TOOL_RISK = {
  Read: 'safe',
  Grep: 'safe',
  Glob: 'safe',
  WebSearch: 'safe',
  WebFetch: 'safe',
  LSP: 'safe',
  TaskCreate: 'safe',
  TaskUpdate: 'safe',
  TaskList: 'safe',
  TaskGet: 'safe',
  Edit: 'caution',
  Write: 'caution',
  Patch: 'caution',
  NotebookEdit: 'caution',
  Agent: 'caution',
  SendMessage: 'caution',
};

const TOOL_CATEGORY = {
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
  WebSearch: 'search',
  WebFetch: 'search',
  LSP: 'search',
  Edit: 'edit',
  Write: 'edit',
  Patch: 'edit',
  NotebookEdit: 'edit',
  Bash: 'shell',
  TaskCreate: 'task',
  TaskUpdate: 'task',
  TaskList: 'task',
  TaskGet: 'task',
  Agent: 'search',
  SendMessage: 'response',
};

function classifyToolRisk(toolName, args) {
  if (toolName === 'Bash') return classifyBashRisk(args?.command);
  return TOOL_RISK[toolName] || 'caution';
}

function getToolCategory(toolName) {
  return TOOL_CATEGORY[toolName] || 'response';
}

// Listener registry — multiple consumers can subscribe
const listeners = [];

export function addListener(fn) {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

export function removeAllListeners() {
  listeners.length = 0;
}

function broadcast(event) {
  for (const fn of listeners) {
    try { fn(event); } catch { /* listener errors must not crash the loop */ }
  }
}

// Current tool context for enriching events
let currentToolContext = null;

export function emitToolStart(tabId, toolName, args) {
  const detail = getToolDetailString(toolName, args);
  currentToolContext = { tabId, tool: toolName, args, detail };

  const event = {
    type: 'tool-start',
    tabId: tabId || 'cli',
    timestamp: new Date().toISOString(),
    category: getToolCategory(toolName),
    tool: toolName,
    detail: detail || '',
    meta: extractMeta(toolName, args),
    risk: classifyToolRisk(toolName, args),
  };
  broadcast(event);
  return event;
}

export function emitToolOutput(tabId, content, totalLines) {
  const event = {
    type: 'tool-output',
    tabId: tabId || 'cli',
    timestamp: new Date().toISOString(),
    category: currentToolContext ? getToolCategory(currentToolContext.tool) : 'response',
    content,
    truncated: totalLines > 12,
    lineCount: totalLines || 0,
  };
  broadcast(event);
  return event;
}

export function emitToolDone(tabId, success, summary) {
  const event = {
    type: 'tool-done',
    tabId: tabId || 'cli',
    timestamp: new Date().toISOString(),
    category: currentToolContext ? getToolCategory(currentToolContext.tool) : 'response',
    success,
    summary: summary || undefined,
  };
  currentToolContext = null;
  broadcast(event);
  return event;
}

export function emitText(tabId, content) {
  const event = {
    type: 'text',
    tabId: tabId || 'cli',
    timestamp: new Date().toISOString(),
    category: 'response',
    content,
  };
  broadcast(event);
  return event;
}

export function emitTextDone(tabId) {
  const event = {
    type: 'text-done',
    tabId: tabId || 'cli',
    timestamp: new Date().toISOString(),
    category: 'response',
  };
  broadcast(event);
  return event;
}

export function emitTaskUpdate(tabId, tasks, completed, total) {
  const event = {
    type: 'task-update',
    tabId: tabId || 'cli',
    timestamp: new Date().toISOString(),
    category: 'task',
    tasks,
    completed,
    total,
  };
  broadcast(event);
  return event;
}

export function emitThinking(tabId, elapsed, phrase) {
  const event = {
    type: 'thinking',
    tabId: tabId || 'cli',
    timestamp: new Date().toISOString(),
    category: 'thinking',
    elapsed,
    phrase,
  };
  broadcast(event);
  return event;
}

export function emitInterrupted(tabId, reason) {
  const event = {
    type: 'interrupted',
    tabId: tabId || 'cli',
    timestamp: new Date().toISOString(),
    category: 'interrupted',
    reason,
  };
  broadcast(event);
  return event;
}

export function emitError(tabId, message) {
  const event = {
    type: 'error',
    tabId: tabId || 'cli',
    timestamp: new Date().toISOString(),
    category: 'warning',
    message,
  };
  broadcast(event);
  return event;
}

export function emitStatus(tabId, statusData) {
  const event = {
    type: 'status',
    tabId: tabId || 'cli',
    timestamp: new Date().toISOString(),
    category: 'status',
    ...statusData,
  };
  broadcast(event);
  return event;
}

// CLI consumer — preserves existing terminal output format
export function createCliListener() {
  const chalk = (await_chalk) => await_chalk; // placeholder, actual chalk injected
  return (event) => {
    // CLI listener is handled by the existing globalThis.__danuOutput or console fallback
    // This is a no-op because the CLI path still uses the legacy emit()
  };
}

// Legacy bridge: makes the old emit(type, content) interface work through the adapter
// Used by loop.js so it doesn't need to know about structured events
export function createLegacyEmitter(tabId) {
  return function emit(type, content) {
    switch (type) {
      case 'tool-start': {
        // Parse the legacy "● ToolName  detail" format
        const match = content.match(/^● (\w+)\s+(.*)/);
        if (match) {
          emitToolStart(tabId, match[1], { _raw: match[2] });
        } else {
          emitToolStart(tabId, 'Unknown', { _raw: content });
        }
        break;
      }
      case 'tool-output':
        emitToolOutput(tabId, content);
        break;
      case 'tool-done':
        emitToolDone(tabId, content === '✓');
        break;
      case 'text':
        emitText(tabId, content);
        break;
      case 'error':
        emitError(tabId, content);
        break;
      case 'system':
        if (content.includes('Interrupted')) {
          emitInterrupted(tabId, 'user');
        } else {
          emitError(tabId, content);
        }
        break;
      default:
        emitText(tabId, content);
    }
  };
}

// Helpers

function getToolDetailString(name, args) {
  if (!args) return '';
  switch (name) {
    case 'Bash': return args.command || args._raw || '';
    case 'Read': return args.file_path || args._raw || '';
    case 'Write': return args.file_path || args._raw || '';
    case 'Edit': return args.file_path || args._raw || '';
    case 'Grep': return args.pattern || args._raw || '';
    case 'Glob': return args.pattern || args._raw || '';
    case 'Agent': return args.description || args.prompt?.slice(0, 60) || args._raw || '';
    case 'SendMessage': return args.to ? `-> ${args.to}` : args._raw || '';
    case 'WebSearch': return args.query || args._raw || '';
    case 'WebFetch': return args.url || args._raw || '';
    default: return args._raw || '';
  }
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function extractMeta(toolName, args) {
  if (!args) return undefined;
  const meta = {};
  if (args.offset !== undefined) meta.start_line = args.offset;
  if (args.limit !== undefined) meta.end_line = (args.offset || 1) + args.limit - 1;
  if (args.old_string !== undefined) {
    meta.has_diff = true;
    meta.old_string = truncate(args.old_string, 500);
    meta.new_string = truncate(args.new_string || '', 500);
  }
  if (args.start_line !== undefined) meta.start_line = args.start_line;
  if (args.end_line !== undefined) meta.end_line = args.end_line;
  if (args.command !== undefined) meta.command = args.command;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

// Export risk/category utilities for use by server
export { classifyToolRisk, getToolCategory, classifyBashRisk };
