import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// These tests exercise the config loading path by writing temp config files
// and verifying loadConfig() reads them correctly.
describe("loadConfig", () => {
  const configDir = join(homedir(), ".eyes");
  const configFile = join(configDir, "config.json");
  let savedConfig: string | null = null;

  beforeEach(() => {
    // Save existing config
    if (existsSync(configFile)) {
      savedConfig = readFileSync(configFile, "utf-8");
    }
    // Clean state
    if (existsSync(configFile)) {
      rmSync(configFile);
    }
    // Clear env vars that affect config
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_TYPE;
    delete process.env.MAX_ITERATIONS;
    delete process.env.MCP_CONFIG_PATH;
  });

  afterEach(() => {
    if (existsSync(configFile)) {
      rmSync(configFile);
    }
    // Restore saved config
    if (savedConfig !== null) {
      if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
      writeFileSync(configFile, savedConfig);
    }
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_TYPE;
    delete process.env.MAX_ITERATIONS;
    delete process.env.MCP_CONFIG_PATH;
  });

  it("should throw when no API key is configured", () => {
    // No config file, no env var — should throw
    const { loadConfig } = requireConfig();
    expect(() => loadConfig()).toThrow(/Missing LLM API key/);
  });

  it("should load LLM config from config.json", () => {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(configFile, JSON.stringify({
      llm: {
        type: "openai",
        apiKey: "sk-test-key",
        baseURL: "https://custom.api/v1",
        model: "gpt-4",
      },
      maxIterations: 5,
    }));

    const { loadConfig } = requireConfig();
    const config = loadConfig();
    expect(config.agent.llmType).toBe("openai");
    expect(config.agent.apiKey).toBe("sk-test-key");
    expect(config.agent.baseURL).toBe("https://custom.api/v1");
    expect(config.agent.model).toBe("gpt-4");
    expect(config.agent.maxIterations).toBe(5);
  });

  it("should override config with env vars", () => {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
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

    const { loadConfig } = requireConfig();
    const config = loadConfig();
    expect(config.agent.apiKey).toBe("sk-env-key");
    expect(config.agent.model).toBe("gpt-4o");
    expect(config.agent.baseURL).toBe("https://env.api/v1");
    expect(config.agent.llmType).toBe("anthropic");
    expect(config.agent.maxIterations).toBe(8);
  });

  it("should parse MCP servers from config.json", () => {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
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

    const { loadConfig } = requireConfig();
    const config = loadConfig();
    expect(config.mcpServers).toHaveLength(2);
    expect(config.mcpServers[0].name).toBe("test-server");
    expect(config.mcpServers[0].command).toBe("node");
    expect(config.mcpServers[0].env).toEqual({ NODE_ENV: "test" });
    expect(config.mcpServers[1].name).toBe("remote-server");
    expect(config.mcpServers[1].url).toBe("https://example.com/mcp/sse");
  });

  it("should parse gateways and channels from config.json", () => {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(configFile, JSON.stringify({
      llm: { type: "openai", apiKey: "sk-test", model: "gpt-4" },
      gateways: [
        { type: "feishu-bot", name: "my-bot", appId: "123", appSecret: "secret" },
      ],
      channels: [
        { type: "feishu-webhook", name: "team-chat", webhookUrl: "https://hook.url" },
      ],
    }));

    const { loadConfig } = requireConfig();
    const config = loadConfig();
    expect(config.gateways).toHaveLength(1);
    expect(config.gateways[0].type).toBe("feishu-bot");
    expect(config.gateways[0].name).toBe("my-bot");
    expect(config.channels).toHaveLength(1);
    expect(config.channels[0].type).toBe("feishu-webhook");
    expect(config.channels[0].name).toBe("team-chat");
  });

  it("should handle corrupt config.json gracefully", () => {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(configFile, "{ invalid json }");

    const { loadConfig } = requireConfig();
    expect(() => loadConfig()).toThrow(/Missing LLM API key/);
    // Config file parse warning logged but doesn't crash
  });

  it("should handle empty config.json gracefully", () => {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(configFile, JSON.stringify({}));

    const { loadConfig } = requireConfig();
    expect(() => loadConfig()).toThrow(/Missing LLM API key/);
  });
});

// Use dynamic import with cache busting to get a fresh module each test
function requireConfig() {
  // We use a module-level cache buster since vitest transforms modules
  return requireConfigModule();
}

// Re-import the module directly — vitest handles module isolation per test file
import { loadConfig, addMCPServerToConfig, MCPServerConfig } from "../../src/config/index.js";

// Re-export for use in tests that need fresh state
function requireConfigModule() {
  return { loadConfig, addMCPServerToConfig };
}

describe("addMCPServerToConfig", () => {
  const configDir = join(homedir(), ".eyes");
  const configFile = join(configDir, "config.json");

  afterEach(() => {
    if (existsSync(configFile)) {
      rmSync(configFile);
    }
    delete process.env.LLM_API_KEY;
  });

  it("should add a new MCP server to config.json", () => {
    // Pre-create config with API key
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(configFile, JSON.stringify({
      llm: { type: "openai", apiKey: "sk-test", model: "gpt-4" },
    }));
    process.env.LLM_API_KEY = "sk-test";

    addMCPServerToConfig({
      name: "new-server",
      command: "npx",
      args: ["-y", "some-package"],
    });

    const raw = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(raw.mcpServers).toBeDefined();
    expect(raw.mcpServers["new-server"].command).toBe("npx");
  });
});
