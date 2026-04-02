// Danucode Console — HTTP + WebSocket server
// Plain Node http.createServer + ws. No Express.

import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { setSkipPermissions, getSkipPermissions, setPermissionHandler } from './permissions.js';
import { isPlanMode } from './planmode.js';
import { getCurrentMode, getModeConfig, setMode } from './modes.js';
import { getConfig, setModel } from './api.js';
import { addListener, classifyToolRisk } from './event-adapter.js';
import { execSync } from 'node:child_process';

// Backend adapters
import * as danuAdapter from './adapters/danucode.js';
import * as claudeAdapter from './adapters/claude-code.js';
import * as opencodeAdapter from './adapters/opencode.js';

const ADAPTERS = {
  danucode: danuAdapter,
  'claude-code': claudeAdapter,
  opencode: opencodeAdapter,
};

function getAdapter(backendId) {
  return ADAPTERS[backendId] || danuAdapter;
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CONSOLE_DIR = join(__dirname, '..', 'console');

// MIME types for static file serving
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Session store: tabId -> session object
const sessions = new Map();
const pendingPermissions = new Map();

let nextTabId = 1;

function generateTabId() {
  return `tab-${nextTabId++}`;
}

function getGitBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function getGitModifiedCount(cwd) {
  try {
    const out = execSync('git status --porcelain', { cwd, stdio: 'pipe', encoding: 'utf-8' });
    return out.trim().split('\n').filter(l => l.trim()).length;
  } catch {
    return 0;
  }
}

function buildStatusForSession(session) {
  const adapter = getAdapter(session.backend);
  const adapterStatus = adapter.getStatus ? adapter.getStatus(session.adapterSession, session.cwd) : {};

  return {
    cwd: session.cwd,
    backend: session.backend || 'danucode',
    supervision: session.supervision || 'deep',
    model: adapterStatus.model || 'unknown',
    provider: adapterStatus.provider || 'local',
    mode: adapterStatus.mode || getCurrentMode(),
    approvalMode: getSkipPermissions() ? 'yolo' : 'perms-on',
    shellAllowed: adapterStatus.shellAllowed !== undefined ? adapterStatus.shellAllowed : true,
    editAllowed: adapterStatus.editAllowed !== undefined ? adapterStatus.editAllowed : true,
    gitBranch: session.gitBranch || '',
    modifiedCount: session.modifiedCount || 0,
    tokenEstimate: adapterStatus.tokenEstimate || 0,
    maxTokens: adapterStatus.maxTokens || 64000,
    filesEdited: adapterStatus.filesEdited || 0,
  };
}

function createSession(cwd, backendId, backendConfig) {
  const tabId = generateTabId();
  const resolvedCwd = resolve(cwd || process.cwd());
  const backend = backendId || 'danucode';
  const adapter = getAdapter(backend);
  const adapterSession = adapter.createSession(tabId, resolvedCwd, backendConfig || {});

  const session = {
    id: tabId,
    cwd: resolvedCwd,
    backend,
    supervision: adapter.meta?.supervision || 'standard',
    adapterSession,
    busy: false,
    created: new Date().toISOString(),
    gitBranch: getGitBranch(resolvedCwd),
    modifiedCount: getGitModifiedCount(resolvedCwd),
  };
  sessions.set(tabId, session);

  // Wire permission handler for Danucode native backend
  if (backend === 'danucode') {
    const permHandler = (toolName, args) => {
      if (getSkipPermissions()) return Promise.resolve('y');

      const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const detail = toolName === 'Bash' ? args.command : args.file_path || toolName;
      broadcastToClients({
        type: 'permission-request',
        tabId: session.id,
        requestId,
        toolName,
        detail,
        risk: classifyToolRisk(toolName, args),
        timestamp: new Date().toISOString(),
        category: 'status',
      });
      return new Promise((resolve) => {
        pendingPermissions.set(requestId, { resolve });
        setTimeout(() => {
          if (pendingPermissions.has(requestId)) {
            pendingPermissions.delete(requestId);
            resolve('n');
          }
        }, 60000);
      });
    };
    setPermissionHandler(permHandler);
  }

  saveGuiState();
  return session;
}

function destroySession(tabId) {
  const session = sessions.get(tabId);
  if (!session) return false;
  const adapter = getAdapter(session.backend);
  if (adapter.destroySession) adapter.destroySession(session.adapterSession);
  sessions.delete(tabId);
  broadcastToClients({ type: 'session-closed', tabId, timestamp: new Date().toISOString(), category: 'status' });
  saveGuiState();
  return true;
}

// WebSocket clients
const wsClients = new Set();

function broadcastToClients(event) {
  const data = JSON.stringify(event);
  for (const ws of wsClients) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(data);
    }
  }
}

