let currentMode = 'code';

const MODES = {
  code: {
    name: 'Code',
    description: 'Full access. Read, write, edit, search, execute.',
    color: 'green',
    allowedTools: null, // null = all tools allowed
    systemPromptAddition: '',
  },
  architect: {
    name: 'Architect',
    description: 'Read-only + markdown. Design and plan.',
    color: 'blue',
    allowedTools: new Set(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Agent', 'Write', 'TaskCreate', 'TaskUpdate', 'TaskList', 'MemoryQuery']),
    // Write is allowed but restricted to .md files — checked in tools/index.js
    writeRestriction: '.md',
    systemPromptAddition: `\n\n## Architect Mode\nYou are in Architect mode. Focus on system design, planning, and documentation. You can only write to markdown (.md) files. Analyze the codebase, design solutions, document architectures. Do not write code directly.`,
  },
  ask: {
    name: 'Ask',
    description: 'Read-only. Quick answers and explanations.',
    color: 'cyan',
    allowedTools: new Set(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'TaskList', 'MemoryQuery']),
    systemPromptAddition: `\n\n## Ask Mode\nYou are in Ask mode. Answer questions, explain code, provide documentation. You cannot modify files or run commands. Use Read, Grep, Glob to explore the codebase.`,
  },
  debug: {
    name: 'Debug',
    description: 'Full access. Focus on debugging and diagnostics.',
    color: 'red',
    allowedTools: null, // all tools
    systemPromptAddition: `\n\n## Debug Mode\nYou are in Debug mode. Focus on finding and fixing bugs. Trace issues, isolate root causes, check logs, run diagnostics. Be systematic: reproduce first, then diagnose, then fix.`,
  },
};

export function getCurrentMode() {
  return currentMode;
}

export function getMode(name) {
  return MODES[name];
}

export function getModeConfig() {
  return MODES[currentMode];
}

export function setMode(name) {
  if (!MODES[name]) {
    return { ok: false, error: `Unknown mode: ${name}. Available: ${Object.keys(MODES).join(', ')}` };
  }
  const old = currentMode;
  currentMode = name;
  return { ok: true, old, new: name, mode: MODES[name] };
}

export function isToolAllowedInMode(toolName) {
  const mode = MODES[currentMode];
  if (!mode.allowedTools) return true; // null = all allowed
  return mode.allowedTools.has(toolName);
}

export function getModePromptAddition() {
  return MODES[currentMode].systemPromptAddition;
}

export function listModes() {
  return Object.entries(MODES).map(([key, mode]) => ({
    key,
    name: mode.name,
    description: mode.description,
    active: key === currentMode,
    color: mode.color,
  }));
}
