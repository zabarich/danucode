#!/usr/bin/env node

// benchmarks/improve.js — Self-improvement loop for Danucode.
// Meta-agent analyzes benchmark failures and system prompt, proposes changes,
// benchmarks again, keeps improvements, reverts regressions.
//
// Usage:
//   node benchmarks/improve.js                # one improvement iteration
//   node benchmarks/improve.js --iterations 5 # run N iterations
//   node benchmarks/improve.js --dry-run      # show proposed changes without applying

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');
const IMPROVE_LOG = join(__dirname, 'improve-log.json');
const SYSTEM_PROMPT_PATH = join(__dirname, '..', 'core', 'system-prompt.js');
const SYSTEM_PROMPT_BACKUP = join(__dirname, 'system-prompt.backup.js');
const RUN_SCRIPT = join(__dirname, 'run.js');

// ─── LLM Call ────────────────────────────────────────────────

async function callLLM(messages) {
  // Use danu's own API infrastructure
  const { loadConfig, getConfig } = await import('../core/api.js');
  const { chatCompletion } = await import('../core/api.js');

  try { loadConfig(); } catch {}

  const response = await chatCompletion(messages, []);
  const content = response?.choices?.[0]?.message?.content
    || response?.message?.content
    || response?.content?.[0]?.text
    || response?.content
    || '';
  return typeof content === 'string' ? content : JSON.stringify(content);
}

// ─── Benchmark Running ───────────────────────────────────────

function runBenchmarks() {
  const result = spawnSync('node', [RUN_SCRIPT], {
    cwd: join(__dirname, '..'),
    timeout: 600000,
    encoding: 'utf-8',
    env: { ...process.env },
  });
  console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);

  // Load the latest result
  const files = readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(RESULTS_DIR, files[files.length - 1]), 'utf-8'));
}

// ─── System Prompt Extraction ────────────────────────────────

function extractPromptText() {
  const source = readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
  // Extract the template literal content from buildSystemPrompt()
  const match = source.match(/return `([\s\S]*?)`;?\s*\}$/m);
  if (!match) throw new Error('Could not extract system prompt template');
  return match[1];
}

function getEditableSection() {
  // Return the full system-prompt.js for the meta-agent to see and modify
  return readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
}

// ─── Meta-Agent Analysis ─────────────────────────────────────

async function analyzeAndPropose(benchmarkResult, promptSource) {
  const failures = benchmarkResult.tasks.filter(t => !t.passed);
  const successes = benchmarkResult.tasks.filter(t => t.passed);
  const s = benchmarkResult.summary;

  // Build analysis for the meta-agent
  const taskSummaries = benchmarkResult.tasks.map(t => {
    let summary = `${t.passed ? 'PASS' : 'FAIL'}: ${t.id} (${t.difficulty}) — ${t.toolCalls} tool calls, ${(t.duration / 1000).toFixed(1)}s`;
    if (!t.passed && t.verify_stderr) {
      summary += `\n  Error: ${t.verify_stderr.split('\n').slice(0, 3).join('\n  ')}`;
    }
    if (t.errors?.length > 0) {
      summary += `\n  Agent errors: ${t.errors.slice(0, 3).join('; ')}`;
    }
    return summary;
  }).join('\n');

  // High tool call count tasks — even passing ones could be more efficient
  const inefficient = benchmarkResult.tasks
    .filter(t => t.passed && t.toolCalls > 8)
    .map(t => `${t.id}: ${t.toolCalls} tool calls (could be fewer)`);

  const prompt = `You are a meta-agent optimizing a coding assistant's system prompt. Your goal is to improve the assistant's performance on coding benchmarks by making targeted, minimal changes to the system prompt.

Current benchmark results (${s.passed}/${s.total} passed, ${s.total_tool_calls} total tool calls):
${taskSummaries}

${inefficient.length > 0 ? `Tasks that passed but used excessive tool calls:\n${inefficient.join('\n')}\n` : ''}

The system prompt is in core/system-prompt.js. Here is the full source:

\`\`\`javascript
${promptSource}
\`\`\`

Analyze the benchmark results and propose SPECIFIC changes to the system prompt that would:
1. Fix failures (highest priority)
2. Reduce unnecessary tool calls on passing tasks
3. Add guidance for common error patterns you see

RULES:
- Make MINIMAL changes. Don't rewrite the whole prompt.
- Each change must be a precise find-and-replace: old text → new text.
- Don't change function signatures, imports, or the template structure.
- Only modify the text content within the template literal.
- Changes should be general improvements, not task-specific hacks.
- If benchmarks are already 100% pass, focus only on efficiency (reducing tool calls).

Return your response as a JSON object:
{
  "analysis": "Brief explanation of what you found",
  "changes": [
    {
      "description": "What this change does",
      "old_text": "exact text to find in system-prompt.js",
      "new_text": "replacement text"
    }
  ],
  "expected_impact": "What improvement you expect"
}

If no changes would help, return: { "analysis": "...", "changes": [], "expected_impact": "none" }

Return ONLY the JSON object, no markdown fences.`;

  const response = await callLLM([
    { role: 'system', content: 'You are a meta-agent that optimizes AI coding assistants. Return only valid JSON.' },
    { role: 'user', content: prompt },
  ]);

  // Parse JSON response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Meta-agent did not return valid JSON');
  return JSON.parse(jsonMatch[0]);
}

