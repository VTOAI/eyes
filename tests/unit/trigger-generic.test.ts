import { describe, it, expect } from "vitest";
import { resolvePath } from "../../src/trigger/generic.js";

describe("resolvePath", () => {
  const obj = {
    alert: {
      id: "alert-001",
      title: "Disk is full",
      details: {
        severity: "critical",
        message: "Disk usage at 95%",
      },
    },
    tags: { env: "prod", team: "sre" },
    items: [{ name: "first" }, { name: "second" }],
  };

  it("should resolve simple dot path", () => {
    expect(resolvePath(obj, "$.alert.id")).toBe("alert-001");
  });

  it("should resolve path without leading $.", () => {
    expect(resolvePath(obj, "alert.title")).toBe("Disk is full");
  });

  it("should resolve nested path", () => {
    expect(resolvePath(obj, "$.alert.details.severity")).toBe("critical");
  });

  it("should resolve path to an object", () => {
    expect(resolvePath(obj, "$.tags")).toEqual({ env: "prod", team: "sre" });
  });

  it("should resolve array with index", () => {
    expect(resolvePath(obj, "$.items[0].name")).toBe("first");
    expect(resolvePath(obj, "$.items[1].name")).toBe("second");
  });

  it("should resolve array with wildcard", () => {
    expect(resolvePath(obj, "$.items[*].name")).toBe("first");
  });

  it("should return undefined for missing path", () => {
    expect(resolvePath(obj, "$.nonexistent.field")).toBeUndefined();
  });

  it("should return undefined for null/undefined input", () => {
    expect(resolvePath(null, "$.field")).toBeUndefined();
    expect(resolvePath(undefined, "$.field")).toBeUndefined();
  });
});
