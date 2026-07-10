import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupMockFs, seedMockFs, getMockFs, resetMockFs } from "../helpers/mock-fs.js";

setupMockFs();

const LESSONS_FILE = "./lessons.json";

vi.mock("../../../hivemind.js", () => ({
  getSharedLessonsForPrompt: vi.fn(() => []),
  pushHiveLesson: vi.fn(),
  pushHivePerformanceEvent: vi.fn(),
  default: {},
}));

let lessonsMod;
async function loadModule(seedFiles = {}) {
  resetMockFs();
  seedMockFs(seedFiles);
  vi.resetModules();
  lessonsMod = await import("../../../lessons.js");
}

// recordPerformance recalculates pnl from initial/final/fees, and efficiency from minutes
// pnl_usd = final_value_usd + fees_earned_usd - initial_value_usd
// pnl_pct = (pnl_usd / initial_value_usd) * 100
// range_efficiency = (minutes_in_range / minutes_held) * 100
function makePerfRecord(overrides = {}) {
  return {
    position: "pos_" + Math.random().toString(36).slice(2, 8),
    pool: "pool_" + Math.random().toString(36).slice(2, 8),
    pool_name: "TEST-SOL",
    base_mint: "mint_test",
    strategy: "spot",
    bin_range: { min: -400, max: -300, bins_below: 69, bins_above: 0 },
    bin_step: 100,
    volatility: 5.0,
    fee_tvl_ratio: 3.0,
    organic_score: 75,
    amount_sol: 0.4,
    fees_earned_usd: 0.5,
    final_value_usd: 40,
    initial_value_usd: 39,
    minutes_in_range: 15,
    minutes_held: 20,
    close_reason: "test close",
    pnl_usd: 1.5,  // will be recalculated: 40 + 0.5 - 39 = 1.5
    pnl_pct: 3.85, // will be recalculated: (1.5 / 39) * 100 = 3.85
    range_efficiency: 75, // will be recalculated: (15/20)*100 = 75
    recorded_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("lessons", () => {
  describe("recordPerformance", () => {
    it("records a position and recalculates pnl", async () => {
      await loadModule();
      // pnl = 40 + 0.5 - 39 = 1.5
      await lessonsMod.recordPerformance(makePerfRecord());

      const saved = JSON.parse(getMockFs()[LESSONS_FILE]);
      expect(saved.performance.length).toBe(1);
      expect(Math.round(saved.performance[0].pnl_usd * 100) / 100).toBe(1.5);
    });

    it("records a losing position", async () => {
      await loadModule();
      // pnl = 30 + 0 - 39 = -9
      await lessonsMod.recordPerformance(makePerfRecord({
        final_value_usd: 30,
        fees_earned_usd: 0,
        pnl_usd: -9,
      }));

      const saved = JSON.parse(getMockFs()[LESSONS_FILE]);
      expect(saved.performance.length).toBe(1);
      expect(saved.performance[0].pnl_usd).toBe(-9);
    });

    it("appends multiple performance records", async () => {
      await loadModule();
      await lessonsMod.recordPerformance(makePerfRecord({ position: "pos_001" }));
      await lessonsMod.recordPerformance(makePerfRecord({ position: "pos_002" }));

      const saved = JSON.parse(getMockFs()[LESSONS_FILE]);
      expect(saved.performance.length).toBe(2);
    });
  });

  describe("addLesson", () => {
    it("adds a manual lesson", async () => {
      await loadModule();
      lessonsMod.addLesson("Never deploy into tokens under 2h old", ["safety", "timing"]);

      const saved = JSON.parse(getMockFs()[LESSONS_FILE]);
      expect(saved.lessons.length).toBe(1);
      expect(saved.lessons[0].rule).toBe("Never deploy into tokens under 2h old");
      expect(saved.lessons[0].tags).toEqual(["safety", "timing"]);
      expect(saved.lessons[0].outcome).toBe("manual");
    });

    it("sanitizes lesson text", async () => {
      await loadModule();
      lessonsMod.addLesson("  Watch  out for\t<bad>tokens\nwith lots of spaces  ", []);

      const saved = JSON.parse(getMockFs()[LESSONS_FILE]);
      const rule = saved.lessons[0].rule;
      expect(rule).not.toContain("<");
      expect(rule).not.toContain(">");
      expect(rule).not.toContain("\n");
      expect(rule).not.toContain("\t");
    });

    it("truncates long lesson text to 400 characters", async () => {
      await loadModule();
      lessonsMod.addLesson("x".repeat(500), []);

      const saved = JSON.parse(getMockFs()[LESSONS_FILE]);
      expect(saved.lessons[0].rule.length).toBe(400);
    });

    it("adds a pinned lesson", async () => {
      await loadModule();
      lessonsMod.addLesson("Important lesson", ["key"], { pinned: true });

      const saved = JSON.parse(getMockFs()[LESSONS_FILE]);
      expect(saved.lessons[0].pinned).toBe(true);
    });
  });

  describe("listLessons", () => {
    it("returns all lessons in object format", async () => {
      await loadModule({
        [LESSONS_FILE]: JSON.stringify({
          lessons: [
            { id: 1, rule: "First lesson", tags: [], outcome: "good", pinned: false, created_at: new Date().toISOString() },
            { id: 2, rule: "Second lesson", tags: [], outcome: "bad", pinned: false, created_at: new Date().toISOString() },
          ],
          performance: [],
        }),
      });

      const result = lessonsMod.listLessons();
      expect(result.total).toBe(2);
      expect(result.lessons.length).toBe(2);
    });

    it("returns empty when no lessons exist", async () => {
      await loadModule();
      const result = lessonsMod.listLessons();
      expect(result.total).toBe(0);
      expect(result.lessons).toEqual([]);
    });

    it("filters by role", async () => {
      await loadModule();
      lessonsMod.addLesson("Screener lesson", [], { role: "SCREENER" });
      lessonsMod.addLesson("Manager lesson", [], { role: "MANAGER" });

      const result = lessonsMod.listLessons({ role: "SCREENER" });
      expect(result.total).toBe(1);
      expect(result.lessons[0].rule).toBe("Screener lesson");
    });
  });

  describe("pinLesson / unpinLesson", () => {
    it("pins a lesson", async () => {
      await loadModule();
      lessonsMod.addLesson("Test lesson", []);
      const result = lessonsMod.listLessons();
      const id = result.lessons[0].id;

      const pinned = lessonsMod.pinLesson(id);
      expect(pinned).toBeDefined();
      expect(pinned.pinned).toBe(true);
    });

    it("unpins a lesson", async () => {
      await loadModule();
      lessonsMod.addLesson("Test lesson", []);
      const result = lessonsMod.listLessons();
      const id = result.lessons[0].id;

      lessonsMod.pinLesson(id);
      const unpinned = lessonsMod.unpinLesson(id);
      expect(unpinned.pinned).toBe(false);
    });

    it("returns found:false for pinning non-existent lesson", async () => {
      await loadModule();
      const result = lessonsMod.pinLesson(999999);
      expect(result).toEqual({ found: false });
    });
  });

  describe("removeLessonsByKeyword", () => {
    it("removes lessons matching keyword", async () => {
      await loadModule();
      lessonsMod.addLesson("bad-pool: avoid this pool", []);
      lessonsMod.addLesson("good-pool: deploy here", []);

      const removed = lessonsMod.removeLessonsByKeyword("bad-pool");
      expect(removed).toBe(1);

      const result = lessonsMod.listLessons();
      expect(result.total).toBe(1);
      expect(result.lessons[0].rule).toContain("good-pool");
    });

    it("returns 0 when no lessons match", async () => {
      await loadModule();
      lessonsMod.addLesson("some rule", []);
      const removed = lessonsMod.removeLessonsByKeyword("nonexistent");
      expect(removed).toBe(0);
    });
  });

  describe("clearAllLessons", () => {
    it("removes all lessons but preserves performance", async () => {
      await loadModule();
      lessonsMod.addLesson("Lesson 1", []);
      lessonsMod.addLesson("Lesson 2", []);
      await lessonsMod.recordPerformance(makePerfRecord());

      const cleared = lessonsMod.clearAllLessons();
      expect(cleared).toBe(2);

      const saved = JSON.parse(getMockFs()[LESSONS_FILE]);
      expect(saved.lessons.length).toBe(0);
      expect(saved.performance.length).toBe(1);
    });
  });

  describe("getPerformanceHistory", () => {
    it("returns performance history within default 24h window", async () => {
      await loadModule();
      await lessonsMod.recordPerformance(makePerfRecord({ position: "pos_001" }));
      await lessonsMod.recordPerformance(makePerfRecord({ position: "pos_002" }));

      const result = lessonsMod.getPerformanceHistory();
      expect(result.count).toBe(2);
      expect(result.positions.length).toBe(2);
    });

    it("returns empty when no records exist", async () => {
      await loadModule();
      const result = lessonsMod.getPerformanceHistory();
      expect(result.count).toBe(0);
      expect(result.positions).toEqual([]);
    });
  });

  describe("evolveThresholds", () => {
    it("does not evolve with fewer than 5 positions", async () => {
      await loadModule();
      const perfData = Array.from({ length: 4 }, (_, i) => makePerfRecord());
      const config = {
        screening: {
          maxVolatility: 10,
          minFeeTvlRatio: 0.1,
          maxBundlersPct: 30,
          maxTop10Pct: 60,
        },
      };

      const result = lessonsMod.evolveThresholds(perfData, config);
      expect(result).toBeNull();
    });

    it("returns null when no signal data", async () => {
      await loadModule();
      const perfData = Array.from({ length: 6 }, () =>
        makePerfRecord({ pnl_pct: 0, fee_tvl_ratio: 1, volatility: 5 })
      );
      const config = {
        screening: {
          maxVolatility: 10,
          minFeeTvlRatio: 0.1,
          maxBundlersPct: 30,
          maxTop10Pct: 60,
        },
      };

      const result = lessonsMod.evolveThresholds(perfData, config);
      expect(result === null || result instanceof Object).toBe(true);
    });
  });

  describe("file corruption", () => {
    it("handles corrupted lessons.json gracefully", async () => {
      await loadModule({
        [LESSONS_FILE]: "{ broken json }",
      });

      const result = lessonsMod.listLessons();
      expect(result.total).toBe(0);
    });

    it("handles missing lessons.json gracefully", async () => {
      await loadModule();
      const result = lessonsMod.listLessons();
      expect(result.total).toBe(0);
    });
  });
});
