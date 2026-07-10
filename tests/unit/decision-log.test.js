import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupMockFs, seedMockFs, getMockFs, resetMockFs } from "../helpers/mock-fs.js";

setupMockFs();

const DECISION_LOG_FILE = "./decision-log.json";

let decisionLog;
async function loadModule() {
  resetMockFs();
  vi.resetModules();
  decisionLog = await import("../../decision-log.js");
}

describe("decision-log", () => {
  beforeEach(async () => {
    await loadModule();
  });

  describe("appendDecision", () => {
    it("appends a deploy decision with required fields", () => {
      const entry = decisionLog.appendDecision({
        type: "deploy",
        actor: "SCREENER",
        pool: "pool_abc",
        summary: "Deployed 0.5 SOL into SOL-USDC",
        reason: "High fee/TVL ratio",
      });

      expect(entry.id).toMatch(/^dec_\d+_[a-z0-9]+$/);
      expect(entry.ts).toBeDefined();
      expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
      expect(entry.type).toBe("deploy");
      expect(entry.actor).toBe("SCREENER");
      expect(entry.pool).toBe("pool_abc");
      expect(entry.summary).toBe("Deployed 0.5 SOL into SOL-USDC");
      expect(entry.reason).toBe("High fee/TVL ratio");

      const saved = JSON.parse(getMockFs()[DECISION_LOG_FILE]);
      expect(saved.decisions[0].id).toBe(entry.id);
    });

    it("appends a close decision with position", () => {
      const entry = decisionLog.appendDecision({
        type: "close",
        actor: "MANAGER",
        position: "pos_xyz",
        pool: "pool_abc",
        summary: "Closed position for stop loss",
        reason: "PnL -3.22% <= -3% threshold",
      });

      expect(entry.type).toBe("close");
      expect(entry.position).toBe("pos_xyz");
      expect(entry.actor).toBe("MANAGER");
    });

    it("defaults nullable fields to null when omitted", () => {
      const entry = decisionLog.appendDecision({
        type: "note",
        summary: "Manual note",
      });

      expect(entry.pool).toBeNull();
      expect(entry.pool_name).toBeNull();
      expect(entry.position).toBeNull();
      expect(entry.reason).toBeNull();
      expect(entry.risks).toEqual([]);
      expect(entry.metrics).toEqual({});
      expect(entry.rejected).toEqual([]);
    });

    it("prepends new entries (newest first)", () => {
      decisionLog.appendDecision({ type: "note", summary: "First" });
      decisionLog.appendDecision({ type: "note", summary: "Second" });

      const saved = JSON.parse(getMockFs()[DECISION_LOG_FILE]);
      expect(saved.decisions[0].summary).toBe("Second");
      expect(saved.decisions[1].summary).toBe("First");
    });

    it("trims old entries past MAX_DECISIONS", () => {
      for (let i = 0; i < 105; i++) {
        decisionLog.appendDecision({ type: "note", summary: `Entry ${i}` });
      }

      const saved = JSON.parse(getMockFs()[DECISION_LOG_FILE]);
      expect(saved.decisions.length).toBe(100);
      expect(saved.decisions[0].summary).toBe("Entry 104");
    });
  });

  describe("sanitization", () => {
    it("collapses whitespace in summary", () => {
      const entry = decisionLog.appendDecision({
        type: "note",
        summary: "  Multiple   spaces  and\ttabs\nand newlines  ",
      });
      expect(entry.summary).toBe("Multiple spaces and tabs and newlines");
    });

    it("truncates summary to 280 characters", () => {
      const long = "a".repeat(300);
      const entry = decisionLog.appendDecision({ type: "note", summary: long });
      expect(entry.summary.length).toBe(280);
    });

    it("truncates reason to 500 characters", () => {
      const long = "b".repeat(600);
      const entry = decisionLog.appendDecision({ type: "note", summary: "test", reason: long });
      expect(entry.reason.length).toBe(500);
    });

    it("truncates each risk to 140 characters and limits to 6 items", () => {
      const risks = Array.from({ length: 10 }, (_, i) => "x".repeat(200));
      const entry = decisionLog.appendDecision({ type: "note", summary: "test", risks });

      expect(entry.risks.length).toBe(6);
      for (const risk of entry.risks) {
        expect(risk.length).toBeLessThanOrEqual(140);
      }
    });

    it("truncates each rejected to 180 characters and limits to 8 items", () => {
      const rejected = Array.from({ length: 12 }, (_, i) => "y".repeat(250));
      const entry = decisionLog.appendDecision({ type: "note", summary: "test", rejected });

      expect(entry.rejected.length).toBe(8);
      for (const r of entry.rejected) {
        expect(r.length).toBeLessThanOrEqual(180);
      }
    });

    it("filters null/empty items from risks and rejected arrays", () => {
      const entry = decisionLog.appendDecision({
        type: "note",
        summary: "test",
        risks: ["valid", null, "", "also valid"],
        rejected: [null, "", "kept"],
      });

      expect(entry.risks).toEqual(["valid", "also valid"]);
      expect(entry.rejected).toEqual(["kept"]);
    });
  });

  describe("getRecentDecisions", () => {
    it("returns at most the requested number of decisions", () => {
      for (let i = 0; i < 20; i++) {
        decisionLog.appendDecision({ type: "note", summary: `Entry ${i}` });
      }

      const recent = decisionLog.getRecentDecisions(5);
      expect(recent.length).toBe(5);
      expect(recent[0].summary).toBe("Entry 19");
      expect(recent[4].summary).toBe("Entry 15");
    });

    it("returns all decisions if fewer exist than requested", () => {
      for (let i = 0; i < 3; i++) {
        decisionLog.appendDecision({ type: "note", summary: `Entry ${i}` });
      }

      const recent = decisionLog.getRecentDecisions(10);
      expect(recent.length).toBe(3);
    });

    it("returns empty array when no decisions", () => {
      const recent = decisionLog.getRecentDecisions(5);
      expect(recent).toEqual([]);
    });
  });

  describe("getDecisionSummary", () => {
    it("returns a formatted summary string", () => {
      decisionLog.appendDecision({
        type: "deploy",
        actor: "SCREENER",
        pool: "pool_abc",
        pool_name: "SOL-USDC",
        summary: "Deployed into SOL-USDC",
      });

      const summary = decisionLog.getDecisionSummary(5);
      expect(typeof summary).toBe("string");
      expect(summary).toContain("DEPLOY");
      expect(summary).toContain("SOL-USDC");
    });

    it("returns no-decisions message when empty", () => {
      const summary = decisionLog.getDecisionSummary(5);
      expect(summary).toBe("No recent structured decisions yet.");
    });
  });

  describe("file corruption", () => {
    it("handles corrupted JSON gracefully", async () => {
      seedMockFs({ [DECISION_LOG_FILE]: "{ invalid json }" });
      vi.resetModules();
      decisionLog = await import("../../decision-log.js");

      const recent = decisionLog.getRecentDecisions(5);
      expect(recent).toEqual([]);
    });

    it("handles missing file gracefully", () => {
      const recent = decisionLog.getRecentDecisions(5);
      expect(recent).toEqual([]);
    });
  });
});
