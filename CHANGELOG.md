# Changelog

## v1.2.0 (2026-04-04)

Danucode learns from experience and improves itself.

### Auto-Learning
- **Post-session reflection** -- when a session ends, an LLM reflection pass reviews tool outcomes, errors, and user corrections to extract insights worth remembering
- **Graph memory enrichment** -- learnings are stored as typed nodes with keyword-matched edges in the graph memory, injected into future system prompts
- **Crash recovery** -- events are buffered to `~/.danu/sessions/pending-learn.jsonl` incrementally; if a session crashes, learnings are recovered on next startup
- **Always-on** -- enabled by default. Set `auto_learn: false` in config to disable. Set `auto_learn_model` to use a different model for reflection
- **Smart filtering** -- only tool outcomes, errors, and user messages are sent to reflection, not the full conversation
- `/clear` now also clears the pending-learn buffer
- `core/auto-learn.js` exported from the SDK public API
- 17 new tests covering event buffering, learning application, crash recovery, and edge creation

### Benchmark Harness
- **5 coding tasks** across 3 difficulty levels: fix-syntax-error (easy), add-feature (easy), refactor-callbacks (medium), debug-logic-error (medium), multi-file-feature (hard)
- **Automated runner** -- `node benchmarks/run.js` sets up isolated temp directories, runs danu in one-shot `--json` mode, verifies results via test commands
- **Scoring** -- tracks pass/fail, tool call count, duration, and errors per task
- **Results history** -- `--results` shows past runs, `--compare` diffs the last two
- **Extensible** -- add tasks as JSON files in `benchmarks/tasks/`

### Self-Improvement Loop
- **Meta-agent** -- `node benchmarks/improve.js` analyses benchmark results and the current system prompt, proposes targeted find-and-replace changes
- **Keep or revert** -- changes that improve benchmark scores are kept; regressions are automatically rolled back
- **Scoring** -- pass rate (primary, 100pts) + tool call efficiency (secondary, up to 20pts). Pass count regressions are always reverted
- **Iteration support** -- `--iterations N` runs multiple improvement cycles; `--dry-run` shows proposals without applying
- **First result** -- meta-agent added two directives that improved score from 77.0 → 113.8 (3/5 → 5/5 passing)
- Improve log and backup files are gitignored

### Stats
- 87 tests (up from 70)
- 4 new files: `core/auto-learn.js`, `test/auto-learn.test.js`, `benchmarks/run.js`, `benchmarks/improve.js`

## v1.0.0 (2026-04-03)

SDK architecture. Danucode is now a two-layer system: an importable core library with zero terminal dependencies, and a CLI built on top of it.

### Breaking Changes
- All source files moved from `src/` to `core/` (SDK) and `cli/` (terminal UI)
- `src/` directory removed
- Package now exports the SDK: `import { Agent } from 'danucode'`

### SDK
- **Agent class** -- `EventEmitter`-based entry point for programmatic use
  - `Agent.create(options)` / `new Agent(options)`
  - `agent.run(message)` -- one-shot prompt
  - `agent.send(message)` -- multi-turn conversation
  - `agent.stop()`, `agent.save()`, `agent.load()`, `agent.clear()`, `agent.compact()`
  - `agent.getMessages()`, `agent.getTokenEstimate()`
- **Structured events** -- `text`, `text-done`, `tool-start`, `tool-output`, `tool-done`, `task-update`, `interrupted`, `error`
- **Risk classification** -- every tool call classified as `safe`, `caution`, or `danger` with categories (`read`, `search`, `edit`, `shell`, `task`)
- **Permission policy engine** -- `checkPermission()` returns allow/deny decisions; consumers plug in their own approval logic
- **Package exports** -- `import { Agent, EventType, Risk, Category, classifyRisk } from 'danucode'`
- **Subpath exports** -- `import { classifyRisk } from 'danucode/core/events.js'`

