import { WXBizMsgCrypt, parseXml } from "../gateway/wecom-bot.js";

export function createWecomVerifyHandler(
  token: string,
  aesKey: string,
  corpid: string,
): {
  verify: (req: { method?: string; url?: string }, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body: string) => void }) => boolean;
  decryptMessage: (encrypted: string) => string;
} {
  const crypt = new WXBizMsgCrypt(token, aesKey, corpid);

  const verify = (req: { method?: string; url?: string }, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body: string) => void }) => {
    if (req.method !== "GET") return false;
    const url = new URL(req.url || "/", "http://localhost");
    const echostr = url.searchParams.get("echostr");
    if (!echostr) return false;

    try {
      const plaintext = crypt.decrypt(echostr);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(plaintext);
    } catch {
      res.writeHead(500);
      res.end("decrypt failed");
    }
    return true;
  };

  const decryptMessage = (encrypted: string): string => {
    return crypt.decrypt(encrypted);
  };

  return { verify, decryptMessage };
}
