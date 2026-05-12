import { Messenger } from "./types.js";

const WECOM_API = "https://qyapi.weixin.qq.com/cgi-bin";
const WECOM_MSG_LIMIT_BYTES = 4096;

function byteLength(str: string): number {
  return Buffer.byteLength(str, "utf-8");
}

export async function getAccessToken(corpid: string, corpsecret: string): Promise<string> {
  const res = await fetch(`${WECOM_API}/gettoken?corpid=${corpid}&corpsecret=${corpsecret}`);
  const data = (await res.json()) as { errcode: number; errmsg: string; access_token?: string };
  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`WeCom gettoken failed: ${data.errmsg} (${data.errcode})`);
  }
  return data.access_token;
}

export async function sendWecomMessage(accessToken: string, data: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${WECOM_API}/message/send?access_token=${accessToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const result = (await res.json()) as { errcode: number; errmsg: string };
  if (result.errcode !== 0) {
    throw new Error(`WeCom send failed: ${result.errmsg} (${result.errcode})`);
  }
}

export async function sendWecomGroupMessage(accessToken: string, data: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${WECOM_API}/appchat/send?access_token=${accessToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const result = (await res.json()) as { errcode: number; errmsg: string };
  if (result.errcode !== 0) {
    throw new Error(`WeCom group send failed: ${result.errmsg} (${result.errcode})`);
  }
}

function splitContent(text: string, maxBytes: number): string[] {
  if (byteLength(text) <= maxBytes) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (byteLength(remaining) <= maxBytes) {
      parts.push(remaining);
      break;
    }

    // Find cut point that fits within byte limit
    let cut = remaining.length;
    while (byteLength(remaining.slice(0, cut)) > maxBytes) {
      cut--;
    }

    // Try to split at the nearest paragraph break
    const chunk = remaining.slice(0, cut);
    let splitAt = chunk.lastIndexOf("\n\n");
    if (splitAt === -1 || splitAt < cut / 2) {
      splitAt = chunk.lastIndexOf("\n");
    }
    if (splitAt > cut / 2) {
      cut = splitAt;
    }

    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }

  const total = parts.length;
  return parts.map((p, i) => `${p}\n\n(${i + 1}/${total})`);
}

export class WecomAppMessenger implements Messenger {
  readonly name: string;
  private corpid: string;
  private corpsecret: string;
  private agentId: number;
  private accessToken: string | null = null;
  private tokenExpiry = 0;

  constructor(name: string, corpid: string, corpsecret: string, agentId: number) {
    this.name = name;
    this.corpid = corpid;
    this.corpsecret = corpsecret;
    this.agentId = agentId;
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }
    this.accessToken = await getAccessToken(this.corpid, this.corpsecret);
    this.tokenExpiry = Date.now() + 7000 * 1000;
    return this.accessToken;
  }

  async send(to: string[], title: string, content: string): Promise<void> {
    const token = await this.ensureAccessToken();
    const fullContent = title ? `## ${title}\n\n${content}` : content;
    const parts = splitContent(fullContent, WECOM_MSG_LIMIT_BYTES);

    for (const recipient of to) {
      for (const part of parts) {
        await sendWecomMessage(token, {
          touser: recipient,
          msgtype: "markdown",
          agentid: this.agentId,
          markdown: { content: part },
        }).catch((e) => console.error(`[messenger:${this.name}] send to ${recipient} failed: ${e.message}`));
      }
    }
  }

  async sendGroup(chatId: string, title: string, content: string): Promise<void> {
    const token = await this.ensureAccessToken();
    const fullContent = title ? `## ${title}\n\n${content}` : content;
    const parts = splitContent(fullContent, WECOM_MSG_LIMIT_BYTES);

    for (const part of parts) {
      await sendWecomGroupMessage(token, {
        chatid: chatId,
        msgtype: "markdown",
        markdown: { content: part },
        safe: 0,
      });
    }
  }
}
