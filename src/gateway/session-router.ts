import { SessionStore } from "../session/store.js";
import { SessionLike } from "../agent/loop.js";

/**
 * Manages per-chat session isolation for gateways.
 * Each chat (keyed by platform + chatId) gets its own session store.
 */
export class PerChatSessionRouter {
  private stores = new Map<string, SessionStore>();

  private key(platform: string, chatId: string): string {
    return `${platform}:${chatId}`;
  }

  getSession(platform: string, chatId: string): SessionLike {
    const k = this.key(platform, chatId);
    if (!this.stores.has(k)) {
      this.stores.set(k, new SessionStore());
    }
    return this.stores.get(k)!;
  }

  clearChat(platform: string, chatId: string): void {
    const k = this.key(platform, chatId);
    this.stores.delete(k);
  }
}
