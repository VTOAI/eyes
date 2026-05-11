import { describe, it, expect, vi } from "vitest";
import { Agent } from "../../src/agent/loop.js";
import { LLMClient } from "../../src/llm/client.js";
import { MCPRegistry } from "../../src/mcp/registry.js";
import { SessionStore } from "../../src/session/store.js";

describe("Agent abort signal", () => {
  it("should throw AbortError when signal is already aborted before run", async () => {
    const session = new SessionStore(1000);
    const ac = new AbortController();
    ac.abort(); // Pre-abort

    const llm: LLMClient = {
      async chat() {
        return { type: "text", content: "should not reach" };
      },
    };

    const mcp = {
      listAllTools: vi.fn().mockResolvedValue([]),
      callTool: vi.fn(),
      listServers: vi.fn().mockReturnValue([]),
    } as any;

    const agent = new Agent(llm, mcp, session, 10);
    await expect(agent.run("test", undefined, ac.signal)).rejects.toThrow();
  });

  it("should abort between tool call and next LLM call", async () => {
    const session = new SessionStore(1000);
    const ac = new AbortController();

    let callCount = 0;
    const llm: LLMClient = {
      async chat(_msgs, _tools, _cb, signal) {
        callCount++;
        if (callCount === 1) {
          // First call: return tool_call
          return {
            type: "tool_call",
            toolCall: { id: "tc1", name: "abortable", args: {} },
          };
        }
        // Second call: check signal
        signal?.throwIfAborted();
        return { type: "text", content: "should not reach" };
      },
    };

    const mcp = {
      listAllTools: vi.fn().mockResolvedValue([{ name: "abortable", description: "", inputSchema: {} }]),
      callTool: vi.fn().mockImplementation(async () => {
        // Abort during tool execution
        ac.abort();
        return "tool result";
      }),
      listServers: vi.fn().mockReturnValue([{ name: "test", toolCount: 1 }]),
    } as any;

    const agent = new Agent(llm, mcp, session, 10);
    await expect(agent.run("test abort", undefined, ac.signal)).rejects.toThrow();
  });

  it("should complete normally when signal is not aborted", async () => {
    const session = new SessionStore(1000);
    const ac = new AbortController();

    const llm: LLMClient = {
      async chat() {
        return { type: "text", content: "all good" };
      },
    };

    const mcp = {
      listAllTools: vi.fn().mockResolvedValue([]),
      callTool: vi.fn(),
      listServers: vi.fn().mockReturnValue([]),
    } as any;

    const agent = new Agent(llm, mcp, session, 10);
    const result = await agent.run("test", undefined, ac.signal);
    expect(result).toBe("all good");
  });
});
