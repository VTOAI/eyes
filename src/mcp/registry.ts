import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Tool } from "../agent/types.js";
import { createTransport } from "./transport.js";
import { MCPServerConfig } from "../config/index.js";

interface ServerConnection {
  client: Client;
  name: string;
}

export class MCPRegistry {
  private connections: ServerConnection[] = [];
  private toolMap: Map<string, ServerConnection> = new Map();
  private cachedTools: Tool[] = [];

  async initialize(servers: MCPServerConfig[]): Promise<void> {
    const results = await Promise.allSettled(
      servers.map((cfg) => this.connectServer(cfg))
    );

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      console.error(`Warning: ${failed.length} MCP server(s) failed to connect`);
      failed.forEach((r) => console.error(`  - ${(r as PromiseRejectedResult).reason}`));
    }
  }

  private async connectServer(cfg: MCPServerConfig): Promise<void> {
    const transport = createTransport(cfg);
    const client = new Client(
      { name: "agent-cli", version: "0.1.0" },
      { capabilities: {} }
    );

    try {
      await client.connect(transport);

      const { tools } = await client.listTools();
      const conn: ServerConnection = { client, name: cfg.name };

      for (const tool of tools) {
        if (this.toolMap.has(tool.name)) {
          console.error(`Warning: duplicate tool name "${tool.name}" from server "${cfg.name}" — previous definition will be shadowed`);
        }
        this.toolMap.set(tool.name, conn);
        this.cachedTools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }

      this.connections.push(conn);
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
  }

  listAllTools(): Tool[] {
    return [...this.cachedTools];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const conn = this.toolMap.get(name);
    if (!conn) {
      return `Error: Tool "${name}" not found. Available tools: ${[...this.toolMap.keys()].join(", ")}`;
    }

    try {
      const result = await conn.client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: 30000 }
      );

      const content = result.content as Array<{ type: string; text?: string }>;
      return content.map((c) => c.text || "").filter(Boolean).join("\n");
    } catch (e) {
      return `Error calling tool "${name}" on server "${conn.name}": ${e}`;
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      this.connections.map((conn) => conn.client.close())
    );
    this.connections = [];
    this.toolMap.clear();
    this.cachedTools = [];
  }
}
