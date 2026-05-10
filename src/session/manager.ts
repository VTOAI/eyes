import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Message, SessionMetadata } from "../agent/types.js";
import { SessionStore } from "./store.js";

const SESSIONS_DIR = join(homedir(), ".eyes", "sessions");

export class SessionManager {
  private sessions: Map<string, { metadata: SessionMetadata; store: SessionStore }> = new Map();
  private activeId: string;

  private constructor() {}

  static loadOrCreate(): SessionManager {
    const mgr = new SessionManager();

    if (!existsSync(SESSIONS_DIR)) {
      mkdirSync(SESSIONS_DIR, { recursive: true });
    }

    const files = existsSync(SESSIONS_DIR)
      ? readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"))
      : [];

    if (files.length === 0) {
      mgr.createSession("default");
    } else {
      for (const f of files) {
        const id = f.replace(/\.json$/, "");
        try {
          const raw = readFileSync(join(SESSIONS_DIR, f), "utf-8");
          const data = JSON.parse(raw);
          const store = new SessionStore();
          store.load(data.messages ?? []);
          mgr.sessions.set(id, {
            metadata: {
              id,
              name: data.name ?? id,
              createdAt: data.createdAt ?? Date.now(),
              lastAccessedAt: data.lastAccessedAt ?? Date.now(),
            },
            store,
          });
        } catch {
          // Skip corrupt session files
        }
      }

      if (mgr.sessions.size === 0) {
        mgr.createSession("default");
      }
    }

    // Activate most recently accessed session
    let mostRecent: { id: string; ts: number } | null = null;
    for (const [, s] of mgr.sessions) {
      if (!mostRecent || s.metadata.lastAccessedAt > mostRecent.ts) {
        mostRecent = { id: s.metadata.id, ts: s.metadata.lastAccessedAt };
      }
    }
    mgr.activeId = mostRecent!.id;
    return mgr;
  }

  createSession(name: string): SessionMetadata {
    const id = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
      || `session-${Date.now()}`;

    if (this.sessions.has(id)) {
      throw new Error(`Session "${id}" already exists.`);
    }

    const metadata: SessionMetadata = {
      id,
      name,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    };
    this.sessions.set(id, { metadata, store: new SessionStore() });
    this.saveSession(id);
    return metadata;
  }

  switchSession(id: string): SessionMetadata {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Session "${id}" not found.`);
    this.activeId = id;
    s.metadata.lastAccessedAt = Date.now();
    return s.metadata;
  }

  deleteSession(id: string): void {
    if (this.sessions.size <= 1) {
      throw new Error("Cannot delete the only session.");
    }
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Session "${id}" not found.`);

    this.sessions.delete(id);
    const file = join(SESSIONS_DIR, `${id}.json`);
    try { unlinkSync(file); } catch { /* ok */ }

    if (this.activeId === id) {
      const next = this.sessions.keys().next().value!;
      this.activeId = next;
    }
  }

  renameSession(id: string, newName: string): SessionMetadata {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Session "${id}" not found.`);
    s.metadata.name = newName;
    s.metadata.lastAccessedAt = Date.now();
    this.saveSession(id);
    return s.metadata;
  }

  listSessions(): SessionMetadata[] {
    return [...this.sessions.values()]
      .map((s) => s.metadata)
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
  }

  getActive(): SessionMetadata {
    return this.sessions.get(this.activeId)!.metadata;
  }

  // Delegate to active session store

  add(msg: Message): void {
    const active = this.sessions.get(this.activeId);
    if (!active) return;
    active.store.add(msg);
    active.metadata.lastAccessedAt = Date.now();
  }

  getAll(): Message[] {
    const active = this.sessions.get(this.activeId);
    return active ? active.store.getAll() : [];
  }

  clear(): void {
    const active = this.sessions.get(this.activeId);
    if (active) active.store.clear();
  }

  save(): void {
    this.saveSession(this.activeId);
  }

  private saveSession(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;

    if (!existsSync(SESSIONS_DIR)) {
      mkdirSync(SESSIONS_DIR, { recursive: true });
    }

    writeFileSync(
      join(SESSIONS_DIR, `${id}.json`),
      JSON.stringify({
        name: s.metadata.name,
        createdAt: s.metadata.createdAt,
        lastAccessedAt: s.metadata.lastAccessedAt,
        messages: s.store.getAll(),
      }, null, 2),
    );
  }
}
