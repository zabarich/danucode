// core/events.js — Event types, risk classification, and tool categories.
// Zero terminal dependencies. This is the foundation of the SDK event system.

export const EventType = {
  TOOL_START: 'tool-start',
  TOOL_OUTPUT: 'tool-output',
  TOOL_DONE: 'tool-done',
  TEXT: 'text',
  TEXT_DONE: 'text-done',
  TASK_UPDATE: 'task-update',
  THINKING: 'thinking',
  INTERRUPTED: 'interrupted',
  ERROR: 'error',
  STATUS: 'status',
};

export const Risk = {
  SAFE: 'safe',
  CAUTION: 'caution',
  DANGER: 'danger',
};

export const Category = {
  READ: 'read',
  SEARCH: 'search',
  EDIT: 'edit',
  SHELL: 'shell',
  RESPONSE: 'response',
  WARNING: 'warning',
  TASK: 'task',
};

const TOOL_CATEGORIES = {
  Read: Category.READ,
  Grep: Category.SEARCH,
  Glob: Category.SEARCH,
  WebSearch: Category.SEARCH,
  WebFetch: Category.READ,
  Write: Category.EDIT,
  Edit: Category.EDIT,
  Patch: Category.EDIT,
  NotebookEdit: Category.EDIT,
  Bash: Category.SHELL,
  Agent: Category.SHELL,
  SendMessage: Category.SHELL,
  GitHub: Category.SHELL,
  LSP: Category.READ,
  TaskCreate: Category.TASK,
  TaskUpdate: Category.TASK,
  TaskList: Category.TASK,
  MemoryStore: Category.TASK,
  MemoryQuery: Category.SEARCH,
};

const DANGER_TOOLS = new Set(['Bash']);
const CAUTION_TOOLS = new Set(['Write', 'Edit', 'Patch', 'NotebookEdit', 'Agent']);

export function classifyRisk(toolName, args) {
  if (DANGER_TOOLS.has(toolName)) {
    const cmd = args?.command || '';
    if (/rm\s+-rf|dd\s+if=|mkfs|format\s+|del\s+\/[sfq]/i.test(cmd)) {
      return Risk.DANGER;
    }
    return Risk.CAUTION;
  }
  if (CAUTION_TOOLS.has(toolName)) return Risk.CAUTION;
  return Risk.SAFE;
}

export function getCategory(toolName) {
  return TOOL_CATEGORIES[toolName] || Category.RESPONSE;
}
