import { describe, it, expect, vi } from "vitest";
import { buildAlertSystemPrompt, AlertAnalyzer, AnalyzerConfig } from "../../src/trigger/analyzer.js";
import { AlertEvent } from "../../src/trigger/types.js";

const TEST_EVENT: AlertEvent = {
  source: "alertmanager",
  alertId: "HighCPU-abc123",
  severity: "critical",
  title: "CPU usage is high",
  description: "CPU is at 95% on node-1 for 5 minutes",
  labels: { alertname: "HighCPU", severity: "critical", instance: "node-1" },
  annotations: { summary: "CPU usage is high", runbook: "https://wiki/runbooks/cpu" },
  startsAt: "2026-05-12T14:00:00Z",
  raw: {},
};

const TEST_CONFIG: AnalyzerConfig = {
  triggerName: "test",
  cooldownMs: 300_000,
  maxConcurrent: 3,
  maxIterations: 10,
  contextWindow: 128_000,
  knownServerDescriptions: "",
};

describe("buildAlertSystemPrompt", () => {
  it("should include alert details", () => {
    const prompt = buildAlertSystemPrompt(TEST_EVENT, TEST_CONFIG);
    expect(prompt).toContain("CPU usage is high");
    expect(prompt).toContain("critical");
    expect(prompt).toContain("node-1");
    expect(prompt).toContain("alertmanager");
    expect(prompt).toContain("CPU is at 95%");
  });

  it("should include task instructions", () => {
    const prompt = buildAlertSystemPrompt(TEST_EVENT, TEST_CONFIG);
    expect(prompt).toContain("诊断");
    expect(prompt).toContain("修复步骤");
  });

  it("should handle empty labels and annotations", () => {
    const event: AlertEvent = {
      ...TEST_EVENT,
      labels: {},
      annotations: {},
    };
    const prompt = buildAlertSystemPrompt(event, TEST_CONFIG);
    expect(prompt).toContain("(无)");
  });
});

describe("AlertAnalyzer", () => {
  it("should suppress duplicate alerts", async () => {
    const llm = { chat: vi.fn().mockResolvedValue({ type: "text", content: "Analysis result" }) } as any;
    const mcp = { listAllTools: vi.fn().mockResolvedValue([]), listServers: vi.fn().mockReturnValue([]) } as any;
    const channels: any[] = [];

    const analyzer = new AlertAnalyzer(TEST_CONFIG, llm, mcp, channels);
    const result1 = await analyzer.analyze(TEST_EVENT);
    expect(result1).not.toBe("suppressed: duplicate alert within cooldown");

    const result2 = await analyzer.analyze(TEST_EVENT);
    expect(result2).toBe("suppressed: duplicate alert within cooldown");
  });
});
