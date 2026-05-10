import { ChannelConfig } from "../config/index.js";
import { NotificationChannel } from "./types.js";

export async function createChannel(cfg: ChannelConfig): Promise<NotificationChannel> {
  switch (cfg.type) {
    case "feishu-webhook": {
      const { FeishuWebhookChannel } = await import("./feishu-webhook.js");
      return new FeishuWebhookChannel(cfg.name, String(cfg.webhookUrl));
    }
    default:
      throw new Error(`Unknown channel type: ${cfg.type}`);
  }
}
