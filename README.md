# Danucode

[![CI](https://github.com/zabarich/danucode/actions/workflows/ci.yml/badge.svg)](https://github.com/zabarich/danucode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-brightgreen)](https://nodejs.org)

Backend-agnostic terminal coding agent. Early-stage, hackable, runs locally.

Runs on any OpenAI-compatible API — point it at llama.cpp, Ollama, vLLM, or a remote provider. Gives you shell, file, web and sub-agent tools with project memory and persistent sessions.

> **Status:** Experimental. This is an early framework, not a production tool. It works for simple coding tasks with capable models but lacks the polish, test coverage and battle-testing of mature alternatives like Aider, Claude Code or Codex CLI. Use it to learn, tinker, and build on.

**(c) Danucore** | [Security Model](SECURITY.md) | [Changelog](CHANGELOG.md) | [Demos](docs/demos/)

## Quick Start

```bash
cd danu
npm install
npm link        # installs 'danu' as a global command

danu        # launch from any directory
```

## Configuration

Danu looks for `danu.config.json` in the current directory, then in the install directory.

```json
{
  "base_url": "http://localhost:8080/v1",
  "api_key": "your-api-key",
  "model": "Qwen3.5-35B-A3B-UD-Q4_K_XL.gguf",
  "chat_template_kwargs": { "enable_thinking": false },
  "timeout": 300000,
  "search": {
    "provider": "duckduckgo"
  }
}
```

Point it at any OpenAI-compatible endpoint:

```json
{
  "base_url": "https://api.openai.com/v1",
  "api_key": "sk-...",
  "model": "gpt-4o",
  "timeout": 120000
}
```

Or specify a config path: `danu --config /path/to/config.json`

### Web Search Providers

DuckDuckGo is the default (no API key needed). You can switch to Brave or SearXNG:

```json
// Brave Search (free tier: 2000 queries/month, get key at https://brave.com/search/api/)
"search": { "provider": "brave", "api_key": "BSA..." }

// SearXNG (self-hosted)
"search": { "provider": "searxng", "base_url": "http://localhost:8888" }

// DuckDuckGo (default, no key needed)
"search": { "provider": "duckduckgo" }
```

## Tools

| Tool | Description |
|------|-------------|
| **Bash** | Execute shell commands (auto-detects Git Bash on Windows) |
| **Read** | Read files with line numbers, offset/limit support |
| **Write** | Create/overwrite files, auto-creates parent directories |
| **Edit** | Find-and-replace editing with uniqueness checks |
| **Grep** | Regex content search (uses ripgrep if available, JS fallback) |
| **Glob** | File pattern matching sorted by modification time |
| **Agent** | Spawn sub-agents with their own conversation for complex tasks |
| **WebSearch** | Search the web (DuckDuckGo/Brave/SearXNG), no API key needed by default |
| **WebFetch** | Fetch a URL and convert HTML to readable text |

Bash, Write, and Edit require permission confirmation before execution.

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/init` | Create a `DANUCODE.md` template in the current directory |
| `/memory save <text>` | Remember something across sessions |
| `/memory list` | Show all saved memories |
| `/memory forget <N>` | Forget memory number N |
| `/memory clear` | Clear all memories |
| `/exit` | Quit Danu |

## Project Instructions

Create a `DANUCODE.md` (or `CLAUDE.md`) in your project root to give Danu project-specific context. Use `/init` to generate a template.

Danu searches the current directory and up to 5 parent directories for:
- `DANUCODE.md`
- `CLAUDE.md`
- `.claude/CLAUDE.md`

All found files are loaded into the system prompt.

## Memory

Memories persist across sessions in `~/.danu/memory/memories.json` and are injected into the system prompt so the LLM has context about your preferences and past decisions.

## Features

- **Streaming** — Tokens print as they arrive, no waiting for full responses
- **Context management** — Automatic conversation compaction when approaching token limits (summarizes old messages via the LLM)
- **Git awareness** — Detects git repos and includes branch name + modified file count in context
- **Sub-agents** — Agent tool spawns independent conversations (max 15 tool iterations)
- **Configurable backend** — Any OpenAI-compatible API (local or remote)

## Architecture

```
bin/danu.js          Entry point, splash screen, readline loop, command routing
src/
  api.js                 OpenAI-compatible API client (fetch + SSE streaming)
  loop.js                Conversation orchestrator (stream, dispatch tools, loop)
  system-prompt.js       Builds system prompt (git info, DANUCODE.md, memories)
  context.js             Token estimation + conversation compaction
  commands.js            Slash command handlers (/init, /memory, /help)
  permissions.js         Permission prompts for dangerous tools
  tools/
    index.js             Tool registry + dispatcher (50k char result cap)
    bash.js              Shell execution with Windows bash detection
    read.js              File reading with line numbers
    write.js             File writing with mkdir -p
    edit.js              String replacement with uniqueness enforcement
    grep.js              Regex search (ripgrep or JS fallback)
    glob.js              Glob pattern matching with mtime sorting
    agent.js             Sub-agent spawning with independent conversations
```

## What's Next

### High Priority
- [x] **Session persistence** — `/save` and `/resume` for conversations across restarts
- [x] **Diff display for edits** — Colored diffs on Edit, before/after line counts on Write
- [x] **Markdown rendering** — Inline bold, italic, code formatting during streaming
- [x] **`/compact` command** — Manually trigger conversation compaction
- [x] **Token counting display** — Estimated token count shown in status bar after each turn

### Medium Priority (done)
- [x] **WebSearch / WebFetch tools** — DuckDuckGo/Brave/SearXNG + URL fetching
- [x] **NotebookEdit tool** — Replace, insert, delete Jupyter notebook cells
- [x] **Task management tools** — TaskCreate/TaskUpdate/TaskList for tracking work
- [x] **MCP Integration** — stdio-based MCP servers, tool discovery + execution
- [x] **Hook system** — Pre/post tool execution automation via config
- [x] **Multi-level config** — ~/.danu/config.json + project + --config flag
- [x] **"Allow for session" permissions** — y/n/a(lways) per tool
- [x] **Plan mode** — /plan for read-only exploration, ExitPlanMode for approval
- [x] **Rich terminal UI** — Spinners, tool indicators, Escape to cancel, command stacking
- [x] **Escape to interrupt** — Cancel streaming/tools mid-operation
- [x] **Command stacking** — Semicolon-separated commands in one input

### Remaining
- [ ] **Skills system** — Markdown-based prompt templates (like /commit, /review-pr)
- [ ] **Worktree support** — Git worktree isolation for agents
- [ ] **Cron scheduling** — Scheduled recurring tasks
- [ ] **Auto-updates** — Self-update mechanism
- [ ] **Image/PDF support** — Multimodal input for vision-capable models
- [ ] **Sandbox/process isolation** — Real sandboxing for Bash commands
- [ ] **Conversation history browser** — Browse and search past sessions
- [ ] **Keyboard shortcuts / keybindings** — Configurable key mappings
- [ ] **Ink/React full rewrite** — Proper terminal framework for panels, scrolling, etc.

## Testing

```bash
npm test
```

Tests cover: Read, Write, Edit, Glob, Grep, Patch, Tasks tools, permission boundaries, token estimation, and context pruning. Uses Node.js built-in test runner (no external test framework).

CI runs on every push across Node 20/22 on Linux, Windows, and macOS.

## Security

Danucode gives an LLM the ability to execute shell commands and modify files on your system. See [SECURITY.md](SECURITY.md) for the full security model, including:

- Permission system (y/n/always) with `--yolo` bypass
- `.danuignore` for excluding sensitive files
- Mode-based tool access restrictions
- Plan mode read-only enforcement
- No telemetry — data only goes to your configured LLM endpoint

## Requirements

- Node.js >= 20.0.0
- An OpenAI-compatible LLM server with tool/function calling support
