import chalk from 'chalk';
import { chatCompletion, streamChatCompletion } from './api.js';
import { buildSystemPrompt } from './system-prompt.js';
import { getToolDefinitions, executeTool } from './tools/index.js';
import { askPermission } from './permissions.js';
import { compactIfNeeded, isContextLengthError, compactOnError, checkContextWarning } from './context.js';
import { renderInline } from './markdown.js';
import { isPlanMode, getPlanModePrompt } from './planmode.js';
import { runPreHooks, runPostHooks } from './hooks.js';

const NEEDS_PERMISSION = new Set(['Bash', 'Write', 'Edit']);

// File access tracking: maps file_path -> { count, tools: Set of tool names }
const fileAccessCounts = new Map();

const FILE_ACCESS_TOOLS = new Set(['Read', 'Write', 'Edit']);

function trackFileAccess(toolName, args) {
  if (!FILE_ACCESS_TOOLS.has(toolName)) return;
  const filePath = args?.file_path;
  if (!filePath) return;

  const existing = fileAccessCounts.get(filePath);
  if (existing) {
    existing.count++;
    existing.tools.add(toolName);
  } else {
    fileAccessCounts.set(filePath, { count: 1, tools: new Set([toolName]) });
  }
}

export function getFileAccessCounts() {
  return Array.from(fileAccessCounts.entries())
    .map(([filePath, data]) => ({ filePath, count: data.count, tools: Array.from(data.tools) }))
    .sort((a, b) => b.count - a.count);
}

export function clearFileAccessCounts() {
  fileAccessCounts.clear();
}


// State for tracking thinking blocks during streaming
let inThinkBlock = false;

function stripThinking(text) {
  // Handle complete think blocks
  text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
  return text;
}

function processStreamChunk(chunk) {
  let result = '';
  let i = 0;
  while (i < chunk.length) {
    if (!inThinkBlock) {
      // Check if we're entering a think block
      const thinkStart = chunk.indexOf('<think>', i);
      if (thinkStart === -1) {
        result += chunk.slice(i);
        break;
      } else {
        result += chunk.slice(i, thinkStart);
        inThinkBlock = true;
        i = thinkStart + 7; // skip past <think>
      }
    } else {
      // We're inside a think block, look for end
      const thinkEnd = chunk.indexOf('</think>', i);
      if (thinkEnd === -1) {
        break; // Still in think block, discard rest
      } else {
        inThinkBlock = false;
        i = thinkEnd + 8; // skip past </think>
      }
    }
  }
  return result;
}

// Output helpers — route through Ink when available, fallback to console
function emit(type, content) {
  if (globalThis.__danuOutput) {
    globalThis.__danuOutput(type, content);
  } else if (type === 'error') {
    console.log(chalk.red(content));
  } else if (type === 'tool-output') {
    console.log(chalk.dim(`    ${content}`));
  } else if (type === 'tool-start') {
    console.log(chalk.cyan(`  ${content}`));
  } else if (type === 'tool-done') {
    console.log(content === '✓' ? chalk.green('    ✓') : chalk.red('    ✗'));
  } else if (type === 'system') {
    console.log(chalk.dim(`  ${content}`));
  } else {
    console.log(content);
  }
}

