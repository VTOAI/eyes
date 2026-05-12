import { TriggerConfig } from "../config/index.js";
import { AlertReceiver } from "./types.js";
import { LLMClient } from "../llm/client.js";
import { MCPRegistry } from "../mcp/registry.js";
import { NotificationChannel } from "../channel/types.js";
import { Messenger } from "../messenger/types.js";
import { WecomAppMessenger } from "../messenger/wecom.js";
import { createWecomVerifyHandler } from "./wecom-verify.js";

function createMessenger(cfg: TriggerConfig): Messenger | undefined {
  const m = cfg.messenger;
  if (!m) return undefined;

  switch (m.type) {
    case "wecom-app": {
      return new WecomAppMessenger(
        cfg.name,
        String(m.corpid),
        String(m.corpsecret),
        Number(m.agentId),
      );
    }
    default:
      return undefined;
  }
}

type WecomVerifyFn = (req: { method?: string; url?: string }, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body: string) => void }) => boolean;
type WecomDecryptFn = (encrypted: string) => string;

function buildVerifyHandler(cfg: TriggerConfig): { verify: WecomVerifyFn; decryptMessage: WecomDecryptFn } | undefined {
  const m = cfg.messenger;
  if (!m?.callbackToken || !m?.callbackAesKey) return undefined;
  return createWecomVerifyHandler(
    String(m.callbackToken),
    String(m.callbackAesKey),
    String(m.corpid),
  );
}

export async function createTrigger(
  cfg: TriggerConfig,
  llm: LLMClient,
  mcp: MCPRegistry,
  channels: NotificationChannel[],
  contextWindow: number,
  knownServerDescriptions: string,
): Promise<AlertReceiver> {
  const messenger = createMessenger(cfg);
  const verifyHandler = buildVerifyHandler(cfg);

  switch (cfg.type) {
    case "flashduty": {
      const { createFlashDutyReceiver } = await import("./flashduty.js");
      return createFlashDutyReceiver(cfg, llm, mcp, channels, contextWindow, knownServerDescriptions, messenger, verifyHandler?.verify, verifyHandler?.decryptMessage);
    }
    case "generic": {
      const { createGenericReceiver } = await import("./generic.js");
      return createGenericReceiver(cfg, llm, mcp, channels, contextWindow, knownServerDescriptions, messenger, verifyHandler?.verify, verifyHandler?.decryptMessage);
    }
    default:
      throw new Error(`Unknown trigger type: ${cfg.type}`);
  }
}
