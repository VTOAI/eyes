import { NotificationChannel } from "./types.js";

const FEISHU_MSG_LIMIT = 20000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

export class FeishuWebhookChannel implements NotificationChannel {
  readonly name: string;
  private webhookUrl: string;

  constructor(name: string, webhookUrl: string) {
    this.name = name;
    this.webhookUrl = webhookUrl;
  }

  async send(text: string): Promise<void> {
    const payload = {
      msg_type: "text",
      content: { text: truncate(text, FEISHU_MSG_LIMIT) },
    };

    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Feishu webhook failed (${res.status}): ${body}`);
    }
  }
}
