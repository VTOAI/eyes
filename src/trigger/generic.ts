import crypto from "node:crypto";
import { AlertReceiver, AlertEvent } from "./types.js";
import { AlertAnalyzer } from "./analyzer.js";
import { TriggerConfig } from "../config/index.js";
import { LLMClient } from "../llm/client.js";
import { MCPRegistry } from "../mcp/registry.js";
import { NotificationChannel } from "../channel/types.js";
import { Messenger } from "../messenger/types.js";
type WecomVerifyFn = (req: { method?: string; url?: string }, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body: string) => void }) => boolean;
type WecomDecryptFn = (encrypted: string) => string;

export function resolvePath(obj: unknown, path: string): unknown {
  const clean = path.replace(/^\$\.?/, "");
  const segments = clean.split(/(?<!\[)\.(?![^\[]*\])/).flatMap((s) => {
    const m = s.match(/^(.+?)\[(\*|\d+)\]$/);
    if (m) return [m[1], m[2]];
    return [s];
  });
  let current: any = obj;
  for (const seg of segments) {
    if (current == null) return undefined;
    if (seg === "*") {
      current = Array.isArray(current) ? current[0] : undefined;
      continue;
    }
    if (/^\d+$/.test(seg)) {
      current = Array.isArray(current) ? current[Number(seg)] : undefined;
    } else {
      current = current[seg];
    }
  }
  return current;
}

function stringOr(obj: unknown, fallback: string): string {
  if (typeof obj === "string" && obj.length > 0) return obj;
  return fallback;
}

function parseGenericPayload(
  body: Record<string, unknown>,
  cfg: TriggerConfig,
): AlertEvent[] {
  const alertId = stringOr(resolvePath(body, String(cfg.jsonPathAlertId ?? "$.alertId")), crypto.randomUUID());
  const title = stringOr(resolvePath(body, String(cfg.jsonPathTitle ?? "$.title")), "Generic Alert");
  const description = stringOr(resolvePath(body, String(cfg.jsonPathDescription ?? "$.description")), JSON.stringify(body));
  const rawSeverity = resolvePath(body, String(cfg.jsonPathSeverity ?? "$.severity"));
  const severityStr = typeof rawSeverity === "string" ? rawSeverity : "warning";
  const labels = resolvePath(body, String(cfg.jsonPathLabels ?? "$"));
  const annotations = resolvePath(body, String(cfg.jsonPathAnnotations ?? "$"));
  const startsAt = stringOr(resolvePath(body, String(cfg.jsonPathStartsAt ?? "")), new Date().toISOString());

  const severity: "critical" | "warning" | "info" =
    severityStr.toLowerCase() === "critical" ? "critical" :
    severityStr.toLowerCase() === "info" ? "info" :
    "warning";

  return [{
    source: "generic",
    alertId,
    severity,
    title,
    description,
    labels: typeof labels === "object" && labels !== null ? labels as Record<string, string> : {},
    annotations: typeof annotations === "object" && annotations !== null ? annotations as Record<string, string> : {},
    startsAt,
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

export function createGenericReceiver(
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
    parse: (body) => parseGenericPayload(body, cfg),
    onAlert: async (event: AlertEvent): Promise<string> => analyzer.analyze(event),
    onMessage: async (userId: string, message: string): Promise<string> =>
      analyzer.continueConversation(userId, message),
    verify: wecomVerify,
    decryptMessage,
  };
}
