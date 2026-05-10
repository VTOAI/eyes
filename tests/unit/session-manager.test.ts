import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SessionManager } from "../../src/session/manager.js";

const SESSIONS_DIR = join(homedir(), ".eyes", "sessions");

describe("SessionManager", () => {
  beforeEach(() => {
    if (existsSync(SESSIONS_DIR)) rmSync(SESSIONS_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(SESSIONS_DIR)) rmSync(SESSIONS_DIR, { recursive: true });
  });

  it("loadOrCreate creates default session when no files exist", () => {
    const mgr = SessionManager.loadOrCreate();
    const sessions = mgr.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("default");
    expect(sessions[0].name).toBe("default");
  });

  it("createSession adds a new session and persists", () => {
    const mgr = SessionManager.loadOrCreate();
    mgr.createSession("debug");
    expect(mgr.listSessions()).toHaveLength(2);
    const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
    expect(files).toContain("debug.json");
  });

  it("switchSession changes active session", () => {
    const mgr = SessionManager.loadOrCreate();
    mgr.createSession("work");
    mgr.switchSession("work");
    expect(mgr.getActive().id).toBe("work");
  });

  it("deleteSession removes session", () => {
    const mgr = SessionManager.loadOrCreate();
    mgr.createSession("temp");
    mgr.deleteSession("temp");
    expect(mgr.listSessions()).toHaveLength(1);
  });

  it("deleteSession throws when deleting only session", () => {
    const mgr = SessionManager.loadOrCreate();
    expect(() => mgr.deleteSession("default")).toThrow("only session");
  });

  it("renameSession updates name and persists", () => {
    const mgr = SessionManager.loadOrCreate();
    mgr.renameSession("default", "main");
    expect(mgr.getActive().name).toBe("main");
  });

  it("add/getAll/clear delegate to active store", () => {
    const mgr = SessionManager.loadOrCreate();
    mgr.add({ role: "user", content: "hello", timestamp: 1 });
    mgr.add({ role: "assistant", content: "hi", timestamp: 2 });
    expect(mgr.getAll()).toHaveLength(2);
    mgr.clear();
    expect(mgr.getAll()).toHaveLength(0);
  });

  it("persists and restores messages across reloads", () => {
    const mgr1 = SessionManager.loadOrCreate();
    mgr1.add({ role: "user", content: "test message", timestamp: 1 });
    mgr1.save();

    const mgr2 = SessionManager.loadOrCreate();
    const msgs = mgr2.getAll();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("test message");
  });
});
