import chalk from 'chalk';
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { forceCompact, estimateTokens } from './context.js';
import { setSkipPermissions, getSkipPermissions } from './permissions.js';
import { enterPlanMode, isPlanMode } from './planmode.js';
import { setMode, listModes, getCurrentMode } from './modes.js';
import { undo, redo, getHistoryCount, getRedoCount } from './filetracker.js';
import { getVersion } from './updater.js';
import { getConfig, setModel } from './api.js';

const MEMORY_DIR = join(homedir(), '.danu', 'memory');
const SESSION_DIR = join(homedir(), '.danu', 'sessions');

let conversationRef = null;

export function setConversationRef(conv) {
  conversationRef = conv;
}

// /init — create a DANUCODE.md in cwd, auto-populated with project info
export function handleInit() {
  const target = resolve(process.cwd(), 'DANUCODE.md');

  if (existsSync(target)) {
    console.log(chalk.yellow(`\n  DANUCODE.md already exists at ${target}`));
    return true;
  }

  console.log(chalk.dim('\n  Scanning project...'));
  const info = scanProject();
  const template = buildTemplate(info);

  writeFileSync(target, template, 'utf-8');
  console.log(chalk.green(`  Created ${target}`));
  console.log(chalk.dim('  Review and edit to refine the instructions.\n'));
  return true;
}

function scanProject() {
  const cwd = process.cwd();
  const info = {
    name: '',
    description: '',
    languages: [],
    frameworks: [],
    entryPoint: '',
    gitRepo: false,
    gitBranch: '',
    structure: [],
  };

  // Project name + description from package.json, pyproject.toml, etc.
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf-8'));
    info.name = pkg.name || '';
    info.description = pkg.description || '';
    if (pkg.dependencies || pkg.devDependencies) {
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.react || deps['react-dom']) info.frameworks.push('React');
      if (deps.next) info.frameworks.push('Next.js');
      if (deps.express) info.frameworks.push('Express');
      if (deps.fastify) info.frameworks.push('Fastify');
      if (deps.vue) info.frameworks.push('Vue');
      if (deps.svelte) info.frameworks.push('Svelte');
      if (deps.typescript) info.frameworks.push('TypeScript');
      if (deps.tailwindcss) info.frameworks.push('Tailwind CSS');
    }
  } catch { /* not a node project */ }

  try {
    const pyproj = readFileSync(resolve(cwd, 'pyproject.toml'), 'utf-8');
    const nameMatch = pyproj.match(/name\s*=\s*"([^"]+)"/);
    if (nameMatch) info.name = info.name || nameMatch[1];
  } catch { /* not a python project */ }

  try {
    const cargo = readFileSync(resolve(cwd, 'Cargo.toml'), 'utf-8');
    const nameMatch = cargo.match(/name\s*=\s*"([^"]+)"/);
    if (nameMatch) info.name = info.name || nameMatch[1];
  } catch { /* not a rust project */ }

  // Fallback name from directory
  if (!info.name) {
    const parts = cwd.replace(/\\/g, '/').split('/');
    info.name = parts[parts.length - 1] || 'my-project';
  }

  // Detect languages from file extensions
  const extCounts = {};
  try {
    countExtensions(cwd, extCounts, 0, 3);
  } catch { /* ignore */ }

  const langMap = {
    '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
    '.ts': 'TypeScript', '.tsx': 'TypeScript',
    '.py': 'Python', '.rb': 'Ruby', '.go': 'Go',
    '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin',
    '.cs': 'C#', '.cpp': 'C++', '.c': 'C', '.h': 'C/C++',
    '.php': 'PHP', '.swift': 'Swift', '.dart': 'Dart',
    '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
  };

  const langCounts = {};
  for (const [ext, count] of Object.entries(extCounts)) {
    const lang = langMap[ext];
    if (lang) langCounts[lang] = (langCounts[lang] || 0) + count;
  }
  info.languages = Object.entries(langCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lang]) => lang);

  // Git info
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'pipe' });
    info.gitRepo = true;
    info.gitBranch = execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim();
  } catch { /* not git */ }

  // Top-level structure
  try {
    const entries = readdirSync(cwd).filter(e => !e.startsWith('.') && e !== 'node_modules' && e !== '__pycache__');
    info.structure = entries.slice(0, 20);
  } catch { /* ignore */ }

  // Find entry points
  const candidates = ['src/index.ts', 'src/main.ts', 'src/App.tsx', 'index.js', 'main.py', 'main.go', 'src/main.rs', 'app.py', 'server.js'];
  for (const c of candidates) {
    if (existsSync(resolve(cwd, c))) { info.entryPoint = c; break; }
  }

  return info;
}

