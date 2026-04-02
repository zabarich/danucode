#!/usr/bin/env node

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { render, Box, Text, Static, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import chalk from 'chalk';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { loadConfig, getConfig } from '../src/api.js';
import { createConversation } from '../src/loop.js';
import { handleCommand, setConversationRef } from '../src/commands.js';
import { setSkipPermissions, getSkipPermissions, setPermissionHandler } from '../src/permissions.js';
import { estimateTokens } from '../src/context.js';
import { isPlanMode } from '../src/planmode.js';
import { getCurrentMode, getModeConfig } from '../src/modes.js';
import { initMcpServers, shutdownMcpServers } from '../src/mcp.js';
import { loadCustomTools } from '../src/custom-tools.js';
import { checkForUpdates, showUpdateNotice, getVersion } from '../src/updater.js';
import { initLsp, shutdownLsp } from '../src/lsp.js';
import { addToHistory, getHistory } from '../src/history.js';

const e = React.createElement;

async function runDoctor() {
  const g = chalk.green;
  const r = chalk.red;
  const y = chalk.yellow;
  const d = chalk.dim;

  console.log(chalk.bold('\n  Danu Doctor\n'));

  // Node version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1));
  console.log((major >= 20 ? g('  ✓') : r('  ✗')) + ` Node.js ${nodeVersion}`);

  // Config
  try {
    loadConfig();
    const cfg = getConfig();
    console.log(g('  ✓') + ` Config loaded (model: ${cfg.model})`);

    // API connectivity
    try {
      const res = await fetch(`${cfg.base_url}/models`, {
        headers: { 'Authorization': `Bearer ${cfg.api_key}` },
        signal: AbortSignal.timeout(5000),
      });
      console.log(res.ok ? g('  ✓') + ` LLM server reachable (${cfg.base_url})` : y('  ⚠') + ` LLM server returned ${res.status}`);
    } catch {
      console.log(r('  ✗') + ` LLM server unreachable (${cfg.base_url})`);
    }
  } catch {
    console.log(r('  ✗') + ' No config found');
  }

  // git
  try { execSync('git --version', { stdio: 'pipe' }); console.log(g('  ✓') + ' git available'); }
  catch { console.log(y('  ⚠') + ' git not found'); }

  // gh CLI
  try { execSync('gh --version', { stdio: 'pipe' }); console.log(g('  ✓') + ' gh CLI available'); }
  catch { console.log(d('  ○') + ' gh CLI not installed (optional)'); }

  // ripgrep
  try { execSync('rg --version', { stdio: 'pipe' }); console.log(g('  ✓') + ' ripgrep available'); }
  catch { console.log(d('  ○') + ' ripgrep not installed (JS fallback used)'); }

  // Directories
  const sessDir = join(homedir(), '.danu', 'sessions');
  const memDir = join(homedir(), '.danu', 'memory');
  console.log((existsSync(sessDir) ? g('  ✓') : d('  ○')) + ` Sessions: ${sessDir}`);
  console.log((existsSync(memDir) ? g('  ✓') : d('  ○')) + ` Memory: ${memDir}`);

  // DANUCODE.md
  const danumd = join(process.cwd(), 'DANUCODE.md');
  console.log((existsSync(danumd) ? g('  ✓') : d('  ○')) + ' DANUCODE.md in cwd');

  console.log('');
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { config: undefined, yolo: false, model: undefined, command: undefined, session: undefined };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--config': opts.config = args[++i]; break;
      case '--model': opts.model = args[++i]; break;
      case '--dangerously-skip-permissions':
      case '--yolo': opts.yolo = true; break;
      case '-c':
      case '--command': opts.command = args[++i]; break;
      case '--session': opts.session = args[++i]; break;
      case '--version':
      case '-v':
        console.log(getVersion());
        process.exit(0);
      case '--help':
        console.log(`\nUsage: danu [options|subcommand]\n\nSubcommands:\n  doctor                            Check system setup and LLM connectivity\n\nOptions:\n  --config <path>                   Path to danu.config.json\n  --model <name>                    Override model name\n  -c, --command <cmd>               One-shot mode: run command and exit\n  --session <name>                  Named session (persistent across runs)\n  --yolo                            Skip all permission prompts\n  --dangerously-skip-permissions    Same as --yolo\n  -v, --version                     Show version\n  --help                            Show this help\n`);
        process.exit(0);
    }
  }
  return opts;
}

