# eyes

Terminal AI agent that connects an LLM to MCP tools. Type messages, the agent loops (LLM → tool call → LLM) until the LLM responds with text.

## Quick Start

```bash
npm install
npm link
eyes
```

On first run, an interactive wizard sets up your LLM config. Config is saved to `~/.eyes/config.json`.

## Commands

```bash
eyes                  # Start interactive session
eyes resume <id>      # Resume a saved session
eyes help             # Show usage
eyes config           # Show LLM configuration
eyes mcp              # List MCP servers and tools
eyes doctor           # Check config and connectivity
eyes install <desc>   # Install an MCP server by description
eyes sessions list    # List saved sessions
eyes serve            # Start gateways in background
eyes serve console    # Start gateways in foreground
eyes serve stop       # Stop background serve
eyes serve status     # Check serve status
eyes gateways         # List configured gateways and channels
```

## In-Session Slash Commands

| Command       | Description                              |
|---------------|------------------------------------------|
| `/help`       | Show available commands                  |
| `/config`     | Show LLM configuration                   |
| `/mcp`        | List MCP servers and tools               |
| `/doctor`     | Check config and LLM connectivity        |
| `/install`    | Install an MCP server by description     |
| `/gateways`   | List gateways and notification channels  |
| `/sessions`   | Manage sessions (list/new/switch/delete/rename) |
| `/clear`      | Clear session history                    |
| `/exit`       | Exit the CLI                             |

Double-tap ESC to abort an in-progress agent run.

## Configuration

`~/.eyes/config.json`:

```json
{
  "llm": {
    "type": "openai",
    "apiKey": "sk-...",
    "baseURL": "https://api.openai.com/v1",
    "model": "gpt-4o"
  },
  "maxIterations": 10,
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    },
    "remote-service": {
      "url": "https://example.com/mcp/sse"
    }
  },
  "gateways": [
    {
      "type": "feishu-bot",
      "name": "my-bot",
      "appId": "...",
      "appSecret": "..."
    }
  ],
  "channels": [
    {
      "type": "feishu-webhook",
      "name": "team-chat",
      "webhookUrl": "https://open.feishu.cn/..."
    }
  ]
}
```

### Environment Variables

All config fields can be overridden via env vars:

| Variable          | Config field      |
|-------------------|-------------------|
| `LLM_API_KEY`     | `llm.apiKey`      |
| `LLM_MODEL`       | `llm.model`       |
| `LLM_BASE_URL`    | `llm.baseURL`     |
| `LLM_TYPE`        | `llm.type`        |
| `MAX_ITERATIONS`  | `maxIterations`   |
| `MCP_CONFIG_PATH` | MCP server file   |

A `.env` file in `~/.eyes/`, `.eyes/`, or the working directory is also loaded (does not override existing env vars).

## MCP Servers

eyes supports both **stdio** (command + args) and **SSE** (url) MCP transports. Known servers can be installed by description:

```bash
eyes install postgres database access
eyes install github api integration
```

Built-in known servers: `filesystem`, `github`, `postgres`, `sqlite`, `puppeteer`, `brave-search`, `memory`, `slack`.

## Gateways & Channels

**Gateways** receive messages from external platforms and route them to the LLM. **Channels** let the LLM send notifications to external platforms.

### Feishu Bot (Gateway)

Configure a Feishu bot gateway to let users interact with eyes through Feishu messages. Each chat gets its own session via `PerChatSessionRouter`.

### Feishu Webhook (Channel)

Notification channel that sends LLM responses to a Feishu group chat. The LLM can call the `send_notification` tool to push messages through configured channels.

## Architecture

```
CLI (src/index.ts)
  → loadConfig()          config/index.ts
  → createLLMClient()     llm/anthropic.ts or llm/openai.ts
  → MCPRegistry           mcp/registry.ts
  → MCPServerInstaller    mcp/installer.ts
  → SessionManager        session/manager.ts
  → Agent(…, session, …)  agent/loop.ts — ReAct loop
```

**Agent loop**: adds user message → builds system prompt with current tools → `llm.chat()` → if text, return; if tool_call, execute via `mcp.callTool()`, record to session, repeat. Max iterations hard-stops with a timeout message.

**LLM clients**: OpenAI-compatible (OpenAI, DeepSeek, etc.) and Anthropic. Both support streaming and non-streaming. Reasoning content (DeepSeek R1, etc.) is passed through to the session.

## Develop

```bash
npm run dev        # Run CLI via tsx (no build step)
npm run build      # Compile TypeScript (tsc → dist/)
npm test           # Run all tests (vitest run)
npx vitest run tests/unit/feishu-webhook.test.ts  # Run a single test file
npx tsc --noEmit  # Typecheck only
```

## Tech Stack

- TypeScript (strict, ES2022, ESM)
- MCP SDK (`@modelcontextprotocol/sdk`)
- OpenAI SDK (`openai`) + Anthropic SDK (`@anthropic-ai/sdk`)
- Feishu/Lark SDK (`@larksuiteoapi/node-sdk`)
- Vitest for testing