### --json Output Mode
- New `--json` flag for NDJSON event output on stdout
- Every agent event (text, tool-start, tool-output, tool-done, error, interrupted, task-update) emitted as one JSON object per line
- Enables piping: `danu --json --yolo -c "fix the bug" | jq '.type'`
- No chalk, no Ink, no spinner when `--json` is active

### Architecture
- `core/` -- SDK layer. Zero dependencies on chalk, ink, react, readline. No `console.log` or `process.stdout.write`. All output via EventEmitter.
- `cli/` -- Terminal layer. Ink/React TUI, chalk formatting, interactive permission prompts, slash commands. Imports from `core/`, never the reverse.
- `bin/danu.js` -- CLI entry point. Creates an EventEmitter and subscribes to core events for rendering.
- One-way dependency: `cli/ -> core/`. The SDK runs headless in any JS environment.

### Core Changes
- `loop.js` refactored from `globalThis.__danuOutput` callback to `EventEmitter.emit()` pattern
- `permissions.js` split into policy engine (`core/permissions.js`) and interactive prompts (`cli/permissions-prompt.js`)
- `edit.js` returns plain-text diffs; CLI layer colorizes
- `context.js` compaction functions return data instead of logging
- `system-prompt.js` inlined memory loading (previously imported from `commands.js`)
- All `console.log` and `chalk` usage removed from every file in `core/`

### CLI
- Same `danu` command, same interactive TUI, same slash commands -- unchanged behavior
- `bin/danu.js` now creates an EventEmitter and subscribes to core events
- One-shot mode (`-c`) and non-TTY fallback subscribe to events and print to console

---

## v0.1.0 (2026-03-28)

Initial release.

### Core
- OpenAI-compatible API client with streaming (SSE) support
- Conversation loop with tool calling (function calling protocol)
- Configurable context limits with 2-stage compaction (prune tool outputs, then summarise)
- Multi-level config: `~/.danu/config.json` -> `./danu.config.json` -> `--config`

### Tools (15 built-in)
- **Bash** -- shell execution with Windows Git Bash detection
- **Read** -- file reading with line numbers, offset/limit
- **Write** -- file creation with mkdir -p, overwrite detection
- **Edit** -- find-and-replace with uniqueness enforcement, colored diffs
- **Grep** -- regex search with ripgrep or JS fallback
- **Glob** -- file pattern matching sorted by mtime
- **Patch** -- unified diff application
- **Agent** -- sub-agent spawning with optional git worktree isolation
- **WebSearch** -- DuckDuckGo (default), Brave, SearXNG
- **WebFetch** -- URL fetching with HTML-to-text conversion
- **NotebookEdit** -- Jupyter cell replace/insert/delete
- **GitHub** -- PR/issue operations via `gh` CLI
- **LSP** -- language server integration (definition, references, hover)
- **TaskCreate/Update/List** -- in-session task tracking

### Extensibility
- **MCP Integration** -- stdio-based Model Context Protocol servers
- **Custom tools directory** -- `.danu/tools/` and `~/.danu/tools/`
- **Hook system** -- pre/post tool execution hooks via config

### Modes
- **code** -- full access (default)
- **architect** -- read-only + markdown writing
- **ask** -- read-only, no modifications
- **debug** -- full access with debugging-focused prompt

### Commands (18)
`/help`, `/init`, `/plan`, `/mode`, `/model`, `/yolo`, `/undo`, `/redo`,
`/compact`, `/save`, `/resume`, `/history`, `/memory` (save/list/forget/clear),
`/pr`, `/exit`

### CLI
- `danu` -- interactive TUI (Ink/React when TTY, readline fallback)
- `danu --yolo` -- skip all permission prompts
- `danu -c "command"` -- one-shot mode
- `danu --session name` -- persistent named sessions with auto-save
- `danu --model name` -- override model
- `danu doctor` -- system diagnostics
- `danu --version`

### Security
- Permission system: y/n/a(lways) per tool
- `.danuignore` for excluding sensitive files
- Plan mode restricts to read-only tools
- Mode-based tool access restrictions
- No telemetry, no data sent except to configured LLM endpoint
