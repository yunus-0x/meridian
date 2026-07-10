import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupMockFs, seedMockFs, getMockFs, resetMockFs } from "../helpers/mock-fs.js";

setupMockFs();

const STATE_FILE = "./state.json";

let stateMod;
async function loadModule() {
  resetMockFs();
  vi.resetModules();
  stateMod = await import("../../state.js");
}

describe("state", () => {
  beforeEach(async () => {
    await loadModule();
  });

  describe("trackPosition", () => {
    it("registers a new position", () => {
      stateMod.trackPosition({
        position: "pos_001",
        pool: "pool_abc",
        pool_name: "SOL-USDC",
        strategy: "spot",
        amount_sol: 0.5,
      });

      const pos = stateMod.getTrackedPosition("pos_001");
      expect(pos).not.toBeNull();
      expect(pos.pool).toBe("pool_abc");
      expect(pos.strategy).toBe("spot");

      const saved = JSON.parse(getMockFs()[STATE_FILE]);
      expect(saved.positions.pos_001).toBeDefined();
    });

    it("registers position with optional fields", () => {
      stateMod.trackPosition({
        position: "pos_002",
        pool: "pool_xyz",
        pool_name: "BONK-SOL",
        strategy: "bid_ask",
        bin_range: { min: -200, max: -100, bins_below: 50, bins_above: 10 },
        bin_step: 100,
        volatility: 8.5,
        deployed_at: new Date().toISOString(),
      });

      const pos = stateMod.getTrackedPosition("pos_002");
      expect(pos.pool_name).toBe("BONK-SOL");
      expect(pos.bin_range.min).toBe(-200);
      expect(pos.volatility).toBe(8.5);
    });
  });

  describe("getTrackedPosition", () => {
    it("retrieves a tracked position", () => {
      stateMod.trackPosition({
        position: "pos_001",
        pool: "pool_abc",
        pool_name: "SOL-USDC",
      });
      const pos = stateMod.getTrackedPosition("pos_001");
      expect(pos.pool).toBe("pool_abc");
    });

    it("returns null for non-existent position", () => {
      const pos = stateMod.getTrackedPosition("nonexistent");
      expect(pos).toBeNull();
    });
  });

  describe("markOutOfRange / markInRange / minutesOutOfRange", () => {
    it("marks a position as out of range", () => {
      stateMod.trackPosition({ position: "pos_001", pool: "pool_abc" });
      stateMod.markOutOfRange("pos_001");

      const pos = stateMod.getTrackedPosition("pos_001");
      expect(pos.out_of_range_since).toBeDefined();
    });

    it("marks a position as back in range", () => {
      stateMod.trackPosition({ position: "pos_001", pool: "pool_abc" });
      stateMod.markOutOfRange("pos_001");
      stateMod.markInRange("pos_001");

      const pos = stateMod.getTrackedPosition("pos_001");
      expect(pos.out_of_range_since).toBeNull();
    });

    it("returns 0 minutes out of range for in-range position", () => {
      stateMod.trackPosition({ position: "pos_001", pool: "pool_abc" });
      const mins = stateMod.minutesOutOfRange("pos_001");
      expect(mins).toBe(0);
    });

    it("does nothing for non-existent position on markOutOfRange", () => {
      expect(() => stateMod.markOutOfRange("nonexistent")).not.toThrow();
    });
  });

  describe("recordClaim", () => {
    it("records a fee claim", () => {
      stateMod.trackPosition({ position: "pos_001", pool: "pool_abc" });
      stateMod.recordClaim("pos_001", 1.5);

      const pos = stateMod.getTrackedPosition("pos_001");
      expect(pos.last_claim_at).toBeDefined();
      expect(pos.total_fees_claimed_usd).toBe(1.5);
    });

    it("accumulates multiple claims", () => {
      stateMod.trackPosition({ position: "pos_001", pool: "pool_abc" });
      stateMod.recordClaim("pos_001", 1.0);
      stateMod.recordClaim("pos_001", 0.5);

      const pos = stateMod.getTrackedPosition("pos_001");
      expect(pos.total_fees_claimed_usd).toBe(1.5);
    });

    it("does nothing for non-existent position", () => {
      expect(() => stateMod.recordClaim("nonexistent", 1.0)).not.toThrow();
    });
  });

  describe("recordClose", () => {
    it("records a position close", () => {
      stateMod.trackPosition({ position: "pos_001", pool: "pool_abc" });
      stateMod.recordClose("pos_001", "stop loss");

      const pos = stateMod.getTrackedPosition("pos_001");
      expect(pos.closed).toBe(true);
      expect(pos.closed_at).toBeDefined();
      expect(pos.notes.some((n) => n.includes("stop loss"))).toBe(true);
    });

    it("does nothing for non-existent position", () => {
      expect(() => stateMod.recordClose("nonexistent", "reason")).not.toThrow();
    });
  });

  describe("setPositionInstruction", () => {
    it("sets an instruction on an existing position", () => {
      stateMod.trackPosition({ position: "pos_001", pool: "pool_abc" });
      stateMod.setPositionInstruction("pos_001", "do not close");

      const pos = stateMod.getTrackedPosition("pos_001");
      expect(pos.instruction).toBe("do not close");
    });

    it("sanitizes instruction text", () => {
      stateMod.trackPosition({ position: "pos_001", pool: "pool_abc" });
      stateMod.setPositionInstruction("pos_001", "  <script>alert('xss')</script>  keep open  ");

      const pos = stateMod.getTrackedPosition("pos_001");
      expect(pos.instruction).not.toContain("<");
      expect(pos.instruction).not.toContain(">");
      expect(pos.instruction).not.toContain("`");
    });

    it("returns false for non-existent position", () => {
      const result = stateMod.setPositionInstruction("nonexistent", "instruction");
      expect(result).toBe(false);
    });
  });

  describe("getStateSummary", () => {
    it("returns summary with zero positions", () => {
      const summary = stateMod.getStateSummary();
      expect(summary).toBeDefined();
    });

    it("includes tracked positions in summary", () => {
      stateMod.trackPosition({ position: "pos_001", pool: "pool_abc" });
      stateMod.trackPosition({ position: "pos_002", pool: "pool_xyz" });

      const summary = stateMod.getStateSummary();
      // Should have info about open positions
      expect(summary).toBeDefined();
    });
  });

  describe("getLastBriefingDate / setLastBriefingDate", () => {
    it("returns null when no briefing date set", () => {
      expect(stateMod.getLastBriefingDate()).toBeNull();
    });

    it("sets and retrieves the last briefing date", () => {
      stateMod.setLastBriefingDate();
      const date = stateMod.getLastBriefingDate();
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe("syncOpenPositions", () => {
    it("marks positions not in the active set as closed", async () => {
      const oldDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Seed state with positions that have old deployed_at (past grace period)
      const initialState = JSON.stringify({
        positions: {
          pos_001: {
            position: "pos_001", pool: "pool_abc", deployed_at: oldDate,
            closed: false, notes: [], total_fees_claimed_usd: 0, amount_x: 0,
            rebalance_count: 0, trailing_active: false, peak_pnl_pct: 0,
            closed_at: null, last_claim_at: null, out_of_range_since: null,
            signal_snapshot: null, pending_peak_pnl_pct: null,
            pending_peak_started_at: null, pending_trailing_current_pnl_pct: null,
            pending_trailing_peak_pnl_pct: null, pending_trailing_drop_pct: null,
            pending_trailing_started_at: null, confirmed_trailing_exit_reason: null,
            confirmed_trailing_exit_until: null,
          },
          pos_002: {
            position: "pos_002", pool: "pool_xyz", deployed_at: oldDate,
            closed: false, notes: [], total_fees_claimed_usd: 0, amount_x: 0,
            rebalance_count: 0, trailing_active: false, peak_pnl_pct: 0,
            closed_at: null, last_claim_at: null, out_of_range_since: null,
            signal_snapshot: null, pending_peak_pnl_pct: null,
            pending_peak_started_at: null, pending_trailing_current_pnl_pct: null,
            pending_trailing_peak_pnl_pct: null, pending_trailing_drop_pct: null,
            pending_trailing_started_at: null, confirmed_trailing_exit_reason: null,
            confirmed_trailing_exit_until: null,
          },
        },
        recentEvents: [],
        lastUpdated: null,
      });

      seedMockFs({ "./state.json": initialState });
      vi.resetModules();
      stateMod = await import("../../state.js");

      stateMod.syncOpenPositions(["pos_001"]);

      expect(stateMod.getTrackedPosition("pos_001")).not.toBeNull();
      expect(stateMod.getTrackedPosition("pos_001").closed).toBe(false);
      const pos2 = stateMod.getTrackedPosition("pos_002");
      expect(pos2.closed).toBe(true);
    });

    it("preserves all positions when all are active", () => {
      stateMod.trackPosition({ position: "pos_001", pool: "pool_abc" });
      stateMod.syncOpenPositions(["pos_001"]);

      expect(stateMod.getTrackedPosition("pos_001")).not.toBeNull();
    });
  });

  describe("file corruption", () => {
    it("handles corrupted state.json gracefully", async () => {
      seedMockFs({ [STATE_FILE]: "{ broken json }" });
      vi.resetModules();
      stateMod = await import("../../state.js");

      const pos = stateMod.getTrackedPosition("any");
      expect(pos).toBeNull();
    });

    it("handles missing state.json gracefully", () => {
      const pos = stateMod.getTrackedPosition("any");
      expect(pos).toBeNull();
    });
  });
});
