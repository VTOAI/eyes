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

  it("loadOrCreate creates new timestamp-based session by default", () => {
    const mgr = SessionManager.loadOrCreate();
    const sessions = mgr.listSessions();
    expect(sessions).toHaveLength(1);
    expect(mgr.getActive().id).toMatch(/^session-\d+$/);
  });

  it("each loadOrCreate call creates a different session", async () => {
    const mgr1 = SessionManager.loadOrCreate();
    await new Promise((r) => setTimeout(r, 1)); // ensure different timestamps
    const mgr2 = SessionManager.loadOrCreate();
    expect(mgr1.getActive().id).not.toBe(mgr2.getActive().id);
    expect(mgr2.listSessions()).toHaveLength(2);
  });

  it("loadOrCreate resumes specific session when resumeId provided", () => {
    const mgr1 = SessionManager.loadOrCreate();
    const id = mgr1.getActive().id;
    mgr1.add({ role: "user", content: "test", timestamp: 1 });
    mgr1.save();

    const mgr2 = SessionManager.loadOrCreate(id);
    expect(mgr2.getActive().id).toBe(id);
    expect(mgr2.getAll()).toHaveLength(1);
    expect(mgr2.getAll()[0].content).toBe("test");
  });

  it("loadOrCreate throws when resumeId not found", () => {
    expect(() => SessionManager.loadOrCreate("nonexistent")).toThrow("not found");
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
    const id = mgr.getActive().id;
    mgr.createSession("temp");
    mgr.deleteSession("temp");
    expect(mgr.listSessions()).toHaveLength(1);
    expect(mgr.getActive().id).toBe(id);
  });

  it("deleteSession throws when deleting only session", () => {
    const mgr = SessionManager.loadOrCreate();
    const id = mgr.getActive().id;
    expect(() => mgr.deleteSession(id)).toThrow("only session");
  });

  it("renameSession updates name and persists", () => {
    const mgr = SessionManager.loadOrCreate();
    const id = mgr.getActive().id;
    mgr.renameSession(id, "main");
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

  it("persists and restores messages via resumeId", () => {
    const mgr1 = SessionManager.loadOrCreate();
    const id = mgr1.getActive().id;
    mgr1.add({ role: "user", content: "test message", timestamp: 1 });
    mgr1.save();

    const mgr2 = SessionManager.loadOrCreate(id);
    const msgs = mgr2.getAll();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("test message");
  });
});
