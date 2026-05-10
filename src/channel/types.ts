export interface NotificationChannel {
  /** Unique name for this channel, used by the LLM to pick a target */
  readonly name: string;

  /** Send a text message through this channel */
  send(text: string): Promise<void>;
}