function getProjectName() {
  const parts = process.cwd().replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || 'project';
}

// ─── Ink App ────────────────────────────────────────────────

function DanuApp({ config, yolo, projectName, conversation, abort, sessionName }) {
  const { exit } = useApp();
  const [lines, setLines] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [tokenCount, setTokenCount] = useState(null);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [spinnerPhrase, setSpinnerPhrase] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [permPrompt, setPermPrompt] = useState(null);
  const busyStart = useRef(0);
  const lineId = useRef(0);
  const historyIndex = useRef(-1);
  const historyDraft = useRef('');

  const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'.split('');
  const PHRASES = [
    'Thinking...', 'Pondering...', 'Cogitating...', 'Kia kaha...',
    'Sweet as, processing...', 'Crunching tokens...', 'On to it...',
    'She\'ll be right...', 'Choice bro, computing...', 'Sorting it out...',
  ];

  // Spinner animation
  useEffect(() => {
    if (!busy) return;
    busyStart.current = Date.now();
    setSpinnerPhrase(PHRASES[Math.floor(Math.random() * PHRASES.length)]);
    const id = setInterval(() => {
      setSpinnerFrame(f => (f + 1) % FRAMES.length);
      setElapsed(Math.floor((Date.now() - busyStart.current) / 1000));
    }, 80);
    const phraseId = setInterval(() => {
      setSpinnerPhrase(PHRASES[Math.floor(Math.random() * PHRASES.length)]);
    }, 4000);
    return () => { clearInterval(id); clearInterval(phraseId); };
  }, [busy]);

  const addLine = useCallback((type, content) => {
    setLines(prev => [...prev, { id: lineId.current++, type, content }]);
  }, []);

  // Wire output from loop.js
  useEffect(() => {
    const handler = (type, content) => addLine(type, content);
    globalThis.__danuOutput = handler;
    return () => { globalThis.__danuOutput = null; };
  }, [addLine]);

  // Wire permission handler
  useEffect(() => {
    setPermissionHandler((toolName, args) => {
      return new Promise((resolve) => {
        const detail = toolName === 'Bash' ? args.command : args.file_path || toolName;
        setPermPrompt({ toolName, detail, resolve });
      });
    });
    return () => setPermissionHandler(null);
  }, []);

  // Handle escape and arrow keys
  useInput((ch, key) => {
    if (key.escape) {
      if (busy && abort.current) {
        abort.current.abort();
        addLine('system', 'Interrupted (Esc)');
      } else if (!busy && !permPrompt) {
        shutdown();
        exit();
      }
    }
    // Up/down arrow: history navigation
    if (!busy && !permPrompt) {
      if (key.upArrow) {
        const history = getHistory(process.cwd());
        if (history.length === 0) return;
        if (historyIndex.current === -1) {
          historyDraft.current = input;
        }
        const next = Math.min(historyIndex.current + 1, history.length - 1);
        historyIndex.current = next;
        setInput(history[next]);
      } else if (key.downArrow) {
        if (historyIndex.current <= 0) {
          historyIndex.current = -1;
          setInput(historyDraft.current);
        } else {
          historyIndex.current--;
          const history = getHistory(process.cwd());
          setInput(history[historyIndex.current]);
        }
      }
    }
    // Handle permission prompt y/n/a
    if (permPrompt) {
      const c = ch?.toLowerCase();
      if (c === 'y') {
        permPrompt.resolve('y');
        setPermPrompt(null);
      } else if (c === 'n') {
        permPrompt.resolve('n');
        setPermPrompt(null);
      } else if (c === 'a') {
        permPrompt.resolve('a');
        setPermPrompt(null);
      }
    }
  });

  const handleSubmit = useCallback(async (value) => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;

    setInput('');
    historyIndex.current = -1;
    historyDraft.current = '';
    addToHistory(trimmed, process.cwd(), sessionName || '');
    addLine('user', trimmed);

    const parts = trimmed.split(';').map(s => s.trim()).filter(s => s.length > 0);

    for (const part of parts) {
      if (await handleCommand(part, conversation)) continue;

      const cmd = part.toLowerCase();
      if (cmd === '/exit' || cmd === '/quit' || cmd === 'exit') {
        shutdown();
        exit();
        return;
      }

      setBusy(true);
      abort.current = new AbortController();
      await conversation.send(part, null, abort.current.signal);
      abort.current = null;
      setBusy(false);

      const tokens = estimateTokens(conversation.getMessages());
      setTokenCount((tokens / 1000).toFixed(1));

      autoSave(conversation, sessionName);
    }
  }, [busy, conversation, addLine, exit, sessionName]);

  // Model info
  const model = (config?.model || '').replace(/\.gguf$/, '').split('/').pop();
  const modelShort = model.length > 25 ? model.slice(0, 22) + '...' : model;
  const mode = getCurrentMode();
  const modeConfig = getModeConfig();
  const plan = isPlanMode();

  return e(Box, { flexDirection: 'column' },
    // Scrollable output
    e(Static, { items: lines }, (item) =>
      e(Box, { key: item.id, paddingLeft: 1 },
        item.type === 'user'
          ? e(Text, { color: 'green', bold: true }, `❯ ${item.content}`)
          : item.type === 'tool-start'
            ? e(Text, { color: 'cyan' }, `  ${item.content}`)
            : item.type === 'tool-output'
              ? e(Text, { dimColor: true }, `    ${item.content}`)
              : item.type === 'tool-done'
                ? e(Text, { color: item.content === '✓' ? 'green' : 'red' }, `    ${item.content}`)
                : item.type === 'error'
                  ? e(Text, { color: 'red' }, `  ${item.content}`)
                  : item.type === 'system'
                    ? e(Text, { dimColor: true }, `  ${item.content}`)
                    : e(Text, null, item.content)
      )
    ),

    // Spinner
    busy && e(Box, { paddingLeft: 2 },
      e(Text, { color: 'green' }, FRAMES[spinnerFrame]),
      e(Text, { dimColor: true }, ` ${spinnerPhrase} ${elapsed}s`),
      elapsed > 3 && e(Text, { dimColor: true }, ' · Esc to cancel'),
    ),

    // Permission prompt
    permPrompt && e(Box, { paddingLeft: 2, flexDirection: 'column' },
      e(Text, { color: 'yellow' }, `  Allow ${permPrompt.toolName}?`),
      e(Text, { dimColor: true }, `  ${permPrompt.detail}`),
      e(Text, { color: 'yellow' }, '  [y] yes  [n] no  [a] always'),
    ),

    // Status bar
    e(Box, { paddingLeft: 1, borderStyle: 'single', borderTop: true, borderBottom: false, borderLeft: false, borderRight: false },
      e(Text, { dimColor: true },
        (getSkipPermissions() ? '⏵⏵ yolo' : '⏵ perms on')
        + (plan ? ' · plan' : '')
        + (mode !== 'code' ? ` · ${modeConfig.name}` : '')
        + ` · ${modelShort}`
        + (tokenCount ? ` · ~${tokenCount}k` : '')
      ),
    ),

    // Input area
    !permPrompt && e(Box, { paddingLeft: 1 },
      e(Text, { color: plan ? 'magenta' : 'green', bold: true }, '❯ '),
      busy
        ? e(Text, { dimColor: true }, '')
        : e(TextInput, { value: input, onChange: setInput, onSubmit: handleSubmit, placeholder: '' }),
    ),
  );
}

