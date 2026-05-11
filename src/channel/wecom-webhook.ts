import { NotificationChannel } from "./types.js";

const WECOM_MSG_LIMIT = 4000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

export class WecomWebhookChannel implements NotificationChannel {
  readonly name: string;
  private webhookUrl: string;

  constructor(name: string, webhookUrl: string) {
    this.name = name;
    this.webhookUrl = webhookUrl;
  }

  async send(text: string): Promise<void> {
    const payload = {
      msgtype: "markdown",
      markdown: { content: truncate(text, WECOM_MSG_LIMIT) },
    };

    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`WeCom webhook failed (${res.status}): ${body}`);
    }

    const result = (await res.json()) as { errcode: number; errmsg: string };
    if (result.errcode !== 0) {
      throw new Error(`WeCom webhook error: ${result.errmsg} (${result.errcode})`);
    }
  }
}
