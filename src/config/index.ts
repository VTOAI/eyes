import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentConfig } from "../agent/types.js";

export interface MCPServerConfig {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface GatewayConfig {
  type: string;
  name: string;
  [key: string]: unknown;
}

export interface ChannelConfig {
  type: string;
  name: string;
  [key: string]: unknown;
}

export interface AppConfig {
  agent: AgentConfig;
  mcpServers: MCPServerConfig[];
  gateways: GatewayConfig[];
  channels: ChannelConfig[];
}

function homeConfigDir(): string {
  return process.env.EYES_CONFIG_DIR || join(homedir(), ".eyes");
}
const LOCAL_CONFIG_DIR = ".eyes";

function findFile(...paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

function configPath(filename: string): string[] {
  return [
    join(homeConfigDir(), filename),
    join(LOCAL_CONFIG_DIR, filename),
    filename, // bare filename for .env fallback
  ];
}

function loadDotenv(): void {
  const envFile = findFile(...configPath(".env"));
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

const VALID_LLM_TYPES = ["openai", "anthropic"] as const;

interface RawConfigJson {
  llm?: {
    type?: string;
    apiKey?: string;
    baseURL?: string;
    model?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
  };
  maxIterations?: number;
  mcpServers?: Record<string, {
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  }>;
  gateways?: Array<Record<string, unknown>>;
  channels?: Array<Record<string, unknown>>;
}

function loadConfigJson(): RawConfigJson | null {
  const path = findFile(...configPath("config.json"));
  if (!path) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Warning: failed to parse ${path}: ${msg}`);
    return null;
  }
}

function parseMCPServersFromFile(path: string): MCPServerConfig[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
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
      env: cfg.env,
    }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Warning: failed to parse ${path}: ${msg}`);
    return [];
  }
}

function resolveMCPServers(rawCfg?: RawConfigJson | null): MCPServerConfig[] {
  // 1. Explicit env var path wins
  const envPath = process.env.MCP_CONFIG_PATH;
  if (envPath) {
    const servers = parseMCPServersFromFile(envPath);
    if (servers.length > 0) return servers;
  }

  // 2. mcpServers from config.json
  if (rawCfg?.mcpServers) {
    return Object.entries(rawCfg.mcpServers).map(([name, cfg]) => ({
      name,
      command: cfg.command,
      args: cfg.args,
      url: cfg.url,
      env: cfg.env,
    }));
  }

  return [];
}

export function addMCPServerToConfig(cfg: MCPServerConfig): void {
  const raw = loadConfigJson() ?? {};
  raw.mcpServers = raw.mcpServers ?? {};
  raw.mcpServers[cfg.name] = {
    command: cfg.command,
    args: cfg.args,
    url: cfg.url,
    env: cfg.env,
  };
  const dir = homeConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(raw, null, 2));
}

export function loadConfig(): AppConfig {
  loadDotenv();

  // Load .eyes/config.json as optional base config
  const rawCfg = loadConfigJson();

  const rawType = process.env.LLM_TYPE ?? rawCfg?.llm?.type ?? "openai";
  const llmType = VALID_LLM_TYPES.includes(rawType as any)
    ? (rawType as "openai" | "anthropic")
    : "openai";

  const rawIterations = process.env.MAX_ITERATIONS;
  const maxIterations = rawIterations !== undefined
    ? Number(rawIterations)
    : (rawCfg?.maxIterations ?? 10);

  const rawContextWindow = process.env.CONTEXT_WINDOW ?? rawCfg?.llm?.contextWindow;
  const contextWindow = rawContextWindow !== undefined
    ? Number(rawContextWindow)
    : 128_000;

  const rawMaxOutput = process.env.MAX_OUTPUT_TOKENS ?? rawCfg?.llm?.maxOutputTokens;
  const maxOutputTokens = rawMaxOutput !== undefined
    ? Number(rawMaxOutput)
    : 4096;

  const apiKey = process.env.LLM_API_KEY ?? rawCfg?.llm?.apiKey;
  if (!apiKey) {
    throw new Error(
      "Missing LLM API key. Set it in ~/.eyes/config.json (llm.apiKey) or LLM_API_KEY env var."
    );
  }

  const gateways = (rawCfg?.gateways ?? []).map((g) => ({
    type: String(g.type ?? ""),
    name: String(g.name ?? g.type ?? ""),
    ...Object.fromEntries(Object.entries(g).filter(([k]) => k !== "type" && k !== "name")),
  })) as GatewayConfig[];

  const channels = (rawCfg?.channels ?? []).map((c) => ({
    type: String(c.type ?? ""),
    name: String(c.name ?? c.type ?? ""),
    ...Object.fromEntries(Object.entries(c).filter(([k]) => k !== "type" && k !== "name")),
  })) as ChannelConfig[];

  return {
    agent: {
      llmType,
      apiKey,
      baseURL: process.env.LLM_BASE_URL ?? rawCfg?.llm?.baseURL ?? "https://api.openai.com/v1",
      model: process.env.LLM_MODEL ?? rawCfg?.llm?.model ?? "gpt-4o",
      maxIterations,
      contextWindow,
      maxOutputTokens,
    },
    mcpServers: resolveMCPServers(rawCfg),
    gateways,
    channels,
  };
}
