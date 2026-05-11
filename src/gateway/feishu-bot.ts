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

  onMessage = async (_msg: GatewayMessage, _reply: (text: string) => Promise<void>): Promise<void> => {
    // Streaming is handled in listen() via channel.stream().
    // This no-op satisfies the MessageGateway interface.
  };

  /** Wire the LarkChannel message event to streaming agent replies. */
  listen(): void {
    this.channel.on("message", async (event: NormalizedMessage) => {
      if (event.rawContentType !== "text") return;

      const botOpenId = this.channel.botIdentity?.openId;
      if (botOpenId && event.senderId === botOpenId) return;

      const chatId = event.chatId;
      const platform = this.name;
      const session = this.sessions.getSession(platform, chatId);
      const agent = new Agent(this.llm, this.mcp, session, this.maxIterations, this.knownServerDescriptions);

      await this.channel.stream(chatId, {
        markdown: async (ctrl) => {
          let stepCount = 0;
          let streamed = false;
          try {
            const response = await agent.run(event.content, {
              onStep: (step) => {
                stepCount++;
                if (step.type === "tool_call") {
                  console.log(`[feishu-bot] step ${stepCount}: tool_call → ${step.name}(${JSON.stringify(step.args)})`);
                } else if (step.type === "tool_result") {
                  const preview = (step.content || "").slice(0, 200);
                  console.log(`[feishu-bot] step ${stepCount}: tool_result ← ${preview}...`);
                }
              },
              onToken: (token) => {
                streamed = true;
                ctrl.append(token);
              },
            });
            if (!streamed && response) {
              await ctrl.append(response);
            }
            console.log(`[feishu-bot] done after ${stepCount} steps`);
            this.sessions.saveChat(platform, chatId);
          } catch (e: any) {
            console.error(`[feishu-bot] error: ${e.message}`);
            await ctrl.append(`Error: ${e.message}`);
          }
        },
      });
    });
  }
}