// Register event-adapter listener to forward all events to WebSocket clients
addListener((event) => {
  broadcastToClients(event);
});

// HTTP request handler
function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API Routes ---

  if (path === '/health' && req.method === 'GET') {
    json(res, 200, { status: 'ok', version: '0.4.0' });
    return;
  }

  if (path === '/browse' && req.method === 'GET') {
    const { readdirSync, statSync } = await import('node:fs');
    const requestedPath = url.searchParams.get('path') || process.cwd();
    const resolved = resolve(requestedPath);
    try {
      const entries = readdirSync(resolved, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      const parent = resolve(resolved, '..');
      json(res, 200, { current: resolved, parent: parent !== resolved ? parent : null, dirs });
    } catch (err) {
      json(res, 400, { error: `Cannot read directory: ${err.message}`, current: resolved });
    }
    return;
  }

  if (path === '/backends' && req.method === 'GET') {
    const list = Object.values(ADAPTERS).map(a => ({
      id: a.meta.id,
      name: a.meta.name,
      supervision: a.meta.supervision,
      description: a.meta.description,
    }));
    json(res, 200, list);
    return;
  }

  if (path === '/config' && req.method === 'GET') {
    const cfg = getConfig() || {};
    // Detect provider from base_url
    let provider = 'local';
    const baseUrl = (cfg.base_url || '').toLowerCase();
    if (baseUrl.includes('anthropic.com')) provider = 'anthropic';
    else if (baseUrl.includes('openai.com')) provider = 'openai';
    else if (cfg.provider) provider = cfg.provider;
    else if (cfg.api_key && cfg.api_key !== 'none') provider = 'openai-compatible';

    // Mask API key — show last 4 chars only
    let maskedKey = '';
    if (cfg.api_key && cfg.api_key.length > 4) {
      maskedKey = '****' + cfg.api_key.slice(-4);
    }

    json(res, 200, {
      provider,
      model: cfg.model || '',
      base_url: cfg.base_url || '',
      maskedKey,
      mode: getCurrentMode(),
      approvalMode: getSkipPermissions() ? 'yolo' : 'ask-every-time',
      timeout: cfg.timeout || 300000,
    });
    return;
  }

  if (path === '/settings' && req.method === 'POST') {
    readBody(req).then(body => {
      const results = {};
      if (body.mode) {
        const r = setMode(body.mode);
        results.mode = r;
      }
      if (body.approvalMode !== undefined) {
        const skip = body.approvalMode === 'yolo';
        setSkipPermissions(skip);
        results.approvalMode = skip ? 'yolo' : 'ask-every-time';
      }
      if (body.model) {
        setModel(body.model);
        results.model = body.model;
      }
      if (body.api_key) {
        const cfg = getConfig();
        if (cfg) cfg.api_key = body.api_key;
        // Persist to credentials file
        try {
          mkdirSync(join(homedir(), '.danu'), { recursive: true });
          writeFileSync(join(homedir(), '.danu', 'credentials.json'), JSON.stringify({ api_key: body.api_key }), 'utf-8');
        } catch { /* best effort */ }
        results.api_key = 'updated';
      }
      // Broadcast updated status to all clients
      for (const [tabId, session] of sessions) {
        const status = buildStatusForSession(session);
        broadcastToClients({ type: 'status', tabId, timestamp: new Date().toISOString(), category: 'status', ...status });
      }
      json(res, 200, results);
    }).catch(err => json(res, 400, { error: err.message }));
    return;
  }

  if (path === '/test-connection' && req.method === 'POST') {
    const cfg = getConfig();
    fetch(`${cfg.base_url}/models`, {
      headers: { 'Authorization': `Bearer ${cfg.api_key}` },
      signal: AbortSignal.timeout(5000),
    }).then(r => {
      json(res, 200, { ok: r.ok, status: r.status });
    }).catch(err => {
      json(res, 200, { ok: false, error: err.message });
    });
    return;
  }

  if (path === '/sessions' && req.method === 'GET') {
    const list = Array.from(sessions.values()).map(s => ({
      id: s.id,
      cwd: s.cwd,
      backend: s.backend || 'danucode',
      supervision: s.supervision || 'deep',
      created: s.created,
      busy: s.busy,
    }));
    json(res, 200, list);
    return;
  }

  if (path === '/sessions' && req.method === 'POST') {
    readBody(req).then(body => {
      const cwd = body.cwd || process.cwd();
      const backend = body.backend || 'danucode';
      const backendConfig = body.backendConfig || {};
      const session = createSession(cwd, backend, backendConfig);

      // Send initial status
      const status = buildStatusForSession(session);
      broadcastToClients({
        type: 'status',
        tabId: session.id,
        timestamp: new Date().toISOString(),
        category: 'status',
        ...status,
      });

      json(res, 201, { id: session.id, backend, supervision: session.supervision });
    }).catch(err => {
      json(res, 400, { error: err.message });
    });
    return;
  }

  // Session-specific routes
  const sessionMatch = path.match(/^\/sessions\/([^/]+)\/(.+)$/);
  const sessionIdOnly = path.match(/^\/sessions\/([^/]+)$/);

  if (sessionMatch) {
    const [, tabId, action] = sessionMatch;
    const session = sessions.get(tabId);
    if (!session) {
      json(res, 404, { error: 'Session not found' });
      return;
    }

    if (action === 'message' && req.method === 'POST') {
      readBody(req).then(async (body) => {
        if (!body.message) {
          json(res, 400, { error: 'message required' });
          return;
        }
        json(res, 202, { status: 'accepted' });

        // Process asynchronously
        session.busy = true;
        broadcastToClients({ type: 'busy', tabId, busy: true, timestamp: new Date().toISOString(), category: 'status' });

        const adapter = getAdapter(session.backend);
        await adapter.sendMessage(session.adapterSession, body.message, session._permHandler);

        session.busy = false;
        session.gitBranch = getGitBranch(session.cwd);
        session.modifiedCount = getGitModifiedCount(session.cwd);

        // Send updated status
        const status = buildStatusForSession(session);
        broadcastToClients({
          type: 'status',
          tabId,
          timestamp: new Date().toISOString(),
          category: 'status',
          ...status,
        });
        broadcastToClients({ type: 'busy', tabId, busy: false, timestamp: new Date().toISOString(), category: 'status' });
      }).catch(err => {
        session.busy = false;
        broadcastToClients({
          type: 'error',
          tabId,
          timestamp: new Date().toISOString(),
          category: 'warning',
          message: err.message,
        });
      });
      return;
    }

    if (action === 'stop' && req.method === 'POST') {
      const adapter = getAdapter(session.backend);
      adapter.stopSession(session.adapterSession);
      json(res, 200, { status: 'stopped' });
      return;
    }

    if (action === 'command' && req.method === 'POST') {
      readBody(req).then(async (body) => {
        if (!body.command) {
          json(res, 400, { error: 'command required' });
          return;
        }
        setConversationRef(session.conversation);
        const handled = await handleCommand(body.command, session.conversation);
        json(res, 200, { handled });
      }).catch(err => {
        json(res, 400, { error: err.message });
      });
      return;
    }

    if (action === 'status' && req.method === 'GET') {
      const status = buildStatusForSession(session);
      json(res, 200, { type: 'status', tabId, ...status });
      return;
    }

    json(res, 404, { error: 'Unknown action' });
    return;
  }

  if (sessionIdOnly && req.method === 'DELETE') {
    const tabId = sessionIdOnly[1];
    const destroyed = destroySession(tabId);
    if (destroyed) {
      res.writeHead(204);
      res.end();
    } else {
      json(res, 404, { error: 'Session not found' });
    }
    return;
  }

  // --- Static File Serving ---
  serveStatic(path, res);
}

