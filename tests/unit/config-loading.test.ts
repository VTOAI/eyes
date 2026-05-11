import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, readFileSync } from "node:fs";
import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, addMCPServerToConfig } from "../../src/config/index.js";

const SAVED_EYES_CONFIG_DIR = process.env.EYES_CONFIG_DIR;

function createTempConfigDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "eyes-test-")));
  process.env.EYES_CONFIG_DIR = dir;
  return dir;
}

function cleanupTempDir(dir: string): void {
  process.env.EYES_CONFIG_DIR = SAVED_EYES_CONFIG_DIR;
  try { rmSync(dir, { recursive: true }); } catch { /* ok */ }
}

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempConfigDir();
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_TYPE;
    delete process.env.MAX_ITERATIONS;
    delete process.env.MCP_CONFIG_PATH;
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_TYPE;
    delete process.env.MAX_ITERATIONS;
    delete process.env.MCP_CONFIG_PATH;
  });

  it("should throw when no API key is configured", () => {
    expect(() => loadConfig()).toThrow(/Missing LLM API key/);
  });

  it("should load LLM config from config.json", () => {
    const configFile = join(tmpDir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      llm: {
        type: "openai",
        apiKey: "sk-test-key",
        baseURL: "https://custom.api/v1",
        model: "gpt-4",
      },
      maxIterations: 5,
    }));

    const config = loadConfig();
    expect(config.agent.llmType).toBe("openai");
    expect(config.agent.apiKey).toBe("sk-test-key");
    expect(config.agent.baseURL).toBe("https://custom.api/v1");
    expect(config.agent.model).toBe("gpt-4");
    expect(config.agent.maxIterations).toBe(5);
  });

  it("should override config with env vars", () => {
    const configFile = join(tmpDir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      llm: {
        type: "openai",
        apiKey: "sk-file-key",
        baseURL: "https://file.api/v1",
        model: "gpt-3.5",
      },
      maxIterations: 3,
    }));

    process.env.LLM_API_KEY = "sk-env-key";
    process.env.LLM_MODEL = "gpt-4o";
    process.env.LLM_BASE_URL = "https://env.api/v1";
    process.env.LLM_TYPE = "anthropic";
    process.env.MAX_ITERATIONS = "8";

    const config = loadConfig();
    expect(config.agent.apiKey).toBe("sk-env-key");
    expect(config.agent.model).toBe("gpt-4o");
    expect(config.agent.baseURL).toBe("https://env.api/v1");
    expect(config.agent.llmType).toBe("anthropic");
    expect(config.agent.maxIterations).toBe(8);
  });

  it("should parse MCP servers from config.json", () => {
    const configFile = join(tmpDir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      llm: { type: "openai", apiKey: "sk-test", model: "gpt-4" },
      mcpServers: {
        "test-server": {
          command: "node",
          args: ["server.js"],
          env: { NODE_ENV: "test" },
        },
        "remote-server": {
          url: "https://example.com/mcp/sse",
        },
      },
    }));

    const config = loadConfig();
    expect(config.mcpServers).toHaveLength(2);
    expect(config.mcpServers[0].name).toBe("test-server");
    expect(config.mcpServers[0].command).toBe("node");
    expect(config.mcpServers[0].env).toEqual({ NODE_ENV: "test" });
    expect(config.mcpServers[1].name).toBe("remote-server");
    expect(config.mcpServers[1].url).toBe("https://example.com/mcp/sse");
  });

  it("should parse gateways and channels from config.json", () => {
    const configFile = join(tmpDir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      llm: { type: "openai", apiKey: "sk-test", model: "gpt-4" },
      gateways: [
        { type: "feishu-bot", name: "my-bot", appId: "123", appSecret: "secret" },
      ],
      channels: [
        { type: "feishu-webhook", name: "team-chat", webhookUrl: "https://hook.url" },
      ],
    }));

    const config = loadConfig();
    expect(config.gateways).toHaveLength(1);
    expect(config.gateways[0].type).toBe("feishu-bot");
    expect(config.gateways[0].name).toBe("my-bot");
    expect(config.channels).toHaveLength(1);
    expect(config.channels[0].type).toBe("feishu-webhook");
    expect(config.channels[0].name).toBe("team-chat");
  });

  it("should handle corrupt config.json gracefully", () => {
    const configFile = join(tmpDir, "config.json");
    writeFileSync(configFile, "{ invalid json }");

    expect(() => loadConfig()).toThrow(/Missing LLM API key/);
  });

  it("should handle empty config.json gracefully", () => {
    const configFile = join(tmpDir, "config.json");
    writeFileSync(configFile, JSON.stringify({}));

    expect(() => loadConfig()).toThrow(/Missing LLM API key/);
  });
});

describe("addMCPServerToConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempConfigDir();
    delete process.env.LLM_API_KEY;
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
    delete process.env.LLM_API_KEY;
  });

  it("should add a new MCP server to config.json", () => {
    const configFile = join(tmpDir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      llm: { type: "openai", apiKey: "sk-test", model: "gpt-4" },
    }));
    process.env.LLM_API_KEY = "sk-test";

    addMCPServerToConfig({
      name: "new-server",
      command: "npx",
      args: ["-y", "some-package"],
    });

    const data = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(data.mcpServers).toBeDefined();
    expect(data.mcpServers["new-server"].command).toBe("npx");
  });
});
