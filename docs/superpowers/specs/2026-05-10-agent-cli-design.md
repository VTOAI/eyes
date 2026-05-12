# Agent CLI — 设计文档

## 概述

基于 TypeScript 的命令行 AI Agent，支持通用 MCP 工具扩展，兼容 OpenAI / Anthropic API，支持飞书/企业微信 Bot 网关、告警事件 Trigger 系统和通知推送，具备上下文窗口管理和精确 token 计数。

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
│  │    ├─ 上下文窗口管理（tiktoken 精确计数 + 前置裁剪）         │  │
│  │    ├─ 工具循环检测（同工具+同参数连续3次自动停止）           │  │
│  │    └─ 流式输出 + 实时 token/耗时展示                        │  │
│  └──────────────────┬─────────────────────────────────────────┘  │
│         ↕                       ↕                                │
│  ┌─────────────┐     ┌──────────────────────────┐               │
│  │  LLM Client  │     │     MCP Registry          │               │
│  │  (OpenAI /   │     │  ┌────────────────────┐  │               │
│  │   Anthropic) │     │  │ MCP Tools (stdio/  │  │               │
│  │  ├─ max_tokens│     │  │ SSE)               │  │               │
│  └─────────────┘     │  ├─ 启动时连接         │  │               │
│                       │  ├─ 获取 tools list   │  │               │
│  ┌──────────────────┐ │  ├─ unified call()   │  │               │
│  │  上下文管理       │ │  ├─ 错误隔离          │  │               │
│  │  ├─ tiktoken     │ │  └────────────────────┘  │               │
│  │  │  cl100k_base  │ │  ┌────────────────────┐  │               │
│  │  ├─ 前置裁剪      │ │  │ Local Tools        │  │               │
│  │  │  (85% 阈值)   │ │  │ (程序注册的本地工具) │  │               │
│  │  └─ 配对保护      │ │  └────────────────────┘  │               │
│  └──────────────────┘ └──────────────────────────┘               │
│                                                                  │
│  ┌──────────────────┐                                           │
│  │  会话管理器       │                                           │
│  │  ├─ 磁盘持久化    │                                           │
│  │  ├─ SessionStore  │                                           │
│  │  │  自动裁剪      │                                           │
│  │  └─ 多会话 CRUD   │                                           │
│  └──────────────────┘                                           │
│                                                                  │
│  ┌──────────────────┐                                           │
│  │  配置加载         │                                           │
│  │  ~/.eyes/        │                                           │
│  │  config.json     │                                           │
│  │  ├─ contextWindow│                                           │
│  │  └─ maxOutputTok │                                           │
│  └──────────────────┘                                           │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │               Gateway / Trigger / Channel Layer              │  │
│  │  ┌──────────────────────────┐  ┌──────────────────────┐   │  │
│  │  │ Message Gateway           │  │ Trigger System        │   │  │
│  │  │ ├─ FeishuBotGateway       │  │ ├─ TriggerServer      │   │  │
│  │  │ ├─ WecomBotGateway        │  │ │  统一端口 + 路径路由 │   │  │
│  │  │ ├─ WecomAiBotGateway (WS) │  │ ├─ FlashDutyReceiver  │   │  │
│  │  │ └─ 流式回复 + Markdown    │  │ ├─ GenericReceiver    │   │  │
│  │  └──────────────────────────┘  │ └─ 企微回调 + 会话延续 │   │  │
│  │                                 └──────────────────────┘   │  │
│  │  ┌──────────────────────────┐                              │  │
│  │  │ Notification Channel      │                              │  │
│  │  │ ├─ FeishuWebhook          │                              │  │
│  │  │ └─ WecomWebhook           │                              │  │
│  │  └──────────────────────────┘                              │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │           PerChatSessionRouter                              │  │
│  │    platform + chatId → 独立 Agent Session                   │  │
│  │    ├─ 上下文窗口限制传递                                      │  │
│  │    └─ SessionStore 自动裁剪                                  │  │
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
    // 工具循环检测：同工具+同参数连续3次自动停止
    if tool_call.name + args === last_tool_call:
      loop_count++
      if loop_count >= 3: break  // 防止死循环
    else:
      loop_count = 1

    result = mcpRegistry.call(tool_call.name, tool_call.args)
    messages.append(tool_call, result)
    continue

  else:
    print(response.text)
    break
