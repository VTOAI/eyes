# Agent CLI — 设计文档

## 概述

基于 TypeScript 的命令行 AI Agent，支持通用 MCP 工具扩展，优先对接国产大模型并兼容 OpenAI / Claude API。

### Why CLI First

先做 CLI 验证 Agent + MCP 的核心能力，下一阶段再包装为企业微信应用服务。

---

## 整体架构

```
┌────────────────────────────────────────────────────┐
│                  Agent CLI (终端交互)                 │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │              ReAct Loop                       │  │
│  │  User Input → LLM → Tool Call → LLM → Output │  │
│  └──────────────┬───────────────────────────────┘  │
│         ↕                   ↕                      │
│  ┌─────────────┐   ┌────────────────────────┐     │
│  │  LLM Client  │   │   Tool Call Router     │     │
│  │  (API 调用)   │   │  (统一 tool call 分发)  │     │
│  └─────────────┘   └───────────┬────────────┘     │
│                                │                   │
│  ┌─────────────────────────────▼────────────────┐  │
│  │           MCP Client Layer                    │  │
│  │  ┌──────────────────────────────────────┐    │  │
│  │  │  MCP Registry (动态加载)              │    │  │
│  │  │  ├─ 启动时连所有 MCP Server           │    │  │
│  │  │  ├─ 获取 tools list                  │    │  │
│  │  │  ├─ 暴露 unified call()              │    │  │
│  │  │  └─ 错误隔离                        │    │  │
│  │  └──────────────────────────────────────┘    │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────┐  ┌──────────────────────┐   │
│  │  会话管理器       │  │  配置加载             │   │
│  │  (in-memory)     │  │  .mcp.json / .env    │   │
│  └──────────────────┘  └──────────────────────┘   │
└────────────────────────────────────────────────────┘
```

## 组件设计

### 1. Agent Core — ReAct 循环

核心逻辑：

```
loop:
  response = llm.call(messages + tools)

  if response has tool_call:
    result = mcpRegistry.call(tool_call.name, tool_call.args)
    messages.append(tool_call, result)
    continue

  else:
    print(response.text)
    break
```

- 最大循环轮次：10 轮（防死循环）
- 上下文窗口：messages 累积，接近上限时丢弃最早的 tool_call ↔ result 对

### 2. LLM Client

抽象接口，支持两种实现：

```typescript
interface LLMClient {
  chat(messages: Message[], tools: Tool[]): Promise<ChatResponse>
}

type ChatResponse =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name: string; args: Record<string, any> }
```

| 实现 | 覆盖模型 | 备注 |
|------|---------|------|
| `OpenAICompatibleClient` | DeepSeek / GPT / 通义千问 / 智谱 / Moonshot 等 | 国产模型及 OpenAI |
| `AnthropicClient` | Claude Sonnet / Opus | 可选，兼容 Anthropic Messages API |

通过配置选择 LLM 后端，切换模型无需改代码。

### 3. MCP Registry

职责：
- 启动时读取 `.mcp.json`，连接所有配置的 MCP Server
- 自动发现每个 Server 的 tools 列表，合并后暴露给 LLM
- 调用时按 tool name 路由到对应的 Server 执行
- 单个 Server 故障不影响其他

支持的传输方式：
- **stdio** — 本地子进程通信（`command` + `args`）
- **HTTP** — 远程 MCP Server

配置格式（`.mcp.json`，兼容 Claude Code 生态）：

```json
{
  "mcpServers": {
    "prometheus": {
      "command": "node",
      "args": ["mcp-server-prometheus/index.js"]
    },
    "obs": {
      "url": "https://mcp.obs.cn/api/mcp"
    }
  }
}
```

### 4. 会话管理器

- 内存存储（CLI 场景，单用户够用）
- 按会话 ID 组织，每次启动自动创建新会话
- 每条消息包含 `{role, content, timestamp}`
- Token 上限策略：接近上限时丢弃最早的 tool_call ↔ result 对

### 5. 配置加载

| 配置项 | 来源 | 说明 |
|--------|------|------|
| LLM 类型 | 环境变量 / 配置文件 | openai / anthropic |
| API Key | 环境变量 | LLM_API_KEY |
| API Base URL | 环境变量 | LLM_BASE_URL |
| 模型名称 | 环境变量 / 配置文件 | LLM_MODEL |
| MCP 服务器 | `.mcp.json` | 同 Claude Code 格式 |

---

## 错误处理

| 场景 | 策略 |
|------|------|
| MCP Server 连接失败 | 重试 1 次，失败后返回错误给 LLM |
| LLM API 调用失败 | 退避重试 3 次，都失败则报错 |
| Tool 执行异常 | 错误信息作为 tool result 返回给 LLM |
| 循环达到最大轮次 | 停止并提示 |
| Tool Call 格式错误 | 跳过该调用，通知 LLM 重新生成 |

**核心原则**：Tool 执行失败不 Crash Agent，错误信息喂回 LLM 自行决策。

---

## 项目结构

```
agent-cli/
├── src/
│   ├── index.ts             # CLI 入口
│   ├── agent/
│   │   ├── loop.ts          # ReAct 核心循环
│   │   └── types.ts         # 类型定义
│   ├── llm/
│   │   ├── client.ts        # LLMClient 接口
│   │   ├── openai.ts        # OpenAI-compatible 实现
│   │   └── anthropic.ts     # Anthropic 实现 (可选)
│   ├── mcp/
│   │   ├── registry.ts      # MCP 注册中心
│   │   └── transport.ts     # stdio/HTTP 传输层
│   ├── session/
│   │   └── store.ts         # 会话管理器
│   └── config/
│       └── index.ts         # 配置加载
├── tests/
│   ├── unit/
│   │   ├── mcp-registry.test.ts
│   │   ├── llm-client.test.ts
│   │   └── session-store.test.ts
│   └── integration/
│       └── agent-loop.test.ts
├── .mcp.json                # MCP 服务器配置
├── package.json
└── tsconfig.json
```

---

## 测试策略

| 层级 | 覆盖 | 工具 |
|------|------|------|
| 单元测试 | MCP Registry、LLM Client、会话管理 | Vitest |
| 集成测试 | Agent 循环流转（Mock LLM + MCP） | Vitest |
| E2E（手动） | 真实连接 MCP Server 验证 | — |

---

## 后续规划（不在当前范围）

- 企业微信回调消息协议集成
- Redis 会话存储（支持多实例）
- Subagent 并行查询
- K8s 部署
