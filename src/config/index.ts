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

const CONFIG_DIR = ".eyes";

function findFile(...paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

function loadDotenv(): void {
  const envFile = findFile(`${CONFIG_DIR}/.env`, ".env");
  if (!envFile) return;

  try {
    const raw = readFileSync(envFile, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key && !process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch {
    // .env file is optional, silently skip
  }
}

function loadEnv(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

const VALID_LLM_TYPES = ["openai", "anthropic"] as const;

function loadMCPServers(): MCPServerConfig[] {
  const mcpPath = process.env.MCP_CONFIG_PATH ?? findFile(`${CONFIG_DIR}/mcp.json`, ".mcp.json");
  if (!mcpPath || !existsSync(mcpPath)) return [];

  try {
    const raw = readFileSync(mcpPath, "utf-8");
    const parsed = JSON.parse(raw);
    const servers = parsed.mcpServers ?? {};

    if (typeof servers !== "object" || Array.isArray(servers)) {
      console.error("Warning: mcpServers config should be an object, got array");
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
  loadDotenv();

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
