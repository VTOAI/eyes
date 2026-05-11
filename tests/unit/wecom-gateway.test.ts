import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { parseXml, WXBizMsgCrypt } from "../../src/gateway/wecom-bot.js";

describe("parseXml", () => {
  it("should parse CDATA fields", () => {
    const xml = `<xml>
      <ToUserName><![CDATA[corpid123]]></ToUserName>
      <FromUserName><![CDATA[user456]]></FromUserName>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[hello world]]></Content>
    </xml>`;

    const result = parseXml(xml);
    expect(result.ToUserName).toBe("corpid123");
    expect(result.FromUserName).toBe("user456");
    expect(result.MsgType).toBe("text");
    expect(result.Content).toBe("hello world");
  });

  it("should parse plain text fields as fallback", () => {
    const xml = "<xml><MsgId>12345</MsgId><AgentID>1000001</AgentID></xml>";

    const result = parseXml(xml);
    expect(result.MsgId).toBe("12345");
    expect(result.AgentID).toBe("1000001");
  });

  it("should parse the outer XML envelope with Encrypt field", () => {
    const xml = `<xml>
      <ToUserName><![CDATA[corpid]]></ToUserName>
      <Encrypt><![CDATA[base64encrypteddata]]></Encrypt>
    </xml>`;

    const result = parseXml(xml);
    expect(result.Encrypt).toBe("base64encrypteddata");
  });

  it("should parse inner decrypted message XML", () => {
    const xml = `<xml>
      <ToUserName><![CDATA[corpid]]></ToUserName>
      <FromUserName><![CDATA[ZhangSan]]></FromUserName>
      <CreateTime>1408091189</CreateTime>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[查询天气]]></Content>
      <MsgId>1234567890123456</MsgId>
      <AgentID>1000001</AgentID>
    </xml>`;

    const result = parseXml(xml);
    expect(result.FromUserName).toBe("ZhangSan");
    expect(result.Content).toBe("查询天气");
    expect(result.MsgType).toBe("text");
    expect(result.AgentID).toBe("1000001");
  });
});

describe("WXBizMsgCrypt", () => {
  // Test with round-trip: encrypt with known key, then decrypt
  it("should round-trip decrypt an encrypted message", () => {
    const corpid = "testcorp";
    const encodingAesKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"; // 43 chars
    const token = "testtoken";

    const crypt = new WXBizMsgCrypt(token, encodingAesKey, corpid);

    // Manually encrypt a test message using the same algorithm
    const plaintext = `<xml><ToUserName><![CDATA[${corpid}]]></ToUserName><FromUserName><![CDATA[user1]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[test message]]></Content></xml>`;

    const aesKey = Buffer.from(encodingAesKey + "=", "base64");
    const randomBytes = crypto.randomBytes(16);
    const msgBuffer = Buffer.from(plaintext, "utf-8");
    const msgLen = Buffer.alloc(4);
    msgLen.writeUInt32BE(msgBuffer.length, 0);
    const corpidBuffer = Buffer.from(corpid, "utf-8");

    const raw = Buffer.concat([randomBytes, msgLen, msgBuffer, corpidBuffer]);

    // PKCS#7 padding
    const blockSize = 32;
    const padLen = blockSize - (raw.length % blockSize);
    const padBuffer = Buffer.alloc(padLen, padLen);
    const padded = Buffer.concat([raw, padBuffer]);

    // AES-256-CBC encrypt
    const iv = aesKey.subarray(0, 16);
    const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    const encryptedBase64 = encrypted.toString("base64");

    // Now decrypt with our class
    const decrypted = crypt.decrypt(encryptedBase64);
    expect(decrypted).toBe(plaintext);
  });

  it("should decrypt URL verification echostr", () => {
    const corpid = "wx123456";
    const encodingAesKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const token = "mytoken";

    const crypt = new WXBizMsgCrypt(token, encodingAesKey, corpid);

    const echostrContent = "1234567890";

    const aesKey = Buffer.from(encodingAesKey + "=", "base64");
    const randomBytes = crypto.randomBytes(16);
    const msgBuffer = Buffer.from(echostrContent, "utf-8");
    const msgLen = Buffer.alloc(4);
    msgLen.writeUInt32BE(msgBuffer.length, 0);
    const corpidBuffer = Buffer.from(corpid, "utf-8");

    let raw = Buffer.concat([randomBytes, msgLen, msgBuffer, corpidBuffer]);
    const blockSize = 32;
    const padLen = blockSize - (raw.length % blockSize);
    raw = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);

    const iv = aesKey.subarray(0, 16);
    const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);

    const decrypted = crypt.decrypt(encrypted.toString("base64"));
    expect(decrypted).toBe(echostrContent);
  });

  it("should throw on corpid mismatch", () => {
    const crypt = new WXBizMsgCrypt(
      "token",
      "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
      "mycorpid",
    );

    // Encrypt with a different corpid
    const aesKey = Buffer.from("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=", "base64");
    const wrongCorpid = "wrongcorp";
    const msgBuffer = Buffer.from("test", "utf-8");
    const msgLen = Buffer.alloc(4);
    msgLen.writeUInt32BE(msgBuffer.length, 0);

    let raw = Buffer.concat([
      crypto.randomBytes(16),
      msgLen,
      msgBuffer,
      Buffer.from(wrongCorpid, "utf-8"),
    ]);
    const blockSize = 32;
    const padLen = blockSize - (raw.length % blockSize);
    raw = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);

    const iv = aesKey.subarray(0, 16);
    const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);

    expect(() => crypt.decrypt(encrypted.toString("base64"))).toThrow("Corpid mismatch");
  });
});