function serveStatic(urlPath, res) {
  let filePath;
  if (urlPath === '/' || urlPath === '') {
    filePath = join(CONSOLE_DIR, 'index.html');
  } else {
    filePath = join(CONSOLE_DIR, urlPath);
  }

  // Prevent directory traversal
  const resolved = resolve(filePath);
  if (!resolved.startsWith(resolve(CONSOLE_DIR))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!existsSync(resolved)) {
    // SPA fallback
    if (!extname(urlPath)) {
      filePath = join(CONSOLE_DIR, 'index.html');
    } else {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
  }

  try {
    const content = readFileSync(filePath);
    const ext = extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch {
    res.writeHead(500);
    res.end('Internal server error');
  }
}

// Utility functions
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        resolve(body);
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// PID file for background process management
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

const PID_DIR = join(homedir(), '.danu');
const PID_FILE = join(PID_DIR, 'console.pid');
const STATE_FILE = join(PID_DIR, 'console.json');
const GUI_STATE_FILE = join(PID_DIR, 'gui-state.json');

function writePidFile(port) {
  try {
    mkdirSync(PID_DIR, { recursive: true });
    writeFileSync(PID_FILE, String(process.pid), 'utf-8');
    writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port, started: new Date().toISOString() }), 'utf-8');
  } catch { /* best effort */ }
}

