import WebSocket from "ws";
import { MessageGateway, GatewayMessage } from "./types.js";
import { PerChatSessionRouter } from "./session-router.js";
import { LLMClient } from "../llm/client.js";
import { MCPRegistry } from "../mcp/registry.js";
import { Agent } from "../agent/loop.js";

export interface WecomAiBotConfig {
  botId: string;
  secret: string;
}

const WS_URL = "wss://openws.work.weixin.qq.com";
const HEARTBEAT_MS = 30_000;
const FLUSH_MS = 200;

function reqId(prefix = ""): string {
  return `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── WebSocket helpers ────────────────────────────────────

interface AiBotMessage {
  cmd: string;
  headers: { req_id: string };
  body: Record<string, unknown>;
}

function send(ws: WebSocket, msg: AiBotMessage): void {
  ws.send(JSON.stringify(msg));
}

export class WecomAiBotGateway implements MessageGateway {
  readonly name: string;
  private config: WecomAiBotConfig;
  private llm: LLMClient;
  private mcp: MCPRegistry;
  private sessions: PerChatSessionRouter;
  private maxIterations: number;
  private knownServerDescriptions: string;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    name: string,
    config: WecomAiBotConfig,
    llm: LLMClient,
    mcp: MCPRegistry,
    sessions: PerChatSessionRouter,
    maxIterations: number,
    knownServerDescriptions: string,
  ) {
    this.name = name;
    this.config = config;
    this.llm = llm;
    this.mcp = mcp;
    this.sessions = sessions;
    this.maxIterations = maxIterations;
    this.knownServerDescriptions = knownServerDescriptions;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.clearHeartbeat();
    this.clearAuthTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  onMessage = async (_msg: GatewayMessage, _reply: (text: string) => Promise<void>): Promise<void> => {
    // Handled in listen() via WebSocket streaming
  };

  listen(): void {
    // Message handling is wired in connect()
  }

  // ── Connection ─────────────────────────────────────────

  private async connect(): Promise<void> {
    if (!this.running) return;

    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      console.log(`[wecom-aibot:${this.name}] connected, authenticating...`);
      send(this.ws!, {
        cmd: "aibot_subscribe",
        headers: { req_id: reqId("aibot_subscribe_") },
        body: { bot_id: this.config.botId, secret: this.config.secret },
      });

      // Timeout: if no response within 10s, close and retry
      this.authTimer = setTimeout(() => {
        console.error(`[wecom-aibot:${this.name}] auth timeout — no response from server. Check BotID and Secret.`);
        this.ws?.close();
      }, 10000);
    };

    this.ws.onmessage = (event) => {
      try {
        const raw = event.data.toString();
        const msg = JSON.parse(raw) as AiBotMessage;
        console.log(`[wecom-aibot:${this.name}] ← ${msg.cmd}`, JSON.stringify(raw).slice(0, 300));
        this.handleMessage(msg);
      } catch {
        console.log(`[wecom-aibot:${this.name}] ← non-JSON:`, event.data.toString().slice(0, 200));
      }
    };

    this.ws.onclose = (event) => {
      console.log(`[wecom-aibot:${this.name}] disconnected (code=${event.code}, reason=${event.reason || "none"})`);
      this.clearHeartbeat();
      this.clearAuthTimer();
      if (this.running) {
        setTimeout(() => this.connect(), 5000);
      }
    };

    this.ws.onerror = (_err) => {
      console.error(`[wecom-aibot:${this.name}] ws error (readyState=${this.ws?.readyState})`);
    };
  }

  // ── Heartbeat ───────────────────────────────────────────

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        send(this.ws, { cmd: "ping", headers: { req_id: reqId("ping_") }, body: {} });
      }
    }, HEARTBEAT_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearAuthTimer(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  // ── Message dispatch ────────────────────────────────────

  private handleMessage(msg: AiBotMessage & { errcode?: number; errmsg?: string }): void {
    const reqId = msg.headers?.req_id ?? "";

    // Frames with a cmd field
    if (msg.cmd === "aibot_msg_callback") {
      this.handleMsgCallback(msg);
      return;
    }

    // Frames without a cmd field
    if (!msg.cmd) {
      if (reqId.startsWith("aibot_subscribe")) {
        this.handleSubscribeResponse(msg);
        return;
      }
      if (reqId.startsWith("ping")) {
        // heartbeat ack — connection is alive
        return;
      }
      // Reply acks (aibot_respond_msg responses) have errcode but no cmd
      if (msg.errcode !== undefined) {
        if (msg.errcode !== 0) {
          console.error(`[wecom-aibot:${this.name}] reply error: errcode=${msg.errcode} errmsg=${msg.errmsg ?? "unknown"}`);
        }
        return;
      }
      console.log(`[wecom-aibot:${this.name}] ← unknown frame:`, JSON.stringify(msg).slice(0, 300));
      return;
    }
  }

  private handleSubscribeResponse(msg: AiBotMessage & { errcode?: number; errmsg?: string }): void {
    if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
    if (msg.errcode === 0) {
      console.log(`[wecom-aibot:${this.name}] authenticated`);
      this.startHeartbeat();
    } else {
      console.error(`[wecom-aibot:${this.name}] auth failed: errcode=${msg.errcode} errmsg=${msg.errmsg ?? "unknown"}`);
    }
  }

  private handleMsgCallback(msg: AiBotMessage): void {
    const body = msg.body ?? {};
    const msgtype = String(body.msgtype ?? "");

    if (msgtype !== "text") return;

    const msgid = String(body.msgid ?? reqId());
    const from = (body.from as Record<string, unknown>) ?? {};
    const userId = String(from.userid ?? "");
    // chatid is only present for group chats; for single chat, use userid
    const chatid = String(body.chatid || userId || "");
    const text = String((body.text as Record<string, unknown>)?.content ?? "");

    if (!chatid || !text) return;

    const platform = this.name;
    const session = this.sessions.getSession(platform, chatid);
    const agent = new Agent(this.llm, this.mcp, session, this.maxIterations, this.knownServerDescriptions);

    // Must use the callback's req_id for the reply (server validates it)
    const callbackReqId = msg.headers?.req_id ?? msgid;
    this.streamReply(agent, text, msgid, callbackReqId, chatid, platform);
  }

  // ── Streaming reply ─────────────────────────────────────

  private async streamReply(
    agent: Agent,
    userText: string,
    streamId: string,
    replyReqId: string,
    chatid: string,
    platform: string,
  ): Promise<void> {
    let fullResponse = "";
    let dirty = false;
    let finished = false;
    let stepCount = 0;

    const flush = () => {
      if (!dirty || finished) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      // WeChat Work stream replaces full content each time (not incremental)
      send(this.ws, {
        cmd: "aibot_respond_msg",
        headers: { req_id: replyReqId },
        body: {
          msgtype: "stream",
          stream: { id: streamId, finish: false, content: fullResponse },
        },
      });
      dirty = false;
    };

    const finish = (finalContent?: string) => {
      if (finished) return;
      finished = true;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const content = finalContent ?? fullResponse;
      send(this.ws, {
        cmd: "aibot_respond_msg",
        headers: { req_id: replyReqId },
        body: {
          msgtype: "stream",
          stream: { id: streamId, finish: true, content },
        },
      });
    };

    const flushTimer = setInterval(() => flush(), FLUSH_MS);

    try {
      const response = await agent.run(userText, {
        onStep: (step) => {
          stepCount++;
          if (step.type === "tool_call") {
            console.log(`[wecom-aibot:${this.name}] step ${stepCount}: tool_call → ${step.name}(${JSON.stringify(step.args)})`);
          }
        },
        onToken: (token) => {
          fullResponse += token;
          dirty = true;
        },
      });

      clearInterval(flushTimer);

      // Send final content with finish flag
      const finalContent = fullResponse || response;
      finish(finalContent);

      console.log(`[wecom-aibot:${this.name}] done after ${stepCount} steps`);
      this.sessions.saveChat(platform, chatid);
    } catch (e: any) {
      clearInterval(flushTimer);
      console.error(`[wecom-aibot:${this.name}] error: ${e.message}`);
      finish(`Error: ${e.message}`);
    }
  }
}
