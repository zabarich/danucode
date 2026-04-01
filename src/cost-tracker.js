// Cost & token tracking for the session
// Tracks input/output tokens per model, lines changed, and session duration.

const state = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalAPIDuration: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  sessionStart: Date.now(),
  requests: 0,
  modelUsage: {},   // { [model]: { inputTokens, outputTokens, requests, durationMs } }
};

export function addTokenUsage(model, inputTokens, outputTokens, durationMs) {
  const inp = inputTokens || 0;
  const out = outputTokens || 0;
  const dur = durationMs || 0;

  state.totalInputTokens += inp;
  state.totalOutputTokens += out;
  state.totalAPIDuration += dur;
  state.requests++;

  if (!state.modelUsage[model]) {
    state.modelUsage[model] = { inputTokens: 0, outputTokens: 0, requests: 0, durationMs: 0 };
  }
  const m = state.modelUsage[model];
  m.inputTokens += inp;
  m.outputTokens += out;
  m.requests++;
  m.durationMs += dur;
}

export function addLinesChanged(added, removed) {
  state.totalLinesAdded += added || 0;
  state.totalLinesRemoved += removed || 0;
}

export function getTotalInputTokens() { return state.totalInputTokens; }
export function getTotalOutputTokens() { return state.totalOutputTokens; }
export function getTotalTokens() { return state.totalInputTokens + state.totalOutputTokens; }
export function getModelUsage() { return { ...state.modelUsage }; }
export function getSessionDuration() { return Date.now() - state.sessionStart; }
export function getRequests() { return state.requests; }
export function getLinesAdded() { return state.totalLinesAdded; }
export function getLinesRemoved() { return state.totalLinesRemoved; }

export function resetCostState() {
  state.totalInputTokens = 0;
  state.totalOutputTokens = 0;
  state.totalAPIDuration = 0;
  state.totalLinesAdded = 0;
  state.totalLinesRemoved = 0;
  state.sessionStart = Date.now();
  state.requests = 0;
  state.modelUsage = {};
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

export function formatCostSummary() {
  const dur = getSessionDuration();
  const apiDur = state.totalAPIDuration;
  const total = getTotalTokens();
  const lines = [];

  lines.push(`  Session: ${formatDuration(dur)} wall · ${formatDuration(apiDur)} API time · ${state.requests} requests`);
  lines.push(`  Tokens:  ${state.totalInputTokens.toLocaleString()} in + ${state.totalOutputTokens.toLocaleString()} out = ${total.toLocaleString()} total`);

  if (state.totalLinesAdded || state.totalLinesRemoved) {
    lines.push(`  Code:    +${state.totalLinesAdded} / -${state.totalLinesRemoved} lines`);
  }

  const models = Object.entries(state.modelUsage);
  if (models.length > 0) {
    lines.push('');
    lines.push('  Per model:');
    for (const [model, u] of models) {
      const short = model.replace(/\.gguf$/, '').split('/').pop();
      const t = u.inputTokens + u.outputTokens;
      lines.push(`    ${short}: ${t.toLocaleString()} tokens (${u.requests} reqs, ${formatDuration(u.durationMs)} API)`);
    }
  }

  return lines.join('\n');
}
