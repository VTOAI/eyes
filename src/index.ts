#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { loadConfig, AppConfig } from "./config/index.js";
import { OpenAICompatibleClient } from "./llm/openai.js";
import { AnthropicClient } from "./llm/anthropic.js";
import { LLMClient } from "./llm/client.js";
import { MCPRegistry } from "./mcp/registry.js";
import { MCPServerInstaller, getKnownServerDescriptions } from "./mcp/installer.js";
import { SessionManager } from "./session/manager.js";
import { Agent, AgentHooks } from "./agent/loop.js";
import { isCommand, executeCommand, COMMANDS } from "./commands.js";
import { NotificationChannel } from "./channel/types.js";
import { MessageGateway } from "./gateway/types.js";
import { PerChatSessionRouter } from "./gateway/session-router.js";

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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function createAgentHooks(channels?: NotificationChannel[]): AgentHooks {
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
        const raw = step.content || "";
        let formatted = raw;

        // Try to pretty-print JSON results
        try {
          const parsed = JSON.parse(raw);
          formatted = JSON.stringify(parsed, null, 2);
        } catch {
          // Not JSON — use as-is
        }

        const lines = formatted.split("\n");
        const maxLines = 20;
        const maxLen = 2000;

        if (lines.length <= maxLines && formatted.length <= maxLen) {
          for (const line of lines) {
            process.stdout.write(`  ${DIM}│ ${RESET}${line}\n`);
          }
        } else {
          // Show truncated preview
          const truncated = formatted.slice(0, maxLen);
          for (const line of truncated.split("\n").slice(0, maxLines)) {
            process.stdout.write(`  ${DIM}│ ${RESET}${line}\n`);
          }
          process.stdout.write(`  ${DIM}│ ... (${raw.length} chars total)${RESET}\n`);
        }
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
    onUsage: (usage, durationMs) => {
      const sec = (durationMs / 1000).toFixed(1);
      if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
        process.stdout.write(`  ${DIM}⎿ ${sec}s · ↑ ${formatTokens(usage.inputTokens)} · ↓ ${formatTokens(usage.outputTokens)}${RESET}\n`);
      } else {
        process.stdout.write(`  ${DIM}⎿ ${sec}s${RESET}\n`);
      }
    },
    onComplete: channels?.length
      ? (response: string) => {
          for (const ch of channels) {
            ch.send(response).catch(() => {});
          }
        }
      : undefined,
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

const CLI_COMMANDS: Record<string, string> = {
  config: "/config",
  mcp: "/mcp",
  doctor: "/doctor",
  sessions: "/sessions",
  install: "/install",
  help: "/help",
  gateways: "/gateways",
};

function printHelp(): void {
  console.log(`${BOLD}eyes${RESET} — AI agent CLI with MCP tools`);
  console.log();
  console.log(`${BOLD}Usage:${RESET}`);
  console.log(`  eyes                Start a new session`);
  console.log(`  eyes resume <id>    Resume a previous session`);
  console.log(`  eyes help           Show this help`);
  console.log(`  eyes config         Show LLM configuration`);
  console.log(`  eyes mcp            List MCP servers and tools`);
  console.log(`  eyes doctor         Check configuration and connectivity`);
  console.log(`  eyes install <desc> Install an MCP server`);
  console.log(`  eyes sessions list  List saved sessions`);
  console.log(`  eyes serve          Start gateways in background (default)`);
  console.log(`  eyes serve console  Start gateways in foreground`);
  console.log(`  eyes serve stop     Stop background serve`);
  console.log(`  eyes serve status   Check if serve is running`);
  console.log(`  eyes gateways       List configured gateways and channels`);
  console.log();
  console.log(`${DIM}All subcommands also work as in-session /commands.${RESET}`);
  console.log(`${DIM}Config: ~/.eyes/config.json${RESET}`);
}

async function runCliCommand(subcmd: string, args: string[]): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (e: any) {
    console.error(`${RED}Config error: ${e.message}${RESET}`);
    process.exit(1);
  }

  const llm = createLLMClient(config);
  const mcp = new MCPRegistry();
  const installer = new MCPServerInstaller(mcp, llm);
  await mcp.initialize(config.mcpServers);

  const slashCmd = CLI_COMMANDS[subcmd];
  const input = args.length > 0 ? `${slashCmd} ${args.join(" ")}` : slashCmd;

  try {
    const result = await executeCommand(input, { config, mcp, llm, installer });
    console.log(result);
  } catch (e: any) {
    console.error(`${RED}${e.message}${RESET}`);
    process.exit(1);
  } finally {
    await mcp.close();
  }
}

const PID_FILE = join(homedir(), ".eyes", "serve.pid");

