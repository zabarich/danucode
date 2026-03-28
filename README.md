# Danucode

[![npm](https://img.shields.io/npm/v/danucode.svg)](https://www.npmjs.com/package/danucode)
[![CI](https://github.com/zabarich/danucode/actions/workflows/ci.yml/badge.svg)](https://github.com/zabarich/danucode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-brightgreen)](https://nodejs.org)

**The simplest agent shell for your own models.**

<img src="demo.gif" alt="Danucode demo" />

An agentic coding tool for your terminal where nothing leaves your network. Point it at Ollama, llama.cpp, vLLM, or any OpenAI-compatible endpoint. No account, no subscription, no cloud.

```
$ danu

  ____                                 _
 |  _ \  __ _ _ __  _   _  ___ ___   __| | ___
 | | | |/ _` | '_ \| | | |/ __/ _ \ / _` |/ _ \
 | |_| | (_| | | | | |_| | (_| (_) | (_| |  __/
 |____/ \__,_|_| |_|\__,_|\___\___/ \__,_|\___|

  v0.1.0 · qwen2.5-coder:32b · localhost:11434  (c) Danucore

❯ find the bug in src/auth.js and fix it

  ● Read  src/auth.js
    1  import bcrypt from 'bcrypt';
    2  ...
    ✓
  ● Edit  src/auth.js
    [-] const valid = await bcrypt.compare(password, user.passwordHash);
    [+] if (!user) return { error: 'Invalid credentials' };
    [+] const valid = await bcrypt.compare(password, user.passwordHash);
    ✓

Added null check for user before accessing passwordHash.
```

## Get Running in 60 Seconds

**Install from npm:**
```bash
npm install -g danucode
```

**Or clone from source:**
```bash
git clone https://github.com/zabarich/danucode.git
cd danucode
npm install
npm link
```

Create `~/.danu/config.json` — three fields, that's it:

```json
{
  "base_url": "http://localhost:11434/v1",
  "api_key": "ollama",
  "model": "qwen2.5-coder:32b"
}
```

```bash
danu                    # interactive
danu --yolo             # skip permission prompts
danu -c "fix the bug"  # one-shot
danu doctor             # check your setup
```

## Danucode vs Aider vs Claude Code

| | Danucode | Aider | Claude Code |
|---|---|---|---|
| **Philosophy** | Simplest possible agent shell. Read the code in an afternoon. | Battle-tested AI pair programmer with deep git integration. | Full agentic coding platform from the model provider. |
| **Language** | JavaScript (~4k LOC) | Python (large codebase) | Node.js (closed source) |
| **License** | MIT | Apache 2.0 | Proprietary |
| **Setup** | `npm i -g danucode` → 3-field JSON | `pip install aider-install` | `npm i -g @anthropic-ai/claude-code` |
| **Backend** | Any OpenAI-compatible + native Anthropic (Ollama, llama.cpp, vLLM, OpenAI, Anthropic) | Any OpenAI-compatible, plus native Claude, Gemini, DeepSeek | Claude only (Opus/Sonnet) |
| **Local-only / air-gapped** | First-class. Zero cloud dependency. | With local models via Ollama etc. | Requires Anthropic account + API |
| **Account required** | No | No (bring your own key) | Yes (Claude subscription or API key) |
| **Git integration** | Manual | Automatic commits, smart messages, auto-stage | Automatic commits, branches, PRs |
| **Codebase mapping** | No | Repo-map for large projects | Full codebase awareness |
| **Modes** | code, architect, ask, debug | code, architect, ask | Interactive, headless, background agents |
| **Plan before execute** | `/plan` | `/architect` | Via extended thinking |
| **IDE integration** | Terminal only | VS Code, in-editor comments | VS Code, JetBrains, web, mobile |
| **MCP support** | Configurable | No | Extensive |
| **Sub-agents** | Agent tool | No | Agent Teams |
| **Lint / test loop** | Manual | Auto-lint and auto-test | Auto-test |
| **Session persistence** | `--session`, `/save`, `/resume` | Chat history | Sessions, `/rewind` |
| **Permissions** | y/n/always per tool, `--yolo` | Edits directly | y/n/always, `--dangerously-skip-permissions` |
| **Maturity** | Experimental (weeks old) | Production (years, large community) | Production (Anthropic-backed) |

**Honest take:** If you want the most capable tool, use Claude Code. If you want proven open-source with broad model support, use Aider. If you want something you can fully understand, modify, and point at your own infrastructure with zero external dependencies — that's what Danucode is for.

## How It Works

The same loop as every agentic coding tool:

1. You type a message
2. Danucode sends it + tool definitions to your LLM
3. The LLM responds with text or tool calls
4. Tools execute locally, results go back to the LLM
5. Repeat until done

## What You Get

**Tools:** Bash, Read, Write, Edit, Grep, Glob, Patch, Agent, WebSearch, WebFetch, GitHub, LSP, NotebookEdit, Tasks

**Modes:** `code` (full access) · `architect` (read-only + markdown) · `ask` (read-only) · `debug` (diagnostic focus)

**Plan mode:** `/plan` to explore and design before implementing

**Project context:** `DANUCODE.md` loaded into the system prompt — `/init` generates one

**Memory:** `/memory save` persists preferences across sessions

**Sessions:** `--session myproject` auto-saves and resumes

**Permissions:** `y/n/a(lways)` per tool · `--yolo` to bypass

**Extensibility:** MCP servers · custom tools in `.danu/tools/` · hooks · configurable search

**18 commands:** `/help` `/init` `/plan` `/mode` `/model` `/yolo` `/undo` `/redo` `/compact` `/save` `/resume` `/history` `/memory` `/pr` `/exit` and more

## Demos

See [docs/demos/](docs/demos/) for realistic usage transcripts:
- [Basic usage](docs/demos/01-basic-usage.md) — reading code, finding a bug, fixing it
- [Plan mode](docs/demos/02-plan-mode.md) — designing before implementing
- [Task workflow](docs/demos/03-task-workflow.md) — breaking work into tracked steps

## Configuration

Config loads from (later overrides earlier):
1. `~/.danu/config.json` (user)
2. `./danu.config.json` (project)
3. `--config <path>` (CLI)

See `danu.config.example.json` for all options.

### Backend Examples

**Ollama:** `{ "base_url": "http://localhost:11434/v1", "api_key": "ollama", "model": "qwen2.5-coder:32b" }`

**llama.cpp:** `{ "base_url": "http://localhost:8080/v1", "api_key": "none", "model": "my-model.gguf" }`

**vLLM:** `{ "base_url": "http://localhost:8000/v1", "api_key": "token", "model": "Qwen/Qwen2.5-32B" }`

**OpenAI:** `{ "base_url": "https://api.openai.com/v1", "api_key": "sk-...", "model": "gpt-4o" }`

**Anthropic (native):** `{ "base_url": "https://api.anthropic.com", "provider": "anthropic", "api_key": "sk-ant-...", "model": "claude-haiku-4-5-20251001" }`

## Testing

```bash
npm test
```

25 tests covering tool execution, permission boundaries, token estimation, and context management. Node.js built-in test runner, no external framework. CI runs on Node 20/22 across Linux, Windows, and macOS.

## Security

Danucode can execute shell commands and modify files. Read [SECURITY.md](SECURITY.md).

Key points: permission prompts by default, `.danuignore` for sensitive files, mode-based restrictions, no telemetry, data only goes to your configured endpoint.

## Roadmap

Actively developing. Current priorities:
- [ ] Terminal recording / asciinema demo
- [ ] Model compatibility matrix (which models work well with tool calling)
- [ ] Skills system (markdown prompt templates)
- [ ] Deeper test coverage
- [ ] Permission fail-closed hardening

See [CHANGELOG.md](CHANGELOG.md) for what's already built.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports, model compatibility notes, tests, and system prompt improvements are the most impactful contributions right now.

## License

MIT. (c) Danucore.
