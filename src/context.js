import chalk from 'chalk';
import { chatCompletion, getConfig } from './api.js';
import { getTotalInputTokens } from './cost-tracker.js';

// Rough estimate: ~4 chars per token
const CHARS_PER_TOKEN = 4;
let warnedAt70 = false;

function getContextLimits() {
  const config = getConfig();
  // Allow config to set max_context_tokens, otherwise use sensible default
  // Leave 20% headroom for the model's response
  const maxContext = config?.max_context_tokens || 120000;
  return {
    MAX_CONTEXT_TOKENS: maxContext,
    COMPACT_TRIGGER_TOKENS: Math.floor(maxContext * 0.8),
  };
}

export function isContextLengthError(err) {
  const msg = (err?.message || err || '').toLowerCase();
  return /context.*(length|limit|exceed|too long|maximum)/i.test(msg)
    || /maximum context length/i.test(msg)
    || /prompt is too long/i.test(msg)
    || /max_tokens/i.test(msg) && /exceed/i.test(msg)
    || /context_length_exceeded/i.test(msg);
}

export function getContextStatus(messages) {
  const { MAX_CONTEXT_TOKENS, COMPACT_TRIGGER_TOKENS } = getContextLimits();
  const tokens = estimateTokens(messages);
  const percentage = Math.round((tokens / MAX_CONTEXT_TOKENS) * 100);
  return {
    tokens,
    maxTokens: MAX_CONTEXT_TOKENS,
    percentage,
    shouldCompact: tokens >= COMPACT_TRIGGER_TOKENS,
    isWarning: percentage >= 70,
    isCritical: percentage >= 90,
  };
}

export function checkContextWarning(messages) {
  if (warnedAt70) return;
  const { percentage } = getContextStatus(messages);
  if (percentage >= 70) {
    warnedAt70 = true;
    console.log(chalk.yellow(`\n  [Context at ${percentage}% — auto-compact will trigger at 80%]`));
  }
}

export async function compactOnError(messages) {
  // Aggressive compaction for context-length errors: keep only 2 recent messages
  console.log(chalk.yellow('\n  [Context limit hit — aggressively compacting...]'));

  const pruned = pruneToolOutputs(messages);
  const systemMsg = pruned[0];
  const keepRecent = pruned.slice(-2);
  const toSummarize = pruned.slice(1, -2);

  if (toSummarize.length < 2) {
    // Nothing left to compact — just prune
    return [systemMsg, ...pruned.slice(-4)];
  }

  const summaryMessages = [
    { role: 'system', content: 'Summarize the following conversation very concisely. Focus on: tasks completed, files modified, key decisions, and current goal. Maximum 3 paragraphs.' },
    { role: 'user', content: toSummarize.map(m => {
      const role = m.role;
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      if (m.tool_calls) return `[${role}] Tool calls: ${JSON.stringify(m.tool_calls)}`;
      if (role === 'tool') return `[tool result for ${m.name}] ${content?.slice(0, 300)}`;
      return `[${role}] ${content}`;
    }).join('\n') }
  ];

  try {
    const choice = await chatCompletion(summaryMessages, []);
    const summary = choice?.message?.content || 'Previous conversation context (summary failed).';
    const compacted = [
      systemMsg,
      { role: 'user', content: `[Previous conversation summary]\n${summary}` },
      { role: 'assistant', content: 'Understood. Continuing from where we left off.' },
      ...keepRecent,
    ];
    const newTokens = estimateTokens(compacted);
    console.log(chalk.green(`  [Compacted to ~${newTokens} tokens — retrying]`));
    return compacted;
  } catch (err) {
    console.log(chalk.red(`  [Compaction failed: ${err.message} — dropping old messages]`));
    return [systemMsg, ...pruned.slice(-4)];
  }
}

export function resetContextWarnings() {
  warnedAt70 = false;
}

export function estimateTokens(messages) {
  return Math.ceil(
    messages.reduce((sum, m) => {
      let content = '';
      if (typeof m.content === 'string') content = m.content;
      if (m.tool_calls) content += JSON.stringify(m.tool_calls);
      return sum + content.length;
    }, 0) / CHARS_PER_TOKEN
  );
}

export function pruneToolOutputs(messages) {
  if (messages.length < 15) return messages; // too few to prune

  const systemMsg = messages[0];
  const recentCount = 6; // keep last 6 messages fully intact
  const boundary = messages.length - recentCount;

  const pruned = messages.map((msg, i) => {
    if (i === 0) return msg; // keep system prompt
    if (i >= boundary) return msg; // keep recent messages

    // Prune old tool results
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > 200) {
      return {
        ...msg,
        content: msg.content.slice(0, 200) + '\n[... output pruned to save context]',
      };
    }

    return msg;
  });

  return pruned;
}

