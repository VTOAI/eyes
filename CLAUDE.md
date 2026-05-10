# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Run CLI via tsx (no build step)
npm run build      # Compile TypeScript (tsc → dist/)
npm test           # Run all tests (vitest run)
npx vitest run tests/unit/session-manager.test.ts  # Run a single test file
npx vitest run --reporter=verbose                   # Verbose test output
npx tsc --noEmit  # Typecheck only
```

After `npm link`, the CLI is available as `eyes`.

## Architecture

`eyes` is a terminal AI agent that connects an LLM to MCP tools. The user types messages; the agent loops (LLM call → tool call → LLM call) until the LLM responds with text.

```
CLI (src/index.ts)
  → loadConfig()          config/index.ts — env vars > ~/.eyes/config.json > defaults
  → createLLMClient()     llm/anthropic.ts or llm/openai.ts
  → MCPRegistry           mcp/registry.ts — manages tool routing (MCP servers + local tools)
  → MCPServerInstaller    mcp/installer.ts — keyword-match or LLM-generate MCP server configs
  → SessionManager        session/manager.ts — multi-session CRUD, persists to ~/.eyes/sessions/
  → Agent(…, session, …)  agent/loop.ts — ReAct loop, accepts any {add,getAll,clear} (SessionLike)
```

**Agent loop** (`src/agent/loop.ts:37-96`): The `run()` method adds the user message to session, then iterates: build system prompt with current MCP tools → `llm.chat()` → if text, return; if tool_call, execute via `mcp.callTool()`, record both to session, repeat. Max iterations hard-stops with a timeout message.

**Types** (`src/agent/types.ts`): Single source of truth for `Message` (user/assistant/tool_result union), `Tool`, `ToolCall`, `Usage` (inputTokens/outputTokens), `LLMResponse` (text or tool_call, each with optional `usage`), `SessionMetadata`.

**LLM clients** (`src/llm/`): Both implement the `LLMClient` interface (`chat()` method). Each handles streaming (for token-by-token UX) and non-streaming (for doctor probe and installer LLM calls). They convert the project's `Message[]` to provider-specific formats and return `LLMResponse` (including `usage` when available from the API).

**MCP** (`src/mcp/`): `MCPRegistry` maintains tool→server mappings, caches tools per server, merges local tools (like `install_mcp_server`) with MCP tools. `connectServer()` hot-reconnects (dedup by name). `transport.ts` creates Stdio or SSE transports.

**Built-in known MCP servers** (`src/mcp/installer.ts:5-60`): github, filesystem, postgres, sqlite, puppeteer, brave-search, memory, slack.

## Config

`~/.eyes/config.json`:
```json
{
  "llm": { "type": "openai|anthropic", "apiKey": "…", "baseURL": "…", "model": "…" },
  "maxIterations": 10,
  "mcpServers": { "name": { "command": "npx", "args": ["-y", "@scope/pkg"] } }
}
```

Env overrides: `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL`, `LLM_TYPE`, `MAX_ITERATIONS`, `MCP_CONFIG_PATH`.

## Conventions

- ESM with `.js` extensions in imports
- TypeScript strict mode, target ES2022
- Vitest with `globals: true`, test environment: `"node"`
- No linting/formatting tools currently configured
- New LLM providers: implement `LLMClient` interface, add case in `createLLMClient()` in `src/index.ts`
