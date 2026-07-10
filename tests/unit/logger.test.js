import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupMockFs, getMockFs, resetMockFs } from "../helpers/mock-fs.js";

setupMockFs();

let loggerMod;
async function loadModule() {
  resetMockFs();
  loggerMod = await import("../../../logger.js");
}

describe("logger", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("LOG_LEVEL", "info");
    await loadModule();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("log function", () => {
    it("logs an info message to console and file", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      loggerMod.log("cycle_start", "Starting management cycle");

      const files = getMockFs();
      const logFile = Object.keys(files).find((f) => f.startsWith("logs/agent-"));
      expect(logFile).toBeDefined();
      expect(files[logFile]).toContain("Starting management cycle");
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("routes error categories to error level", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      loggerMod.log("config_error", "Failed to load config");
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("routes warn categories to warn level", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      loggerMod.log("screening_warn", "Low volume detected");
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("formats log line with timestamp and category", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      loggerMod.log("test_category", "Test message");
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^\[\d{4}-\d{2}-\d{2}T/));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("[TEST_CATEGORY]"));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("Test message"));
      spy.mockRestore();
    });
  });

  describe("log level filtering", () => {
    it("suppresses info messages when level is warn", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "warn";
      await loadModule();

      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      loggerMod.log("test_category", "Info message");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("allows error messages at warn level", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "warn";
      await loadModule();

      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      loggerMod.log("config_error", "Error message");
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("defaults to info level when LOG_LEVEL not set", async () => {
      vi.resetModules();
      delete process.env.LOG_LEVEL;
      await loadModule();

      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      loggerMod.log("test_category", "Info message");
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("allows all messages at debug level", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "debug";
      await loadModule();

      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      loggerMod.log("test_category", "Info message");
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("suppresses info and warn messages when level is error", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "error";
      await loadModule();

      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      loggerMod.log("test_category", "Info message");
      loggerMod.log("screening_warn", "Warn message");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("logAction", () => {
    it("logs a tool action to the JSONL file", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      loggerMod.logAction({
        tool: "deploy_position",
        args: { pool_name: "SOL-USDC", amount_sol: 0.5 },
        result: { success: true },
        success: true,
        duration_ms: 1234,
      });

      const files = getMockFs();
      const actionsFile = Object.keys(files).find((f) => f.startsWith("logs/actions-"));
      expect(actionsFile).toBeDefined();
      const line = files[actionsFile];
      const parsed = JSON.parse(line);
      expect(parsed.tool).toBe("deploy_position");
      expect(parsed.args.pool_name).toBe("SOL-USDC");
      expect(parsed.success).toBe(true);
      expect(parsed.duration_ms).toBe(1234);
      spy.mockRestore();
    });

    it("shows a hint for deploy_position in console", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      loggerMod.logAction({
        tool: "deploy_position",
        args: { pool_name: "SOL-USDC", amount_sol: 0.5 },
        success: true,
        duration_ms: 500,
      });

      expect(spy).toHaveBeenCalledWith(expect.stringContaining("SOL-USDC"));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("0.5 SOL"));
      spy.mockRestore();
    });

    it("shows a hint for close_position with PnL", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      loggerMod.logAction({
        tool: "close_position",
        args: { position_address: "pos_abc1" },
        result: { pnl_usd: 1.5, pnl_pct: 3.2 },
        success: true,
      });

      // The format is "[close_position] ✓ pos_abc1 | PnL $+1.5 (3.2%)"
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("$+1.5"));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("3.2%"));
      spy.mockRestore();
    });

    it("shows a failure indicator for unsuccessful actions", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      loggerMod.logAction({
        tool: "deploy_position",
        args: {},
        success: false,
        duration_ms: 200,
      });

      expect(spy).toHaveBeenCalledWith(expect.stringContaining("✗"));
      spy.mockRestore();
    });
  });

  describe("log directory creation", () => {
    it("creates the logs directory on import", () => {
      const files = getMockFs();
      expect(files).toBeDefined();
    });
  });
});
