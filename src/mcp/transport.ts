import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { MCPServerConfig } from "../config/index.js";

export function createTransport(config: MCPServerConfig): Transport {
  if (config.command) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: config.env,
    });
  }

  if (config.url) {
    return new SSEClientTransport(new URL(config.url));
  }

  throw new Error(
    `MCP server "${config.name}" has neither command nor URL configured.`
  );
}