// ─── Apply / Revert Changes ─────────────────────────────────

function backupPrompt() {
  copyFileSync(SYSTEM_PROMPT_PATH, SYSTEM_PROMPT_BACKUP);
}

function revertPrompt() {
  if (existsSync(SYSTEM_PROMPT_BACKUP)) {
    copyFileSync(SYSTEM_PROMPT_BACKUP, SYSTEM_PROMPT_PATH);
  }
}

function applyChanges(changes) {
  let source = readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
  const applied = [];

  for (const change of changes) {
    if (!change.old_text || !change.new_text) continue;
    if (change.old_text === change.new_text) continue;

    if (source.includes(change.old_text)) {
      source = source.replace(change.old_text, change.new_text);
      applied.push(change);
    } else {
      console.log(`  ⚠ Could not find text for: ${change.description}`);
    }
  }

  if (applied.length > 0) {
    writeFileSync(SYSTEM_PROMPT_PATH, source, 'utf-8');
  }

  return applied;
}

// ─── Scoring ─────────────────────────────────────────────────

function score(result) {
  // Weighted score: passing matters most, then efficiency
  const s = result.summary;
  const passRate = s.passed / s.total;
  const avgCalls = s.total_tool_calls / s.total;
  // Higher is better: 100 points for pass rate, up to 20 bonus for efficiency
  return passRate * 100 + Math.max(0, 20 - avgCalls);
}

function isBetter(newResult, oldResult) {
  const newScore = score(newResult);
  const oldScore = score(oldResult);

  // Must not regress on pass count
  if (newResult.summary.passed < oldResult.summary.passed) return false;

  // If same pass count, accept if fewer tool calls
  if (newResult.summary.passed === oldResult.summary.passed) {
    return newResult.summary.total_tool_calls < oldResult.summary.total_tool_calls;
  }

  // More passes = always better
  return true;
}

// ─── Logging ─────────────────────────────────────────────────

function loadLog() {
  if (existsSync(IMPROVE_LOG)) {
    return JSON.parse(readFileSync(IMPROVE_LOG, 'utf-8'));
  }
  return { iterations: [] };
}

function saveLog(log) {
  writeFileSync(IMPROVE_LOG, JSON.stringify(log, null, 2), 'utf-8');
}

// ─── Main Loop ───────────────────────────────────────────────

