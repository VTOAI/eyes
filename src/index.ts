#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, AppConfig } from "./config/index.js";
import { OpenAICompatibleClient } from "./llm/openai.js";
import { AnthropicClient } from "./llm/anthropic.js";
import { LLMClient } from "./llm/client.js";
import { MCPRegistry } from "./mcp/registry.js";
import { MCPServerInstaller, getKnownServerDescriptions } from "./mcp/installer.js";
import { SessionManager } from "./session/manager.js";
import { Agent, AgentHooks } from "./agent/loop.js";
import { isCommand, executeCommand, COMMANDS } from "./commands.js";

// ANSI escape codes
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const RED = "\x1b[31m";

const BANNER = `${BOLD}${CYAN}
███████╗██╗   ██╗███████╗███████╗
██╔════╝╚██╗ ██╔╝██╔════╝██╔════╝
█████╗   ╚████╔╝ █████╗  ███████╗
██╔══╝    ╚██╔╝  ██╔══╝  ╚════██║
███████╗   ██║   ███████╗███████║
╚══════╝   ╚═╝   ╚══════╝╚══════╝
${RESET}`;

function createLLMClient(config: ReturnType<typeof loadConfig>): LLMClient {
  const { agent } = config;
  if (agent.llmType === "anthropic") {
    return new AnthropicClient(agent.apiKey, agent.model);
  }
  return new OpenAICompatibleClient(agent.apiKey, agent.baseURL, agent.model);
}

function createAgentHooks(): AgentHooks {
  let thinking = false;
  let thinkingTimer: ReturnType<typeof setInterval> | null = null;
  const frames = ["◌", "◍", "◎"];
  let frameIdx = 0;
  let firstToken = true;

  return {
    onStep: (step) => {
      // Kill thinking animation if active
      if (thinking) {
        if (thinkingTimer) clearInterval(thinkingTimer);
        thinkingTimer = null;
        thinking = false;
        process.stdout.write("\r\x1b[K");
      }

      if (step.type === "thinking") {
        firstToken = true;
        process.stdout.write(`${DIM}${YELLOW}◎ Thinking${RESET}`);
        thinking = true;
        frameIdx = 0;
        thinkingTimer = setInterval(() => {
          frameIdx = (frameIdx + 1) % frames.length;
          process.stdout.write(`\r\x1b[K${DIM}${YELLOW}${frames[frameIdx]} Thinking${RESET}`);
        }, 200);
      } else if (step.type === "tool_call") {
        const args = step.args ? JSON.stringify(step.args) : "";
        const shortArgs = args.length > 200 ? args.slice(0, 200) + "..." : args;
        process.stdout.write(`\n  ${DIM}${YELLOW}⚙ ${step.name}${RESET}${DIM}(${shortArgs})${RESET}\n`);
      } else if (step.type === "tool_result") {
        const preview = step.content ? step.content.slice(0, 500) : "(empty)";
        process.stdout.write(`  ${DIM}⏺ ${preview.replace(/\n/g, "\\n")}${RESET}\n`);
      }
    },
    onToken: (token: string) => {
      if (firstToken) {
        if (thinking) {
          if (thinkingTimer) clearInterval(thinkingTimer);
          thinkingTimer = null;
          thinking = false;
        }
        process.stdout.write(`\r\x1b[K${BOLD}${GREEN}⏵${RESET} `);
        firstToken = false;
      }
      process.stdout.write(token);
    },
  };
}

async function runSetupWizard(rl: ReturnType<typeof createInterface>): Promise<void> {
  console.log("\nNo LLM API key configured. Let's set up your config.\n");

  const type = await rl.question("LLM type (openai/anthropic) [openai]: ");
  const llmType = type.trim() || "openai";

  const apiKey = await rl.question("API key: ");
  if (!apiKey.trim()) {
    console.log("API key is required. Run 'eyes' again to configure.\n");
    process.exit(1);
  }

  const defaultBaseURL = llmType === "anthropic"
    ? "https://api.anthropic.com"
    : "https://api.openai.com/v1";
  const baseUrlInput = await rl.question(`Base URL [${defaultBaseURL}]: `);
  const baseURL = baseUrlInput.trim() || defaultBaseURL;

  const defaultModel = llmType === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o";
  const modelInput = await rl.question(`Model [${defaultModel}]: `);
  const model = modelInput.trim() || defaultModel;

  const configDir = join(homedir(), ".eyes");
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

  const config = {
    llm: { type: llmType, apiKey: apiKey.trim(), baseURL, model },
    maxIterations: 10,
    mcpServers: {} as Record<string, never>,
  };

  writeFileSync(join(configDir, "config.json"), JSON.stringify(config, null, 2));
  console.log(`\nConfig saved to ${configDir}/config.json. Starting eyes...\n`);
}

