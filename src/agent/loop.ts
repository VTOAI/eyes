import { Message, LLMResponse, Tool, Usage } from "./types.js";
import { LLMClient } from "../llm/client.js";
import { MCPRegistry } from "../mcp/registry.js";

export interface SessionLike {
  add(msg: Message): void;
  getAll(): Message[];
  clear(): void;
}

export interface AgentHooks {
  onStep?: (step: { type: "thinking" | "tool_call" | "tool_result"; content?: string; name?: string; args?: Record<string, unknown> }) => void;
  onToken?: (token: string) => void;
  onUsage?: (usage: Usage | undefined, durationMs: number, contextInfo?: { usedTokens: number; maxTokens: number }) => void;
  onComplete?: (response: string) => void;
}

export class Agent {
  private llm: LLMClient;
  private mcp: MCPRegistry;
  private session: SessionLike;
  private maxIterations: number;
  private knownServerDescriptions: string;
  private contextWindow: number;

  constructor(
    llm: LLMClient,
    mcp: MCPRegistry,
    session: SessionLike,
    maxIterations = 10,
    knownServerDescriptions = "",
    contextWindow = 128_000,
  ) {
    this.llm = llm;
    this.mcp = mcp;
    this.session = session;
    this.maxIterations = maxIterations;
    this.knownServerDescriptions = knownServerDescriptions;
    this.contextWindow = contextWindow;
  }

  async run(userInput: string, hooks?: AgentHooks, signal?: AbortSignal): Promise<string> {
    if (!userInput.trim()) {
      return "Please provide a non-empty message.";
    }

    signal?.throwIfAborted();

    this.session.add({ role: "user", content: userInput, timestamp: Date.now() });

    const streamCallbacks = hooks ? { onToken: (t: string) => hooks.onToken?.(t) } : undefined;

    let sameToolCount = 0;
    let lastToolName = "";

    for (let i = 0; i < this.maxIterations; i++) {
      signal?.throwIfAborted();

      hooks?.onStep?.({ type: "thinking" });

      const tools = await this.mcp.listAllTools();
      const systemPrompt = buildSystemPrompt(this.mcp, this.knownServerDescriptions);

      const messages: Message[] = [
        { role: "system", content: systemPrompt, timestamp: Date.now() },
        ...this.session.getAll(),
      ];

      const t0 = Date.now();
      const response = await this.llm.chat(messages, tools, streamCallbacks, signal);
      const elapsed = Date.now() - t0;

      const sessionTokens = (this.session as any).getEstimatedTokens?.() ?? 0;
      const usedTokens = Math.ceil(systemPrompt.length / 4) + sessionTokens;
      hooks?.onUsage?.(response.usage, elapsed, { usedTokens, maxTokens: this.contextWindow });

      if (response.type === "text") {
        if (!response.content.trim()) continue;
        this.session.add({
          role: "assistant",
          content: response.content,
          timestamp: Date.now(),
          ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
        });
        hooks?.onComplete?.(response.content);
        return response.content;
      }

      // Handle tool call
      const tc = response.toolCall;

      // Detect tool-calling loops: same tool + same args repeatedly → stop
      const argKey = JSON.stringify(tc.args);
      const toolKey = `${tc.name}:${argKey}`;
      if (toolKey === lastToolName) {
        sameToolCount++;
      } else {
        sameToolCount = 1;
        lastToolName = toolKey;
      }
      if (sameToolCount >= 3) {
        const msg = "已调用同一工具多次，请换个方式描述你的需求。";
        this.session.add({ role: "assistant", content: msg, timestamp: Date.now() });
        hooks?.onComplete?.(msg);
        return msg;
      }

      hooks?.onStep?.({ type: "tool_call", name: tc.name, args: tc.args });

      const result = await this.mcp.callTool(tc.name, tc.args);

      hooks?.onStep?.({ type: "tool_result", content: result });

      this.session.add({
        role: "assistant",
        content: "",
        toolCallId: tc.id,
        toolName: tc.name,
        args: tc.args,
        timestamp: Date.now(),
        ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
      });
      this.session.add({
        role: "tool_result",
        content: result,
        toolCallId: tc.id,
        toolName: tc.name,
        timestamp: Date.now(),
      });
    }

    const timeoutMsg = "I've reached the maximum number of tool call iterations. Please try simplifying your request.";
    this.session.add({ role: "assistant", content: timeoutMsg, timestamp: Date.now() });
    hooks?.onComplete?.(timeoutMsg);
    return timeoutMsg;
  }
}

function buildSystemPrompt(mcp: MCPRegistry, knownDescriptions: string): string {
  const servers = mcp.listServers();
  const installed = servers.length > 0
    ? `Currently connected MCP servers: ${servers.map((s) => `${s.name} (${s.toolCount} tools)`).join(", ")}.`
    : "No MCP servers are currently connected.";

  const known = knownDescriptions
    ? `\n\nCommon MCP servers you can install:\n${knownDescriptions}`
    : "";

  return `You are a helpful AI assistant.
Reply directly to the user's message. Only call a tool when it is clearly necessary to fulfill the user's request.

Important rules:
- If the user just says hello, asks a general question, or wants to chat — respond with text, do NOT call any tool.
- Only call tools when the user explicitly asks you to do something that requires external data or actions (query a database, read a file, search the web, etc.).
- After calling a tool, review the result and provide a final text response to the user. Do not keep calling tools in a loop.

${installed}

You have a built-in tool called "install_mcp_server" that can dynamically install
new MCP servers. Only use this when the user explicitly asks for a specific capability
you don't currently have — never preemptively install servers.${known}`;
}
