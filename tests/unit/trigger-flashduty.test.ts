import { describe, it, expect } from "vitest";
import { parseFlashDutyPayload } from "../../src/trigger/flashduty.js";

const BASIC_PAYLOAD = {
  event_id: "fac0599a2a25529ba2362c0c184b6cfb",
  event_time: 1689335086948,
  event_type: "i_new",
  person: {
    person_id: 1552048792504,
    person_name: "头铁",
    email: "toutie@flashcat.cloud",
  },
  incident: {
    incident_id: "64b1352e376e32c85c56e25b",
    title: "CPU idle low on node-1",
    description: "CPU idle dropped below 10% for 5 minutes",
    impact: "Service response time increased to 2s",
    root_cause: "",
    resolution: "",
    incident_severity: "Critical" as const,
    incident_status: "Critical",
    progress: "Triggered",
    start_time: 1689335086,
    labels: { check: "cpu idle low", instance: "node-1", env: "prod" },
    detail_url: "http://flashduty.internal/incident/detail/64b1352e",
    alert_cnt: 3,
    channel_name: "SRE Channel",
  },
};

describe("parseFlashDutyPayload", () => {
  it("should parse a new incident", () => {
    const result = parseFlashDutyPayload(BASIC_PAYLOAD);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: "flashduty",
      alertId: "fac0599a2a25529ba2362c0c184b6cfb",
      severity: "critical",
      title: "CPU idle low on node-1",
    });
    expect(result[0].description).toContain("CPU idle dropped");
    expect(result[0].description).toContain("Service response time increased to 2s");
    expect(result[0].description).toContain("http://flashduty.internal");
    expect(result[0].labels).toEqual({ check: "cpu idle low", instance: "node-1", env: "prod" });
    expect(result[0].annotations.incident_id).toBe("64b1352e376e32c85c56e25b");
    expect(result[0].annotations.incident_status).toBe("Critical");
    expect(result[0].annotations.alert_cnt).toBe("3");
  });

  it("should skip non-i_new events", () => {
    const payload = { ...BASIC_PAYLOAD, event_type: "i_ack" };
    expect(parseFlashDutyPayload(payload)).toHaveLength(0);

    const payload2 = { ...BASIC_PAYLOAD, event_type: "i_rslv" };
    expect(parseFlashDutyPayload(payload2)).toHaveLength(0);
  });

  it("should handle missing optional fields", () => {
    const payload = {
      event_id: "simple-event",
      event_time: 1689335086948,
      event_type: "i_new",
      person: undefined,
      incident: {
        incident_id: "inc-1",
        title: "Simple alert",
        description: "",
        incident_severity: "Warning" as const,
        incident_status: "Warning",
        progress: "Triggered",
        start_time: 1689335086,
        detail_url: "",
      },
    };
    const result = parseFlashDutyPayload(payload);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("warning");
    expect(result[0].description).toBe("");
  });

  it("should include root_cause in description when present", () => {
    const payload = {
      ...BASIC_PAYLOAD,
      incident: {
        ...BASIC_PAYLOAD.incident,
        root_cause: "Memory leak in auth service pool",
      },
    };
    const result = parseFlashDutyPayload(payload);
    expect(result[0].description).toContain("Memory leak in auth service pool");
  });
});
