import { describe, it, expect, vi, beforeEach } from "vitest";
import { MCPRegistry } from "../../src/mcp/registry.js";

vi.mock("../../src/mcp/transport.js", () => ({
  createTransport: vi.fn(() => ({
    start: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  const mockConnect = vi.fn();
  const mockClose = vi.fn();
  const mockListTools = vi.fn();
  const mockCallTool = vi.fn();

  const mockClient = vi.fn(() => ({
    connect: mockConnect,
    close: mockClose,
    listTools: mockListTools,
    callTool: mockCallTool,
  }));

  return {
    Client: mockClient,
    __mockConnect: mockConnect,
    __mockClose: mockClose,
    __mockListTools: mockListTools,
    __mockCallTool: mockCallTool,
  };
});

describe("MCPRegistry", () => {
  let registry: MCPRegistry;

  beforeEach(() => {
    registry = new MCPRegistry();
  });

  it("should initialize with no servers", async () => {
    await registry.initialize([]);
    expect(registry.listAllTools()).toHaveLength(0);
  });

  it("should return error for unknown tool", async () => {
    await registry.initialize([]);
    const result = await registry.callTool("nonexistent", {});
    expect(result).toContain('Tool "nonexistent" not found');
  });

  it("should close successfully", async () => {
    await registry.initialize([]);
    await expect(registry.close()).resolves.toBeUndefined();
  });

  it("should handle server connection failure gracefully", async () => {
    const { __mockConnect } = await import("@modelcontextprotocol/sdk/client/index.js");
    __mockConnect.mockRejectedValueOnce(new Error("connection failed"));

    // Should not throw — errors are swallowed with console.error
    await expect(
      registry.initialize([
        { name: "bad-server", command: "nonexistent", args: [] },
      ])
    ).resolves.toBeUndefined();
  });
});
