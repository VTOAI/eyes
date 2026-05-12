import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { AlertReceiver } from "./types.js";
import { parseXml } from "../gateway/wecom-bot.js";

const LOG_DIR = join(homedir(), ".eyes");

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  console.log(msg);
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, "trigger.log"), line);
  } catch {}
}

export class TriggerServer {
  private server: Server | null = null;
  private port: number;
  private triggers: AlertReceiver[];

  constructor(port: number, triggers: AlertReceiver[]) {
    this.port = port;
    this.triggers = triggers;
  }

  async start(): Promise<void> {
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://localhost`);
      log(`[trigger-server] ${req.method} ${url.pathname}${url.search || ""}`);
      const trigger = this.triggers.find((t) => t.path === url.pathname);

      if (!trigger) {
        log(`[trigger-server] 404: no trigger for path "${url.pathname}" (available: ${this.triggers.map(t => t.path).join(", ") || "none"})`);
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      if (trigger.verify?.(req, res)) {
        log(`[trigger-server] ${trigger.name}: verify handled`);
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405);
        res.end("Method Not Allowed");
        return;
      }

      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const rawBody = Buffer.concat(chunks).toString("utf-8");

        if (rawBody.trimStart().startsWith("<xml>")) {
          await this.handleWecomCallback(trigger, rawBody, res);
          return;
        }

        const body = JSON.parse(rawBody);
        const alerts = trigger.parse(body);
        for (const alert of alerts) {
          trigger.onAlert(alert).catch((e) =>
            log(`[trigger:${trigger.name}] analysis failed: ${e.message}`)
          );
        }

        res.writeHead(200);
        res.end("ok");
      } catch (e: any) {
        log(`[trigger:${trigger.name}] webhook error: ${e.message}`);
        res.writeHead(400);
        res.end("Bad Request");
      }
    });

    await new Promise<void>((resolve) => this.server!.listen(this.port, () => resolve()));
  }

  private async handleWecomCallback(
    trigger: AlertReceiver,
    rawBody: string,
    res: ServerResponse,
  ): Promise<void> {
    try {
      log(`[trigger:${trigger.name}] wecom callback received, bodyLen=${rawBody.length}`);
      const envelope = parseXml(rawBody);
      log(`[trigger:${trigger.name}] envelope keys: ${Object.keys(envelope).join(", ")}`);
      const encrypted = envelope.Encrypt;
      if (!encrypted) {
        log(`[trigger:${trigger.name}] no Encrypt field`);
        res.writeHead(200);
        res.end("missing Encrypt");
        return;
      }

      if (!trigger.decryptMessage) {
        log(`[trigger:${trigger.name}] no decryptMessage`);
        res.writeHead(500);
        res.end("no decrypt handler");
        return;
      }

      const innerXml = trigger.decryptMessage(encrypted);
      const msg = parseXml(innerXml);
      log(`[trigger:${trigger.name}] MsgType=${msg.MsgType}, FromUserName=${msg.FromUserName}, Content=${msg.Content?.slice(0, 50)}`);

      if (msg.MsgType !== "text") {
        res.writeHead(200);
        res.end("ok");
        return;
      }

      const userId = msg.FromUserName || "";
      const text = msg.Content || "";

      res.writeHead(200);
      res.end("");

      if (!trigger.onMessage) {
        log(`[trigger:${trigger.name}] no onMessage handler`);
        return;
      }

      trigger.onMessage(userId, text).catch((e) =>
        log(`[trigger:${trigger.name}] conversation error: ${e.message}`)
      );
    } catch (e: any) {
      log(`[trigger:${trigger.name}] wecom callback error: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("callback error");
      }
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }
}
