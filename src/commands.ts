import { AppConfig } from "./config/index.js";
import { MCPRegistry } from "./mcp/registry.js";
import { LLMClient } from "./llm/client.js";
import { MCPServerInstaller } from "./mcp/installer.js";
import { SessionManager } from "./session/manager.js";

export const COMMANDS = ["/help", "/config", "/mcp", "/doctor", "/install", "/sessions", "/exit", "/clear"];

export interface CommandContext {
  config: AppConfig;
  mcp: MCPRegistry;
  llm: LLMClient;
  installer?: MCPServerInstaller;
  sessionManager?: SessionManager;
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 3) + "****" + key.slice(-4);
}

function cmdSessions(ctx: CommandContext, args: string[]): string {
  const mgr = ctx.sessionManager;

  const sub = args[0] ?? "list";

  // "list" works without an active session (reads from disk)
  if (sub === "list") {
    const sessions = mgr
      ? mgr.listSessions()
      : SessionManager.listFromDisk();
    if (sessions.length === 0) return "No sessions.";
    if (mgr) {
      const active = mgr.getActive();
      return sessions
        .map((s) => `${s.id === active.id ? "*" : " "} ${s.id} — "${s.name}" (${new Date(s.lastAccessedAt).toLocaleString()})`)
        .join("\n");
    }
    return sessions
      .map((s) => `  ${s.id} — "${s.name}" (${new Date(s.lastAccessedAt).toLocaleString()})`)
      .join("\n");
  }

  if (!mgr) return "Session management (new/switch/delete/rename) is only available inside an interactive eyes session.";

  switch (sub) {
    case "new": {
      const name = args.slice(1).join(" ") || `session-${Date.now()}`;
      try {
        const meta = mgr.createSession(name);
        mgr.switchSession(meta.id);
        return `Created and switched to session "${meta.name}" (${meta.id}).`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }
    case "switch": {
      const id = args[1];
      if (!id) return "Usage: /sessions switch <id>";
      try {
        const meta = mgr.switchSession(id);
        return `Switched to session "${meta.name}" (${meta.id}).`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }
    case "delete": {
      const id = args[1];
      if (!id) return "Usage: /sessions delete <id>";
      try {
        mgr.deleteSession(id);
        return `Deleted session "${id}". Active: "${mgr.getActive().name}".`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }
    case "rename": {
      const id = args[1];
      const newName = args.slice(2).join(" ");
      if (!id || !newName) return "Usage: /sessions rename <id> <new name>";
      try {
        const meta = mgr.renameSession(id, newName);
        return `Renamed session "${id}" to "${meta.name}".`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }
    default:
      return `Unknown subcommand: ${sub}. Use: list, new, switch, delete, rename`;
  }
}

function cmdHelp(): string {
  return [
    "Available commands:",
    "  /help      Show this help",
    "  /config    Show current LLM configuration",
    "  /mcp       List connected MCP servers and tools",
    "  /doctor    Check configuration and connectivity",
    "  /install   Install an MCP server by description",
    "  /sessions  Manage sessions (list, new, switch, delete, rename)",
    "  /exit      Exit the CLI",
    "  /clear     Clear session history",
    "",
    "Everything else is sent to the LLM.",
  ].join("\n");
}

function cmdConfig(ctx: CommandContext): string {
  const a = ctx.config.agent;
  return [
    "LLM Configuration:",
    `  Type:      ${a.llmType}`,
    `  Model:     ${a.model}`,
    `  Base URL:  ${a.baseURL}`,
    `  API Key:   ${maskKey(a.apiKey)}`,
    `  Max Iter:  ${a.maxIterations}`,
  ].join("\n");
}

async function cmdMcp(ctx: CommandContext): Promise<string> {
  const tools = await ctx.mcp.listAllTools();
  const servers = ctx.mcp.listServers();

  if (servers.length === 0 && tools.length === 0) {
    return "No MCP servers connected. Use /install to add servers, or edit ~/.eyes/config.json.";
  }

  const lines: string[] = [`MCP Servers: ${servers.length} connected`];
  for (const s of servers) {
    lines.push(`  ${s.name} (${s.toolCount} tool${s.toolCount !== 1 ? "s" : ""})`);
  }

  if (tools.length > 0) {
    lines.push("", "Available tools:");
    for (const t of tools) {
      lines.push(`  ${t.name}${t.description ? ` — ${t.description}` : ""}`);
    }
  }

  return lines.join("\n");
}

async function cmdDoctor(ctx: CommandContext): Promise<string> {
  const lines: string[] = ["Eyes Doctor", "===========", ""];

  // 1. Config check
  const a = ctx.config.agent;
  lines.push("✓ Config: loaded");
  lines.push(`  Type: ${a.llmType}, Model: ${a.model}, Base URL: ${a.baseURL}`);
  if (a.apiKey && a.apiKey !== "sk-your-key-here") {
    lines.push("  API Key: " + maskKey(a.apiKey) + " (set)");
  } else {
    lines.push("  ✗ API Key: not configured");
  }

  // 2. MCP check
  lines.push("");
  if (ctx.config.mcpServers.length === 0) {
    lines.push("⚠ MCP: no servers configured");
  } else {
    const tools = await ctx.mcp.listAllTools();
    lines.push(`✓ MCP: ${ctx.config.mcpServers.length} server(s), ${tools.length} tool(s)`);
  }

  // 3. LLM connectivity check
  lines.push("");
  lines.push("Testing LLM connection...");
  try {
    const result = await ctx.llm.chat(
      [{ role: "user", content: "Respond with exactly: OK", timestamp: Date.now() }],
      []
    );
    if (result.type !== "text") {
      lines.push("⚠ LLM: responded with unexpected tool call");
    } else if (result.content.trim().toUpperCase() === "OK") {
      lines.push("✓ LLM: connection OK");
    } else {
      lines.push(`⚠ LLM: responded but unexpected: "${result.content.trim()}"`);
    }
  } catch (e) {
    lines.push(`✗ LLM: connection failed — ${e}`);
  }

  return lines.join("\n");
}

export function isCommand(input: string): boolean {
  return input.startsWith("/") && COMMANDS.includes(input.split(" ")[0].toLowerCase());
}

export async function executeCommand(input: string, ctx: CommandContext): Promise<string> {
  const cmd = input.trim().toLowerCase().split(" ")[0];

  switch (cmd) {
    case "/help":
      return cmdHelp();
    case "/config":
      return cmdConfig(ctx);
    case "/mcp":
      return await cmdMcp(ctx);
    case "/doctor":
      return await cmdDoctor(ctx);
    case "/sessions": {
      const args = input.trim().split(" ").slice(1);
      return cmdSessions(ctx, args);
    }
    case "/install": {
      const description = input.trim().split(" ").slice(1).join(" ");
      if (!description) {
        return [
          "Usage: /install <description of MCP server>",
          "",
          "Known servers: github, filesystem, postgres, sqlite, puppeteer, brave-search, memory, slack",
          "",
          "Examples:",
          "  /install install the github mcp",
          "  /install add postgres database access",
          "  /install npx -y @anthropic/filesystem-mcp",
        ].join("\n");
      }
      if (!ctx.installer) {
        return "MCP installer is not available. Restart eyes to use this feature.";
      }
      return await ctx.installer.install(description);
    }
    default:
      return `Unknown command: ${cmd}. Type /help for available commands.`;
  }
}
