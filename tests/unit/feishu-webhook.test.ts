import { describe, it, expect, vi } from "vitest";
import { FeishuWebhookChannel } from "../../src/channel/feishu-webhook.js";

describe("FeishuWebhookChannel", () => {
  it("should POST a text message to the webhook URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const channel = new FeishuWebhookChannel("test", "https://open.feishu.cn/open-apis/bot/v2/hook/abc");
    await channel.send("hello");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://open.feishu.cn/open-apis/bot/v2/hook/abc");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.msg_type).toBe("text");
    expect(body.content.text).toBe("hello");

    vi.unstubAllGlobals();
  });

  it("should throw on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad request" }));

    const channel = new FeishuWebhookChannel("test", "https://example.com/hook");
    await expect(channel.send("hi")).rejects.toThrow("Feishu webhook failed (400)");

    vi.unstubAllGlobals();
  });
});