export function createConversation() {
  const messages = [
    { role: 'system', content: buildSystemPrompt() }
  ];

  async function send(userMessage, rl, signal) {
    inThinkBlock = false;
    messages.push({ role: 'user', content: userMessage });
    let contextRetries = 0;

    while (true) {
      const compacted = await compactIfNeeded(messages);
      if (compacted !== messages) {
        messages.length = 0;
        messages.push(...compacted);
      }

      if (isPlanMode() && messages[0]?.role === 'system') {
        const planPrompt = getPlanModePrompt();
        if (!messages[0].content.includes('Plan Mode Active')) {
          messages[0] = { role: 'system', content: messages[0].content + planPrompt };
        }
      }

      let assistantMsg;
      let textBuffer = '';
      let hasStreamedText = false;
      try {
        const currentTools = getToolDefinitions();
        const stream = streamChatCompletion(messages, currentTools, signal);

        for await (const event of stream) {
          if (signal?.aborted) {
            emit('system', 'Interrupted.');
            messages.pop();
            return;
          }
          if (event.type === 'text') {
            const processed = processStreamChunk(event.content);
            textBuffer += processed;
            if (processed) hasStreamedText = true;
            // In Ink mode, accumulate and emit complete lines
            if (globalThis.__danuOutput) {
              const lines = textBuffer.split('\n');
              // Emit all complete lines, keep the last partial one
              for (let i = 0; i < lines.length - 1; i++) {
                if (lines[i].trim()) emit('text', renderInline(lines[i]));
              }
              textBuffer = lines[lines.length - 1];
            } else {
              // Console mode: write processed content
              if (processed) process.stdout.write(renderInline(processed));
            }
          } else if (event.type === 'done') {
            // Only process the first done event (safety fallback may emit a second)
            if (assistantMsg) continue;
            // Flush remaining text buffer
            if (textBuffer) {
              emit('text', renderInline(textBuffer));
              textBuffer = '';
            }
            if (!globalThis.__danuOutput && hasStreamedText) {
              process.stdout.write('\n');
            }
            assistantMsg = event.message;
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          emit('system', 'Interrupted.');
          messages.pop();
          return;
        }
        // Reactive compaction: retry on context-length errors
        if (isContextLengthError(err) && contextRetries < 2) {
          contextRetries++;
          const compacted = await compactOnError(messages);
          messages.length = 0;
          messages.push(...compacted);
          continue; // Retry the API call
        }
        emit('error', `Error: ${err.message}`);
        messages.pop();
        return;
      }

      if (!assistantMsg) return;

      messages.push(assistantMsg);
      checkContextWarning(messages);

      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        break;
      }

      for (const toolCall of assistantMsg.tool_calls) {
        if (signal?.aborted) {
          emit('system', 'Interrupted.');
          return;
        }

        const { name } = toolCall.function;
        let args;
        try {
          args = typeof toolCall.function.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments)
            : toolCall.function.arguments;
        } catch (parseErr) {
          emit('error', `Parse error: ${parseErr.message}`);
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name,
            content: `Error: Invalid JSON in tool arguments: ${parseErr.message}. Please try again with valid JSON.`,
          });
          continue;
        }

        const detail = getToolDetail(name, args);
        emit('tool-start', `● ${name}  ${detail || ''}`);

        if (NEEDS_PERMISSION.has(name) && !isPlanMode()) {
          const granted = await askPermission(name, args, rl);
          if (!granted) {
            emit('tool-done', '✗');
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name,
              content: 'Permission denied by user.',
            });
            continue;
          }
        }

        await runPreHooks(name, args);

        let result;
        try {
          result = await executeTool(name, args);
        } catch (err) {
          result = `Tool error: ${err.message}`;
        }

          trackFileAccess(name, args);

        await runPostHooks(name, args, result);

        // Show truncated result
        const lines = result.split('\n');
        const maxLines = 12;
        for (const line of lines.slice(0, maxLines)) {
          emit('tool-output', line);
        }
        if (lines.length > maxLines) {
          emit('tool-output', `... ${lines.length - maxLines} more lines`);
        }

        // Completion indicator
        const failed = result.startsWith('Error:') || result.startsWith('Tool error:') || result.startsWith('Blocked:');
        emit('tool-done', failed ? '✗' : '✓');

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name,
          content: result,
        });
      }
    }
  }

  function getMessages() {
    return messages;
  }

  function loadMessages(saved) {
    messages.length = 0;
    messages.push(...saved);
  }

  return { send, getMessages, loadMessages };
}

function getToolDetail(name, args) {
  switch (name) {
    case 'Bash': return args.command;
    case 'Read': return args.file_path;
    case 'Write': return args.file_path;
    case 'Edit': return args.file_path;
    case 'Grep': return args.pattern;
    case 'Glob': return args.pattern;
    case 'Agent': return args.description || args.prompt?.slice(0, 60);
    case 'SendMessage': return `-> ${args.to}`;
    case 'WebSearch': return args.query;
    case 'WebFetch': return args.url;
    default: return '';
  }
}
