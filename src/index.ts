import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config/index.js";
import { OpenAICompatibleClient } from "./llm/openai.js";
import { AnthropicClient } from "./llm/anthropic.js";
import { LLMClient } from "./llm/client.js";
import { MCPRegistry } from "./mcp/registry.js";
import { SessionStore } from "./session/store.js";
import { Agent } from "./agent/loop.js";

function createLLMClient(config: ReturnType<typeof loadConfig>): LLMClient {
  const { agent } = config;
  if (agent.llmType === "anthropic") {
    return new AnthropicClient(agent.apiKey, agent.model);
  }
  return new OpenAICompatibleClient(agent.apiKey, agent.baseURL, agent.model);
}

async function main() {
  const config = loadConfig();
  const llm = createLLMClient(config);
  const mcp = new MCPRegistry();
  const session = new SessionStore();
  const agent = new Agent(llm, mcp, session, config.agent.maxIterations);

  console.log("Initializing MCP servers...");
  await mcp.initialize(config.mcpServers);
  const tools = await mcp.listAllTools();
  console.log(`Agent ready — ${tools.length} tool(s) available from ${config.mcpServers.length} MCP server(s)`);
  console.log("Type 'exit' to quit, 'clear' to reset session.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      const input = await rl.question("> ");

      if (input.toLowerCase() === "exit") break;
      if (input.toLowerCase() === "clear") {
        session.clear();
        console.log("Session cleared.\n");
        continue;
      }
      if (!input.trim()) continue;

      const result = await agent.run(input);
      console.log(`\n${result}\n`);
    }
  } finally {
    rl.close();
    await mcp.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