async function runIteration(iterationNum, dryRun) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Iteration ${iterationNum}`);
  console.log(`${'═'.repeat(60)}\n`);

  // Step 1: Run baseline benchmarks
  console.log('Step 1: Running baseline benchmarks...\n');
  const baseline = runBenchmarks();
  if (!baseline) {
    console.error('No benchmark results. Aborting.');
    return null;
  }

  const baselineScore = score(baseline);
  console.log(`Baseline: ${baseline.summary.passed}/${baseline.summary.total} passed, ${baseline.summary.total_tool_calls} calls, score: ${baselineScore.toFixed(1)}\n`);

  // Step 2: Meta-agent analysis
  console.log('Step 2: Analyzing results and proposing changes...\n');
  const promptSource = getEditableSection();

  let proposal;
  try {
    proposal = await analyzeAndPropose(baseline, promptSource);
  } catch (err) {
    console.error(`Meta-agent error: ${err.message}`);
    return { iteration: iterationNum, action: 'error', error: err.message };
  }

  console.log(`Analysis: ${proposal.analysis}`);
  console.log(`Expected impact: ${proposal.expected_impact}`);
  console.log(`Proposed changes: ${proposal.changes.length}\n`);

  if (proposal.changes.length === 0) {
    console.log('No changes proposed. Benchmark may already be optimal.\n');
    return {
      iteration: iterationNum,
      action: 'no_changes',
      baseline_score: baselineScore,
      analysis: proposal.analysis,
    };
  }

  for (const c of proposal.changes) {
    console.log(`  • ${c.description}`);
  }
  console.log('');

  if (dryRun) {
    console.log('[DRY RUN] Would apply these changes. Stopping.\n');
    return {
      iteration: iterationNum,
      action: 'dry_run',
      baseline_score: baselineScore,
      proposal,
    };
  }

  // Step 3: Backup and apply changes
  console.log('Step 3: Applying changes to system prompt...\n');
  backupPrompt();
  const applied = applyChanges(proposal.changes);

  if (applied.length === 0) {
    console.log('No changes could be applied (text not found). Skipping.\n');
    revertPrompt();
    return {
      iteration: iterationNum,
      action: 'no_match',
      baseline_score: baselineScore,
      proposal,
    };
  }

  console.log(`Applied ${applied.length}/${proposal.changes.length} changes.\n`);

  // Step 4: Run benchmarks with changes
  console.log('Step 4: Re-running benchmarks with changes...\n');
  const improved = runBenchmarks();
  if (!improved) {
    console.error('Benchmark run failed after changes. Reverting.');
    revertPrompt();
    return { iteration: iterationNum, action: 'error', error: 'benchmark failed after changes' };
  }

  const improvedScore = score(improved);
  console.log(`After changes: ${improved.summary.passed}/${improved.summary.total} passed, ${improved.summary.total_tool_calls} calls, score: ${improvedScore.toFixed(1)}\n`);

  // Step 5: Keep or revert
  const better = isBetter(improved, baseline);

  if (better) {
    console.log(`✓ IMPROVEMENT: score ${baselineScore.toFixed(1)} → ${improvedScore.toFixed(1)}`);
    console.log('  Changes kept.\n');

    // Clean up backup
    // (keep it for manual revert if needed)

    return {
      iteration: iterationNum,
      action: 'improved',
      baseline_score: baselineScore,
      improved_score: improvedScore,
      baseline_summary: baseline.summary,
      improved_summary: improved.summary,
      changes_applied: applied.map(c => c.description),
      analysis: proposal.analysis,
    };
  } else {
    console.log(`✗ REGRESSION or no improvement: score ${baselineScore.toFixed(1)} → ${improvedScore.toFixed(1)}`);
    console.log('  Reverting changes.\n');
    revertPrompt();

    return {
      iteration: iterationNum,
      action: 'reverted',
      baseline_score: baselineScore,
      improved_score: improvedScore,
      baseline_summary: baseline.summary,
      improved_summary: improved.summary,
      changes_reverted: applied.map(c => c.description),
      analysis: proposal.analysis,
    };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const iterIdx = args.indexOf('--iterations');
  const maxIterations = iterIdx >= 0 ? parseInt(args[iterIdx + 1]) || 1 : 1;

  console.log(`\nDanucode Self-Improvement Loop`);
  console.log(`Iterations: ${maxIterations}${dryRun ? ' (dry run)' : ''}\n`);

  const log = loadLog();

  for (let i = 1; i <= maxIterations; i++) {
    const result = await runIteration(log.iterations.length + 1, dryRun);
    if (result) {
      result.timestamp = new Date().toISOString();
      log.iterations.push(result);
      saveLog(log);
    }

    // Stop early if no changes were proposed
    if (result?.action === 'no_changes') {
      console.log('Stopping: meta-agent found no further improvements.\n');
      break;
    }
  }

  // Summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  Self-Improvement Summary');
  console.log(`${'═'.repeat(60)}\n`);

  const recent = log.iterations.slice(-maxIterations);
  for (const r of recent) {
    const icon = r.action === 'improved' ? '✓' : r.action === 'reverted' ? '✗' : '○';
    console.log(`  ${icon} Iteration ${r.iteration}: ${r.action}`);
    if (r.baseline_score !== undefined) {
      console.log(`    Score: ${r.baseline_score.toFixed(1)}${r.improved_score !== undefined ? ` → ${r.improved_score.toFixed(1)}` : ''}`);
    }
    if (r.changes_applied) console.log(`    Applied: ${r.changes_applied.join(', ')}`);
    if (r.changes_reverted) console.log(`    Reverted: ${r.changes_reverted.join(', ')}`);
  }

  console.log('');
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
