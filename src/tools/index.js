import * as bash from './bash.js';
import * as read from './read.js';
import * as write from './write.js';
import * as edit from './edit.js';
import * as grep from './grep.js';
import * as globTool from './glob.js';
import * as agent from './agent.js';
import * as webFetch from './webfetch.js';
import * as webSearch from './websearch.js';
import * as tasks from './tasks.js';
import * as notebook from './notebook.js';
import * as patch from './patch.js';
import * as lspTool from './lsp-tool.js';
import * as githubTool from './github-tool.js';
import * as sendMessage from './send-message.js';
import { resolve } from 'node:path';
import { isPlanMode, isToolAllowedInPlanMode, exitPlanMode, exitPlanModeDefinition, getPlanFilePath } from '../planmode.js';
import { getMcpToolDefinitions, executeMcpTool, isMcpTool } from '../mcp.js';
import { isToolAllowedInMode, getModeConfig } from '../modes.js';
import { getCustomToolDefinitions, isCustomTool, executeCustomTool } from '../custom-tools.js';

const tools = {
  Bash: bash,
  Read: read,
  Write: write,
  Edit: edit,
  Grep: grep,
  Glob: globTool,
  Agent: agent,
  WebFetch: webFetch,
  WebSearch: webSearch,
  NotebookEdit: notebook,
  Patch: patch,
  LSP: lspTool,
  GitHub: githubTool,
  SendMessage: sendMessage,
};

const taskToolNames = new Set(['TaskCreate', 'TaskUpdate', 'TaskList']);

const baseDefinitions = Object.values(tools).map(t => t.definition);

// Dynamic: include ExitPlanMode tool when in plan mode, plus MCP tools and custom tools
export function getToolDefinitions() {
  const definitions = [...baseDefinitions, ...tasks.definitions, ...getMcpToolDefinitions(), ...getCustomToolDefinitions()];
  if (isPlanMode()) {
    return [...definitions, exitPlanModeDefinition];
  }
  return definitions;
}

// Keep static export for backward compat (agent.js uses it)
export const toolDefinitions = baseDefinitions;

const MAX_RESULT_LENGTH = 50000;

export async function executeTool(name, args) {
  // Handle MCP tools
  if (isMcpTool(name)) {
    return await executeMcpTool(name, args);
  }

  // Handle custom tools
  if (isCustomTool(name)) {
    return await executeCustomTool(name, args);
  }

  // Handle ExitPlanMode
  if (name === 'ExitPlanMode') {
    const result = exitPlanMode();
    if (result) {
      return `Plan mode exited. Plan saved at: ${result.path}\n\nUser will now review your plan. Wait for approval before implementing.`;
    }
    return 'Not in plan mode.';
  }

  // Check mode restrictions
  if (!isToolAllowedInMode(name)) {
    const mode = getModeConfig();
    return `Blocked: ${name} is not available in ${mode.name} mode. Switch with /mode code.`;
  }

  // Architect mode: restrict Write to .md files only
  const modeConfig = getModeConfig();
  if (modeConfig.writeRestriction && name === 'Write' && args.file_path) {
    if (!args.file_path.endsWith(modeConfig.writeRestriction)) {
      return `Blocked: In ${modeConfig.name} mode, Write is restricted to ${modeConfig.writeRestriction} files.`;
    }
  }

  // In plan mode, allow Write ONLY to the plan file
  if (isPlanMode()) {
    if ((name === 'Write' || name === 'Edit') && args.file_path) {
      const planFile = getPlanFilePath();
      const normalised = resolve(args.file_path);
      const planNormalised = planFile ? resolve(planFile) : null;
      if (normalised !== planNormalised) {
        return `Blocked: In plan mode, you can only write to the plan file (${planFile}). Use ExitPlanMode first to start implementing.`;
      }
      // Allow write to plan file — bypass ignore check
      args = { ...args, _bypassIgnore: true };
    } else if (!isToolAllowedInPlanMode(name)) {
      return `Blocked: ${name} is not available in plan mode. Only read-only tools are allowed. Use ExitPlanMode when your plan is ready.`;
    }
  }

  // Handle task tools
  if (taskToolNames.has(name)) {
    try {
      let result = await tasks.execute(name, args);
      if (result.length > MAX_RESULT_LENGTH) {
        result = result.slice(0, MAX_RESULT_LENGTH) + `\n... (truncated at ${MAX_RESULT_LENGTH} chars)`;
      }
      return result;
    } catch (err) {
      return `Tool error: ${err.message}`;
    }
  }

  const tool = tools[name];
  if (!tool) return `Unknown tool: ${name}`;
  try {
    let result = await tool.execute(args);
    if (result.length > MAX_RESULT_LENGTH) {
      result = result.slice(0, MAX_RESULT_LENGTH) + `\n... (truncated at ${MAX_RESULT_LENGTH} chars)`;
    }
    return result;
  } catch (err) {
    return `Tool error: ${err.message}`;
  }
}
