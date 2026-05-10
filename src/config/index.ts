import { readFileSync, existsSync } from "node:fs";
import { AgentConfig } from "../agent/types.js";

export interface MCPServerConfig {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
}

export interface AppConfig {
  agent: AgentConfig;
  mcpServers: MCPServerConfig[];
}

function loadEnv(key: string, fallback?: string): string {
  const val = process.env[key] || fallback;
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function loadMCPServers(): MCPServerConfig[] {
  const mcpPath = process.env.MCP_CONFIG_PATH || ".mcp.json";
  if (!existsSync(mcpPath)) return [];

  const raw = readFileSync(mcpPath, "utf-8");
  const parsed = JSON.parse(raw);
  const servers = parsed.mcpServers || {};

  return Object.entries(servers).map(([name, cfg]: [string, any]) => ({
    name,
    command: cfg.command,
    args: cfg.args,
    url: cfg.url,
  }));
}

export function loadConfig(): AppConfig {
  return {
    agent: {
      llmType: (process.env.LLM_TYPE as "openai" | "anthropic") || "openai",
      apiKey: loadEnv("LLM_API_KEY"),
      baseURL: loadEnv("LLM_BASE_URL", "https://api.openai.com/v1"),
      model: loadEnv("LLM_MODEL", "gpt-4o"),
      maxIterations: Number(process.env.MAX_ITERATIONS) || 10,
    },
    mcpServers: loadMCPServers(),
  };
}