function writePid(): void {
  const dir = join(homedir(), ".eyes");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(PID_FILE, String(process.pid));
}

function readPid(): number | null {
  try {
    return Number(readFileSync(PID_FILE, "utf-8").trim()) || null;
  } catch {
    return null;
  }
}

function removePid(): void {
  try { unlinkSync(PID_FILE); } catch {}
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function runServeCommand(config: AppConfig, daemon = false): Promise<void> {
  const { createGateway } = await import("./gateway/factory.js");
  const { createChannel } = await import("./channel/factory.js");

  const llm = createLLMClient(config);
  const mcp = new MCPRegistry();

  if (daemon) {
    // Suppress MCP connection warnings in daemon mode
    await mcp.initialize(config.mcpServers);
  } else {
    await mcp.initialize(config.mcpServers);
  }

  const channels = await Promise.all(config.channels.map((c) => createChannel(c)));
  const gateways: MessageGateway[] = [];
  const sessions = new PerChatSessionRouter();

  for (const g of config.gateways) {
    try {
      const gateway = await createGateway(
        g, llm, mcp, sessions,
        config.agent.maxIterations,
        getKnownServerDescriptions(),
      );
      gateways.push(gateway);

      if ("listen" in gateway && typeof (gateway as any).listen === "function") {
        (gateway as any).listen();
      }

      await gateway.start();
      if (!daemon) console.log(`Gateway "${gateway.name}" started.`);
    } catch (e: any) {
      if (!daemon) console.error(`${RED}Gateway "${g.name}" failed to start: ${e.message}${RESET}`);
    }
  }

  if (!daemon) {
    if (gateways.length === 0) {
      console.log(`${YELLOW}No gateways configured. Add gateways to ~/.eyes/config.json.${RESET}`);
    }
    console.log(`${DIM}eyes serve running. ${gateways.length} gateway(s), ${channels.length} channel(s). Ctrl+C to stop.${RESET}\n`);
  }

  writePid();

  const cleanup = async () => {
    for (const g of gateways) {
      await g.stop().catch(() => {});
    }
    await mcp.close();
    removePid();
  };

  process.once("SIGINT", () => { cleanup().then(() => process.exit(0)); });
  process.once("SIGTERM", () => { cleanup().then(() => process.exit(0)); });

  // Keep alive
  await new Promise(() => {});
}

function startDaemon(): void {
  // Re-spawn ourselves as a detached daemon
  const script = process.argv[1];
  const child = spawn("node", [script, "serve", "--daemon"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(`${DIM}eyes serve started in background (PID: ${child.pid})${RESET}`);
  console.log(`${DIM}Stop: eyes serve stop  ·  Status: eyes serve status${RESET}`);
}

function stopDaemon(): void {
  const pid = readPid();
  if (!pid || !isProcessRunning(pid)) {
    console.log(`${YELLOW}No running eyes serve process found.${RESET}`);
    removePid();
    return;
  }
  process.kill(pid, "SIGTERM");
  console.log(`${DIM}Sent stop signal to PID ${pid}.${RESET}`);
}

function statusDaemon(): void {
  const pid = readPid();
  if (pid && isProcessRunning(pid)) {
    console.log(`${GREEN}eyes serve is running (PID: ${pid})${RESET}`);
  } else {
    console.log(`${YELLOW}eyes serve is not running.${RESET}`);
  }
}

function parseResumeId(): string | undefined {
  // Support both "eyes resume <id>" and "eyes --resume <id>"
  if (process.argv[2] === "resume") return process.argv[3];
  const idx = process.argv.indexOf("--resume");
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const subcmd = process.argv[2];

  // Handle help (also keep -h/--help for muscle memory)
  if (subcmd === "help" || subcmd === "-h" || subcmd === "--help") {
    printHelp();
    process.exit(0);
  }

  // Handle "serve" — start gateways (background by default)
  if (subcmd === "serve" || subcmd === "--serve") {
    const mode = process.argv[3];

    if (mode === "stop") {
      stopDaemon();
      process.exit(0);
    }

    if (mode === "status") {
      statusDaemon();
      process.exit(0);
    }

    if (mode === "console") {
      const config = loadConfig();
      await runServeCommand(config);
      process.exit(0);
    }

    // --daemon flag: internal, called by startDaemon
    if (process.argv.includes("--daemon")) {
      const config = loadConfig();
      await runServeCommand(config, true);
      process.exit(0);
    }

    // Default: background
    const pid = readPid();
    if (pid && isProcessRunning(pid)) {
      console.log(`${YELLOW}eyes serve is already running (PID: ${pid}).${RESET}`);
      console.log(`${DIM}Use 'eyes serve console' for foreground or 'eyes serve stop' to restart.${RESET}`);
      process.exit(0);
    }
    const config = loadConfig();
    if (config.gateways.length === 0) {
      console.log(`${RED}No gateways configured. Add gateways to ~/.eyes/config.json.${RESET}`);
      process.exit(1);
    }
    startDaemon();
    process.exit(0);
  }

  // Handle non-interactive subcommands (both "config" and "--config")
  const normalized = subcmd?.replace(/^--?/, "");
  if (normalized && normalized in CLI_COMMANDS) {
    await runCliCommand(normalized, process.argv.slice(3));
    process.exit(0);
  }

  const resumeId = parseResumeId();
  if (resumeId !== undefined && !resumeId) {
    console.log(`${RED}Usage: eyes resume <session-id>${RESET}`);
    console.log(`${DIM}Run 'eyes sessions list' to see available sessions.${RESET}`);
    process.exit(1);
  }

  console.log(BANNER);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const config = await setupAndLoadConfig(rl);
  const llm = createLLMClient(config);
  const mcp = new MCPRegistry();
  const installer = new MCPServerInstaller(mcp, llm);
  await mcp.initialize(config.mcpServers);

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

  // Register send_notification tool if channels are configured
  if (config.channels.length > 0) {
    mcp.registerLocalTool(
      "send_notification",
      `Send a message to a notification channel (e.g., Feishu group chat). Available channels: ${config.channels.map((c) => c.name).join(", ")}.`,
      {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: `The notification channel name. One of: ${config.channels.map((c) => c.name).join(", ")}`,
          },
          message: {
            type: "string",
            description: "The message text to send",
          },
        },
        required: ["channel", "message"],
      },
      async (args) => {
        const name = String(args.channel || "");
        const channel = channelInstances.find((ch) => ch.name === name);
        if (!channel) {
          return `Unknown channel "${name}". Available: ${channelInstances.map((c) => c.name).join(", ")}`;
        }
        try {
          await channel.send(String(args.message));
          return `Message sent to "${name}" successfully.`;
        } catch (e) {
          return `Failed to send to "${name}": ${e}`;
        }
      },
    );
  }

  console.log(`${DIM}eyes ${config.agent.model} · /help for commands · double-ESC to abort${RESET}\n`);

  // Real-time command suggestions
  let sugLines = 0;
  let selectedIdx = 0;
  let arrowUsed = false;
  let pendingCommand: string | null = null;
  let lastTabAt = 0;
  let tabCycleIdx = 0;

  function findCommonPrefix(strings: string[]): string {
    if (strings.length === 0) return "";
    let prefix = strings[0];
    for (let i = 1; i < strings.length; i++) {
      while (!strings[i].startsWith(prefix)) {
        prefix = prefix.slice(0, -1);
        if (prefix === "") return "";
      }
    }
    return prefix;
  }

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
    tabCycleIdx = 0;
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

    if (key.name === "tab") {
      const line = (rl as any).line || "";
      const lower = line.toLowerCase();
      if (!lower.startsWith("/")) return;

      const hits = COMMANDS.filter((c) => c.startsWith(lower));
      if (hits.length === 0) return;

      if (hits.length === 1) {
        // Single match: auto-complete with trailing space
        const completed = hits[0];
        try { (rl as any).line = completed + " "; } catch {}
        pendingCommand = completed + " ";
        clearSuggestions();
        process.stdout.write(`\x1b[2K\r${BOLD}>${RESET} ${completed} `);
        return;
      }

      // Multiple matches: complete to longest common prefix
      const common = findCommonPrefix(hits);
      if (common.length > lower.length) {
        try { (rl as any).line = common; } catch {}
        clearSuggestions();
        process.stdout.write(`\x1b[2K\r${BOLD}>${RESET} ${common}`);
        // Show updated suggestions for the new prefix
        process.nextTick(() => {
          if (rlClosed) return;
          const newLine = (rl as any).line || common;
          updateSuggestions(newLine);
        });
        lastTabAt = 0;
        return;
      }

      // Already at common prefix: show/cycle suggestions
      const now = Date.now();
      if (now - lastTabAt < 500) {
        tabCycleIdx = (tabCycleIdx + 1) % hits.length;
        selectedIdx = tabCycleIdx;
      } else {
        tabCycleIdx = 0;
        selectedIdx = 0;
      }
      arrowUsed = true;
      clearSugVisual();
      sugLines = 0;
      updateSuggestions(line);
      lastTabAt = now;
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

  // Pre-create notification channels for hooks & tools
  let channelInstances: NotificationChannel[] = [];
  if (config.channels.length > 0) {
    const { createChannel } = await import("./channel/factory.js");
    channelInstances = await Promise.all(config.channels.map((c) => createChannel(c)));
  }

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
      const hooks = createAgentHooks(channelInstances);

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