function removePidFile() {
  try { unlinkSync(PID_FILE); } catch { /* already gone */ }
  try { unlinkSync(STATE_FILE); } catch { /* already gone */ }
}

// GUI session persistence — save/restore tab state across restarts
function saveGuiState() {
  try {
    const tabs = Array.from(sessions.values()).map(s => ({ id: s.id, cwd: s.cwd, backend: s.backend || 'danucode' }));
    mkdirSync(PID_DIR, { recursive: true });
    writeFileSync(GUI_STATE_FILE, JSON.stringify({ tabs, savedAt: new Date().toISOString() }), 'utf-8');
  } catch { /* best effort */ }
}

function loadGuiState() {
  try {
    const data = JSON.parse(readFileSync(GUI_STATE_FILE, 'utf-8'));
    if (Array.isArray(data.tabs)) {
      for (const tab of data.tabs) {
        if (tab.cwd) createSession(tab.cwd, tab.backend || 'danucode');
      }
    }
  } catch { /* no state to restore */ }
}

// Read the saved console state (port, pid)
export function readConsoleState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

// Check if the console server is already running
export function isConsoleRunning() {
  const st = readConsoleState();
  if (!st || !st.pid) return false;
  try {
    process.kill(st.pid, 0); // signal 0 = just check if alive
    return true;
  } catch {
    // Process is dead, clean up stale PID file
    removePidFile();
    return false;
  }
}

// Stop a running console server
export function stopConsole() {
  const st = readConsoleState();
  let killed = false;

  // Try PID file first
  if (st && st.pid) {
    try {
      process.kill(st.pid, 0);
      process.kill(st.pid);
      killed = true;
    } catch { /* already dead */ }
  }

  // Fallback: find and kill any node process on the console port
  const port = (st && st.port) || 3000;
  try {
    const out = execSync(`netstat -ano | findstr ":${port} " | findstr "LISTENING"`, { stdio: 'pipe', encoding: 'utf-8' });
    const pids = new Set();
    for (const line of out.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);
      if (pid && pid !== process.pid) pids.add(pid);
    }
    for (const pid of pids) {
      try {
        process.kill(pid);
        killed = true;
      } catch { /* already gone */ }
    }
  } catch { /* netstat failed or no matches */ }

  removePidFile();

  if (killed) {
    return { ok: true, pid: st?.pid, port };
  }
  return { ok: false, reason: 'No console running' };
}

// Start server (foreground — called by the detached child or by --serve)
export async function startServer(options = {}) {
  const port = options.port || 3000;
  const openBrowser = options.openBrowser !== false;

  // Restore previous sessions
  loadGuiState();

  const server = createServer(handleRequest);

  // WebSocket server
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    wsClients.add(ws);

    // Send current sessions on connect
    const sessionList = Array.from(sessions.values()).map(s => ({
      type: 'session-info',
      tabId: s.id,
      cwd: s.cwd,
      backend: s.backend || 'danucode',
      supervision: s.supervision || 'deep',
      busy: s.busy,
      created: s.created,
      timestamp: new Date().toISOString(),
      category: 'status',
    }));
    for (const info of sessionList) {
      ws.send(JSON.stringify(info));
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'permission-response' && msg.requestId) {
          const pending = pendingPermissions.get(msg.requestId);
          if (pending) {
            pendingPermissions.delete(msg.requestId);
            pending.resolve(msg.answer || 'n');
          }
        }
      } catch { /* ignore invalid messages */ }
    });

    ws.on('close', () => {
      wsClients.delete(ws);
    });

    ws.on('error', () => {
      wsClients.delete(ws);
    });
  });

  // Clean up PID file on exit
  const cleanup = () => { removePidFile(); };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Try next port
        server.listen(port + 1, '127.0.0.1', () => {
          const actualPort = server.address().port;
          writePidFile(actualPort);
          console.log(`  Danucode Console running on http://localhost:${actualPort}`);
          if (openBrowser) launchBrowser(actualPort);
          resolve({ server, wss, port: actualPort });
        });
      } else {
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      writePidFile(actualPort);
      console.log(`  Danucode Console running on http://localhost:${actualPort}`);
      if (openBrowser) launchBrowser(actualPort);
      resolve({ server, wss, port: actualPort });
    });
  });
}

async function launchBrowser(port) {
  try {
    const open = (await import('open')).default;
    await open(`http://localhost:${port}`);
  } catch {
    console.log(`  Open http://localhost:${port} in your browser`);
  }
}
