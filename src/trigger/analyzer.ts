import { Agent } from "../agent/loop.js";
import { SessionStore } from "../session/store.js";
import { AlertEvent } from "./types.js";
import { AlertDedup, ConcurrencyLimiter } from "./dedup.js";
import { TriggerSessionManager } from "./sessions.js";
import { LLMClient } from "../llm/client.js";
import { MCPRegistry } from "../mcp/registry.js";
import { NotificationChannel } from "../channel/types.js";
import { Messenger } from "../messenger/types.js";

export interface AnalyzerConfig {
  triggerName: string;
  cooldownMs: number;
  maxConcurrent: number;
  maxIterations: number;
  contextWindow: number;
  knownServerDescriptions: string;
  notifyLabel?: string;
  messenger?: Messenger;
}

export class AlertAnalyzer {
  private dedup: AlertDedup;
  private limiter: ConcurrencyLimiter;
  private config: AnalyzerConfig;
  private sessions: TriggerSessionManager;

  constructor(
    config: AnalyzerConfig,
    private llm: LLMClient,
    private mcp: MCPRegistry,
    private channels: NotificationChannel[],
  ) {
    this.config = config;
    this.dedup = new AlertDedup(config.cooldownMs);
    this.limiter = new ConcurrencyLimiter(config.maxConcurrent);
    this.sessions = new TriggerSessionManager(config.triggerName, config.contextWindow);
  }

  async analyze(event: AlertEvent): Promise<string> {
    const alertKey = `${event.source}:${event.alertId}`;
    if (!this.dedup.shouldProcess(alertKey)) {
      return "suppressed: duplicate alert within cooldown";
    }

    const release = await this.limiter.acquire();
    try {
      // Find recipients from alert labels
      const labelKey = this.config.notifyLabel || "wecom_users";
      const raw = event.labels[labelKey] || event.annotations[labelKey] || "";
      const recipients = raw.split(",").map((s: string) => s.trim()).filter(Boolean);

      // Use first recipient's existing session, or create new one
      const primaryUser = recipients[0] || "unknown";
      const session = this.sessions.getSession(primaryUser);
      // Clear old messages so each alert analysis starts fresh
      session.clear();

      const agent = new Agent(
        this.llm,
        this.mcp,
        session,
        this.config.maxIterations,
        this.config.knownServerDescriptions,
        this.config.contextWindow,
      );

      const systemPrompt = buildAlertSystemPrompt(event, this.config);
      const userInput = `${systemPrompt}\n\n请分析以上告警，给出根因诊断和操作建议。使用企业微信支持的 Markdown 格式回复（标题、列表、加粗、代码块、链接），不要使用表格。`;

      const result = await agent.run(userInput);

      // Save session for follow-up conversation
      if (primaryUser !== "unknown") {
        this.sessions.saveSession(primaryUser);
      }

      const messageTitle = `[${event.severity.toUpperCase()}] ${event.title}`;

      // Send to channels
      for (const ch of this.channels) {
        ch.send(`${messageTitle}\n\n${result}`).catch(() => {});
      }

      // Send to individual recipients via messenger
      if (this.config.messenger && recipients.length > 0) {
        for (const recipient of recipients) {
          this.config.messenger.send([recipient], messageTitle, result).catch((e) =>
            console.error(`[trigger:${this.config.triggerName}] messenger send to ${recipient} failed: ${e.message}`)
          );
        }
      }

      return result;
    } finally {
      release();
    }
  }

  async continueConversation(userId: string, message: string): Promise<string> {
    const release = await this.limiter.acquire();
    try {
      const session = this.sessions.getSession(userId);

      const agent = new Agent(
        this.llm,
        this.mcp,
        session,
        this.config.maxIterations,
        this.config.knownServerDescriptions,
        this.config.contextWindow,
      );

      const result = await agent.run(
        `${message}\n\n请使用企业微信 Markdown 格式回复（标题、列表、加粗、代码块），不要使用表格。`
      );

      this.sessions.saveSession(userId);

      // Reply to the user via messenger
      if (this.config.messenger) {
        this.config.messenger.send([userId], "", result).catch((e) =>
          console.error(`[trigger:${this.config.triggerName}] messenger reply to ${userId} failed: ${e.message}`)
        );
      }

      return result;
    } finally {
      release();
    }
  }
}

export function buildAlertSystemPrompt(event: AlertEvent, config: AnalyzerConfig): string {
  const labelsStr = Object.entries(event.labels)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  const annotationsStr = Object.entries(event.annotations)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  const lines = [
    "你是一个基础设施监控 AI。一条告警已触发，请分析它。",
    "",
    "## 告警详情",
    `- 来源: ${event.source}`,
    `- 告警 ID: ${event.alertId}`,
    `- 严重级别: ${event.severity}`,
    `- 标题: ${event.title}`,
    `- 开始时间: ${event.startsAt}`,
    "",
    "### 描述",
    event.description,
    "",
    "### 标签",
    labelsStr || "  (无)",
    "",
    "### 注解",
    annotationsStr || "  (无)",
    "",
  ];

  lines.push(
    "## 你的任务",
    "1. 根据告警数据和可用工具诊断问题根因",
    "2. 如适用，使用 MCP 工具检查相关系统/指标",
    "3. 提出具体的修复步骤",
    "4. 如果符合已知模式，引用相关 runbook",
    "",
    "请用中文给出清晰、结构化的分析。使用企业微信 Markdown 格式输出（## 标题、**加粗**、`代码`、列表），禁止使用表格。",
  );

  return lines.join("\n");
}
