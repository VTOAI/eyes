import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SessionStore } from "../session/store.js";

const SESSIONS_DIR = join(homedir(), ".eyes", "trigger-sessions");

export class TriggerSessionManager {
  private triggerName: string;
  private contextWindow: number;
  private sessions: Map<string, SessionStore> = new Map();

  constructor(triggerName: string, contextWindow: number) {
    this.triggerName = triggerName;
    this.contextWindow = contextWindow;

    if (!existsSync(SESSIONS_DIR)) {
      mkdirSync(SESSIONS_DIR, { recursive: true });
    }
  }

  getSession(userId: string): SessionStore {
    const existing = this.sessions.get(userId);
    if (existing) return existing;

    // Try to load from disk
    const loaded = this.loadFromDisk(userId);
    if (loaded) {
      this.sessions.set(userId, loaded);
      return loaded;
    }

    // Create new session
    const session = new SessionStore(this.contextWindow);
    this.sessions.set(userId, session);
    return session;
  }

  saveSession(userId: string): void {
    const session = this.sessions.get(userId);
    if (!session) return;

    if (!existsSync(SESSIONS_DIR)) {
      mkdirSync(SESSIONS_DIR, { recursive: true });
    }

    writeFileSync(
      join(SESSIONS_DIR, `${this.triggerName}-${userId}.json`),
      JSON.stringify({
        userId,
        triggerName: this.triggerName,
        lastAccessedAt: Date.now(),
        messages: session.getAll(),
      }, null, 2),
    );
  }

  private loadFromDisk(userId: string): SessionStore | null {
    const file = join(SESSIONS_DIR, `${this.triggerName}-${userId}.json`);
    if (!existsSync(file)) return null;

    try {
      const raw = readFileSync(file, "utf-8");
      const data = JSON.parse(raw);
      const session = new SessionStore(this.contextWindow);
      session.load(data.messages ?? []);
      return session;
    } catch {
      return null;
    }
  }

  clearExpired(maxAgeMs: number = 3600_000): void {
    if (!existsSync(SESSIONS_DIR)) return;

    const files = readdirSync(SESSIONS_DIR).filter((f) =>
      f.startsWith(`${this.triggerName}-`) && f.endsWith(".json")
    );

    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8"));
        if (Date.now() - data.lastAccessedAt > maxAgeMs) {
          unlinkSync(join(SESSIONS_DIR, f));
        }
      } catch {
        // Skip corrupt files
      }
    }
  }
}
