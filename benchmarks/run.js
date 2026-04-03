#!/usr/bin/env node

// benchmarks/run.js — Benchmark harness for Danucode.
// Runs coding tasks against danu in one-shot mode, scores results, stores history.
//
// Usage:
//   node benchmarks/run.js                    # run all tasks
//   node benchmarks/run.js fix-syntax-error   # run one task
//   node benchmarks/run.js --results          # show past results
//   node benchmarks/run.js --compare          # compare last two runs

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = join(__dirname, 'tasks');
const RESULTS_DIR = join(__dirname, 'results');
const DANU_BIN = resolve(__dirname, '..', 'bin', 'danu.js');

// ─── Task Loading ────────────────────────────────────────────

function loadTasks(filter) {
  const files = readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'));
  const tasks = files.map(f => JSON.parse(readFileSync(join(TASKS_DIR, f), 'utf-8')));

  if (filter) {
    const filtered = tasks.filter(t => t.id === filter);
    if (filtered.length === 0) {
      console.error(`Task not found: ${filter}`);
      console.error(`Available: ${tasks.map(t => t.id).join(', ')}`);
      process.exit(1);
    }
    return filtered;
  }
  return tasks;
}

// ─── Task Execution ──────────────────────────────────────────

function setupWorkdir(task) {
  const workdir = join(tmpdir(), `danu-bench-${task.id}-${Date.now()}`);
  mkdirSync(workdir, { recursive: true });

  // Write setup files
  for (const [path, content] of Object.entries(task.setup.files)) {
    const fullPath = join(workdir, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
  }

  // Create package.json for ESM
  writeFileSync(join(workdir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');

  return workdir;
}

function runDanu(task, workdir) {
  const start = Date.now();

  const result = spawnSync('node', [DANU_BIN, '--yolo', '--json', '-c', task.prompt], {
    cwd: workdir,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env },
    encoding: 'utf-8',
  });

  const duration = Date.now() - start;

  // Parse NDJSON events
  const events = [];
  if (result.stdout) {
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* skip non-json */ }
    }
  }

  const toolCalls = events.filter(e => e.type === 'tool-start').length;
  const toolFailures = events.filter(e => e.type === 'tool-done' && !e.success).length;
  const errors = events.filter(e => e.type === 'error');

  return {
    duration,
    exit_code: result.status,
    events,
    toolCalls,
    toolFailures,
    errors: errors.map(e => e.message),
    stderr: result.stderr || '',
    timedOut: result.signal === 'SIGTERM',
  };
}

function verify(task, workdir) {
  const v = task.verify;
  try {
    const result = spawnSync('node', ['-e', `
      import { execSync } from 'node:child_process';
      const out = execSync(${JSON.stringify(v.command)}, { cwd: ${JSON.stringify(workdir)}, encoding: 'utf-8', timeout: 10000 });
      process.stdout.write(out);
    `], {
      cwd: workdir,
      timeout: 15000,
      encoding: 'utf-8',
    });

    const stdout = result.stdout || '';
    const passed = result.status === (v.expected_exit_code ?? 0)
      && (!v.expected_stdout_contains || stdout.includes(v.expected_stdout_contains));

    return { passed, stdout: stdout.trim(), stderr: (result.stderr || '').trim(), exit_code: result.status };
  } catch (err) {
    return { passed: false, stdout: '', stderr: err.message, exit_code: 1 };
  }
}

// ─── Results ─────────────────────────────────────────────────

function saveResults(results) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(RESULTS_DIR, `${timestamp}.json`);

  // Get model info
  let model = 'unknown';
  try {
    const config = JSON.parse(readFileSync(join(process.env.HOME, '.danu', 'config.json'), 'utf-8'));
    model = config.model || 'unknown';
  } catch {}

  const run = {
    timestamp: new Date().toISOString(),
    model,
    tasks: results,
    summary: {
      total: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      total_duration: results.reduce((s, r) => s + r.duration, 0),
      total_tool_calls: results.reduce((s, r) => s + r.toolCalls, 0),
    },
  };

  writeFileSync(path, JSON.stringify(run, null, 2), 'utf-8');
  return { path, run };
}

function showResults() {
  if (!existsSync(RESULTS_DIR)) {
    console.log('No results yet. Run benchmarks first.');
    return;
  }
  const files = readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) {
    console.log('No results yet.');
    return;
  }

  for (const f of files) {
    const run = JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf-8'));
    const s = run.summary;
    console.log(`\n${run.timestamp}  model: ${run.model}`);
    console.log(`  ${s.passed}/${s.total} passed  |  ${s.total_tool_calls} tool calls  |  ${(s.total_duration / 1000).toFixed(1)}s total`);
    for (const t of run.tasks) {
      const icon = t.passed ? '✓' : '✗';
      console.log(`    ${icon} ${t.id}  (${t.toolCalls} calls, ${(t.duration / 1000).toFixed(1)}s)`);
    }
  }
}

