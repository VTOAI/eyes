import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import crypto from "node:crypto";
import { MessageGateway, GatewayMessage } from "./types.js";
import { PerChatSessionRouter } from "./session-router.js";
import { LLMClient } from "../llm/client.js";
import { MCPRegistry } from "../mcp/registry.js";
import { Agent } from "../agent/loop.js";

export interface WecomBotConfig {
  corpid: string;
  corpsecret: string;
  agentId: string;
  token: string;
  encodingAesKey: string;
  port?: number;
}

// ── WeChat Work Message Crypto ──────────────────────────

export class WXBizMsgCrypt {
  private token: string;
  private aesKey: Buffer;
  private corpid: string;

  constructor(token: string, encodingAesKey: string, corpid: string) {
    this.token = token;
    this.aesKey = Buffer.from(encodingAesKey + "=", "base64");
    this.corpid = corpid;
  }

  decrypt(encrypted: string): string {
    const ciphertext = Buffer.from(encrypted, "base64");
    const iv = this.aesKey.subarray(0, 16);
    const decipher = crypto.createDecipheriv("aes-256-cbc", this.aesKey, iv);
    decipher.setAutoPadding(false);

    let plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // Remove PKCS#7 padding
    const padLen = plaintext[plaintext.length - 1];
    plaintext = plaintext.subarray(0, plaintext.length - padLen);

    // Structure: random(16) + msg_len(4, BE) + msg + corpid
    const msgLen = plaintext.readUInt32BE(16);
    const msg = plaintext.subarray(20, 20 + msgLen).toString("utf-8");
    const expectedCorpid = plaintext.subarray(20 + msgLen).toString("utf-8");

    if (expectedCorpid !== this.corpid) {
      throw new Error(`Corpid mismatch: expected ${this.corpid}, got ${expectedCorpid}`);
    }

    return msg;
  }
}

// ── XML Parsing ─────────────────────────────────────────

export function parseXml(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  // CDATA tags
  const cdataRe = /<(\w+)><!\[CDATA\[(.*?)\]\]><\/\1>/gs;
  let match: RegExpExecArray | null;
  while ((match = cdataRe.exec(xml)) !== null) {
    result[match[1]] = match[2];
  }
  // Plain leaf tags (non-nested, content has no <)
  const plainRe = /<(\w+)>([^<]*)<\/\1>/g;
  while ((match = plainRe.exec(xml)) !== null) {
    if (!(match[1] in result)) {
      result[match[1]] = match[2];
    }
  }
  return result;
}

// ── WeChat Work API ─────────────────────────────────────

import { getAccessToken, sendWecomMessage, sendWecomGroupMessage } from "../messenger/wecom.js";

// ── Gateway ─────────────────────────────────────────────

const WECOM_MSG_LIMIT = 4000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

export class WecomBotGateway implements MessageGateway {
  readonly name: string;
  private config: WecomBotConfig;
  private llm: LLMClient;
  private mcp: MCPRegistry;
  private sessions: PerChatSessionRouter;
  private maxIterations: number;
  private knownServerDescriptions: string;
  private contextWindow: number;
  private server: Server | null = null;
  private accessToken: string | null = null;
  private tokenExpiry = 0;
  private crypt: WXBizMsgCrypt;

  constructor(
    name: string,
    config: WecomBotConfig,
    llm: LLMClient,
    mcp: MCPRegistry,
    sessions: PerChatSessionRouter,
    maxIterations: number,
    contextWindow: number,
    knownServerDescriptions: string,
  ) {
    this.name = name;
    this.config = config;
    this.llm = llm;
    this.mcp = mcp;
    this.sessions = sessions;
    this.maxIterations = maxIterations;
    this.contextWindow = contextWindow;
    this.knownServerDescriptions = knownServerDescriptions;
    this.crypt = new WXBizMsgCrypt(config.token, config.encodingAesKey, config.corpid);
  }

  async start(): Promise<void> {
    const port = this.config.port || 8080;

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url || "/", `http://localhost:${port}`);

        if (req.method === "GET" && url.searchParams.has("echostr")) {
          // URL verification: decrypt echostr and return plaintext
          const echostr = url.searchParams.get("echostr")!;
          const plaintext = this.crypt.decrypt(echostr);
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(plaintext);
          return;
        }

        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.from(chunk));
          }
          const body = Buffer.concat(chunks).toString("utf-8");

          // Parse outer XML envelope → extract Encrypt field
          const envelope = parseXml(body);
          const encrypted = envelope.Encrypt;
          if (!encrypted) {
            res.writeHead(200); res.end("missing Encrypt");
            return;
          }

          // Decrypt → inner message XML
          const innerXml = this.crypt.decrypt(encrypted);
          const msg = parseXml(innerXml);

          if (msg.MsgType !== "text") {
            res.writeHead(200); res.end("ok");
            return;
          }

          const userId = msg.FromUserName || "";
          const chatId = msg.ChatId || "";
          const text = msg.Content || "";

          // Acknowledge immediately (agent may take seconds)
          res.writeHead(200);
          res.end("");

          // Build gateway message
          const gatewayMsg: GatewayMessage = {
            platform: this.name,
            chatId: chatId || userId,
            userId,
            text,
          };

          // Construct reply function with WeChat-specific context
          const isGroup = !!chatId;
          const reply = async (replyText: string) => {
            const token = await this.ensureAccessToken();
            const content = truncate(replyText, WECOM_MSG_LIMIT);

            if (isGroup) {
              await sendWecomGroupMessage(token, {
                chatid: chatId,
                msgtype: "markdown",
                markdown: { content },
                safe: 0,
              });
            } else {
              await sendWecomMessage(token, {
                touser: userId,
                msgtype: "markdown",
                agentid: parseInt(this.config.agentId),
                markdown: { content },
              });
            }
          };

          await this.onMessage(gatewayMsg, reply);
        }
      } catch {
        // Always return 200 to prevent WeCom callback retries
        if (!res.headersSent) {
          res.writeHead(200);
          res.end("");
        }
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(port, () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }
    this.accessToken = await getAccessToken(this.config.corpid, this.config.corpsecret);
    this.tokenExpiry = Date.now() + 7000 * 1000; // 7200s, refresh early
    return this.accessToken;
  }

  onMessage = async (msg: GatewayMessage, reply: (text: string) => Promise<void>): Promise<void> => {
    const session = this.sessions.getSession(msg.platform, msg.chatId);
    const agent = new Agent(this.llm, this.mcp, session, this.maxIterations, this.knownServerDescriptions, this.contextWindow);

    try {
      const response = await agent.run(msg.text);
      this.sessions.saveChat(msg.platform, msg.chatId);
      await reply(response);
    } catch (e: any) {
      await reply(`Error: ${e.message}`);
    }
  };
}
