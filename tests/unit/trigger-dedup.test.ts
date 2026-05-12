import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AlertDedup, ConcurrencyLimiter } from "../../src/trigger/dedup.js";

describe("AlertDedup", () => {
  let dedup: AlertDedup;

  beforeEach(() => {
    dedup = new AlertDedup(1000);
  });

  it("should process first alert", () => {
    expect(dedup.shouldProcess("alertmanager:test1")).toBe(true);
  });

  it("should suppress duplicate within cooldown", () => {
    dedup.shouldProcess("alertmanager:test1");
    expect(dedup.shouldProcess("alertmanager:test1")).toBe(false);
  });

  it("should process different alert within cooldown", () => {
    dedup.shouldProcess("alertmanager:test1");
    expect(dedup.shouldProcess("alertmanager:test2")).toBe(true);
  });

  it("should process alert after cooldown", async () => {
    dedup.shouldProcess("alertmanager:test1");
    await new Promise((r) => setTimeout(r, 1100));
    expect(dedup.shouldProcess("alertmanager:test1")).toBe(true);
  }, 2000);

  it("should reset all entries", () => {
    dedup.shouldProcess("alertmanager:test1");
    dedup.reset();
    expect(dedup.shouldProcess("alertmanager:test1")).toBe(true);
  });
});

describe("ConcurrencyLimiter", () => {
  it("should acquire and release slots", async () => {
    const limiter = new ConcurrencyLimiter(2);
    expect(limiter.active).toBe(0);

    const release1 = await limiter.acquire();
    expect(limiter.active).toBe(1);

    const release2 = await limiter.acquire();
    expect(limiter.active).toBe(2);

    release1();
    expect(limiter.active).toBe(1);

    release2();
    expect(limiter.active).toBe(0);
  });

  it("should block when at capacity", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const release1 = await limiter.acquire();

    let acquired = false;
    const p = limiter.acquire().then((r) => { acquired = true; return r; });

    await new Promise((r) => setTimeout(r, 50));
    expect(acquired).toBe(false);

    release1();
    const release2 = await p;
    expect(acquired).toBe(true);
    release2();
  });

  it("should not double-release", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = await limiter.acquire();
    release();
    release(); // should not go negative
    expect(limiter.active).toBe(0);
  });
});