function compareRuns() {
  if (!existsSync(RESULTS_DIR)) {
    console.log('No results to compare.');
    return;
  }
  const files = readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json')).sort();
  if (files.length < 2) {
    console.log('Need at least 2 runs to compare.');
    return;
  }

  const prev = JSON.parse(readFileSync(join(RESULTS_DIR, files[files.length - 2]), 'utf-8'));
  const curr = JSON.parse(readFileSync(join(RESULTS_DIR, files[files.length - 1]), 'utf-8'));

  console.log(`\nComparing:`);
  console.log(`  Previous: ${prev.timestamp} (${prev.model})`);
  console.log(`  Current:  ${curr.timestamp} (${curr.model})\n`);

  const prevMap = Object.fromEntries(prev.tasks.map(t => [t.id, t]));
  const currMap = Object.fromEntries(curr.tasks.map(t => [t.id, t]));

  const allIds = [...new Set([...Object.keys(prevMap), ...Object.keys(currMap)])];

  for (const id of allIds) {
    const p = prevMap[id];
    const c = currMap[id];
    if (!p) { console.log(`  + ${id}: NEW (${c.passed ? 'PASS' : 'FAIL'})`); continue; }
    if (!c) { console.log(`  - ${id}: REMOVED`); continue; }

    const statusChange = p.passed === c.passed ? (c.passed ? '  ✓' : '  ✗')
      : p.passed ? '  ▼ REGRESSION' : '  ▲ FIXED';
    const callsDiff = c.toolCalls - p.toolCalls;
    const callsStr = callsDiff === 0 ? '' : callsDiff > 0 ? ` (+${callsDiff} calls)` : ` (${callsDiff} calls)`;
    const durDiff = ((c.duration - p.duration) / 1000).toFixed(1);
    const durStr = Math.abs(durDiff) < 0.5 ? '' : durDiff > 0 ? ` (+${durDiff}s)` : ` (${durDiff}s)`;

    console.log(`${statusChange} ${id}${callsStr}${durStr}`);
  }

  const ps = prev.summary, cs = curr.summary;
  console.log(`\n  Score: ${ps.passed}/${ps.total} → ${cs.passed}/${cs.total}`);
  console.log(`  Calls: ${ps.total_tool_calls} → ${cs.total_tool_calls}`);
  console.log(`  Time:  ${(ps.total_duration / 1000).toFixed(1)}s → ${(cs.total_duration / 1000).toFixed(1)}s`);
}

// ─── Main ────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--results')) {
  showResults();
  process.exit(0);
}

if (args.includes('--compare')) {
  compareRuns();
  process.exit(0);
}

const filter = args.find(a => !a.startsWith('-'));
const tasks = loadTasks(filter);

console.log(`\nDanucode Benchmark — ${tasks.length} task${tasks.length === 1 ? '' : 's'}\n`);

const results = [];

for (const task of tasks) {
  const workdir = setupWorkdir(task);
  process.stdout.write(`  ${task.id} (${task.difficulty}) ... `);

  const runResult = runDanu(task, workdir);
  const verifyResult = verify(task, workdir);

  const result = {
    id: task.id,
    name: task.name,
    difficulty: task.difficulty,
    passed: verifyResult.passed,
    duration: runResult.duration,
    toolCalls: runResult.toolCalls,
    toolFailures: runResult.toolFailures,
    errors: runResult.errors,
    timedOut: runResult.timedOut,
    verify_stdout: verifyResult.stdout,
    verify_stderr: verifyResult.stderr,
  };

  results.push(result);

  if (result.passed) {
    console.log(`✓ (${result.toolCalls} calls, ${(result.duration / 1000).toFixed(1)}s)`);
  } else if (result.timedOut) {
    console.log(`✗ TIMEOUT`);
  } else {
    console.log(`✗ FAIL (${result.toolCalls} calls, ${(result.duration / 1000).toFixed(1)}s)`);
    if (verifyResult.stderr) console.log(`    ${verifyResult.stderr.split('\n')[0]}`);
  }

  // Cleanup
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
}

const { path, run } = saveResults(results);
const s = run.summary;

console.log(`\n  ${s.passed}/${s.total} passed  |  ${s.total_tool_calls} tool calls  |  ${(s.total_duration / 1000).toFixed(1)}s`);
console.log(`  Results saved: ${path}\n`);
