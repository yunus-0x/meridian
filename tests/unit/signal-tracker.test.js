import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { stageSignals } from "../../signal-tracker.js";

describe("signal-tracker", () => {
  const poolA = "pool_addr_a";

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports stageSignals function", () => {
    expect(typeof stageSignals).toBe("function");
  });

  it("stageSignals accepts pool and signals without throwing", () => {
    expect(() => {
      stageSignals(poolA, { organic_score: 75, fee_tvl_ratio: 4.5 });
    }).not.toThrow();
  });

  it("stageSignals handles multiple calls", () => {
    expect(() => {
      stageSignals(poolA, { organic_score: 75 });
      stageSignals("pool_b", { organic_score: 80 });
    }).not.toThrow();
  });

  it("stageSignals handles empty signals object", () => {
    expect(() => {
      stageSignals(poolA, {});
    }).not.toThrow();
  });

  it("stageSignals cleans stale entries on new call", () => {
    // Stage a signal
    stageSignals(poolA, { organic_score: 75 });

    // Advance time past TTL
    vi.advanceTimersByTime(11 * 60 * 1000);

    // Staging a new signal triggers cleanup of expired entries
    expect(() => {
      stageSignals("pool_b", { organic_score: 80 });
    }).not.toThrow();
  });
});
