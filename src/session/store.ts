import { Message } from "../agent/types.js";

const DEFAULT_MAX_TOKENS = 128_000;
const CHARS_PER_TOKEN = 4;

export class SessionStore {
  private messages: Message[] = [];
  private maxChars: number;
  private maxTokens: number;

  constructor(maxTokens = DEFAULT_MAX_TOKENS) {
    this.maxTokens = maxTokens;
    this.maxChars = maxTokens * CHARS_PER_TOKEN;
  }

  getEstimatedTokens(): number {
    const totalChars = this.messages.reduce((sum, m) => sum + m.content.length, 0);
    return Math.ceil(totalChars / CHARS_PER_TOKEN);
  }

  getMaxTokens(): number {
    return this.maxTokens;
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
      const first = this.messages[0];

      if (first.role === "assistant" && "toolCallId" in first) {
        // Remove tool_call + paired tool_result together to keep pairing valid
        const removed1 = this.messages.shift()!;
        totalChars -= removed1.content.length;
        const tcId = (removed1 as { toolCallId: string }).toolCallId;
        if (this.messages[0]?.role === "tool_result" && "toolCallId" in this.messages[0]
            && (this.messages[0] as { toolCallId: string }).toolCallId === tcId) {
          const removed2 = this.messages.shift()!;
          totalChars -= removed2.content.length;
        }
      } else {
        const removed = this.messages.shift()!;
        totalChars -= removed.content.length;
      }
    }
  }
}
