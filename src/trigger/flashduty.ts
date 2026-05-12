import { AlertReceiver, AlertEvent } from "./types.js";
import { AlertAnalyzer } from "./analyzer.js";
import { TriggerConfig } from "../config/index.js";
import { LLMClient } from "../llm/client.js";
import { MCPRegistry } from "../mcp/registry.js";
import { NotificationChannel } from "../channel/types.js";
import { Messenger } from "../messenger/types.js";
type WecomVerifyFn = (req: { method?: string; url?: string }, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body: string) => void }) => boolean;
type WecomDecryptFn = (encrypted: string) => string;

interface FlashDutyPayload {
  event_id: string;
  event_time: number;
  event_type: string;
  person?: { person_id: number; person_name: string; email: string };
  incident: {
    incident_id: string;
    title: string;
    description: string;
    incident_severity: "Critical" | "Warning" | "Info";
    incident_status: string;
    progress: string;
    start_time: number;
    end_time?: number;
    labels?: Record<string, string>;
    detail_url: string;
    alert_cnt?: number;
    channel_name?: string;
    root_cause?: string;
    resolution?: string;
    impact?: string;
  };
}

function mapFlashDutySeverity(s: string): "critical" | "warning" | "info" {
  const lower = s.toLowerCase();
  if (lower === "critical") return "critical";
  if (lower === "warning") return "warning";
  return "info";
}

export function parseFlashDutyPayload(body: FlashDutyPayload): AlertEvent[] {
  if (body.event_type !== "i_new") {
    return [];
  }

  const inc = body.incident;
  const severity = mapFlashDutySeverity(inc.incident_severity);

  let description = inc.description || "";
  if (inc.impact) description += `\n\nImpact: ${inc.impact}`;
  if (inc.root_cause) description += `\n\nRoot Cause: ${inc.root_cause}`;
  if (inc.detail_url) description += `\n\nDetail URL: ${inc.detail_url}`;

  return [{
    source: "flashduty",
    alertId: body.event_id,
    severity,
    title: inc.title,
    description,
    labels: inc.labels ?? {},
    annotations: {
      incident_id: inc.incident_id,
      incident_status: inc.incident_status,
      progress: inc.progress,
      detail_url: inc.detail_url,
      channel_name: inc.channel_name ?? "",
      alert_cnt: String(inc.alert_cnt ?? 0),
      ...(inc.resolution ? { resolution: inc.resolution } : {}),
    },
    startsAt: new Date(inc.start_time * 1000).toISOString(),
    raw: body,
  }];
}

function resolveChannels(all: NotificationChannel[], allowlist?: unknown): NotificationChannel[] {
  if (!allowlist || !Array.isArray(allowlist) || allowlist.length === 0 || allowlist.includes("*")) {
    return all;
  }
  const names = new Set(allowlist.map(String));
  return all.filter((ch) => names.has(ch.name));
}

export function createFlashDutyReceiver(
  cfg: TriggerConfig,
  llm: LLMClient,
  mcp: MCPRegistry,
  allChannels: NotificationChannel[],
  contextWindow: number,
  knownServerDescriptions: string,
  messenger?: Messenger,
  wecomVerify?: WecomVerifyFn,
  decryptMessage?: WecomDecryptFn,
): AlertReceiver {
  const channels = resolveChannels(allChannels, cfg.channels);
  const analyzer = new AlertAnalyzer(
    {
      triggerName: cfg.name,
      cooldownMs: (typeof cfg.cooldownSeconds === "number" ? cfg.cooldownSeconds : 300) * 1000,
      maxConcurrent: typeof cfg.maxConcurrent === "number" ? cfg.maxConcurrent : 3,
      maxIterations: typeof cfg.maxIterations === "number" ? cfg.maxIterations : 10,
      contextWindow,
      knownServerDescriptions,
      notifyLabel: cfg.notifyLabel,
      messenger,
    },
    llm,
    mcp,
    channels,
  );

  return {
    name: cfg.name,
    path: cfg.path,
    parse: (body) => parseFlashDutyPayload(body as unknown as FlashDutyPayload),
    onAlert: async (event: AlertEvent): Promise<string> => analyzer.analyze(event),
    onMessage: async (userId: string, message: string): Promise<string> =>
      analyzer.continueConversation(userId, message),
    verify: wecomVerify,
    decryptMessage,
  };
}
