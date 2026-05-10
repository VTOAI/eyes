import { MCPServerConfig, addMCPServerToConfig } from "../config/index.js";
import { MCPRegistry } from "./registry.js";
import { LLMClient } from "../llm/client.js";

const KNOWN_SERVERS: Record<string, {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  description: string;
}> = {
  filesystem: {
    name: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    description: "Read and write files on the local filesystem",
  },
  github: {
    name: "github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    description: "GitHub API — manage repositories, issues, pull requests",
  },
  postgres: {
    name: "postgres",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    description: "PostgreSQL database access — run queries, explore schemas",
  },
  puppeteer: {
    name: "puppeteer",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    description: "Browser automation via Puppeteer — navigate pages, screenshots",
  },
  "brave-search": {
    name: "brave-search",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    description: "Brave Search API — web search capabilities",
  },
  memory: {
    name: "memory",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    description: "Persistent memory / knowledge graph",
  },
  slack: {
    name: "slack",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    description: "Slack workspace access — channels, messages, users",
  },
  "sequential-thinking": {
    name: "sequential-thinking",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    description: "Sequential thinking — break down complex problems step by step",
  },
};

const CONFIG_GEN_PROMPT = `You are an MCP server config generator. Given a user's description of an MCP (Model Context Protocol) server they want to install, output a JSON config object.

The config format is:
{
  "name": "<short identifier>",
  "command": "<command to run, e.g., npx or uvx>",
  "args": ["<arg1>", "<arg2>", ...],
  "url": "<URL for SSE-based servers>"
}

Rules:
- "name" is required and must be a short, lowercase, dash-separated identifier
- For stdio-based servers, provide "command" and "args" (e.g., command: "npx", args: ["-y", "@scope/package-name"])
- For SSE/HTTP-based servers, provide "url" instead of command+args
- Do not include both (command+args) and url on the same server
- Output ONLY the JSON object, no other text, no markdown fences`;

export function getKnownServerDescriptions(): string {
  return Object.entries(KNOWN_SERVERS)
    .map(([, s]) => `- **${s.name}**: ${s.description}`)
    .join("\n");
}

export class MCPServerInstaller {
  constructor(
    private mcp: MCPRegistry,
    private llm: LLMClient,
  ) {}

  private matchKnownServer(input: string): MCPServerConfig | null {
    const lower = input.toLowerCase();
    for (const [key, s] of Object.entries(KNOWN_SERVERS)) {
      if (lower.includes(key)) {
        return { name: s.name, command: s.command, args: s.args, url: s.url };
      }
    }
    return null;
  }

  private async generateConfigViaLLM(description: string): Promise<MCPServerConfig | null> {
    try {
      const response = await this.llm.chat(
        [
          { role: "user", content: CONFIG_GEN_PROMPT, timestamp: Date.now() },
          { role: "user", content: `Install this MCP server: ${description}`, timestamp: Date.now() },
        ],
        []
      );

      if (response.type !== "text") return null;

      const text = response.content.trim();
      // Strip markdown fences if present
      const json = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
      const parsed = JSON.parse(json);

      if (!parsed.name) return null;
      if (!parsed.command && !parsed.url) return null;

      return {
        name: parsed.name,
        command: parsed.command,
        args: parsed.args,
        url: parsed.url,
      };
    } catch {
      return null;
    }
  }

  async install(description: string): Promise<string> {
    // 1. Try known server match first, then LLM generation
    let cfg = this.matchKnownServer(description);
    if (!cfg) {
      cfg = await this.generateConfigViaLLM(description);
    }
    if (!cfg) {
      return "Could not determine MCP server config from your description. Try specifying a known server (e.g., github, postgres, filesystem) or provide explicit command and URL.";
    }

    // 2. Persist to config
    try {
      addMCPServerToConfig(cfg);
    } catch (e) {
      return `Error saving config: ${e}`;
    }

    // 3. Connect
    try {
      await this.mcp.connectServer(cfg);
    } catch (e) {
      return `Server config saved, but connection failed: ${e}\nThe server will be retried on next startup.`;
    }

    // 4. Report success
    const tools = await this.mcp.listAllTools();
    const serverTools = tools.filter((t) => {
      // Find tools associated with this server by checking if they appeared after connect
      const servers = this.mcp.listServers();
      const srv = servers.find((s) => s.name === cfg!.name);
      return srv !== undefined;
    });

    const toolNames = serverTools.map((t) => t.name).join(", ");
    return `Installed and connected to MCP server "${cfg.name}" (${serverTools.length} tools${toolNames ? `: ${toolNames}` : ""}).`;
  }
}
