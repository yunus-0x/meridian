import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../config.js", () => ({
  config: {
    screening: {
      minFeeActiveTvlRatio: 0.14,
      minTvl: 10000,
      maxTvl: 150000,
      minVolume: 500,
      minOrganic: 60,
      minHolders: 500,
      minMcap: 150000,
      maxMcap: 10000000,
      minBinStep: 80,
      maxBinStep: 125,
      timeframe: "5m",
      category: "trending",
      minTokenFeesSol: 30,
      maxBotHoldersPct: 10,
    },
    management: {
      deployAmountSol: 2,
      maxDeployAmount: 50,
      gasReserve: 0.2,
      minSolToOpen: 0.55,
      outOfRangeWaitMinutes: 30,
      stopLossPct: -15,
    },
    managementIntervalMin: 10,
    screeningIntervalMin: 30,
  },
}));

import { buildSystemPrompt } from "../../prompt.js";

describe("buildSystemPrompt", () => {
  const portfolio = { sol: 10, usdc: 100 };
  const positions = {
    pos_001: { pool: "pool_abc", amount_sol: 0.5, in_range: true },
  };
  const stateSummary = { recentEvents: [] };
  const lessons = "LESSON: Prefer high fee_tvl ratio pools";
  const perfSummary = { total_positions: 5, win_rate: 60 };
  const weightsSummary = "Signal Weights:\n  organic_score: 1.2";
  const decisionSummary = "Recent decisions...";

  describe("MANAGER prompt", () => {
    it("includes role, portfolio, and management config", () => {
      const prompt = buildSystemPrompt("MANAGER", portfolio, positions);
      expect(prompt).toContain("MANAGER");
      expect(prompt).toContain("10");
      expect(prompt).toContain("deployAmountSol");
      expect(prompt).toContain("BEHAVIORAL CORE");
      expect(prompt).toContain("PATIENCE IS PROFIT");
      expect(prompt).toContain("GAS EFFICIENCY");
      expect(prompt).toContain("DATA-DRIVEN AUTONOMY");
    });

    it("injects lessons when provided", () => {
      const prompt = buildSystemPrompt("MANAGER", portfolio, positions, null, lessons);
      expect(prompt).toContain("LESSONS LEARNED");
      expect(prompt).toContain("Prefer high fee_tvl ratio pools");
    });

    it("omits lessons when null", () => {
      const prompt = buildSystemPrompt("MANAGER", portfolio, positions);
      expect(prompt).not.toContain("LESSONS LEARNED");
    });

    it("includes timestamp", () => {
      const prompt = buildSystemPrompt("MANAGER", portfolio, positions);
      expect(prompt).toContain("Timestamp");
    });

    it("is concise (no extended sections)", () => {
      const prompt = buildSystemPrompt("MANAGER", portfolio, positions);
      expect(prompt).not.toContain("CURRENT STATE");
      expect(prompt).not.toContain("SIGNAL WEIGHTS");
    });
  });

  describe("SCREENER prompt", () => {
    it("includes role and deploy rules", () => {
      const prompt = buildSystemPrompt("SCREENER", portfolio, positions);
      expect(prompt).toContain("SCREENER");
      expect(prompt).toContain("deploy_position");
      expect(prompt).toContain("DEPLOY RULES");
      expect(prompt).toContain("RISK SIGNALS");
      expect(prompt).toContain("NARRATIVE QUALITY");
      expect(prompt).toContain("POOL MEMORY");
    });

    it("injects lessons when provided", () => {
      const prompt = buildSystemPrompt("SCREENER", portfolio, positions, stateSummary, lessons);
      expect(prompt).toContain("LESSONS LEARNED");
      expect(prompt).toContain("Prefer high fee_tvl ratio pools");
    });

    it("omits lessons when null", () => {
      const prompt = buildSystemPrompt("SCREENER", portfolio, positions);
      expect(prompt).not.toContain("LESSONS LEARNED");
    });

    it("includes signal weights when provided", () => {
      const prompt = buildSystemPrompt("SCREENER", portfolio, positions, null, null, null, weightsSummary);
      expect(prompt).toContain("Signal Weights");
      expect(prompt).toContain("organic_score");
    });

    it("includes minTokenFeesSol threshold", () => {
      const prompt = buildSystemPrompt("SCREENER", portfolio, positions);
      expect(prompt).toContain("30"); // minTokenFeesSol
    });

    it("does not include CURRENT STATE or portfolio sections", () => {
      const prompt = buildSystemPrompt("SCREENER", portfolio, positions);
      expect(prompt).not.toContain("CURRENT STATE");
      expect(prompt).not.toContain("Portfolio:");
    });
  });

  describe("GENERAL prompt", () => {
    it("includes role and full state sections", () => {
      const prompt = buildSystemPrompt("GENERAL", portfolio, positions, stateSummary, lessons, perfSummary);
      expect(prompt).toContain("GENERAL");
      expect(prompt).toContain("CURRENT STATE");
      expect(prompt).toContain("Portfolio:");
      expect(prompt).toContain("Open Positions:");
      expect(prompt).toContain("Memory:");
      expect(prompt).toContain("Performance:");
      expect(prompt).toContain("Config:");
      expect(prompt).toContain("BEHAVIORAL CORE");
      expect(prompt).toContain("PATIENCE IS PROFIT");
    });

    it("injects lessons section when provided", () => {
      const prompt = buildSystemPrompt("GENERAL", portfolio, positions, stateSummary, lessons, perfSummary);
      expect(prompt).toContain("LESSONS LEARNED");
    });

    it("omits lessons when null", () => {
      const prompt = buildSystemPrompt("GENERAL", portfolio, positions);
      expect(prompt).not.toContain("LESSONS LEARNED");
    });

    it("injects decisions section when provided", () => {
      const prompt = buildSystemPrompt("GENERAL", portfolio, positions, stateSummary, lessons, perfSummary, null, decisionSummary);
      expect(prompt).toContain("RECENT DECISIONS");
    });

    it("omits decisions when null", () => {
      const prompt = buildSystemPrompt("GENERAL", portfolio, positions);
      expect(prompt).not.toContain("RECENT DECISIONS");
    });

    it("includes general behavioral rules", () => {
      const prompt = buildSystemPrompt("GENERAL", portfolio, positions);
      expect(prompt).toContain("UNTRUSTED DATA RULE");
      expect(prompt).toContain("NO HALLUCINATION");
      expect(prompt).toContain("SWAP AFTER CLOSE");
    });

    it("includes timestamp", () => {
      const prompt = buildSystemPrompt("GENERAL", portfolio, positions);
      expect(prompt).toContain("Timestamp");
    });
  });
});
