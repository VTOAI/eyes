import { describe, it, expect, vi } from "vitest";
import { PerChatSessionRouter } from "../../src/gateway/session-router.js";

describe("PerChatSessionRouter", () => {
  it("should return the same session for the same platform+chatId", () => {
    const router = new PerChatSessionRouter();
    const s1 = router.getSession("feishu", "chat-1");
    const s2 = router.getSession("feishu", "chat-1");
    expect(s1).toBe(s2);
  });

  it("should return different sessions for different platforms", () => {
    const router = new PerChatSessionRouter();
    const s1 = router.getSession("feishu", "chat-1");
    const s2 = router.getSession("wechat", "chat-1");
    expect(s1).not.toBe(s2);
  });

  it("should return different sessions for different chatIds", () => {
    const router = new PerChatSessionRouter();
    const s1 = router.getSession("feishu", "chat-1");
    const s2 = router.getSession("feishu", "chat-2");
    expect(s1).not.toBe(s2);
  });

  it("should implement SessionLike interface", () => {
    const router = new PerChatSessionRouter();
    const session = router.getSession("feishu", "chat-1");

    expect(typeof session.add).toBe("function");
    expect(typeof session.getAll).toBe("function");
    expect(typeof session.clear).toBe("function");
  });

  it("should clear a chat session", () => {
    const router = new PerChatSessionRouter();
    const s1 = router.getSession("feishu", "chat-1");
    router.clearChat("feishu", "chat-1");
    const s2 = router.getSession("feishu", "chat-1");
    expect(s1).not.toBe(s2); // cleared then recreated
  });
});
