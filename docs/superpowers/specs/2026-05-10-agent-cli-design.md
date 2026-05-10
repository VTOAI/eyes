# Agent CLI — 设计文档

## 概述

基于 TypeScript 的命令行 AI Agent，支持通用 MCP 工具扩展，兼容 OpenAI / Anthropic API，支持飞书 Bot 网关和通知推送。

### Why CLI First

先做 CLI 验证 Agent + MCP 的核心能力，再通过 Gateway 层包装为飞书企业应用服务。

---

## 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        eyes CLI                                  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    ReAct Loop                               │  │
│  │    User Input → LLM → Tool Call → LLM → Output             │  │
│  └──────────────────┬─────────────────────────────────────────┘  │
│         ↕                       ↕                                │
│  ┌─────────────┐     ┌──────────────────────────┐               │
│  │  LLM Client  │     │     MCP Registry          │               │
│  │  (OpenAI /   │     │  ┌────────────────────┐  │               │
│  │   Anthropic) │     │  │ MCP Tools (stdio/  │  │               │
│  └─────────────┘     │  │ SSE)               │  │               │
│                       │  ├─ 启动时连接         │  │               │
│  ┌──────────────────┐ │  ├─ 获取 tools list   │  │               │
│  │  会话管理器       │ │  ├─ unified call()   │  │               │
│  │  (磁盘持久化)     │ │  ├─ 错误隔离          │  │               │
│  └──────────────────┘ │  └────────────────────┘  │               │
│                       │  ┌────────────────────┐  │               │
│  ┌──────────────────┐ │  │ Local Tools        │  │               │
│  │  配置加载         │ │  │ (程序注册的本地工具) │  │               │
│  │  ~/.eyes/        │ │  └────────────────────┘  │               │
│  │  config.json     │ └──────────────────────────┘               │
│  └──────────────────┘                                           │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │               Gateway / Channel Layer                       │  │
│  │  ┌──────────────────┐  ┌──────────────────────────────┐   │  │
│  │  │ Message Gateway   │  │ Notification Channel          │   │  │
│  │  │ (飞书 Bot 等)     │  │ (飞书 Webhook 等)             │   │  │
│  │  │ - 接收外部消息     │  │ - LLM 完成后主动推送          │   │  │
│  │  │ - 路由到 Agent    │  │ - send_notification 工具      │   │  │
│  │  └──────────────────┘  └──────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │           PerChatSessionRouter                              │  │
│  │    platform + chatId → 独立 Agent Session                   │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## 组件设计

### 1. Agent Core — ReAct 循环

核心逻辑：

```
loop:
  response = llm.chat(messages + tools)

  if response has tool_call:
    result = mcpRegistry.call(tool_call.name, tool_call.args)
    messages.append(tool_call, result)
    continue

  else:
    print(response.text)
    break
```

- 最大循环轮次：可配置（默认 10 轮），防死循环
- 上下文窗口：messages 累积，由 LLM 自身管理上下文窗口
- 支持 AbortController 中断（双击 ESC）
- Agent 接受任意 `SessionLike` 接口（`{add, getAll, clear}`），CLI 和 Gateway 复用同一 Agent

### 2. LLM Client

抽象接口：

```typescript
interface StreamCallbacks {
  onToken?: (token: string) => void;
}

interface LLMClient {
  chat(
    messages: Message[],
    tools: Tool[],
    callbacks?: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<LLMResponse>;
}

type LLMResponse =
  | { type: "text"; content: string; usage?: Usage; reasoningContent?: string }
  | { type: "tool_call"; toolCall: ToolCall; usage?: Usage; reasoningContent?: string };
```

| 实现 | 覆盖模型 | 备注 |
|------|---------|------|
| `OpenAICompatibleClient` | DeepSeek / GPT / 通义千问 / 智谱 / Moonshot 等 | 国产模型及 OpenAI，支持 reasoning_content |
| `AnthropicClient` | Claude Sonnet / Opus | 兼容 Anthropic Messages API |

通过配置选择 LLM 后端，切换模型无需改代码。reasoningContent 字段透传推理过程（如 DeepSeek R1）。

