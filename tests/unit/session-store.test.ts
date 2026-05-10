import { describe, it, expect } from "vitest";
import { SessionStore } from "../../src/session/store.js";

describe("SessionStore", () => {
  it("should add and retrieve messages", () => {
    const store = new SessionStore(1000);
    store.add({ role: "user", content: "hello", timestamp: Date.now() });
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].content).toBe("hello");
  });

  it("should prune old messages when over limit", () => {
    const store = new SessionStore(1); // very small: ~4 chars
    store.add({ role: "user", content: "a", timestamp: 1 });
    store.add({ role: "user", content: "b", timestamp: 2 });
    store.add({ role: "user", content: "c", timestamp: 3 });
    store.add({ role: "user", content: "d", timestamp: 4 });
    store.add({ role: "user", content: "e", timestamp: 5 });
    expect(store.getAll().length).toBeLessThan(5);
    expect(store.getAll()[0].content).toBe("b"); // "a" was pruned, "b" is first kept
  });

  it("should keep at least 4 messages even when over limit", () => {
    const store = new SessionStore(1);
    store.add({ role: "user", content: "a", timestamp: 1 });
    store.add({ role: "user", content: "b", timestamp: 2 });
    store.add({ role: "user", content: "c", timestamp: 3 });
    store.add({ role: "user", content: "d", timestamp: 4 });
    expect(store.getAll()).toHaveLength(4);
  });

  it("should clear all messages", () => {
    const store = new SessionStore(1000);
    store.add({ role: "user", content: "hello", timestamp: Date.now() });
    store.clear();
    expect(store.getAll()).toHaveLength(0);
  });
});
