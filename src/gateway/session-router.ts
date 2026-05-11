import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SessionStore } from "../session/store.js";
import { SessionLike } from "../agent/loop.js";

const GATEWAY_SESSIONS_DIR = join(homedir(), ".eyes", "gateway-sessions");

/**
 * Manages per-chat session isolation for gateways.
 * Each chat (keyed by platform + chatId) gets its own session store,
 * persisted to disk so history survives restarts.
 */
export class PerChatSessionRouter {
  private stores = new Map<string, SessionStore>();

  private key(platform: string, chatId: string): string {
    return `${platform}:${chatId}`;
  }

  getSession(platform: string, chatId: string): SessionLike {
    const k = this.key(platform, chatId);
    if (!this.stores.has(k)) {
      const store = new SessionStore();
      // Try to load persisted messages from disk
      const file = join(GATEWAY_SESSIONS_DIR, `${sanitize(k)}.json`);
      if (existsSync(file)) {
        try {
          const data = JSON.parse(readFileSync(file, "utf-8"));
          if (Array.isArray(data.messages)) {
            store.load(data.messages);
          }
        } catch {
          // Corrupt file — start fresh
        }
      }
      this.stores.set(k, store);
    }
    return this.stores.get(k)!;
  }

  saveChat(platform: string, chatId: string): void {
    const k = this.key(platform, chatId);
    const store = this.stores.get(k);
    if (!store) return;

    if (!existsSync(GATEWAY_SESSIONS_DIR)) {
      mkdirSync(GATEWAY_SESSIONS_DIR, { recursive: true });
    }

    writeFileSync(
      join(GATEWAY_SESSIONS_DIR, `${sanitize(k)}.json`),
      JSON.stringify({ messages: store.getAll() }, null, 2),
    );
  }

  clearChat(platform: string, chatId: string): void {
    const k = this.key(platform, chatId);
    this.stores.delete(k);
  }
}

function sanitize(key: string): string {
  return key.replace(/[^a-zA-Z0-9:_.-]/g, "_");
}
