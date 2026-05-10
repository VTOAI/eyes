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
  const val = process.env[key] ?? fallback;
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

const VALID_LLM_TYPES = ["openai", "anthropic"] as const;

function loadMCPServers(): MCPServerConfig[] {
  const mcpPath = process.env.MCP_CONFIG_PATH ?? ".mcp.json";
  if (!existsSync(mcpPath)) return [];

  try {
    const raw = readFileSync(mcpPath, "utf-8");
    const parsed = JSON.parse(raw);
    const servers = parsed.mcpServers ?? {};

    if (typeof servers !== "object" || Array.isArray(servers)) {
      console.error("Warning: .mcp.json mcpServers should be an object, got array");
      return [];
    }

    return Object.entries(servers).map(([name, cfg]: [string, any]) => ({
      name,
      command: cfg.command,
      args: cfg.args,
      url: cfg.url,
    }));
  } catch (e) {
    console.error(`Warning: failed to parse ${mcpPath}:`, e);
    return [];
  }
}

export function loadConfig(): AppConfig {
  const rawType = process.env.LLM_TYPE ?? "openai";
  const llmType = VALID_LLM_TYPES.includes(rawType as any)
    ? (rawType as "openai" | "anthropic")
    : "openai";

  const rawIterations = process.env.MAX_ITERATIONS;
  const maxIterations = rawIterations !== undefined ? Number(rawIterations) : 10;

  return {
    agent: {
      llmType,
      apiKey: loadEnv("LLM_API_KEY"),
      baseURL: loadEnv("LLM_BASE_URL", "https://api.openai.com/v1"),
      model: loadEnv("LLM_MODEL", "gpt-4o"),
      maxIterations,
    },
    mcpServers: loadMCPServers(),
  };
}
