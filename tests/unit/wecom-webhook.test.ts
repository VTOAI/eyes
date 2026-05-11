import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("WecomWebhookChannel", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("should send markdown message via webhook", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 0, errmsg: "ok" }),
    });

    const { WecomWebhookChannel } = await import("../../src/channel/wecom-webhook.js");
    const channel = new WecomWebhookChannel("test", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc");

    await channel.send("Hello **world**");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("key=abc");
    const body = JSON.parse(opts.body);
    expect(body.msgtype).toBe("markdown");
    expect(body.markdown.content).toBe("Hello **world**");
  });

  it("should throw on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
    });

    const { WecomWebhookChannel } = await import("../../src/channel/wecom-webhook.js");
    const channel = new WecomWebhookChannel("test", "https://example.com/webhook");
    await expect(channel.send("test")).rejects.toThrow("WeCom webhook failed");
  });

  it("should throw on API error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 40001, errmsg: "invalid credential" }),
    });

    const { WecomWebhookChannel } = await import("../../src/channel/wecom-webhook.js");
    const channel = new WecomWebhookChannel("test", "https://example.com/webhook");
    await expect(channel.send("test")).rejects.toThrow("invalid credential");
  });

  it("should truncate long messages", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 0, errmsg: "ok" }),
    });

    const { WecomWebhookChannel } = await import("../../src/channel/wecom-webhook.js");
    const channel = new WecomWebhookChannel("test", "https://example.com/webhook");
    await channel.send("a".repeat(5000));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.markdown.content.length).toBeLessThanOrEqual(4000);
    expect(body.markdown.content.endsWith("...")).toBe(true);
  });
});
