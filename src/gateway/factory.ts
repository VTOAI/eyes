import { GatewayConfig } from "../config/index.js";
import { MessageGateway } from "./types.js";
import { PerChatSessionRouter } from "./session-router.js";
import { LLMClient } from "../llm/client.js";
import { MCPRegistry } from "../mcp/registry.js";

export async function createGateway(
  cfg: GatewayConfig,
  llm: LLMClient,
  mcp: MCPRegistry,
  sessions: PerChatSessionRouter,
  maxIterations: number,
  knownServerDescriptions: string,
): Promise<MessageGateway> {
  switch (cfg.type) {
    case "feishu-bot": {
      const { FeishuBotGateway } = await import("./feishu-bot.js");
      return new FeishuBotGateway(
        cfg.name,
        { appId: String(cfg.appId), appSecret: String(cfg.appSecret) },
        llm, mcp, sessions, maxIterations, knownServerDescriptions,
      );
    }
    case "wecom-bot": {
      const { WecomBotGateway } = await import("./wecom-bot.js");
      return new WecomBotGateway(
        cfg.name,
        {
          corpid: String(cfg.corpid),
          corpsecret: String(cfg.corpsecret),
          agentId: String(cfg.agentId),
          token: String(cfg.token),
          encodingAesKey: String(cfg.encodingAesKey),
          port: typeof cfg.port === "number" ? cfg.port : undefined,
        },
        llm, mcp, sessions, maxIterations, knownServerDescriptions,
      );
    }
    case "wecom-aibot": {
      const { WecomAiBotGateway } = await import("./wecom-aibot.js");
      return new WecomAiBotGateway(
        cfg.name,
        { botId: String(cfg.botId), secret: String(cfg.secret) },
        llm, mcp, sessions, maxIterations, knownServerDescriptions,
      );
    }
    default:
      throw new Error(`Unknown gateway type: ${cfg.type}`);
  }
}