### 3. MCP Registry

职责：
- 启动时读取 `~/.eyes/config.json` 的 `mcpServers`，连接所有配置的 MCP Server
- 自动发现每个 Server 的 tools 列表，合并后暴露给 LLM
- 调用时按 tool name 路由到对应的 Server 执行
- 单个 Server 故障不影响其他
- 支持 `connectServer()` 热重连（同名 Server 去重，先断旧连新）
- 支持 `registerLocalTool()` 注册程序内工具（如 `install_mcp_server`、`send_notification`）

支持的传输方式：
- **stdio** — 本地子进程通信（`command` + `args` + `env`）
- **SSE** — 远程 MCP Server（`url`）

### 4. 会话管理器

- 磁盘持久化存储（`~/.eyes/sessions/`），每个会话一个 JSON 文件
- 支持 CRUD：list / new / switch / delete / rename
- `eyes resume <id>` 恢复历史会话
- `eyes sessions list` 在非交互模式下也可用（直接从磁盘读取）
- 每条消息包含 `{role, content, timestamp, reasoningContent?}`

### 5. 配置加载

单文件配置 `~/.eyes/config.json`：

```json
{
  "llm": {
    "type": "openai | anthropic",
    "apiKey": "...",
    "baseURL": "https://api.openai.com/v1",
    "model": "gpt-4o"
  },
  "maxIterations": 10,
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "env": { "KEY": "value" }
    },
    "remote": {
      "url": "https://example.com/mcp/sse"
    }
  },
  "gateways": [
    { "type": "feishu-bot", "name": "my-bot", "appId": "...", "appSecret": "..." }
  ],
  "channels": [
    { "type": "feishu-webhook", "name": "team-chat", "webhookUrl": "https://..." }
  ]
}
```

| 配置项 | 环境变量覆盖 | 说明 |
|--------|-------------|------|
| LLM 类型 | `LLM_TYPE` | openai / anthropic |
| API Key | `LLM_API_KEY` | — |
| API Base URL | `LLM_BASE_URL` | — |
| 模型名称 | `LLM_MODEL` | — |
| 最大迭代 | `MAX_ITERATIONS` | — |
| MCP 配置文件 | `MCP_CONFIG_PATH` | 单独指定 MCP Server 配置 JSON |
| `.env` 文件 | — | 从 `~/.eyes/.env`、`.eyes/.env`、`.env` 自动加载 |

首次运行无配置时，交互式向导引导设置 LLM。

### 6. Gateway — 消息网关

接收外部平台消息，路由到 Agent 处理并回复：

```typescript
interface MessageGateway {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage: (msg: GatewayMessage, reply: (text: string) => Promise<void>) => Promise<void>;
}
```

**已实现**：`FeishuBotGateway` — 通过飞书 WebSocket 长连接接收消息，每条消息独立 Agent Session，回复支持 Markdown 格式。

### 7. Channel — 通知通道

Agent 完成后主动向外部平台推送消息：

```typescript
interface NotificationChannel {
  readonly name: string;
  send(text: string): Promise<void>;
}
```

**已实现**：`FeishuWebhookChannel` — 通过飞书 Webhook URL 发送通知。LLM 可通过 `send_notification` 本地工具指定 channel 名称推送消息。

### 8. PerChatSessionRouter

Gateway 层的会话路由：

```
platform + chatId → Agent Session
```

同一飞书群聊的所有消息共享同一个 Agent Session，保持对话上下文。

### 9. eyes serve — 后台网关服务

```
eyes serve           # 后台启动（daemon 模式，PID 文件管理）
eyes serve console   # 前台启动（调试用）
eyes serve stop      # 停止后台服务
eyes serve status    # 查看运行状态
```

- Daemon 模式通过 `child_process.spawn` detached 实现
- PID 文件：`~/.eyes/serve.pid`
- SIGINT/SIGTERM 时优雅关闭所有 Gateway 和 MCP 连接

---

## CLI 交互特性