function countExtensions(dir, counts, depth, maxDepth) {
  if (depth >= maxDepth) return;
  const skip = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.next', 'vendor', '.understand-anything']);
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (skip.has(entry)) continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        countExtensions(full, counts, depth + 1, maxDepth);
      } else {
        const ext = extname(entry).toLowerCase();
        if (ext) counts[ext] = (counts[ext] || 0) + 1;
      }
    } catch { /* skip */ }
  }
}

function buildTemplate(info) {
  let md = `# ${info.name}\n\n`;

  if (info.description) {
    md += `${info.description}\n\n`;
  }

  md += `## Project Overview\n`;
  if (info.languages.length > 0) md += `- Languages: ${info.languages.join(', ')}\n`;
  if (info.frameworks.length > 0) md += `- Frameworks: ${info.frameworks.join(', ')}\n`;
  if (info.entryPoint) md += `- Entry point: ${info.entryPoint}\n`;
  if (info.gitRepo) md += `- Git: yes (branch: ${info.gitBranch || 'unknown'})\n`;
  if (info.structure.length > 0) {
    md += `- Structure: ${info.structure.join(', ')}\n`;
  }
  md += '\n';

  md += `## Coding Guidelines\n`;
  md += `- (Add your project's coding conventions here)\n`;
  md += `- (e.g., "Use functional components", "Always add tests", etc.)\n\n`;

  md += `## Important Notes\n`;
  md += `- (Add anything Danu should know when working on this project)\n`;
  md += `- (e.g., "The API keys are in .env", "Don't modify /legacy/ code", etc.)\n`;

  return md;
}

// /memory save <text> — save a memory
export function handleMemorySave(text) {
  if (!text.trim()) {
    console.log(chalk.yellow('\n  Usage: /memory save <something to remember>'));
    return true;
  }

  mkdirSync(MEMORY_DIR, { recursive: true });

  const memories = loadMemories();
  memories.push({
    text: text.trim(),
    date: new Date().toISOString(),
    cwd: process.cwd(),
  });

  writeFileSync(join(MEMORY_DIR, 'memories.json'), JSON.stringify(memories, null, 2), 'utf-8');
  console.log(chalk.green(`\n  Remembered: "${text.trim()}"`));
  return true;
}

// /memory list — list all memories
export function handleMemoryList() {
  const memories = loadMemories();

  if (memories.length === 0) {
    console.log(chalk.dim('\n  No memories saved. Use /memory save <text> to add one.'));
    return true;
  }

  console.log(chalk.green(`\n  Memories (${memories.length}):`));
  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    const date = m.date.split('T')[0];
    console.log(chalk.dim(`  ${i + 1}. [${date}] `) + chalk.white(m.text));
  }
  return true;
}

// /memory forget <number> — delete a memory by index
export function handleMemoryForget(indexStr) {
  const idx = parseInt(indexStr) - 1;
  const memories = loadMemories();

  if (isNaN(idx) || idx < 0 || idx >= memories.length) {
    console.log(chalk.yellow(`\n  Usage: /memory forget <number> (1-${memories.length})`));
    return true;
  }

  const removed = memories.splice(idx, 1)[0];
  writeFileSync(join(MEMORY_DIR, 'memories.json'), JSON.stringify(memories, null, 2), 'utf-8');
  console.log(chalk.green(`\n  Forgot: "${removed.text}"`));
  return true;
}

// /memory clear — delete all memories
export function handleMemoryClear() {
  mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(join(MEMORY_DIR, 'memories.json'), '[]', 'utf-8');
  console.log(chalk.green('\n  All memories cleared.'));
  return true;
}

// /compact — force conversation compaction
export async function handleCompact() {
  if (!conversationRef) {
    console.log(chalk.yellow('\n  No active conversation.'));
    return true;
  }

  const messages = conversationRef.getMessages();
  const compacted = await forceCompact(messages);
  if (compacted !== messages) {
    conversationRef.loadMessages(compacted);
  }
  return true;
}

