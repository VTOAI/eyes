import { createLarkChannel, LarkChannel, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { MessageGateway, GatewayMessage } from "./types.js";
import { PerChatSessionRouter } from "./session-router.js";
import { LLMClient } from "../llm/client.js";
import { MCPRegistry } from "../mcp/registry.js";
import { Agent } from "../agent/loop.js";

export interface FeishuBotConfig {
  appId: string;
  appSecret: string;
}

const FEISHU_MSG_LIMIT = 20000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

export class FeishuBotGateway implements MessageGateway {
  readonly name: string;
  private channel: LarkChannel;
  private llm: LLMClient;
  private mcp: MCPRegistry;
  private sessions: PerChatSessionRouter;
  private maxIterations: number;
  private knownServerDescriptions: string;

  constructor(
    name: string,
    config: FeishuBotConfig,
    llm: LLMClient,
    mcp: MCPRegistry,
    sessions: PerChatSessionRouter,
    maxIterations: number,
    knownServerDescriptions: string,
  ) {
    this.name = name;
    this.channel = createLarkChannel({
      appId: config.appId,
      appSecret: config.appSecret,
      transport: "websocket",
    });
    this.llm = llm;
    this.mcp = mcp;
    this.sessions = sessions;
    this.maxIterations = maxIterations;
    this.knownServerDescriptions = knownServerDescriptions;
  }

  async start(): Promise<void> {
    await this.channel.connect();
  }

  async stop(): Promise<void> {
    await this.channel.disconnect();
  }

  onMessage = async (msg: GatewayMessage, reply: (text: string) => Promise<void>): Promise<void> => {
    const session = this.sessions.getSession(msg.platform, msg.chatId);
    const agent = new Agent(this.llm, this.mcp, session, this.maxIterations, this.knownServerDescriptions);

    try {
      const response = await agent.run(msg.text);
      this.sessions.saveChat(msg.platform, msg.chatId);
      await reply(truncate(response, FEISHU_MSG_LIMIT));
    } catch (e: any) {
      await reply(`Error: ${e.message}`);
    }
  };

  /** Wire the LarkChannel message event to the gateway's onMessage callback. */
  listen(): void {
    this.channel.on("message", async (event: NormalizedMessage) => {
      // Guard: only text messages for now
      if (event.rawContentType !== "text") return;

      // Guard: skip bot's own messages to avoid echo loops
      const botOpenId = this.channel.botIdentity?.openId;
      if (botOpenId && event.senderId === botOpenId) return;

      const gatewayMsg: GatewayMessage = {
        platform: this.name,
        chatId: event.chatId,
        userId: event.senderId,
        text: event.content,
      };

      await this.onMessage(gatewayMsg, async (text: string) => {
        await this.channel.send(event.chatId, { markdown: text });
      });
    });
  }
}
