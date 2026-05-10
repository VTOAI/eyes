import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCPServerConfig } from "../config/index.js";

export function createTransport(config: MCPServerConfig): Transport {
  if (config.command) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args || [],
    });
  }

  throw new Error(
    `MCP server "${config.name}" has no command configured. Only stdio transport is supported currently.`
  );
}
