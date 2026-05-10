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
  onUsage?: (usage: Usage | undefined, durationMs: number) => void;
  onComplete?: (response: string) => void;
}

export class Agent {
  private llm: LLMClient;
  private mcp: MCPRegistry;
  private session: SessionLike;
  private maxIterations: number;
  private knownServerDescriptions: string;

  constructor(
    llm: LLMClient,
    mcp: MCPRegistry,
    session: SessionLike,
    maxIterations = 10,
    knownServerDescriptions = "",
  ) {
    this.llm = llm;
    this.mcp = mcp;
    this.session = session;
    this.maxIterations = maxIterations;
    this.knownServerDescriptions = knownServerDescriptions;
  }

  async run(userInput: string, hooks?: AgentHooks, signal?: AbortSignal): Promise<string> {
    if (!userInput.trim()) {
      return "Please provide a non-empty message.";
    }

    signal?.throwIfAborted();

    this.session.add({ role: "user", content: userInput, timestamp: Date.now() });

    const streamCallbacks = hooks ? { onToken: (t: string) => hooks.onToken?.(t) } : undefined;

    for (let i = 0; i < this.maxIterations; i++) {
      signal?.throwIfAborted();

      hooks?.onStep?.({ type: "thinking" });

      const tools = await this.mcp.listAllTools();

      const messages: Message[] = [
        { role: "user", content: buildSystemPrompt(this.mcp, this.knownServerDescriptions), timestamp: Date.now() },
        ...this.session.getAll(),
      ];

      const t0 = Date.now();
      const response = await this.llm.chat(messages, tools, streamCallbacks, signal);
      const elapsed = Date.now() - t0;

      hooks?.onUsage?.(response.usage, elapsed);

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

  return `You are an AI assistant with access to MCP (Model Context Protocol) tools.
You can use these tools to query data, analyze systems, and help with operations tasks.
When you need data, call the appropriate tool. Always explain what you're doing.

${installed}

You have a built-in tool called "install_mcp_server" that can dynamically install
new MCP servers during this conversation. If a user asks for a capability you do not
currently have (database access, file operations, web search, browser automation, etc.),
use install_mcp_server to add it, then use the newly installed server's tools.
Only use install_mcp_server when the user explicitly asks for a new capability or
server — do not preemptively install servers.${known}`;
}
