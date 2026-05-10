import { describe, it, expect, vi, beforeEach } from "vitest";
import { Agent } from "../../src/agent/loop.js";
import { LLMClient } from "../../src/llm/client.js";
import { MCPRegistry } from "../../src/mcp/registry.js";
import { SessionStore } from "../../src/session/store.js";

function createMockLLM(responses: Array<{ type: "text" | "tool_call"; content?: string; toolCall?: any }>): LLMClient {
  let callIndex = 0;
  return {
    async chat() {
      const r = responses[callIndex];
      callIndex = Math.min(callIndex + 1, responses.length - 1);

      if (r.type === "text") {
        return { type: "text", content: r.content || "" };
      }
      return {
        type: "tool_call",
        toolCall: r.toolCall || { id: "call_1", name: "test_tool", args: {} },
      };
    },
  };
}

function createMockMCP(toolResults: Record<string, string>): MCPRegistry {
  return {
    listAllTools: vi.fn().mockResolvedValue([{ name: "test_tool", description: "A test tool", inputSchema: { type: "object" } }]),
    callTool: vi.fn().mockImplementation(async (name: string) => toolResults[name] || `Result from ${name}`),
    listServers: vi.fn().mockReturnValue([]),
    initialize: vi.fn(),
    close: vi.fn(),
  } as any;
}

describe("Agent", () => {
  let session: SessionStore;

  beforeEach(() => {
    session = new SessionStore(1000);
  });

  it("should return direct text response without tool calls", async () => {
    const llm = createMockLLM([{ type: "text", content: "Hello, user!" }]);
    const mcp = createMockMCP({});
    const agent = new Agent(llm, mcp, session, 10);

    const result = await agent.run("hi");
    expect(result).toBe("Hello, user!");
  });

  it("should execute tool call then return text", async () => {
    const llm = createMockLLM([
      { type: "tool_call", toolCall: { id: "tc_1", name: "test_tool", args: { q: "cpu" } } },
      { type: "text", content: "CPU usage is 85%" },
    ]);
    const mcp = createMockMCP({ test_tool: "CPU: 85%" });
    const agent = new Agent(llm, mcp, session, 10);

    const result = await agent.run("check cpu");
    expect(result).toBe("CPU usage is 85%");
    expect(mcp.callTool).toHaveBeenCalledWith("test_tool", { q: "cpu" });
  });

  it("should stop after max iterations and return timeout message", async () => {
    const llm = createMockLLM([
      { type: "tool_call", toolCall: { id: "tc_1", name: "test_tool", args: {} } },
      { type: "tool_call", toolCall: { id: "tc_2", name: "test_tool", args: {} } },
      { type: "tool_call", toolCall: { id: "tc_3", name: "test_tool", args: {} } },
    ]);
    const mcp = createMockMCP({ test_tool: "some data" });
    const agent = new Agent(llm, mcp, session, 2);

    const result = await agent.run("loop");
    expect(result).toContain("maximum");
  });

  it("should store conversation in session", async () => {
    const llm = createMockLLM([{ type: "text", content: "Response" }]);
    const mcp = createMockMCP({});
    const agent = new Agent(llm, mcp, session, 10);

    await agent.run("first message");
    expect(session.getAll().length).toBeGreaterThanOrEqual(2); // user msg + assistant reply
  });
});
