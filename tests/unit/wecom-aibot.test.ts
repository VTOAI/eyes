import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let mockWs: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
let mockInstance: { onopen: (() => void) | null; onmessage: ((e: { data: Buffer }) => void) | null; onclose: (() => void) | null } | null = null;

vi.mock("ws", () => ({
  default: class MockWebSocket {
    readyState = 1; // OPEN
    static OPEN = 1;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: Buffer }) => void) | null = null;
    onclose: ((e: { code: number; reason: string }) => void) | null = null;
    onerror: ((_err: unknown) => void) | null = null;
    constructor(_url: string) {
      mockInstance = this;
      setTimeout(() => this.onopen?.(), 0);
    }
    send(data: string) { mockWs.send(JSON.parse(data)); }
    close() { mockWs.close(); }
  },
}));

beforeEach(() => {
  mockInstance = null;
  mockWs = { send: vi.fn(), close: vi.fn() };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("WecomAiBotGateway", () => {
  it("should connect and authenticate on start", async () => {
    const { WecomAiBotGateway } = await import("../../src/gateway/wecom-aibot.js");
    const gw = new WecomAiBotGateway("test", { botId: "bot123", secret: "sec456" }, {} as any, {} as any, {} as any, 10, "");

    gw.start();
    await new Promise((r) => setTimeout(r, 10));

    expect(mockWs.send).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: "aibot_subscribe",
        headers: expect.objectContaining({ req_id: expect.stringContaining("aibot_subscribe_") }),
        body: { bot_id: "bot123", secret: "sec456" },
      }),
    );
  });

  it("should start heartbeat after successful auth", async () => {
    vi.useFakeTimers();
    const { WecomAiBotGateway } = await import("../../src/gateway/wecom-aibot.js");
    const gw = new WecomAiBotGateway("test", { botId: "b", secret: "s" }, {} as any, {} as any, {} as any, 10, "");

    gw.start();
    await vi.advanceTimersByTimeAsync(10);

    mockInstance?.onmessage?.({
      data: Buffer.from(JSON.stringify({
        headers: { req_id: "aibot_subscribe_1" },
        errcode: 0,
        errmsg: "ok",
      })),
    });

    // Advance past first heartbeat interval
    await vi.advanceTimersByTimeAsync(30_001);

    const pingCalls = (mockWs.send as any).mock.calls.filter(
      (call: any) => call[0]?.cmd === "ping",
    );
    expect(pingCalls.length).toBeGreaterThanOrEqual(1);
    vi.useRealTimers();
  });

  it("should ignore non-text message callbacks", async () => {
    const { WecomAiBotGateway } = await import("../../src/gateway/wecom-aibot.js");
    const gw = new WecomAiBotGateway("test", { botId: "b", secret: "s" }, {} as any, {} as any, {} as any, 10, "");

    gw.start();
    await new Promise((r) => setTimeout(r, 10));

    mockInstance?.onmessage?.({
      data: Buffer.from(JSON.stringify({
        headers: { req_id: "aibot_subscribe_1" },
        errcode: 0,
        errmsg: "ok",
      })),
    });

    mockWs.send.mockClear();

    mockInstance?.onmessage?.({
      data: Buffer.from(JSON.stringify({
        cmd: "aibot_msg_callback",
        headers: { req_id: "2" },
        body: {
          msgid: "img1",
          chatid: "chat1",
          from: { userid: "u1" },
          msgtype: "image",
          image: { image_url: "http://..." },
        },
      })),
    });

    const replyCalls = (mockWs.send as any).mock.calls.filter(
      (call: any) => call[0]?.cmd === "aibot_respond_msg",
    );
    expect(replyCalls).toHaveLength(0);
  });
});