// /save [name] — save current conversation to session file
export async function handleSave(nameArg) {
  if (!conversationRef) {
    console.log(chalk.yellow('\n  No active conversation.'));
    return true;
  }

  mkdirSync(SESSION_DIR, { recursive: true });

  const name = nameArg?.trim() || `session-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const filePath = join(SESSION_DIR, `${name}.json`);

  const messages = conversationRef.getMessages();
  const sessionData = {
    messages,
    savedAt: new Date().toISOString(),
    cwd: process.cwd(),
    model: '',
  };

  try {
    writeFileSync(filePath, JSON.stringify(sessionData, null, 2), 'utf-8');
    console.log(chalk.green(`\n  Session saved: ${filePath}`));
    return true;
  } catch (err) {
    console.log(chalk.red(`\n  Failed to save session: ${err.message}`));
    return true;
  }
}

// /resume [name] — list sessions or load a specific session
export async function handleResume(nameArg) {
  if (!conversationRef) {
    console.log(chalk.yellow('\n  No active conversation.'));
    return true;
  }

  mkdirSync(SESSION_DIR, { recursive: true });

  if (!nameArg?.trim()) {
    const files = readdirSync(SESSION_DIR).filter(f => f.endsWith('.json'));
    if (files.length === 0) {
      console.log(chalk.dim('\n  No saved sessions.'));
      return true;
    }

    console.log(chalk.green(`\n  Saved sessions (${files.length}):`));
    files.forEach((f, i) => {
      const name = f.slice(0, -5);
      const filePath = join(SESSION_DIR, f);
      try {
        const stat = statSync(filePath);
        const date = new Date(stat.mtime).toLocaleString();
        console.log(chalk.dim(`  ${i + 1}. `) + chalk.white(name) + chalk.dim(` (${date})`));
      } catch {
        console.log(chalk.dim(`  ${i + 1}. `) + chalk.white(name));
      }
    });
    console.log(chalk.dim(`\n  Use: /resume <name> to load a session`));
    return true;
  }

  const name = nameArg.trim();
  const filePath = join(SESSION_DIR, `${name}.json`);

  if (!existsSync(filePath)) {
    console.log(chalk.yellow(`\n  Session not found: ${name}`));
    return true;
  }

  try {
    const sessionData = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!Array.isArray(sessionData.messages) || sessionData.messages.length === 0) {
      console.log(chalk.red(`\n  Session file is corrupt or empty: ${name}`));
      return true;
    }
    conversationRef.loadMessages(sessionData.messages);
    console.log(chalk.green(`\n  Session loaded: ${name}`));
    console.log(chalk.dim(`  Restored ${sessionData.messages.length} messages`));
    return true;
  } catch (err) {
    console.log(chalk.red(`\n  Failed to load session: ${err.message}`));
    return true;
  }
}

// Load memories for injection into system prompt
export function loadMemories() {
  try {
    return JSON.parse(readFileSync(join(MEMORY_DIR, 'memories.json'), 'utf-8'));
  } catch {
    return [];
  }
}

export function getMemoryDir() {
  return MEMORY_DIR;
}

// /history [search] — browse past sessions
export function handleHistory(query) {
  mkdirSync(SESSION_DIR, { recursive: true });

  const files = readdirSync(SESSION_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.log(chalk.dim('\n  No conversation history.'));
    return true;
  }

  const sessions = [];
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(SESSION_DIR, file), 'utf-8'));
      const name = file.slice(0, -5);
      const msgCount = data.messages?.length || 0;
      const date = data.savedAt ? new Date(data.savedAt).toLocaleString() : 'unknown';
      const cwd = data.cwd || '';

      const firstUser = data.messages?.find(m => m.role === 'user');
      const preview = firstUser?.content?.slice(0, 60) || '(no messages)';

      sessions.push({ name, msgCount, date, cwd, preview });
    } catch {
      /* skip corrupt files */
    }
  }

  let filtered = sessions;
  if (query?.trim()) {
    const q = query.trim().toLowerCase();
    filtered = sessions.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.preview.toLowerCase().includes(q) ||
      s.cwd.toLowerCase().includes(q)
    );
  }

  if (filtered.length === 0) {
    console.log(chalk.dim(`\n  No sessions matching "${query}".`));
    return true;
  }

  console.log(chalk.green(`\n  History (${filtered.length} sessions):`));
  console.log('');
  for (const s of filtered.slice(0, 20)) {
    console.log(chalk.white(`  ${s.name}`));
    console.log(chalk.dim(`    ${s.date} · ${s.msgCount} messages · ${s.preview}`));
  }
  if (filtered.length > 20) {
    console.log(chalk.dim(`\n  ... and ${filtered.length - 20} more. Use /history <search> to filter.`));
  }
  console.log(chalk.dim(`\n  Use /resume <name> to load a session.`));
  return true;
}

// /help — show available commands
export function handleHelp() {
  console.log(chalk.green('\n  Danu Commands:'));
  console.log(chalk.dim('  ─────────────────────────────────────'));
  console.log('  /init            Create a DANUCODE.md in current directory');
  console.log('  /mode [name]     Switch mode or list modes');
  console.log('  /undo            Undo last file change');
  console.log('  /redo            Redo last undone change');
  console.log('  /compact         Compact conversation history');
  console.log('  /clear           Clear conversation and start fresh');
  console.log('  /context         Show token usage and context window');
  console.log('  /save [name]     Save current session (default: timestamp)');
  console.log('  /resume [name]   Load a session or list all sessions');
  console.log('  /history [search] Browse past sessions');
  console.log('  /memory save <t> Remember something across sessions');
  console.log('  /memory list     Show all saved memories');
  console.log('  /memory forget N Forget memory number N');
  console.log('  /memory clear    Clear all memories');
  console.log('  /model [name]    Show or change current model');
  console.log('  /pr [number]     View PR details or list open PRs');
  console.log('  /test            Run project tests (npm test)');
  console.log('  /plan            Toggle plan mode on/off');
  console.log('  /yolo            Toggle permissions on/off');
  console.log('  /help            Show this help');
  console.log('  /exit            Quit Danu');
  console.log('');
  return true;
}

// Route slash commands — returns true if handled, false if not a command
export async function handleCommand(input, conversation) {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();

  if (lower === '/init') return handleInit();
  if (lower === '/help') return handleHelp();
  if (lower.startsWith('/model')) {
    const modelName = trimmed.slice('/model'.length).trim();
    if (!modelName) {
      const cfg = getConfig();
      console.log(chalk.green(`\n  Current model: `) + chalk.white(cfg.model));
      console.log(chalk.dim('  Use: /model <name> to switch'));
      return true;
    }
    setModel(modelName);
    console.log(chalk.green(`\n  Model changed to: `) + chalk.white(modelName));
    return true;
  }
  if (lower.startsWith('/mode')) {
    const modeName = trimmed.slice('/mode'.length).trim();
    if (!modeName) {
      // List modes
      const modes = listModes();
      console.log(chalk.green('\n  Modes:'));
      for (const m of modes) {
        const indicator = m.active ? chalk.green('● ') : chalk.dim('○ ');
        const name = m.active ? chalk.bold(m.name) : m.name;
        console.log(`  ${indicator}${name} — ${chalk.dim(m.description)}`);
      }
      console.log(chalk.dim(`\n  Use: /mode <name> to switch`));
      return true;
    }
    const result = setMode(modeName);
    if (!result.ok) {
      console.log(chalk.yellow(`\n  ${result.error}`));
    } else {
      const mode = result.mode;
      const colorFn = chalk[mode.color] || chalk.white;
      console.log(colorFn(`\n  Switched to ${mode.name} mode`));
      console.log(chalk.dim(`  ${mode.description}`));
    }
    return true;
  }
  if (lower === '/plan') {
    if (isPlanMode()) {
      const { exitPlanMode } = await import('./planmode.js');
      exitPlanMode();
    } else {
      enterPlanMode();
    }
    return true;
  }
  if (lower === '/yolo') {
    const current = getSkipPermissions();
    setSkipPermissions(!current);
    if (!current) {
      console.log(chalk.yellow('\n  ⏵⏵ Permissions OFF — yolo mode'));
    } else {
      console.log(chalk.green('\n  ⏵ Permissions ON'));
    }
    return true;
  }
  if (lower === '/undo') {
    const result = undo();
    if (result.ok) {
      console.log(chalk.green(`\n  ${result.message}`));
    } else {
      console.log(chalk.yellow(`\n  ${result.error}`));
    }
    return true;
  }
  if (lower === '/redo') {
    const result = redo();
    if (result.ok) {
      console.log(chalk.green(`\n  ${result.message}`));
    } else {
      console.log(chalk.yellow(`\n  ${result.error}`));
    }
    return true;
  }
  if (lower === '/test') {
    try {
      const { execSync } = await import('node:child_process');
      console.log(chalk.dim('\n  Running tests...\n'));
      const output = execSync('npm test', { encoding: 'utf-8', cwd: process.cwd(), timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(output);
    } catch (err) {
      console.log(err.stdout || '');
      console.log(chalk.red(err.stderr || `Tests failed (exit code ${err.status})`));
    }
    return true;
  }
  if (lower === '/compact') return await handleCompact();
  if (lower === '/clear') {
    if (!conversationRef) {
      console.log(chalk.yellow('\n  No active conversation.'));
      return true;
    }
    const { buildSystemPrompt } = await import('./system-prompt.js');
    conversationRef.loadMessages([{ role: 'system', content: buildSystemPrompt() }]);
    console.log(chalk.green('\n  Conversation cleared.'));
    return true;
  }
  if (lower === '/context') {
    if (!conversationRef) {
      console.log(chalk.yellow('\n  No active conversation.'));
      return true;
    }
    const { estimateTokens } = await import('./context.js');
    const messages = conversationRef.getMessages();
    const total = estimateTokens(messages);

    let systemTokens = 0, userTokens = 0, assistantTokens = 0, toolTokens = 0;
    for (const m of messages) {
      const len = (typeof m.content === 'string' ? m.content.length : 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
      const tokens = Math.ceil(len / 4);
      if (m.role === 'system') systemTokens += tokens;
      else if (m.role === 'user') userTokens += tokens;
      else if (m.role === 'assistant') assistantTokens += tokens;
      else if (m.role === 'tool') toolTokens += tokens;
    }

    console.log(chalk.green('\n  Context Usage'));
    console.log(chalk.dim(`  Total: ~${(total/1000).toFixed(1)}k tokens · ${messages.length} messages`));
    console.log(chalk.dim(`  System:    ~${(systemTokens/1000).toFixed(1)}k`));
    console.log(chalk.dim(`  User:      ~${(userTokens/1000).toFixed(1)}k`));
    console.log(chalk.dim(`  Assistant: ~${(assistantTokens/1000).toFixed(1)}k`));
    console.log(chalk.dim(`  Tool:      ~${(toolTokens/1000).toFixed(1)}k`));

    const { getConfig } = await import('./api.js');
    const config = getConfig();
    const maxTokens = config?.max_context_tokens || 120000;
    const pct = Math.round((total / maxTokens) * 100);
    const barLen = 30;
    const filled = Math.round(barLen * pct / 100);
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
    const color = pct > 80 ? chalk.red : pct > 50 ? chalk.yellow : chalk.green;
    console.log(`  ${color(bar)} ${pct}% of ${(maxTokens/1000).toFixed(0)}k`);
    console.log('');
    return true;
  }
  if (lower === '/memory list' || lower === '/memories') return handleMemoryList();
  if (lower === '/memory clear') return handleMemoryClear();

  if (lower.startsWith('/memory save ')) {
    return handleMemorySave(trimmed.slice('/memory save '.length));
  }
  if (lower.startsWith('/memory forget ')) {
    return handleMemoryForget(trimmed.slice('/memory forget '.length));
  }
  if (lower.startsWith('/save')) {
    const nameArg = trimmed.slice('/save'.length).trim();
    return await handleSave(nameArg);
  }
  if (lower.startsWith('/resume')) {
    const nameArg = trimmed.slice('/resume'.length).trim();
    return await handleResume(nameArg);
  }
  if (lower.startsWith('/history')) {
    const query = trimmed.slice('/history'.length).trim();
    return handleHistory(query || null);
  }
  if (lower.startsWith('/pr')) {
    const prArg = trimmed.slice('/pr'.length).trim();
    if (!prArg) {
      const { listPRs, isGhAvailable } = await import('./github.js');
      if (!isGhAvailable()) {
        console.log(chalk.yellow('\n  gh CLI not installed.'));
        return true;
      }
      const result = listPRs();
      try {
        const prs = JSON.parse(result);
        console.log(chalk.green(`\n  Open PRs (${prs.length}):`));
        for (const pr of prs) {
          console.log(`  #${pr.number} ${pr.title} ${chalk.dim(`(${pr.headRefName})`)}`);
        }
      } catch {
        console.log(chalk.dim(`\n  ${result}`));
      }
      return true;
    }
    const { getPR, isGhAvailable } = await import('./github.js');
    if (!isGhAvailable()) {
      console.log(chalk.yellow('\n  gh CLI not installed.'));
      return true;
    }
    console.log(chalk.dim(`\n  ${getPR(prArg)}`));
    return true;
  }

  // Not a known command
  if (lower.startsWith('/') && !lower.startsWith('/exit') && !lower.startsWith('/quit')) {
    console.log(chalk.yellow(`\n  Unknown command: ${trimmed.split(' ')[0]}. Type /help for commands.`));
    return true;
  }

  return false;
}
