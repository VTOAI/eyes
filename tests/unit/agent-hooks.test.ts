import { describe, it, expect, vi } from "vitest";
import { Agent, AgentHooks, SessionLike } from "../../src/agent/loop.js";
import { LLMResponse, Message, Tool } from "../../src/agent/types.js";

describe("AgentHooks onComplete", () => {
  it("should fire onComplete when LLM returns text", async () => {
    let completeText = "";
    const hooks: AgentHooks = {
      onComplete: (text: string) => { completeText = text; },
    };

    const mockLLM = {
      chat: vi.fn().mockResolvedValue({ type: "text", content: "Hello world" } as LLMResponse),
    };

    const session: SessionLike = {
      add: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
    };

    const mockMCP = {
      listAllTools: vi.fn().mockResolvedValue([]),
      listServers: vi.fn().mockReturnValue([]),
    };

    const agent = new Agent(mockLLM as any, mockMCP as any, session, 5);
    const result = await agent.run("hi", hooks);

    expect(result).toBe("Hello world");
    expect(completeText).toBe("Hello world");
  });

  it("should NOT fire onComplete on tool_call responses (only final text)", async () => {
    const onComplete = vi.fn();
    const hooks: AgentHooks = { onComplete };

    // First call: tool_call, second call: text
    const mockLLM = {
      chat: vi.fn()
        .mockResolvedValueOnce({
          type: "tool_call",
          toolCall: { id: "1", name: "some_tool", args: {} },
        } as LLMResponse)
        .mockResolvedValueOnce({ type: "text", content: "Done" } as LLMResponse),
    };

    const session: SessionLike = {
      add: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
    };

    const mockMCP = {
      listAllTools: vi.fn().mockResolvedValue([]),
      listServers: vi.fn().mockReturnValue([]),
      callTool: vi.fn().mockResolvedValue("tool result"),
    };

    const agent = new Agent(mockLLM as any, mockMCP as any, session, 5);
    const result = await agent.run("do something", hooks);

    expect(result).toBe("Done");
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("Done");
  });
});
