import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { setupMockFs, seedMockFs, resetMockFs } from "../helpers/mock-fs.js";

// Config.js reads user-config.json using __dirname-based path that's hard to
// predict in tests due to absolute path construction. We mock it to test
// defaults and shape without fighting the filesystem.
setupMockFs();

vi.mock("dotenv/config", () => ({}));

let configMod;
async function loadModule() {
  resetMockFs();
  vi.resetModules();
  configMod = await import("../../config.js");
}

describe("config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("default values", () => {
    it("provides defaults when user-config.json does not exist", async () => {
      await loadModule();
      expect(configMod.config).toBeDefined();
      expect(configMod.config.screening).toBeDefined();
      expect(configMod.config.management).toBeDefined();
    });

    it("has sensible default screening thresholds", async () => {
      await loadModule();
      const s = configMod.config.screening;
      expect(typeof s.minFeeActiveTvlRatio).toBe("number");
      expect(s.minFeeActiveTvlRatio).toBeGreaterThan(0);
      expect(typeof s.minTvl).toBe("number");
      expect(s.minTvl).toBeGreaterThan(0);
      expect(typeof s.minOrganic).toBe("number");
      expect(s.minOrganic).toBeGreaterThan(0);
      expect(typeof s.timeframe).toBe("string");
      expect(typeof s.category).toBe("string");
    });

    it("has sensible default management settings", async () => {
      await loadModule();
      const m = configMod.config.management;
      expect(typeof m.deployAmountSol).toBe("number");
      expect(m.deployAmountSol).toBeGreaterThan(0);
      expect(typeof m.gasReserve).toBe("number");
      expect(m.gasReserve).toBeGreaterThan(0);
      expect(typeof m.stopLossPct).toBe("number");
    });

    it("has sensible default schedule intervals", async () => {
      await loadModule();
      const schedule = configMod.config.schedule;
      expect(typeof schedule.managementIntervalMin).toBe("number");
      expect(schedule.managementIntervalMin).toBeGreaterThan(0);
      expect(typeof schedule.screeningIntervalMin).toBe("number");
      expect(schedule.screeningIntervalMin).toBeGreaterThan(0);
    });

    it("config object has expected top-level keys", async () => {
      await loadModule();
      expect(configMod.config.screening).toBeDefined();
      expect(configMod.config.management).toBeDefined();
      expect(configMod.config.schedule).toBeDefined();
      expect(configMod.config.strategy).toBeDefined();
    });
  });

  describe("MIN_SAFE_BINS_BELOW", () => {
    it("exports a sensible minimum", async () => {
      await loadModule();
      expect(configMod.MIN_SAFE_BINS_BELOW).toBeGreaterThanOrEqual(30);
    });
  });

  describe("reloadScreeningThresholds", () => {
    it("is a function that can be called", async () => {
      await loadModule();
      expect(typeof configMod.reloadScreeningThresholds).toBe("function");
    });
  });
});
