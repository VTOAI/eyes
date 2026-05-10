import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Message, SessionMetadata } from "../agent/types.js";
import { SessionStore } from "./store.js";

const SESSIONS_DIR = join(homedir(), ".eyes", "sessions");

export class SessionManager {
  private sessions: Map<string, { metadata: SessionMetadata; store: SessionStore }> = new Map();
  private activeId!: string;

  private constructor() {}

  static listFromDisk(): SessionMetadata[] {
    if (!existsSync(SESSIONS_DIR)) return [];
    const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
    const sessions: SessionMetadata[] = [];
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8"));
        sessions.push({
          id: f.replace(/\.json$/, ""),
          name: data.name ?? f.replace(/\.json$/, ""),
          createdAt: data.createdAt ?? 0,
          lastAccessedAt: data.lastAccessedAt ?? 0,
        });
      } catch {
        // Skip corrupt files
      }
    }
    return sessions.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
  }

  static loadOrCreate(resumeId?: string): SessionManager {
    const mgr = new SessionManager();

    if (!existsSync(SESSIONS_DIR)) {
      mkdirSync(SESSIONS_DIR, { recursive: true });
    }

    // Load existing sessions from disk
    const files = existsSync(SESSIONS_DIR)
      ? readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"))
      : [];

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

    if (resumeId) {
      if (!mgr.sessions.has(resumeId)) {
        throw new Error(`Session "${resumeId}" not found. Use /sessions list to see available sessions.`);
      }
      mgr.activeId = resumeId;
      const s = mgr.sessions.get(resumeId)!;
      s.metadata.lastAccessedAt = Date.now();
    } else {
      // Create new session for this window
      mgr.createSession(`session-${Date.now()}`);
    }

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
    this.activeId = id;
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
