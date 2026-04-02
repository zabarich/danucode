// Danucode Console — Frontend Application
// WebSocket client, multi-tab UI, activity feed, event filtering

(function () {
  'use strict';

  // ─── State ────────────────────────────────────────────────

  const state = {
    ws: null,
    tabs: new Map(),       // tabId -> tab state
    activeTabId: null,
    eventCounts: {},       // { read: 0, search: 0, edit: 0, shell: 0, response: 0 }
    activeFilters: new Set(['all']),
    transcriptOpen: false,
    fileTree: new Map(),   // path -> { status, depth }
    tasks: [],
  };

  function createTabState(tabId, cwd, backend, supervision) {
    return {
      id: tabId,
      cwd: cwd || '',
      backend: backend || 'danucode',
      supervision: supervision || 'deep',
      busy: false,
      events: [],
      transcript: [],
      activePath: null,
      activeRisk: null,
      fileTree: new Map(),
      tasks: [],
      status: {
        mode: 'code',
        model: '-',
        provider: '',
        approvalMode: 'perms-on',
        shellAllowed: true,
        editAllowed: true,
        gitBranch: '',
        modifiedCount: 0,
        tokenEstimate: 0,
        maxTokens: 64000,
        filesEdited: 0,
        backend: backend || 'danucode',
        supervision: supervision || 'deep',
      },
      eventCounts: { read: 0, search: 0, edit: 0, shell: 0, response: 0 },
      thinkingStart: null,
    };
  }

  // ─── DOM References ───────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    tabsContainer: $('#tabs-container'),
    btnNewTab: $('#btn-new-tab'),
    btnSettings: $('#btn-settings'),
    sidebarCwd: $('#sidebar-cwd'),
    fileTree: $('#file-tree'),
    taskPanel: $('#task-panel'),
    taskCount: $('#task-count'),
    activePath: $('#active-path'),
    eventFilter: $('#event-filter'),
    feed: $('#feed'),
    transcriptToggle: $('#transcript-toggle'),
    transcriptPane: $('#transcript-pane'),
    input: $('#input'),
    btnStop: $('#btn-stop'),
    btnKill: $('#btn-kill'),
    statusMode: $('#status-mode'),
    statusModel: $('#status-model'),
    statusPerms: $('#status-perms'),
    statusPermDot: $('#status-perm-dot'),
    statusPermDot2: $('#status-perm-dot2'),
    statusFiles: $('#status-files'),
    statusTokens: $('#status-tokens'),
    statusMaxTokens: $('#status-max-tokens'),
    contextFill: $('#context-fill'),
    settingsOverlay: $('#settings-overlay'),
    settingsClose: $('#settings-close'),
    newTabDialog: $('#new-tab-dialog'),
    newTabCwd: $('#new-tab-cwd'),
    newTabCreate: $('#new-tab-create'),
    newTabCancel: $('#new-tab-cancel'),
    killDialog: $('#kill-dialog'),
    killCancel: $('#kill-cancel'),
    killConfirm: $('#kill-confirm'),
  };

  // ─── WebSocket ────────────────────────────────────────────

  function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('WebSocket connected');
      // If no tabs exist, request session list
      if (state.tabs.size === 0) {
        // Server sends session-info events on connect
      }
    };

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        handleEvent(event);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected, reconnecting...');
      state.ws = null;
      setTimeout(connectWebSocket, 2000);
    };

    ws.onerror = () => {
      ws.close();
    };

    state.ws = ws;
  }

  // ─── Event Handling ───────────────────────────────────────

  function handleEvent(event) {
    const tabId = event.tabId;

    // Handle session-level events
    if (event.type === 'session-info') {
      if (!state.tabs.has(tabId)) {
        state.tabs.set(tabId, createTabState(tabId, event.cwd, event.backend, event.supervision));
        renderTabs();
        if (!state.activeTabId) switchTab(tabId);
      }
      return;
    }

    if (event.type === 'session-closed') {
      state.tabs.delete(tabId);
      if (state.activeTabId === tabId) {
        const remaining = Array.from(state.tabs.keys());
        if (remaining.length > 0) switchTab(remaining[0]);
        else state.activeTabId = null;
      }
      renderTabs();
      renderAll();
      return;
    }

    // Ensure tab exists
    if (!state.tabs.has(tabId)) {
      state.tabs.set(tabId, createTabState(tabId, ''));
      renderTabs();
    }

    const tab = state.tabs.get(tabId);

    // Process event by type
    switch (event.type) {
      case 'status':
        tab.status.mode = event.mode || tab.status.mode;
        tab.status.model = event.model || tab.status.model;
        tab.status.provider = event.provider || tab.status.provider;
        tab.status.approvalMode = event.approvalMode || tab.status.approvalMode;
        tab.status.shellAllowed = event.shellAllowed !== undefined ? event.shellAllowed : tab.status.shellAllowed;
        tab.status.editAllowed = event.editAllowed !== undefined ? event.editAllowed : tab.status.editAllowed;
        tab.status.gitBranch = event.gitBranch !== undefined ? event.gitBranch : tab.status.gitBranch;
        tab.status.modifiedCount = event.modifiedCount !== undefined ? event.modifiedCount : tab.status.modifiedCount;
        tab.status.tokenEstimate = event.tokenEstimate || tab.status.tokenEstimate;
        tab.status.maxTokens = event.maxTokens || tab.status.maxTokens;
        tab.status.filesEdited = event.filesEdited !== undefined ? event.filesEdited : tab.status.filesEdited;
        if (event.backend) { tab.backend = event.backend; tab.status.backend = event.backend; }
        if (event.supervision) { tab.supervision = event.supervision; tab.status.supervision = event.supervision; }
        tab.cwd = event.cwd || tab.cwd;
        if (tabId === state.activeTabId) renderStatus();
        break;

      case 'busy':
        tab.busy = event.busy;
        if (event.busy) {
          tab.thinkingStart = Date.now();
        } else {
          tab.thinkingStart = null;
          removeThinkingSpinner();
        }
        renderTabs();
        if (tabId === state.activeTabId) {
          if (event.busy) showThinkingSpinner();
        }
        break;

      case 'tool-start':
        tab.activePath = event.detail || event.tool;
        tab.activeRisk = event.risk;
        trackEventCount(tab, event.category);
        tab.events.push(event);
        trackFileInTree(tab, event);
        if (tabId === state.activeTabId) {
          renderActivePath();
          appendActivityItem(event);
          updateFilterCounts();
        }
        break;

      case 'tool-output':
        tab.events.push(event);
        if (tabId === state.activeTabId) appendActivityItem(event);
        break;

      case 'tool-done':
        tab.events.push(event);
        if (tabId === state.activeTabId) appendActivityItem(event);
        break;

      case 'text':
        trackEventCount(tab, 'response');
        tab.events.push(event);
        if (tabId === state.activeTabId) appendTextEvent(event);
        break;

      case 'text-done':
        tab.events.push(event);
        if (tabId === state.activeTabId) finalizeTextBlock();
        break;

      case 'task-update':
        tab.tasks = event.tasks || [];
        if (tabId === state.activeTabId) renderTasks(tab);
        break;

      case 'thinking':
        tab.events.push(event);
        if (tabId === state.activeTabId) updateThinkingSpinner(event.elapsed, event.phrase);
        break;

      case 'interrupted':
        tab.busy = false;
        tab.thinkingStart = null;
        tab.activePath = null;
        tab.activeRisk = null;
        tab.events.push(event);
        renderTabs();
        if (tabId === state.activeTabId) {
          removeThinkingSpinner();
          appendSystemMessage('Interrupted');
          renderActivePath();
        }
        break;

      case 'error':
        tab.events.push(event);
        if (tabId === state.activeTabId) appendErrorMessage(event.message);
        break;

      case 'permission-request':
        showPermissionDialog(event);
        break;
    }

    // Log to transcript
    tab.transcript.push(event);
    if (tabId === state.activeTabId && state.transcriptOpen) {
      appendTranscriptEntry(event);
    }
  }

  function trackEventCount(tab, category) {
    if (category in tab.eventCounts) {
      tab.eventCounts[category]++;
    }
  }

  function trackFileInTree(tab, event) {
    if (!event.detail) return;
    const path = event.detail;
    // Only track file paths (not commands, patterns, etc.)
    if (!path.includes('/') && !path.includes('\\')) return;
    if (path.startsWith('$') || path.startsWith('"')) return;

    const status = event.category === 'edit' ? 'edited'
      : event.category === 'read' ? 'reading'
      : event.category === 'search' ? 'reading'
      : 'reading';

    tab.fileTree.set(path, { status, timestamp: Date.now() });
    if (event.tabId === state.activeTabId) renderFileTree(tab);
  }

  // ─── Tab Management ───────────────────────────────────────

  async function createNewTab(cwd, backend) {
    try {
      const res = await fetch('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, backend: backend || 'danucode' }),
      });
      const data = await res.json();
      const tabState = createTabState(data.id, cwd, data.backend, data.supervision);
      state.tabs.set(data.id, tabState);
      renderTabs();
      switchTab(data.id);
    } catch (err) {
      console.error('Failed to create session:', err);
    }
  }

  async function closeTab(tabId) {
    try {
      await fetch(`/sessions/${tabId}`, { method: 'DELETE' });
    } catch { /* ignore */ }
    state.tabs.delete(tabId);
    if (state.activeTabId === tabId) {
      const remaining = Array.from(state.tabs.keys());
      if (remaining.length > 0) switchTab(remaining[0]);
      else {
        state.activeTabId = null;
        renderAll();
      }
    }
    renderTabs();
  }

  function switchTab(tabId) {
    state.activeTabId = tabId;
    renderTabs();
    renderAll();
  }

  const BACKEND_LABELS = {
    'danucode': 'danu',
    'claude-code': 'claude',
    'opencode': 'ocode',
  };

  function renderTabs() {
    dom.tabsContainer.innerHTML = '';
    for (const [tabId, tab] of state.tabs) {
      const btn = document.createElement('button');
      btn.className = 'tab' + (tabId === state.activeTabId ? ' active' : '');
      const dotClass = tab.busy ? 'busy' : 'idle';
      const dirName = tab.cwd ? tab.cwd.replace(/\\/g, '/').split('/').pop() : tabId;
      const mode = tab.status.mode || 'code';
      const backendLabel = BACKEND_LABELS[tab.backend] || tab.backend || 'danu';
      btn.innerHTML = `<span class="dot ${dotClass}"></span>${esc(dirName)}<span class="mode-badge">${esc(backendLabel)}</span><span class="mode-badge">${esc(mode)}</span><span class="tab-close" data-tab="${esc(tabId)}">&times;</span>`;
      btn.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close')) {
          e.stopPropagation();
          closeTab(tabId);
          return;
        }
        switchTab(tabId);
      });
      dom.tabsContainer.appendChild(btn);
    }
  }

  // ─── Rendering ────────────────────────────────────────────

  function renderAll() {
    const tab = state.tabs.get(state.activeTabId);
    if (!tab) {
      dom.sidebarCwd.textContent = '';
      dom.fileTree.innerHTML = '<div class="file-tree-empty">No active session</div>';
      dom.taskPanel.innerHTML = '<div class="task-empty">No tasks</div>';
      dom.taskCount.textContent = '0/0';
      dom.activePath.innerHTML = '<span class="idle-text">No active session</span>';
      dom.feed.innerHTML = '<div class="activity-feed-empty">Create a session to get started</div>';
      dom.transcriptPane.innerHTML = '';
      return;
    }

    dom.sidebarCwd.textContent = tab.cwd;
    renderFileTree(tab);
    renderTasks(tab);
    renderActivePath();
    renderActivityFeed(tab);
    renderTranscript(tab);
    renderStatus();
    updateFilterCounts();
  }

  function renderFileTree(tab) {
    if (tab.fileTree.size === 0) {
      dom.fileTree.innerHTML = '<div class="file-tree-empty">Agent will populate files as they are accessed</div>';
      return;
    }

    // Group files by directory, show lazily expanded tree
    const entries = Array.from(tab.fileTree.entries())
      .sort((a, b) => a[0].localeCompare(b[0]));

    const html = [];
    const seenDirs = new Set();

    for (const [path, info] of entries) {
      const normalized = path.replace(/\\/g, '/');
      const parts = normalized.split('/');
      const fileName = parts.pop();
      const dirPath = parts.join('/');

      // Render directory entries we haven't seen
      let accumDir = '';
      for (const part of parts) {
        accumDir += (accumDir ? '/' : '') + part;
        if (!seenDirs.has(accumDir)) {
          seenDirs.add(accumDir);
          const depth = accumDir.split('/').length - 1;
          const indent = '<span class="indent"></span>'.repeat(Math.min(depth, 4));
          html.push(`<div class="file-item" title="${esc(accumDir)}">${indent}<span class="icon">&#128193;</span><span class="name">${esc(part)}/</span></div>`);
        }
      }

      // Fade reading status after 10s
      let status = info.status;
      if (status === 'reading' && Date.now() - info.timestamp > 10000) {
        status = '';
      }

      const depth = parts.length;
      const indent = '<span class="indent"></span>'.repeat(Math.min(depth, 4));
      const cls = status ? ` ${status}` : '';
      html.push(`<div class="file-item${cls}" title="${esc(path)}">${indent}<span class="icon">&#128196;</span><span class="name">${esc(fileName)}</span></div>`);
    }

    dom.fileTree.innerHTML = html.join('');
  }

  function renderTasks(tab) {
    if (!tab.tasks || tab.tasks.length === 0) {
      dom.taskPanel.innerHTML = '<div class="task-empty">No tasks yet</div>';
      dom.taskCount.textContent = '0/0';
      return;
    }

    const completed = tab.tasks.filter(t => t.status === 'completed').length;
    dom.taskCount.textContent = `${completed}/${tab.tasks.length}`;

    const html = tab.tasks.map(t => {
      const iconCls = t.status === 'completed' ? 'completed'
        : t.status === 'in_progress' ? 'in-progress'
        : t.status === 'blocked' ? 'blocked'
        : 'pending';
      const icon = t.status === 'completed' ? '&#9632;'
        : t.status === 'in_progress' ? '&#9658;'
        : t.status === 'blocked' ? '&#8856;'
        : '&#9633;';
      const descCls = t.status === 'in_progress' ? ' active' : '';
      return `<div class="task-item"><span class="task-icon ${iconCls}">${icon}</span><span class="task-desc${descCls}">${esc(t.description)}</span></div>`;
    }).join('');

    dom.taskPanel.innerHTML = html;
  }

  function renderActivePath() {
    const tab = state.tabs.get(state.activeTabId);
    if (!tab || !tab.activePath) {
      dom.activePath.className = 'active-path';
      dom.activePath.innerHTML = '<span class="idle-text">Idle</span>';
      return;
    }

    const riskClass = tab.activeRisk ? `risk-${tab.activeRisk}` : '';
    dom.activePath.className = `active-path ${riskClass}`;

    // Check if path is outside workspace
    const cwd = tab.cwd.replace(/\\/g, '/').toLowerCase();
    const pathNorm = tab.activePath.replace(/\\/g, '/').toLowerCase();
    const isOutside = cwd && pathNorm.includes('/') && !pathNorm.startsWith(cwd);
    const outsideHtml = isOutside ? ' <span class="outside-warning">OUTSIDE CWD</span>' : '';

    dom.activePath.innerHTML = `<span class="path-text">${esc(tab.activePath)}</span>${outsideHtml}`;
  }

  function renderActivityFeed(tab) {
    dom.feed.innerHTML = '';
    if (tab.events.length === 0) {
      dom.feed.innerHTML = '<div class="activity-feed-empty">Send a message to get started</div>';
      return;
    }

    // Re-render all events for this tab
    let currentTextBlock = null;
    for (const event of tab.events) {
      if (event.type === 'text') {
        if (!currentTextBlock) {
          currentTextBlock = createTextBlock();
          dom.feed.appendChild(currentTextBlock);
        }
        appendToTextBlock(currentTextBlock, event.content);
      } else if (event.type === 'text-done') {
        currentTextBlock = null;
      } else {
        currentTextBlock = null;
        const el = createActivityElement(event);
        if (el) dom.feed.appendChild(el);
      }
    }

    applyFilters();
    scrollFeed();
  }

  function renderTranscript(tab) {
    dom.transcriptPane.innerHTML = '';
    for (const event of tab.transcript) {
      const div = document.createElement('div');
      div.className = 'transcript-entry';
      div.textContent = JSON.stringify(event);
      dom.transcriptPane.appendChild(div);
    }
  }

  function renderStatus() {
    const tab = state.tabs.get(state.activeTabId);
    if (!tab) return;
    const s = tab.status;

    dom.statusMode.textContent = s.mode;
    dom.statusMode.className = `status-mode ${s.mode}`;

    // Backend + supervision indicator
    const backendEl = $('#status-backend');
    if (backendEl) {
      const backend = tab.backend || s.backend || 'danucode';
      const sup = tab.supervision || s.supervision || 'deep';
      const label = BACKEND_LABELS[backend] || backend;
      backendEl.textContent = `${label} \u00b7 ${sup}`;
      backendEl.style.color = sup === 'deep' ? 'var(--task)' : 'var(--text-muted)';
    }

    const model = (s.model || '').replace(/\.gguf$/, '').split('/').pop();
    dom.statusModel.textContent = model.length > 25 ? model.slice(0, 22) + '...' : model;

    const isYolo = s.approvalMode === 'yolo';
    dom.statusPerms.textContent = isYolo ? 'perms: yolo' : 'perms: on';
    dom.statusPermDot.className = 'status-dot ' + (isYolo ? 'yellow' : 'green');
    dom.statusPermDot2.className = 'status-dot ' + (isYolo ? 'yellow' : 'green');

    dom.statusFiles.textContent = `${s.filesEdited} files edited`;

    // Git branch
    const branchEl = $('#status-branch');
    if (branchEl) branchEl.textContent = s.gitBranch ? `\u2387 ${s.gitBranch}` : '';

    // Uncommitted files
    const uncommittedEl = $('#status-uncommitted');
    if (uncommittedEl) {
      if (s.modifiedCount > 0) {
        uncommittedEl.innerHTML = `<span class="status-dot yellow"></span> ${s.modifiedCount} uncommitted`;
      } else {
        uncommittedEl.textContent = '';
      }
    }

    // Shell/edit status
    const shellInfoEl = $('#status-shell-info');
    if (shellInfoEl) {
      const parts = [];
      if (s.shellAllowed !== undefined) parts.push(`shell: ${s.shellAllowed ? 'on' : 'off'}`);
      if (s.editAllowed !== undefined) parts.push(`edit: ${s.editAllowed ? 'on' : 'off'}`);
      shellInfoEl.textContent = parts.join(' \u00b7 ');
    }

    const tokensK = (s.tokenEstimate / 1000).toFixed(1);
    const maxK = (s.maxTokens / 1000).toFixed(0);
    dom.statusTokens.textContent = `${tokensK}k`;
    dom.statusMaxTokens.textContent = `/ ${maxK}k`;

    const pct = s.maxTokens > 0 ? (s.tokenEstimate / s.maxTokens) * 100 : 0;
    dom.contextFill.style.width = `${Math.min(pct, 100)}%`;
    dom.contextFill.className = 'context-fill' + (pct > 80 ? ' critical' : pct > 60 ? ' warn' : '');

    dom.sidebarCwd.textContent = tab.cwd;
  }

  // ─── Activity Feed Helpers ────────────────────────────────

  function createActivityElement(event) {
    switch (event.type) {
      case 'tool-start': return createToolStartElement(event);
      case 'tool-output': return createToolOutputElement(event);
      case 'tool-done': return createToolDoneElement(event);
      case 'interrupted': return createSystemElement('Interrupted', 'warn');
      case 'error': return createSystemElement(event.message, 'warn');
      default: return null;
    }
  }

  function createToolStartElement(event) {
    const div = document.createElement('div');
    const badgeClass = getBadgeClass(event.tool, event.risk);
    const badgeText = event.tool.toLowerCase();
    const typeClass = event.risk === 'danger' ? ' type-danger' : '';
    div.className = `activity-item${typeClass}`;
    div.dataset.category = event.category;

    let contentHtml = `<span class="activity-path">${esc(event.detail || '')}</span>`;
    if (event.meta?.start_line) {
      contentHtml += ` <span class="activity-line-range">:${event.meta.start_line}${event.meta.end_line ? '-' + event.meta.end_line : ''}</span>`;
    }

    // Diff preview for edit operations
    if (event.meta?.has_diff && event.meta.old_string) {
      const oldLines = event.meta.old_string.split('\n');
      const newLines = (event.meta.new_string || '').split('\n');
      const maxPreview = 8;
      let diffHtml = '<div class="activity-diff">';
      for (let i = 0; i < Math.min(oldLines.length, maxPreview); i++) {
        diffHtml += `<div class="activity-diff-del">[-] ${esc(oldLines[i])}</div>`;
      }
      if (oldLines.length > maxPreview) {
        diffHtml += `<div class="activity-diff-overflow">   ... ${oldLines.length - maxPreview} more removed</div>`;
      }
      for (let i = 0; i < Math.min(newLines.length, maxPreview); i++) {
        diffHtml += `<div class="activity-diff-add">[+] ${esc(newLines[i])}</div>`;
      }
      if (newLines.length > maxPreview) {
        diffHtml += `<div class="activity-diff-overflow">   ... ${newLines.length - maxPreview} more added</div>`;
      }
      diffHtml += '</div>';
      contentHtml += diffHtml;
    }

    div.innerHTML = `<span class="activity-badge ${badgeClass}">${esc(badgeText)}</span><div class="activity-content">${contentHtml}</div>`;
    return div;
  }

  function createToolOutputElement(event) {
    const div = document.createElement('div');
    div.className = 'activity-item';
    div.dataset.category = event.category || 'response';
    div.style.paddingLeft = '72px';
    div.style.opacity = '0.7';
    div.style.fontSize = '11.5px';
    div.style.fontFamily = 'var(--font-mono)';
    div.style.color = 'var(--text-dim)';
    div.textContent = event.content || '';
    return div;
  }

  function createToolDoneElement(event) {
    const div = document.createElement('div');
    div.className = 'activity-item';
    div.dataset.category = event.category || 'response';
    div.style.paddingLeft = '72px';
    const icon = event.success ? '<span class="activity-check">&#10003;</span>' : '<span class="activity-fail">&#10007;</span>';
    div.innerHTML = `<div class="activity-result">${icon}${event.summary ? ' ' + esc(event.summary) : ''}</div>`;
    return div;
  }

  function createTextBlock() {
    const div = document.createElement('div');
    div.className = 'activity-item type-text';
    div.dataset.category = 'response';
    div.innerHTML = '<span class="activity-badge text">danu</span><div class="activity-content"></div>';
    return div;
  }

  function appendToTextBlock(block, content) {
    const contentEl = block.querySelector('.activity-content');
    if (!contentEl) return;
    // Each event is a complete buffered line — append with line break
    const trimmed = (content || '').trim();
    if (!trimmed) return;
    if (contentEl.childNodes.length > 0) contentEl.appendChild(document.createElement('br'));
    const span = document.createElement('span');
    span.textContent = trimmed;
    contentEl.appendChild(span);
  }

  let currentTextBlockEl = null;

  function appendTextEvent(event) {
    if (!currentTextBlockEl) {
      currentTextBlockEl = createTextBlock();
      dom.feed.appendChild(currentTextBlockEl);
      clearEmptyPlaceholder();
    }
    appendToTextBlock(currentTextBlockEl, event.content);
    scrollFeed();
  }

  function finalizeTextBlock() {
    currentTextBlockEl = null;
  }

  function appendActivityItem(event) {
    clearEmptyPlaceholder();
    const el = createActivityElement(event);
    if (el) {
      dom.feed.appendChild(el);
      applyFilterToElement(el);
      scrollFeed();
    }
  }

  function appendSystemMessage(msg) {
    clearEmptyPlaceholder();
    const el = createSystemElement(msg, 'system');
    if (el) dom.feed.appendChild(el);
    scrollFeed();
  }

  function appendErrorMessage(msg) {
    clearEmptyPlaceholder();
    const el = createSystemElement(msg, 'warn');
    if (el) dom.feed.appendChild(el);
    scrollFeed();
  }

  function createSystemElement(msg, badge) {
    const div = document.createElement('div');
    div.className = 'activity-item' + (badge === 'warn' ? ' type-warn' : '');
    div.dataset.category = 'response';
    div.innerHTML = `<span class="activity-badge ${esc(badge)}">${esc(badge)}</span><div class="activity-content">${esc(msg)}</div>`;
    return div;
  }

  function clearEmptyPlaceholder() {
    const empty = dom.feed.querySelector('.activity-feed-empty');
    if (empty) empty.remove();
  }

  // Thinking spinner
  let thinkingEl = null;
  let thinkingInterval = null;

  function showThinkingSpinner() {
    removeThinkingSpinner();
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'activity-spinner';
    thinkingEl.id = 'thinking-spinner';
    thinkingEl.innerHTML = '<span class="dot-pulse"></span> <span class="thinking-text">Thinking... 0s</span>';
    dom.feed.appendChild(thinkingEl);
    scrollFeed();

    const startTime = Date.now();
    thinkingInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const textEl = thinkingEl?.querySelector('.thinking-text');
      if (textEl) textEl.textContent = `Thinking... ${elapsed}s`;
    }, 1000);
  }

  function updateThinkingSpinner(elapsed, phrase) {
    const textEl = thinkingEl?.querySelector('.thinking-text');
    if (textEl) textEl.textContent = `${phrase || 'Thinking...'} ${elapsed}s`;
  }

  function removeThinkingSpinner() {
    if (thinkingInterval) { clearInterval(thinkingInterval); thinkingInterval = null; }
    const el = document.getElementById('thinking-spinner');
    if (el) el.remove();
    thinkingEl = null;
  }

  function scrollFeed() {
    requestAnimationFrame(() => {
      dom.feed.scrollTop = dom.feed.scrollHeight;
    });
  }

  // ─── Event Filtering ─────────────────────────────────────

  function setupFilterButtons() {
    dom.eventFilter.addEventListener('click', (e) => {
      const btn = e.target.closest('.filter-btn');
      if (!btn) return;
      const filter = btn.dataset.filter;

      if (filter === 'all') {
        state.activeFilters.clear();
        state.activeFilters.add('all');
        $$('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
      } else {
        state.activeFilters.delete('all');
        if (state.activeFilters.has(filter)) {
          state.activeFilters.delete(filter);
        } else {
          state.activeFilters.add(filter);
        }
        if (state.activeFilters.size === 0) {
          state.activeFilters.add('all');
        }
        $$('.filter-btn').forEach(b => {
          b.classList.toggle('active', state.activeFilters.has(b.dataset.filter));
        });
      }

      applyFilters();
    });
  }

  function applyFilters() {
    const items = dom.feed.querySelectorAll('.activity-item');
    const showAll = state.activeFilters.has('all');

    for (const item of items) {
      if (showAll) {
        item.classList.remove('hidden');
      } else {
        const category = item.dataset.category || 'response';
        item.classList.toggle('hidden', !state.activeFilters.has(category));
      }
    }
  }

  function applyFilterToElement(el) {
    if (state.activeFilters.has('all')) return;
    const category = el.dataset.category || 'response';
    el.classList.toggle('hidden', !state.activeFilters.has(category));
  }

  function updateFilterCounts() {
    const tab = state.tabs.get(state.activeTabId);
    if (!tab) return;
    $$('.filter-btn').forEach(btn => {
      const filter = btn.dataset.filter;
      if (filter === 'all') return;
      const count = tab.eventCounts[filter] || 0;
      const existing = btn.querySelector('.count');
      if (count > 0) {
        if (existing) {
          existing.textContent = `(${count})`;
        } else {
          btn.innerHTML = `${btn.textContent.replace(/\s*\(\d+\)/, '')} <span class="count">(${count})</span>`;
        }
      }
    });
  }

  // ─── Transcript ───────────────────────────────────────────

  function appendTranscriptEntry(event) {
    const div = document.createElement('div');
    div.className = 'transcript-entry';
    div.textContent = JSON.stringify(event);
    dom.transcriptPane.appendChild(div);
    dom.transcriptPane.scrollTop = dom.transcriptPane.scrollHeight;
  }

  // ─── Input Handling ───────────────────────────────────────

  function setupInput() {
    dom.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && dom.input.value.trim()) {
        sendMessage(dom.input.value.trim());
        dom.input.value = '';
      }
    });

    // Escape to stop
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        stopCurrentOperation();
      }
    });

    dom.btnStop.addEventListener('click', stopCurrentOperation);

    dom.btnKill.addEventListener('click', () => {
      if (!state.activeTabId) return;
      dom.killDialog.classList.add('open');
    });

    dom.killCancel.addEventListener('click', () => {
      dom.killDialog.classList.remove('open');
    });

    dom.killConfirm.addEventListener('click', () => {
      dom.killDialog.classList.remove('open');
      if (state.activeTabId) closeTab(state.activeTabId);
    });
  }

  async function sendMessage(msg) {
    if (!state.activeTabId) {
      // Auto-create a session if none exists
      await createNewTab(prompt('Working directory:') || '.');
      if (!state.activeTabId) return;
    }

    // Show user message in feed
    clearEmptyPlaceholder();
    const userDiv = document.createElement('div');
    userDiv.className = 'activity-item type-user';
    userDiv.dataset.category = 'response';
    userDiv.innerHTML = `<span class="activity-badge user">you</span><div class="activity-content">${esc(msg)}</div>`;
    dom.feed.appendChild(userDiv);
    scrollFeed();

    // Also track in tab state
    const tab = state.tabs.get(state.activeTabId);
    if (tab) {
      tab.events.push({ type: 'user', content: msg, tabId: state.activeTabId, timestamp: new Date().toISOString(), category: 'response' });
    }

    try {
      await fetch(`/sessions/${state.activeTabId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
    } catch (err) {
      appendErrorMessage(`Failed to send: ${err.message}`);
    }
  }

  async function stopCurrentOperation() {
    if (!state.activeTabId) return;
    try {
      await fetch(`/sessions/${state.activeTabId}/stop`, { method: 'POST' });
    } catch { /* ignore */ }
  }

  // ─── Settings ─────────────────────────────────────────────

  function setupSettings() {
    dom.btnSettings.addEventListener('click', async () => {
      // Fetch real config from server before showing
      try {
        const res = await fetch('/config');
        const cfg = await res.json();
        // Populate global settings from actual config
        setDropdownByValue($('#set-provider'), cfg.provider);
        $('#set-model').value = cfg.model || '';
        setDropdownByValue($('#set-mode'), cfg.mode);
        setDropdownByValue($('#set-perms'), cfg.approvalMode);
        // Show connection info
        const infoEl = $('#settings-connection-info');
        if (infoEl) {
          infoEl.textContent = `${cfg.base_url}  (key: ${cfg.maskedKey || 'none'})`;
        }
      } catch { /* show with defaults if fetch fails */ }
      dom.settingsOverlay.classList.add('open');
    });
    dom.settingsClose.addEventListener('click', () => {
      dom.settingsOverlay.classList.remove('open');
    });
    dom.settingsOverlay.addEventListener('click', (e) => {
      if (e.target === dom.settingsOverlay) {
        dom.settingsOverlay.classList.remove('open');
      }
    });
  }

  function setDropdownByValue(select, value) {
    if (!select || !value) return;
    for (const opt of select.options) {
      if (opt.value === value) { select.value = value; return; }
    }
    const lower = value.toLowerCase();
    for (const opt of select.options) {
      if (lower.includes(opt.value) || opt.value.includes(lower)) {
        select.value = opt.value; return;
      }
    }
  }

  async function postSetting(key, value) {
    try {
      await fetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
    } catch { /* best effort */ }
  }

  function setupSettingsHandlers() {
    // Server-side settings
    const modeSelect = $('#set-mode');
    if (modeSelect) modeSelect.addEventListener('change', (e) => postSetting('mode', e.target.value));

    const permsSelect = $('#set-perms');
    if (permsSelect) permsSelect.addEventListener('change', (e) => postSetting('approvalMode', e.target.value));

    const modelInput = $('#set-model');
    if (modelInput) modelInput.addEventListener('blur', (e) => { if (e.target.value.trim()) postSetting('model', e.target.value.trim()); });

    // API key
    const keyInput = $('#set-api-key');
    if (keyInput) keyInput.addEventListener('blur', (e) => { if (e.target.value.trim()) postSetting('api_key', e.target.value.trim()); });

    const testBtn = $('#btn-test-key');
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        const resultEl = $('#key-test-result');
        if (resultEl) resultEl.textContent = 'testing...';
        try {
          const res = await fetch('/test-connection', { method: 'POST' });
          const data = await res.json();
          if (resultEl) resultEl.textContent = data.ok ? 'connected' : `failed (${data.status || data.error})`;
          if (resultEl) resultEl.style.color = data.ok ? 'var(--task)' : 'var(--warning)';
        } catch (err) {
          if (resultEl) { resultEl.textContent = 'error'; resultEl.style.color = 'var(--warning)'; }
        }
      });
    }

    // Theme (frontend-only, localStorage)
    const themeSelect = $('#set-theme');
    if (themeSelect) {
      themeSelect.addEventListener('change', (e) => {
        applyTheme(e.target.value);
        localStorage.setItem('danu-theme', e.target.value);
      });
    }

    // Density (frontend-only, localStorage)
    const densitySelect = $('#set-density');
    if (densitySelect) {
      densitySelect.addEventListener('change', (e) => {
        applyDensity(e.target.value);
        localStorage.setItem('danu-density', e.target.value);
      });
    }
  }

  function applyTheme(theme) {
    document.body.classList.remove('theme-light', 'theme-high-contrast');
    if (theme && theme !== 'dark') document.body.classList.add('theme-' + theme);
    const sel = $('#set-theme');
    if (sel) sel.value = theme || 'dark';
  }

  function applyDensity(density) {
    document.body.classList.toggle('density-compact', density === 'compact');
    const sel = $('#set-density');
    if (sel) sel.value = density || 'comfortable';
  }

  function restoreUiPreferences() {
    const theme = localStorage.getItem('danu-theme');
    if (theme) applyTheme(theme);
    const density = localStorage.getItem('danu-density');
    if (density) applyDensity(density);
  }

  // ─── New Tab Dialog ───────────────────────────────────────

  async function browseDir(dirPath) {
    const browser = $('#folder-browser');
    if (!browser) return;
    browser.innerHTML = '<div style="padding:12px;color:var(--text-muted)">Loading...</div>';
    try {
      const res = await fetch(`/browse?path=${encodeURIComponent(dirPath || '.')}`);
      const data = await res.json();
      if (data.error) {
        browser.innerHTML = `<div style="padding:12px;color:var(--warning)">${esc(data.error)}</div>`;
        return;
      }
      dom.newTabCwd.value = data.current;

      let html = '';
      // Parent directory link
      if (data.parent) {
        html += `<div class="browse-item browse-parent" data-path="${esc(data.parent)}"><span class="browse-icon">..</span> parent directory</div>`;
      }
      // Current directory indicator
      const currentName = data.current.replace(/\\/g, '/').split('/').pop() || data.current;
      html += `<div class="browse-item browse-current"><span class="browse-icon">&#128194;</span> ${esc(currentName)} (current)</div>`;
      // Subdirectories
      for (const dir of data.dirs) {
        const fullPath = data.current + (data.current.endsWith('\\') || data.current.endsWith('/') ? '' : '\\') + dir;
        html += `<div class="browse-item" data-path="${esc(fullPath)}"><span class="browse-icon">&#128193;</span> ${esc(dir)}</div>`;
      }
      if (data.dirs.length === 0) {
        html += '<div style="padding:8px 12px;color:var(--text-muted);font-style:italic">No subdirectories</div>';
      }
      browser.innerHTML = html;

      // Click handlers
      browser.querySelectorAll('.browse-item[data-path]').forEach(item => {
        item.addEventListener('click', () => browseDir(item.dataset.path));
      });
    } catch (err) {
      browser.innerHTML = `<div style="padding:12px;color:var(--warning)">Failed to browse: ${esc(err.message)}</div>`;
    }
  }

  function setupNewTab() {
    dom.btnNewTab.addEventListener('click', () => {
      dom.newTabDialog.classList.add('open');
      dom.newTabCwd.value = '';
      browseDir('.');
    });

    // Go button — navigate to typed path
    const goBtn = $('#btn-browse-go');
    if (goBtn) {
      goBtn.addEventListener('click', () => {
        const path = dom.newTabCwd.value.trim();
        if (path) browseDir(path);
      });
    }

    dom.newTabCancel.addEventListener('click', () => {
      dom.newTabDialog.classList.remove('open');
    });

    dom.newTabCreate.addEventListener('click', () => {
      const cwd = dom.newTabCwd.value.trim() || '.';
      const backend = ($('#new-tab-backend') || {}).value || 'danucode';
      dom.newTabDialog.classList.remove('open');
      createNewTab(cwd, backend);
    });

    dom.newTabCwd.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        // If dialog is open and they press Enter in the path field, browse there first
        const path = dom.newTabCwd.value.trim();
        if (path && $('#folder-browser')?.children.length > 0) {
          e.preventDefault();
          browseDir(path);
        }
      }
      if (e.key === 'Escape') {
        dom.newTabDialog.classList.remove('open');
      }
    });
  }

  // ─── Transcript Toggle ───────────────────────────────────

  function setupTranscript() {
    dom.transcriptToggle.addEventListener('click', () => {
      state.transcriptOpen = !state.transcriptOpen;
      dom.transcriptPane.classList.toggle('open', state.transcriptOpen);
      dom.transcriptToggle.innerHTML = state.transcriptOpen
        ? '&#9660; Hide Raw Transcript'
        : '&#9650; Show Raw Transcript';
    });
  }

  // ─── Permission Dialog ────────────────────────────────────

  let pendingPermEvent = null;

  function showPermissionDialog(event) {
    pendingPermEvent = event;
    const dialog = $('#permission-dialog');
    const toolEl = $('#perm-tool');
    const detailEl = $('#perm-detail');
    if (!dialog || !toolEl || !detailEl) return;

    toolEl.textContent = event.toolName;
    detailEl.textContent = event.detail || '';

    // Risk-based border color
    dialog.className = 'permission-dialog open';
    if (event.risk === 'danger') dialog.classList.add('risk-danger');
    else if (event.risk === 'caution') dialog.classList.add('risk-caution');

    // Button handlers
    const deny = $('#perm-deny');
    const allow = $('#perm-allow');
    const always = $('#perm-always');

    function respond(answer) {
      if (!pendingPermEvent) return;
      if (state.ws && state.ws.readyState === 1) {
        state.ws.send(JSON.stringify({
          type: 'permission-response',
          requestId: pendingPermEvent.requestId,
          answer,
        }));
      }
      pendingPermEvent = null;
      dialog.classList.remove('open');
    }

    // Remove old listeners by cloning
    const newDeny = deny.cloneNode(true);
    const newAllow = allow.cloneNode(true);
    const newAlways = always.cloneNode(true);
    deny.replaceWith(newDeny);
    allow.replaceWith(newAllow);
    always.replaceWith(newAlways);

    newDeny.addEventListener('click', () => respond('n'));
    newAllow.addEventListener('click', () => respond('y'));
    newAlways.addEventListener('click', () => respond('a'));
  }

  // Keyboard shortcuts for permission dialog
  document.addEventListener('keydown', (e) => {
    if (!pendingPermEvent) return;
    if (e.key === 'y' || e.key === 'Y') {
      e.preventDefault();
      const dialog = $('#permission-dialog');
      if (state.ws && state.ws.readyState === 1) {
        state.ws.send(JSON.stringify({ type: 'permission-response', requestId: pendingPermEvent.requestId, answer: 'y' }));
      }
      pendingPermEvent = null;
      if (dialog) dialog.classList.remove('open');
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      const dialog = $('#permission-dialog');
      if (state.ws && state.ws.readyState === 1) {
        state.ws.send(JSON.stringify({ type: 'permission-response', requestId: pendingPermEvent.requestId, answer: 'n' }));
      }
      pendingPermEvent = null;
      if (dialog) dialog.classList.remove('open');
    } else if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      const dialog = $('#permission-dialog');
      if (state.ws && state.ws.readyState === 1) {
        state.ws.send(JSON.stringify({ type: 'permission-response', requestId: pendingPermEvent.requestId, answer: 'a' }));
      }
      pendingPermEvent = null;
      if (dialog) dialog.classList.remove('open');
    }
  });

  // ─── Helpers ──────────────────────────────────────────────

  function getBadgeClass(tool, risk) {
    if (risk === 'danger') return 'bash-danger';
    switch (tool) {
      case 'Read': return 'read';
      case 'Grep': case 'Glob': case 'WebSearch': case 'WebFetch': case 'Agent': return 'search';
      case 'Edit': return 'edit';
      case 'Write': case 'Patch': return 'write';
      case 'Bash': return risk === 'caution' ? 'bash' : 'bash';
      case 'TaskCreate': case 'TaskUpdate': case 'TaskList': return 'task';
      default: return 'text';
    }
  }

  function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── File tree fade timer ─────────────────────────────────

  setInterval(() => {
    const tab = state.tabs.get(state.activeTabId);
    if (!tab) return;
    let needsRender = false;
    for (const [, info] of tab.fileTree) {
      if (info.status === 'reading' && Date.now() - info.timestamp > 10000) {
        needsRender = true;
      }
    }
    if (needsRender) renderFileTree(tab);
  }, 5000);

  // ─── Initialization ──────────────────────────────────────

  function init() {
    connectWebSocket();
    setupFilterButtons();
    setupInput();
    setupSettings();
    setupSettingsHandlers();
    setupNewTab();
    setupTranscript();
    restoreUiPreferences();

    // Auto-create first session on load
    setTimeout(() => {
      if (state.tabs.size === 0) {
        createNewTab('.');
      }
    }, 500);
  }

  init();
})();
