import { describe, it, expect } from "vitest";
import { tools } from "../../../tools/definitions.js";

describe("tools/definitions.js", () => {
  describe("tool schemas", () => {
    it("exports an array of tools", () => {
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    });

    it("every tool has type: 'function'", () => {
      for (const tool of tools) {
        expect(tool.type).toBe("function");
      }
    });

    it("every tool has a function.name", () => {
      for (const tool of tools) {
        expect(tool.function).toBeDefined();
        expect(typeof tool.function.name).toBe("string");
        expect(tool.function.name.length).toBeGreaterThan(0);
      }
    });

    it("every tool has a function.description", () => {
      for (const tool of tools) {
        expect(typeof tool.function.description).toBe("string");
        expect(tool.function.description.length).toBeGreaterThan(0);
      }
    });

    it("every tool has function.parameters with properties", () => {
      for (const tool of tools) {
        expect(tool.function.parameters).toBeDefined();
        expect(tool.function.parameters.properties).toBeDefined();
      }
    });

    it("every tool has additionalProperties: false on parameters", () => {
      for (const tool of tools) {
        if (tool.function.parameters.type === "object") {
          expect(tool.function.parameters.additionalProperties).toBe(false);
        }
      }
    });

    it("all tool names are unique", () => {
      const names = tools.map((t) => t.function.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    it("includes essential screening tools", () => {
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("get_top_candidates");
      expect(names).toContain("get_pool_detail");
      expect(names).toContain("discover_pools");
    });

    it("includes essential management tools", () => {
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("close_position");
      expect(names).toContain("claim_fees");
      expect(names).toContain("get_position_pnl");
      expect(names).toContain("get_my_positions");
    });

    it("includes deploy tools", () => {
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("deploy_position");
      expect(names).toContain("get_wallet_balance");
    });

    it("includes token research tools", () => {
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("get_token_info");
      expect(names).toContain("get_token_narrative");
      expect(names).toContain("get_token_holders");
    });

    it("includes learning tools", () => {
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("add_lesson");
      expect(names).toContain("get_performance_history");
      expect(names).toContain("get_pool_memory");
    });

    it("includes blacklist tools", () => {
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("add_to_blacklist");
      expect(names).toContain("remove_from_blacklist");
      expect(names).toContain("list_blacklist");
    });

    it("includes smart wallet tools", () => {
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("add_smart_wallet");
      expect(names).toContain("check_smart_wallets_on_pool");
    });

    it("includes config tool", () => {
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("update_config");
    });

    it("includes study tool", () => {
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("study_top_lpers");
    });

    it("includes swap tool", () => {
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("swap_token");
    });
  });

  describe("tool name conventions", () => {
    it("all tool names use snake_case", () => {
      for (const tool of tools) {
        expect(tool.function.name).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    });

    it("all parameter names use snake_case", () => {
      for (const tool of tools) {
        const props = tool.function.parameters?.properties || {};
        for (const key of Object.keys(props)) {
          expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
        }
      }
    });
  });
});