function isConfigUsable(config: AppConfig): boolean {
  const key = config.agent.apiKey;
  return !!key && key !== "sk-your-key-here";
}

async function setupAndLoadConfig(
  rl: ReturnType<typeof createInterface>
): Promise<AppConfig> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch {
    await runSetupWizard(rl);
    return loadConfig();
  }

  if (!isConfigUsable(config)) {
    console.log("\nLLM API key not configured.");
    await runSetupWizard(rl);
    return loadConfig();
  }

  return config;
}

function separator(): void {
  const width = (process.stdout.columns || 80) - 2;
  process.stdout.write(`${DIM}${"─".repeat(width)}${RESET}\n`);
}

function printHelp(): void {
  console.log(`${BOLD}eyes${RESET} — AI agent CLI with MCP tools`);
  console.log();
  console.log(`${BOLD}Usage:${RESET}`);
  console.log(`  eyes              Start a new session`);
  console.log(`  eyes --resume <id> Resume a previous session`);
  console.log(`  eyes --help        Show this help`);
  console.log();
  console.log(`${BOLD}In-session commands:${RESET}`);
  console.log(`  /help             Show available commands`);
  console.log(`  /config           Show LLM configuration`);
  console.log(`  /mcp              List MCP servers and tools`);
  console.log(`  /doctor           Check configuration and connectivity`);
  console.log(`  /install <desc>   Install an MCP server by description`);
  console.log(`  /sessions list    List saved sessions`);
  console.log(`  /sessions new <name>  Create and switch to a new session`);
  console.log(`  /sessions switch <id>  Switch to a session`);
  console.log(`  /sessions rename <id> <name>  Rename a session`);
  console.log(`  /sessions delete <id>  Delete a session`);
  console.log(`  /clear            Clear current session history`);
  console.log(`  /exit             Exit`);
  console.log();
  console.log(`${DIM}Config: ~/.eyes/config.json${RESET}`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  console.log(BANNER);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const config = await setupAndLoadConfig(rl);
  const llm = createLLMClient(config);
  const mcp = new MCPRegistry();
  const installer = new MCPServerInstaller(mcp, llm);

  const resumeArgIdx = process.argv.indexOf("--resume");
  const resumeId = resumeArgIdx !== -1 ? process.argv[resumeArgIdx + 1] : undefined;
  if (resumeArgIdx !== -1 && !resumeId) {
    console.log(`${RED}Usage: eyes --resume <session-id>${RESET}`);
    console.log(`${DIM}Run /sessions list inside eyes to see available sessions.${RESET}`);
    process.exit(1);
  }

  let sessionManager: SessionManager;
  try {
    sessionManager = SessionManager.loadOrCreate(resumeId);
  } catch (e: any) {
    console.log(`${RED}${e.message}${RESET}`);
    process.exit(1);
  }
  const agent = new Agent(llm, mcp, sessionManager, config.agent.maxIterations, getKnownServerDescriptions());

  function getPrompt(): string {
    return `${BOLD}>${RESET} `;
  }

  mcp.registerLocalTool(
    "install_mcp_server",
    "Install a new MCP (Model Context Protocol) server to add new capabilities. Call this when the user wants to add a data source, API, or tool that is not currently available. Support a description of what the user wants.",
    {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Natural language description of the MCP server to install (e.g., 'postgresql database access', 'github api integration', 'filesystem access to a specific directory')",
        },
      },
      required: ["description"],
    },
    async (args) => installer.install(String(args.description || "")),
  );

  console.log(`${DIM}eyes ${config.agent.model} · /help for commands · double-ESC to abort${RESET}\n`);

  // Real-time command suggestions
  let sugLines = 0;
  let selectedIdx = 0;
  let arrowUsed = false;
  let pendingCommand: string | null = null;

  function clearSugVisual(): void {
    if (sugLines === 0) return;
    process.stdout.write(`\x1b[${sugLines}B`);
    for (let i = 0; i < sugLines; i++) {
      process.stdout.write("\x1b[2K\x1b[1A");
    }
  }

  function clearSuggestions(): void {
    clearSugVisual();
    sugLines = 0;
    selectedIdx = 0;
    arrowUsed = false;
  }

  function updateSuggestions(line: string): void {
    const lower = line.toLowerCase();
    if (!lower.startsWith("/") || !line.trim()) return;

    const hits = COMMANDS.filter((c) => c.startsWith(lower));
    if (hits.length === 0) return;
    if (hits.length === 1 && hits[0] === lower) return;

    if (selectedIdx >= hits.length) selectedIdx = hits.length - 1;

    process.stdout.write("\r\n");
    sugLines = 1;
    for (let i = 0; i < hits.length; i++) {
      const sel = i === selectedIdx;
      const prefix = sel ? `${GREEN}❯ ` : "  ";
      const style = sel ? BOLD : DIM;
      process.stdout.write(`\x1b[2K${prefix}${style}${hits[i]}${RESET}\r\n`);
      sugLines++;
    }
    process.stdout.write(`\x1b[${sugLines}A`);
    if (typeof (rl as any)._refreshLine === "function") {
      (rl as any)._refreshLine();
    } else {
      process.stdout.write(`\x1b[2K\r${BOLD}>${RESET} ${line}`);
    }
  }

  function navigateSuggestions(delta: number): void {
    const line = (rl as any).line || "";
    const lower = line.toLowerCase();
    const hits = COMMANDS.filter((c) => c.startsWith(lower));
    if (hits.length === 0) return;

    selectedIdx = ((selectedIdx + delta) % hits.length + hits.length) % hits.length;
    clearSugVisual();
    sugLines = 0;
    updateSuggestions(line);
  }

  // Double-ESC handler + real-time suggestions
  let lastEscAt = 0;
  let currentAbort = new AbortController();
  let rlClosed = false;
  const onKeyPress = (_: string | undefined, key: { name: string; ctrl: boolean } | undefined) => {
    if (!key) return;

    if (key.name === "up") {
      if (sugLines > 0) { arrowUsed = true; navigateSuggestions(-1); }
      return;
    }
    if (key.name === "down") {
      if (sugLines > 0) { arrowUsed = true; navigateSuggestions(1); }
      return;
    }
    if (key.name === "left" || key.name === "right") {
      clearSuggestions();
      return;
    }

    if (key.name === "escape") {
      const now = Date.now();
      if (now - lastEscAt < 300) {
        currentAbort.abort();
      }
      lastEscAt = now;
      return;
    }

    if (key.name === "return") {
      if (sugLines > 0 && arrowUsed) {
        const line = (rl as any).line || "";
        const hits = COMMANDS.filter((c) => c.startsWith(line.toLowerCase()));
        if (hits.length > 0 && selectedIdx < hits.length) {
          pendingCommand = hits[selectedIdx];
          try { (rl as any).line = pendingCommand; } catch { /* read-only in some versions */ }
        }
      }
      clearSuggestions();
      if (pendingCommand) {
        process.stdout.write(`\x1b[2K\r${BOLD}>${RESET} ${pendingCommand}`);
      }
      return;
    }
    if (key.name === "c" && key.ctrl) {
      clearSuggestions();
      return;
    }

    clearSuggestions();

    process.nextTick(() => {
      if (rlClosed) return;
      const line = (rl as any).line || "";
      updateSuggestions(line);
    });
  };
  process.stdin.on("keypress", onKeyPress);

  try {
    while (true) {
      const input = await rl.question(getPrompt());
      const actualInput = pendingCommand ?? input;
      pendingCommand = null;

      if (!actualInput.trim()) continue;

      if (actualInput.startsWith("/")) {
        const cmd = actualInput.trim().toLowerCase().split(" ")[0];
        if (cmd === "/exit") break;
        if (cmd === "/clear") {
          sessionManager.clear();
          console.log(`${DIM}Session cleared.${RESET}\n`);
          continue;
        }
        if (isCommand(actualInput)) {
          const result = await executeCommand(actualInput, { config, mcp, llm, installer, sessionManager });
          console.log(`\n${result}\n`);
        } else {
          console.log(`\n${RED}Unknown command: ${actualInput}${RESET}\n`);
        }
        continue;
      }

      const ac = new AbortController();
      currentAbort = ac;
      const hooks = createAgentHooks();

      try {
        await agent.run(actualInput, hooks, ac.signal);
        sessionManager.save();
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") {
          console.log(`\n${DIM}Aborted.${RESET}\n`);
          continue;
        }
        console.log(`\n${RED}Error: ${e}${RESET}\n`);
        continue;
      }

      console.log(`\n`);
      separator();
    }
  } finally {
    rlClosed = true;
    process.stdin.off("keypress", onKeyPress);
    rl.close();
    await mcp.close();
    console.log(`${DIM}Goodbye!${RESET}`);
  }
}

main().catch((err) => {
  console.error(`${RED}Fatal: ${err}${RESET}`);
  process.exit(1);
});
