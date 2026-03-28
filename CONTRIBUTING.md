# Contributing to Danucode

Danucode is early-stage and actively evolving. Contributions are welcome.

## Getting Started

```bash
git clone https://github.com/zabarich/danucode.git
cd danucode
npm install
npm link     # creates the 'danu' command
npm test     # run the test suite
```

## What Would Help Most

**Right now, the highest-impact contributions are:**

1. **Bug reports** — use Danucode with your local model and report what breaks. Tool calling, streaming, edge cases.
2. **Model compatibility notes** — which models work well? Which have tool-calling issues? Add to a `docs/models/` directory.
3. **System prompt tuning** — `src/system-prompt.js` is where most quality improvement comes from. Better prompts = better results with smaller models.
4. **Tests** — `test/` has 25 tests but coverage is thin. More tool tests, edge case tests, integration tests.
5. **Demo recordings** — terminal recordings (asciinema, GIF) showing real usage with different models.

## Architecture

The codebase is intentionally simple — ~4k lines of JavaScript, no build step, no transpiler.

```
bin/danu.js          Entry point, Ink TUI, CLI arg parsing
src/
  api.js             API client (fetch + SSE streaming)
  loop.js            Conversation loop (stream → tools → loop)
  tools/index.js     Tool registry and dispatch
  tools/*.js         Individual tool implementations
  system-prompt.js   System prompt builder
  permissions.js     Permission gate
  context.js         Token estimation + compaction
  commands.js        Slash command handlers
  modes.js           Mode system (code/architect/ask/debug)
  planmode.js        Plan mode enforcement
  mcp.js             MCP server integration
  lsp.js             LSP client
```

Each tool is a self-contained file exporting `definition` (JSON schema) and `execute(args)`. Adding a new tool means creating a file and registering it in `tools/index.js`.

## Code Style

- ESM modules (import/export)
- No TypeScript, no build step
- Minimal dependencies (chalk, glob, ink, react)
- Functions over classes
- Errors returned as strings to the LLM, not thrown

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Add tests for new tools or behaviour changes
- Run `npm test` before submitting
- Update CHANGELOG.md for user-visible changes

## Security

If you find a security issue (especially in the permission system or bash execution), please open an issue or email rather than a public PR.
