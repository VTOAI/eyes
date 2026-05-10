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
    default:
      throw new Error(`Unknown gateway type: ${cfg.type}`);
  }
}