// ─── Main ───────────────────────────────────────────────────

function shutdown() {
  shutdownLsp();
  shutdownMcpServers();
}

function autoSave(conversation, sessionName) {
  if (!sessionName) return;
  const dir = join(homedir(), '.danu', 'sessions');
  mkdirSync(dir, { recursive: true });
  const data = { messages: conversation.getMessages(), savedAt: new Date().toISOString(), cwd: process.cwd() };
  writeFileSync(join(dir, `${sessionName}.json`), JSON.stringify(data, null, 2), 'utf-8');
}

async function main() {
  // Check for doctor subcommand before parseArgs
  const subcommand = process.argv[2];
  if (subcommand === 'doctor') {
    try {
      loadConfig();
    } catch {
      // Doctor runs even without config
    }
    await runDoctor();
    process.exit(0);
  }

  const opts = parseArgs();
  if (opts.yolo) setSkipPermissions(true);

  try {
    loadConfig(opts.config);
    // CLI model override
    if (opts.model) {
      const { setModel } = await import('../src/api.js');
      setModel(opts.model);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  await initMcpServers();
  await loadCustomTools();
  await initLsp();
  checkForUpdates().then(showUpdateNotice).catch(() => {});

  const config = getConfig();
  const conversation = createConversation();
  setConversationRef(conversation);
  const projectName = getProjectName();
  const abort = { current: null };

  // Load session if specified
  if (opts.session) {
    const sessionPath = join(homedir(), '.danu', 'sessions', `${opts.session}.json`);
    try {
      const data = JSON.parse(readFileSync(sessionPath, 'utf-8'));
      if (Array.isArray(data.messages) && data.messages.length > 0) {
        conversation.loadMessages(data.messages);
        console.log(chalk.dim(`  Resumed session: ${opts.session}`));
      }
    } catch {
      console.log(chalk.dim(`  New session: ${opts.session}`));
    }
  }

  // One-shot mode: run command and exit
  if (opts.command) {
    addToHistory(opts.command.trim(), process.cwd(), opts.session || '');
    const parts = opts.command.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const part of parts) {
      if (await handleCommand(part, conversation)) continue;
      await conversation.send(part, null);
      autoSave(conversation, opts.session);
    }
    shutdown();
    process.exit(0);
  }

  // ASCII splash before Ink takes over
  const g = chalk.green;
  const d = chalk.dim;
  const model = config.model.replace(/\.gguf$/, '').split('/').pop();
  let server; try { server = new URL(config.base_url).host; } catch { server = config.base_url; }

  console.log('');
  console.log(g('  ____                                 _      '));
  console.log(g(' |  _ \\  __ _ _ __  _   _  ___ ___   __| | ___ '));
  console.log(g(' | | | |/ _` | \'_ \\| | | |/ __/ _ \\ / _` |/ _ \\'));
  console.log(g(' | |_| | (_| | | | | |_| | (_| (_) | (_| |  __/'));
  console.log(g(' |____/ \\__,_|_| |_|\\__,_|\\___\\___/ \\__,_|\\___|'));
  console.log('');
  console.log(d(`  v${getVersion()} · ${model} · ${server}`) + d('  (c) Danucore'));
  console.log(d(`  ${process.cwd()}`));
  if (opts.yolo) console.log(chalk.yellow('  ⏵⏵ permissions off (--yolo)'));
  if (opts.session) console.log(chalk.dim(`  📌 session: ${opts.session}`));
  console.log(d('  /help for commands · Esc to cancel/quit'));
  console.log('');

  // Use Ink if we have a real TTY, fallback to simple readline otherwise
  if (process.stdin.isTTY) {
    const { waitUntilExit } = render(
      e(DanuApp, { config, yolo: opts.yolo, projectName, conversation, abort, sessionName: opts.session })
    );
    await waitUntilExit();
    autoSave(conversation, opts.session);
  } else {
    // Non-TTY fallback (piped input, CI, etc.)
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('close', () => { shutdown(); process.exit(0); });
    while (true) {
      let userInput;
      try { userInput = await rl.question(chalk.green('❯ ')); } catch { break; }
      if (!userInput.trim()) continue;
      const parts = userInput.split(';').map(s => s.trim()).filter(s => s.length > 0);
      addToHistory(userInput.trim(), process.cwd(), opts.session || '');
      for (const part of parts) {
        if (await handleCommand(part, conversation)) continue;
        const cmd = part.toLowerCase();
        if (cmd === '/exit' || cmd === '/quit' || cmd === 'exit') { shutdown(); process.exit(0); }
        await conversation.send(part, rl);
        autoSave(conversation, opts.session);
      }
    }
  }
  shutdown();
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
