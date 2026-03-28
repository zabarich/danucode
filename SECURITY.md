# Security Model

Danucode is a CLI tool that gives an LLM the ability to read files, write files, execute shell commands, and access the network on your behalf. This is inherently powerful and potentially dangerous. Understanding the security boundaries is important.

## Permission System

By default, three tools require explicit user approval before execution:

| Tool | What it does | Why it needs permission |
|------|-------------|----------------------|
| **Bash** | Executes arbitrary shell commands | Can run anything on your system |
| **Write** | Creates or overwrites files | Can destroy data |
| **Edit** | Modifies file contents | Can corrupt files |

All other tools (Read, Grep, Glob, WebSearch, WebFetch, etc.) are read-only and execute without prompting.

### Permission Responses

When prompted, you can respond:
- `y` — allow this one operation
- `n` — deny this operation
- `a` — allow this tool type for the rest of the session (e.g., "always allow Bash")

### Bypassing Permissions

- `danu --yolo` starts with all permissions bypassed
- `/yolo` toggles permissions on/off mid-session
- **Use with caution** — the LLM can and will run arbitrary commands

## What Danucode CAN Access

When running, Danucode can:
- **Read any file** on the filesystem that the current user can access
- **Write/create/delete files** anywhere the current user has write access (with permission)
- **Execute any shell command** the current user can run (with permission)
- **Make network requests** to any URL (WebFetch, WebSearch)
- **Connect to external services** via MCP servers
- **Access git repositories** and GitHub via the `gh` CLI

## What Danucode CANNOT Do

- **Escalate privileges** — it runs as your user, with your permissions
- **Bypass OS security** — sandboxing is not implemented; the OS is the security boundary
- **Access other users' files** — standard Unix/Windows permissions apply
- **Run without your terminal** — there is no background daemon (sessions save to disk, not running processes)

## .danuignore

Create a `.danuignore` file in your project root to prevent Danucode from reading or modifying sensitive files:

```
# Secrets
.env
.env.*
*.pem
*.key
credentials.json

# Generated
dist/
build/
```

Files matching these patterns will be blocked by Read, Write, Edit, Grep, and Glob tools.

## Modes as Security Boundaries

| Mode | Can read | Can write | Can execute | Can search web |
|------|----------|-----------|-------------|---------------|
| **code** | Yes | Yes (with permission) | Yes (with permission) | Yes |
| **architect** | Yes | Only .md files | No | Yes |
| **ask** | Yes | No | No | Yes |
| **debug** | Yes | Yes (with permission) | Yes (with permission) | Yes |
| **plan** | Yes | Only the plan file | No | Yes |

## Plan Mode

In plan mode, the LLM is restricted to read-only tools plus writing to a single plan file. It cannot execute commands, modify code, or make changes. This is enforced at the tool execution layer — not just by the system prompt.

## Network Security

- **LLM API calls** go to the configured `base_url` (your local server or a remote API)
- **WebSearch** queries go to DuckDuckGo (default), Brave, or SearXNG
- **WebFetch** can access any public URL
- **MCP servers** are spawned locally as child processes
- **No telemetry** — Danucode sends no data anywhere except the configured LLM endpoint

## Recommendations

1. **Don't run with `--yolo` on production systems** — use it for personal dev machines only
2. **Use `.danuignore`** to protect secrets and sensitive files
3. **Use `ask` or `architect` mode** when you want read-only exploration
4. **Use `plan` mode** for complex tasks — review the plan before allowing execution
5. **Review tool calls** — the permission prompt shows you exactly what will run
6. **Run with a local LLM** if privacy is critical — no data leaves your network