| 特性 | 说明 |
|------|------|
| 实时命令补全 | 输入 `/` 后实时匹配并显示可用命令，方向键选择 |
| 双击 ESC 中断 | 300ms 内双击 ESC 中止当前 Agent 运行 |
| 流式输出 | LLM 响应逐 token 输出 |
| 用法展示 | `⎿ 3.2s · ↑ 1.2k · ↓ 0.8k` 格式展示耗时和 token |
| Tool Result 美化 | JSON 结果自动格式化，超长内容截断显示 |

### 内置 Slash 命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示可用命令 |
| `/config` | 显示 LLM 配置 |
| `/mcp` | 列出 MCP 服务器和工具 |
| `/doctor` | 检查配置和 LLM 连通性 |
| `/install` | 按描述安装 MCP 服务器 |
| `/gateways` | 列出配置的网关和通知通道 |
| `/sessions` | 管理会话（list/new/switch/delete/rename） |
| `/clear` | 清除会话历史 |
| `/exit` | 退出 |

所有子命令也支持 CLI 直接调用（`eyes config`、`eyes mcp` 等）。

---

## 错误处理

| 场景 | 策略 |
|------|------|
| MCP Server 连接失败 | 静默跳过，错误日志输出，不影响其他 Server |
| LLM API 调用失败 | 退避重试 3 次，都失败则报错 |
| Tool 执行异常 | 错误信息作为 tool result 返回给 LLM |
| 循环达到最大轮次 | 停止并返回超时提示 |
| Tool Call JSON 解析失败 | 跳过该调用，通知 LLM 重新生成 |
| Gateway 启动失败 | 单个 Gateway 失败不影响其他 |
| Channel 推送失败 | 静默忽略（.catch），不阻塞 Agent 响应 |
| AbortError | 优雅中断，输出 "Aborted" 提示 |

---

## 项目结构

```
eyes/
├── src/
│   ├── index.ts                # CLI 入口（交互 + 子命令 + serve）
│   ├── commands.ts             # Slash 命令实现
│   ├── agent/
│   │   ├── loop.ts             # ReAct 核心循环
│   │   └── types.ts            # 类型定义
│   ├── llm/
│   │   ├── client.ts           # LLMClient 接口
│   │   ├── openai.ts           # OpenAI-compatible 实现
│   │   └── anthropic.ts        # Anthropic 实现
│   ├── mcp/
│   │   ├── registry.ts         # MCP 注册中心（含 local tool）
│   │   ├── transport.ts        # stdio / SSE 传输层
│   │   └── installer.ts        # MCP Server 安装器
│   ├── session/
│   │   └── manager.ts          # 会话管理器（磁盘持久化）
│   ├── config/
│   │   └── index.ts            # 配置加载
│   ├── gateway/
│   │   ├── types.ts            # MessageGateway 接口
│   │   ├── factory.ts          # Gateway 工厂
│   │   ├── feishu-bot.ts       # 飞书 Bot 网关
│   │   └── session-router.ts   # PerChatSessionRouter
│   └── channel/
│       ├── types.ts            # NotificationChannel 接口
│       ├── factory.ts          # Channel 工厂
│       └── feishu-webhook.ts   # 飞书 Webhook 通道
├── tests/
│   ├── unit/
│   │   ├── agent-hooks.test.ts
│   │   ├── feishu-session-router.test.ts
│   │   └── feishu-webhook.test.ts
│   └── integration/
│       └── agent-loop.test.ts
├── CLAUDE.md                   # Claude Code 项目指南
├── package.json
└── tsconfig.json
```

---

## 测试策略

| 层级 | 覆盖 | 工具 |
|------|------|------|
| 单元测试 | Agent hooks、Feishu Webhook、Session Router | Vitest |
| 集成测试 | Agent 循环流转（Mock LLM + MCP） | Vitest |
| E2E（手动） | 真实连接 MCP Server 验证 | — |

---

## 后续规划

- 更多 Gateway 适配（企业微信、Slack、Discord）
- Redis 会话存储（支持多实例水平扩展）
- Subagent 并行查询
- K8s 部署（Gateway 无状态化）