```

- 最大循环轮次：可配置（默认 10 轮），防死循环
- 工具循环检测：对比 `toolName + JSON.stringify(args)`，同工具同参数连续 3 次自动停止
- **上下文窗口管理**：
  - 使用 `tiktoken` (cl100k_base 编码) 精确计数，覆盖 DeepSeek/OpenAI 模型
  - 每次 LLM 调用前进行前置裁剪（85% 阈值），防止超窗口报错
  - 裁剪时保护 tool-call/tool-result 配对，至少保留最后 4 条消息
  - 工具定义额外估算 200 tokens/个
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
| `OpenAICompatibleClient` | DeepSeek / GPT / 通义千问 / 智谱 / Moonshot 等 | 国产模型及 OpenAI，支持 reasoning_content，支持 `max_tokens` 限制 |
| `AnthropicClient` | Claude Sonnet / Opus | 兼容 Anthropic Messages API，支持 `max_tokens` 限制 |

通过配置选择 LLM 后端，切换模型无需改代码。reasoningContent 字段透传推理过程（如 DeepSeek R1）。`maxOutputTokens` 通过 AgentConfig 传递给 LLM Client，控制每次 API 调用的最大输出长度。

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
- `SessionManager` — 多会话 CRUD（list/new/switch/delete/rename）
- `SessionStore` — 单会话消息存储，内置裁剪机制：
  - 添加消息时若超出上下文窗口限制自动裁剪老旧消息
  - 保护 tool-call/tool-result 配对不被拆散
  - 支持配置化的 `maxTokens` 上限
- `eyes resume <id>` 恢复历史会话
- `eyes sessions list` 在非交互模式下也可用（直接从磁盘读取）
- 每条消息包含 `{role, content, timestamp, reasoningContent?, toolCallId?, toolName?, args?}`

### 5. 配置加载

单文件配置 `~/.eyes/config.json`：

```json
{
  "serve": {
    "port": 9095
  },
  "llm": {
    "type": "openai | anthropic",
    "apiKey": "...",
    "baseURL": "https://api.openai.com/v1",
    "model": "gpt-4o",
    "contextWindow": 128000,
    "maxOutputTokens": 4096
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
  "triggers": [
    {
      "type": "flashduty",
      "name": "prod-alerts",
      "path": "/trigger/flashduty",
      "notifyLabel": "wecom_users",
      "messenger": {
        "type": "wecom-app",
        "corpid": "...",
        "corpsecret": "...",
        "agentId": "1000004"
      }
    }
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
| 上下文窗口 | `CONTEXT_WINDOW` | 默认 128000 |
| 最大输出长度 | `MAX_OUTPUT_TOKENS` | 默认 4096 |
| 最大迭代 | `MAX_ITERATIONS` | 默认 10 |
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

**已实现**：

| Gateway | 传输 | 说明 |
|---------|------|------|
| `FeishuBotGateway` | WebSocket | 飞书 Bot 长连接，Markdown 回复 |
| `WecomBotGateway` | HTTP Callback | 企业微信机器人回调，Markdown 回复，WXBizMsgCrypt 加解密 |
| `WecomAiBotGateway` | WebSocket | 企业微信 AI Bot 长连接，流式回复（全量覆盖模式），支持单聊和群聊 |

所有 Gateway 通过 `PerChatSessionRouter` 管理会话，确保同平台同会话的消息共享上下文。上下文窗口限制通过 Agent 构造函数传递。

### 7. Trigger — 告警事件入口

接收外部监控平台（FlashDuty、AlertManager、Grafana 等）的 webhook 推送，独立分析后通过 Messenger 推送给指定人员：

```
外部 webhook → TriggerServer (统一端口) → 解析适配器 → Agent 独立分析 → Messenger 推送
                                                                       → Channel 推送
```

**统一 HTTP Server**：
- 单端口（默认 9095，通过 `serve.port` 配置）
- 按 URL path 路由到不同 Trigger：`POST /trigger/flashduty`、`POST /trigger/generic`
- 支持 GET echostr 验证（企业微信回调 URL 认证）

**核心接口**：

```typescript
interface AlertEvent {
  source: string;
  alertId: string;
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  raw: unknown;
}

interface AlertReceiver {
  readonly name: string;
  readonly path: string;
  parse(body: Record<string, unknown>): AlertEvent[];
  onAlert: (event: AlertEvent) => Promise<string>;
  onMessage?: (userId: string, message: string) => Promise<string>;
  decryptMessage?: (encrypted: string) => string;
  verify?: (req, res) => boolean;
}
```

**已实现**：

| Trigger | 说明 |
|---------|------|
| `FlashDutyReceiver` | 解析 FlashDuty webhook，仅处理 `i_new` 事件，自动提取 labels 中的通知对象 |
| `GenericReceiver` | 通用 JSONPath 适配器，通过 `jsonPath*` 配置字段映射，适配任意 webhook 格式 |

**消息路由**：
- `parse()` — 将原始 webhook body 解析为 `AlertEvent[]`
- `onAlert()` — 触发独立 Agent 分析（新 SessionStore，中文 system prompt）
- `onMessage()` — 用户回复后继续对话，复用已有会话上下文
- `decryptMessage()` — 解密企业微信消息回调

**告警分析流程**：
1. 创建独立 `SessionStore`（不共享网关会话）
2. 构建中文 system prompt，包含告警详情和诊断任务
3. Agent 调用 MCP 工具查询相关系统/指标
4. 输出企业微信兼容 Markdown（禁止表格，支持标题/加粗/列表/代码块）
5. 会话持久化到 `~/.eyes/trigger-sessions/`，支持后续追问

**去重 & 限流**：
- `AlertDedup`：基于 `source:alertId` 在 cooldown 内去重（默认 300s）
- `ConcurrencyLimiter`：最大并发分析数（默认 3）

**会话延续**（追问）：
- 首次分析后保存 SessionStore 到磁盘
- 用户通过企业微信应用回复时，企业微信 POST 回调到 trigger 路径
- 解密回调消息，提取用户 ID 和消息内容
- 找到该用户的会话，继续 Agent 对话
- 回复通过 Messenger 推送回用户

### 8. Messenger — 应用消息推送

通过企业微信应用主动向用户发送消息：

```typescript
interface Messenger {
  readonly name: string;
  send(to: string[], title: string, content: string): Promise<void>;
}
```

**已实现**：`WecomAppMessenger` — 使用企业微信 `/cgi-bin/message/send` API 发送 Markdown 消息，自动按 4096 字节分段，支持 `callbackToken` + `callbackAesKey` 配置。

### 9. Channel — 通知通道

Agent 完成后主动向外部平台推送消息：

```typescript
interface NotificationChannel {
  readonly name: string;
  send(text: string): Promise<void>;
}
```

**已实现**：`FeishuWebhookChannel`、`WecomWebhookChannel` — 通过飞书/企业微信 Webhook URL 发送通知。LLM 可通过 `send_notification` 本地工具指定 channel 名称推送消息。

### 10. PerChatSessionRouter

Gateway 层的会话路由：

```
platform + chatId → Agent Session
```

同一平台同会话的所有消息共享同一个 Agent Session，保持对话上下文。接收 `maxTokens` 参数并传递给内部 `SessionStore`，支持自动裁剪。

### 11. eyes serve — 后台网关服务

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
| 上下文窗口接近上限 | 前置裁剪（85% 阈值），移除最旧消息，保护 tool 配对 |
| Tool 执行异常 | 错误信息作为 tool result 返回给 LLM |
| 循环达到最大轮次 | 停止并返回超时提示 |
| 工具循环检测触发 | 同工具+同参数连续 3 次自动停止，提示换个方式描述 |
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
│   │   ├── loop.ts             # ReAct 核心循环（含上下文管理 + 循环检测）
│   │   └── types.ts            # 类型定义（Message, Tool, AgentConfig 等）
│   ├── context/
│   │   └── tokenizer.ts        # tiktoken 封装（cl100k_base，精确 token 计数）
│   ├── llm/
│   │   ├── client.ts           # LLMClient 接口
│   │   ├── openai.ts           # OpenAI-compatible 实现（含 reasoning_content）
│   │   └── anthropic.ts        # Anthropic 实现
│   ├── mcp/
│   │   ├── registry.ts         # MCP 注册中心（含 local tool）
│   │   ├── transport.ts        # stdio / SSE 传输层
│   │   └── installer.ts        # MCP Server 安装器
│   ├── session/
│   │   ├── manager.ts          # 会话管理器（多会话 CRUD + 磁盘持久化）
│   │   └── store.ts            # SessionStore（单会话消息存储 + 自动裁剪）
│   ├── config/
│   │   └── index.ts            # 配置加载（含 contextWindow, maxOutputTokens）
│   ├── gateway/
│   │   ├── types.ts            # MessageGateway 接口
│   │   ├── factory.ts          # Gateway 工厂（含 contextWindow 传递）
│   │   ├── feishu-bot.ts       # 飞书 Bot 网关（WebSocket）
│   │   ├── wecom-bot.ts        # 企业微信机器人网关（HTTP Callback + 加解密）
│   │   ├── wecom-aibot.ts      # 企业微信 AI Bot 网关（WebSocket + 流式回复）
│   │   └── session-router.ts   # PerChatSessionRouter（含 maxTokens）
│   ├── trigger/
│   │   ├── types.ts            # AlertEvent / AlertReceiver 接口
│   │   ├── factory.ts          # Trigger 工厂（动态 import）
│   │   ├── server.ts           # 统一 HTTP Server + 路径路由、企微回调处理
│   │   ├── analyzer.ts         # 告警分析（中文 prompt + 会话延续）
│   │   ├── flashduty.ts        # FlashDuty webhook 适配器
│   │   ├── generic.ts          # 通用 JSONPath webhook 适配器
│   │   ├── dedup.ts            # 去重（AlertDedup） + 限流（ConcurrencyLimiter）
│   │   ├── sessions.ts         # TriggerSessionManager（磁盘持久化）
│   │   └── wecom-verify.ts     # 企业微信回调验证 + 解密
│   ├── messenger/
│   │   ├── types.ts            # Messenger 接口
│   │   └── wecom.ts            # WecomAppMessenger（4096 字节分段）
│   └── channel/
│       ├── types.ts            # NotificationChannel 接口
│       ├── factory.ts          # Channel 工厂
│       ├── feishu-webhook.ts   # 飞书 Webhook 通道
│       └── wecom-webhook.ts    # 企业微信 Webhook 通道
├── tests/
│   ├── unit/
│   │   ├── agent-hooks.test.ts
│   │   ├── agent-abort.test.ts
│   │   ├── config-loading.test.ts
│   │   ├── feishu-session-router.test.ts
│   │   ├── feishu-webhook.test.ts
│   │   ├── llm-client.test.ts
│   │   ├── mcp-registry.test.ts
│   │   ├── session-manager.test.ts
│   │   ├── session-prune-pairing.test.ts
│   │   ├── session-store.test.ts
│   │   ├── trigger-analyzer.test.ts
│   │   ├── trigger-dedup.test.ts
│   │   ├── trigger-flashduty.test.ts
│   │   ├── trigger-generic.test.ts
│   │   ├── wecom-aibot.test.ts
│   │   ├── wecom-gateway.test.ts
│   │   └── wecom-webhook.test.ts
│   └── integration/
│       └── agent-loop.test.ts
├── CLAUDE.md                   # Claude Code 项目指南
├── README.md
├── package.json
└── tsconfig.json
```

---

## 测试策略

| 层级 | 覆盖 | 工具 |
|------|------|------|
| 单元测试 | Agent hooks/abort、Session Store/Manager/Prune、LLM Client、MCP Registry、Config Loading、Feishu/Wecom Gateway/Webhook、Session Router、Trigger/Dedup/Analyzer/FlashDuty/Generic | Vitest |
| 集成测试 | Agent 循环流转（Mock LLM + MCP） | Vitest |
| E2E（手动） | 真实连接 MCP Server 验证 | — |

共 18 个测试文件，88 个测试用例，覆盖所有核心模块。

---

## 后续规划

- ~~企业微信 Gateway~~ ✅ 已完成（Bot + AI Bot 双模式）
- ~~告警 Trigger 系统~~ ✅ 已完成（统一 HTTP Server + FlashDuty/Generic 适配器 + 企业微信 Messenger + 会话延续）
- 更多 Gateway 适配（Slack、Discord、钉钉）
- Redis 会话存储（支持多实例水平扩展）
- Subagent 并行查询
- K8s 部署（Gateway 无状态化）
- 上下文智能总结（超出窗口时自动压缩而非简单裁剪）
