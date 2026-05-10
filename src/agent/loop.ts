import { Message, LLMResponse, Tool } from "./types.js";
import { LLMClient } from "../llm/client.js";
import { MCPRegistry } from "../mcp/registry.js";
import { SessionStore } from "../session/store.js";

const SYSTEM_PROMPT = `You are an AI assistant with access to MCP tools.
You can use these tools to query monitoring data, analyze systems, and help with operations tasks.
When you need data, call the appropriate tool. Always explain what you're doing.`;

export class Agent {
  private llm: LLMClient;
  private mcp: MCPRegistry;
  private session: SessionStore;
  private maxIterations: number;

  constructor(
    llm: LLMClient,
    mcp: MCPRegistry,
    session: SessionStore,
    maxIterations = 10
  ) {
    this.llm = llm;
    this.mcp = mcp;
    this.session = session;
    this.maxIterations = maxIterations;
  }

  async run(userInput: string): Promise<string> {
    if (!userInput.trim()) {
      return "Please provide a non-empty message.";
    }

    this.session.add({ role: "user", content: userInput, timestamp: Date.now() });

    const tools = await this.mcp.listAllTools();

    for (let i = 0; i < this.maxIterations; i++) {
      // Build messages from session each iteration so pruning applies
      const messages: Message[] = [
        { role: "user", content: SYSTEM_PROMPT, timestamp: Date.now() },
        ...this.session.getAll(),
      ];

      const response = await this.llm.chat(messages, tools);

      if (response.type === "text") {
        if (!response.content.trim()) continue; // skip empty response, retry
        this.session.add({ role: "assistant", content: response.content, timestamp: Date.now() });
        return response.content;
      }

      // Handle tool call
      const tc = response.toolCall;
      const result = await this.mcp.callTool(tc.name, tc.args);

      this.session.add({
        role: "assistant",
        content: "",
        toolCallId: tc.id,
        toolName: tc.name,
        args: tc.args,
        timestamp: Date.now(),
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
    return timeoutMsg;
  }
}