export async function compactIfNeeded(messages) {
  const { COMPACT_TRIGGER_TOKENS } = getContextLimits();
  const tokens = estimateTokens(messages);
  if (tokens < COMPACT_TRIGGER_TOKENS) return messages;

  // Stage 1: prune old tool outputs (free, no API call)
  const pruned = pruneToolOutputs(messages);
  const prunedTokens = estimateTokens(pruned);
  if (prunedTokens < COMPACT_TRIGGER_TOKENS) {
    console.log(chalk.dim(`\n  [Pruned old tool outputs: ~${tokens} -> ~${prunedTokens} tokens]`));
    return pruned;
  }

  // Stage 2: full summarization (costs an API call)
  console.log(chalk.dim(`\n  [Compacting conversation: ~${prunedTokens} tokens -> summarizing...]`));

  // Keep the system prompt (index 0) and the last 4 messages
  const systemMsg = pruned[0];
  const keepRecent = pruned.slice(-4);
  const toSummarize = pruned.slice(1, -4);

  if (toSummarize.length < 4) return pruned; // Not enough to summarize

  // Ask the LLM to summarize the old conversation
  const summaryMessages = [
    { role: 'system', content: 'Summarize the following conversation concisely. Focus on: what tasks were completed, what files were read/written/edited, key decisions made, and current state. Be brief but preserve important details.' },
    { role: 'user', content: toSummarize.map(m => {
      const role = m.role;
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      if (m.tool_calls) return `[${role}] Tool calls: ${JSON.stringify(m.tool_calls)}`;
      if (role === 'tool') return `[tool result for ${m.name}] ${content?.slice(0, 500)}`;
      return `[${role}] ${content}`;
    }).join('\n') }
  ];

  try {
    const choice = await chatCompletion(summaryMessages, []);
    const summary = choice?.message?.content || 'Previous conversation context (summary failed).';

    const compactedMessages = [
      systemMsg,
      { role: 'user', content: `[Previous conversation summary]\n${summary}` },
      { role: 'assistant', content: 'Understood, I have the context from our previous conversation. How can I continue helping?' },
      ...keepRecent,
    ];

    const newTokens = estimateTokens(compactedMessages);
    console.log(chalk.dim(`  [Compacted to ~${newTokens} tokens]`));
    return compactedMessages;
  } catch (err) {
    console.log(chalk.dim(`  [Compaction failed: ${err.message}, trimming old messages instead]`));
    // Fallback: just drop old messages
    return [systemMsg, ...pruned.slice(-10)];
  }
}

export async function forceCompact(messages) {
  const beforeTokens = estimateTokens(messages);

  // Stage 1: prune old tool outputs first
  const pruned = pruneToolOutputs(messages);
  const prunedTokens = estimateTokens(pruned);

  console.log(chalk.dim(`\n  [Forcing compaction: ~${beforeTokens} tokens -> summarizing...]`));

  // Keep the system prompt (index 0) and the last 4 messages
  const systemMsg = pruned[0];
  const keepRecent = pruned.slice(-4);
  const toSummarize = pruned.slice(1, -4);

  if (toSummarize.length < 4) {
    console.log(chalk.yellow('\n  Not enough messages to compact (need at least 8 total).'));
    return pruned;
  }

  // Ask the LLM to summarize the old conversation
  const summaryMessages = [
    { role: 'system', content: 'Summarize the following conversation concisely. Focus on: what tasks were completed, what files were read/written/edited, key decisions made, and current state. Be brief but preserve important details.' },
    { role: 'user', content: toSummarize.map(m => {
      const role = m.role;
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      if (m.tool_calls) return `[${role}] Tool calls: ${JSON.stringify(m.tool_calls)}`;
      if (role === 'tool') return `[tool result for ${m.name}] ${content?.slice(0, 500)}`;
      return `[${role}] ${content}`;
    }).join('\n') }
  ];

  try {
    const choice = await chatCompletion(summaryMessages, []);
    const summary = choice?.message?.content || 'Previous conversation context (summary failed).';

    const compactedMessages = [
      systemMsg,
      { role: 'user', content: `[Previous conversation summary]\n${summary}` },
      { role: 'assistant', content: 'Understood, I have the context from our previous conversation. How can I continue helping?' },
      ...keepRecent,
    ];

    const afterTokens = estimateTokens(compactedMessages);
    console.log(chalk.green(`  [Compacted: ~${beforeTokens} tokens -> ~${afterTokens} tokens]`));
    return compactedMessages;
  } catch (err) {
    console.log(chalk.red(`  [Compaction failed: ${err.message}]`));
    return pruned;
  }
}
