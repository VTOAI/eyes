import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Tool } from "../agent/types.js";
import { createTransport } from "./transport.js";
import { MCPServerConfig } from "../config/index.js";

interface ServerConnection {
  client: Client;
  name: string;
}

interface ToolWithServer {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  serverName: string;
}

export class MCPRegistry {
  private connections: ServerConnection[] = [];
  private toolMap: Map<string, ServerConnection> = new Map();
  private cachedTools: ToolWithServer[] = [];
  private localToolHandlers: Map<string, {
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<string>;
  }> = new Map();

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

  registerLocalTool(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<string>
  ): void {
    this.localToolHandlers.set(name, { description, inputSchema, handler });
  }

  async connectServer(cfg: MCPServerConfig): Promise<void> {
    // Remove existing server with same name
    const existing = this.connections.find((c) => c.name === cfg.name);
    if (existing) {
      this.toolMap.forEach((conn, toolName) => {
        if (conn.name === cfg.name) this.toolMap.delete(toolName);
      });
      this.cachedTools = this.cachedTools.filter((t) => t.serverName !== cfg.name);
      this.connections = this.connections.filter((c) => c.name !== cfg.name);
      await existing.client.close().catch(() => {});
    }
    const transport = createTransport(cfg);
    const client = new Client(
      { name: "eyes", version: "0.1.0" },
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
          serverName: cfg.name,
        });
      }

      this.connections.push(conn);
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
  }

  listAllTools(): Tool[] {
    const mcpTools = this.cachedTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    const localTools = [...this.localToolHandlers.entries()].map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return [...localTools, ...mcpTools] as Tool[];
  }

  listServers(): Array<{ name: string; toolCount: number }> {
    const counts = new Map<string, number>();
    for (const t of this.cachedTools) {
      counts.set(t.serverName, (counts.get(t.serverName) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, toolCount]) => ({ name, toolCount }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const local = this.localToolHandlers.get(name);
    if (local) {
      try {
        return await local.handler(args);
      } catch (e) {
        return `Error calling local tool "${name}": ${e}`;
      }
    }

    const conn = this.toolMap.get(name);
    if (!conn) {
      const all = [...this.localToolHandlers.keys(), ...this.toolMap.keys()].join(", ");
      return `Error: Tool "${name}" not found. Available tools: ${all}`;
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
    this.localToolHandlers.clear();
  }
}
