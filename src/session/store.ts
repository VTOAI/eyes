import { Message } from "../agent/types.js";

const MAX_TOKENS_ESTIMATE = 128_000;
const CHARS_PER_TOKEN = 4;

export class SessionStore {
  private messages: Message[] = [];
  private maxChars: number;

  constructor(maxTokens = MAX_TOKENS_ESTIMATE) {
    this.maxChars = maxTokens * CHARS_PER_TOKEN;
  }

  add(msg: Message): void {
    this.messages.push(msg);
    this.prune();
  }

  getAll(): Message[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
  }

  load(messages: Message[]): void {
    this.messages = [...messages];
  }

  private prune(): void {
    let totalChars = this.messages.reduce((sum, m) => sum + m.content.length, 0);

    while (totalChars > this.maxChars && this.messages.length > 4) {
      const removed = this.messages.shift()!;
      totalChars -= removed.content.length;
    }
  }
}
