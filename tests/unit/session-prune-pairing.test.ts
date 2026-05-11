import { describe, it, expect } from "vitest";
import { SessionStore } from "../../src/session/store.js";

describe("SessionStore prune pairing", () => {
  it("should remove tool_call and tool_result as a pair", () => {
    const store = new SessionStore(1); // maxChars = 4
    // Add tool_call + tool_result pair, then enough to trigger prune
    store.add({ role: "user", content: "hello", timestamp: 1 });
    store.add({
      role: "assistant", content: "", toolCallId: "tc1", toolName: "test",
      args: {}, timestamp: 2,
    });
    store.add({ role: "tool_result", content: "result", toolCallId: "tc1", toolName: "test", timestamp: 3 });
    store.add({ role: "user", content: "world", timestamp: 4 });
    store.add({ role: "user", content: "overflow", timestamp: 5 });

    const msgs = store.getAll();
    // Should have pruned the first "hello" user message, keeping the pair intact
    expect(msgs[0].role).not.toBe("tool_result");
  });

  it("should preserve tool_call/tool_result pairing after prune", () => {
    const store = new SessionStore(1);
    store.add({ role: "user", content: "a", timestamp: 1 });
    store.add({ role: "user", content: "b", timestamp: 2 });
    store.add({
      role: "assistant", content: "", toolCallId: "tc1", toolName: "t",
      args: {}, timestamp: 3,
    });
    store.add({ role: "tool_result", content: "c", toolCallId: "tc1", toolName: "t", timestamp: 4 });
    store.add({ role: "user", content: "d", timestamp: 5 });

    const msgs = store.getAll();
    // After prune, if a tool_call remains, its paired tool_result must follow
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === "assistant" && "toolCallId" in msgs[i]) {
        const next = msgs[i + 1];
        expect(next).toBeDefined();
        expect(next!.role).toBe("tool_result");
        if ("toolCallId" in next!) {
          expect(next.toolCallId).toBe((msgs[i] as { toolCallId: string }).toolCallId);
        }
      }
    }
  });

  it("should not leave orphaned tool_result without preceding tool_call", () => {
    const store = new SessionStore(1);
    // Fill with pairs to trigger pruning
    store.add({ role: "user", content: "x", timestamp: 1 });
    store.add({
      role: "assistant", content: "", toolCallId: "tc1", toolName: "t",
      args: {}, timestamp: 2,
    });
    store.add({ role: "tool_result", content: "y", toolCallId: "tc1", toolName: "t", timestamp: 3 });
    store.add({ role: "user", content: "z", timestamp: 4 });
    store.add({ role: "user", content: "overflow-msg", timestamp: 5 });

    const msgs = store.getAll();
    // First message should not be an orphaned tool_result
    expect(msgs[0].role).not.toBe("tool_result");

    // Every tool_result should follow a matching tool_call
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === "tool_result") {
        expect(i).toBeGreaterThan(0);
        const prev = msgs[i - 1];
        const hasToolCall = prev.role === "assistant" && "toolCallId" in prev;
        expect(hasToolCall).toBe(true);
      }
    }
  });
});
