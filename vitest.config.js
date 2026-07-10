import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.js"],
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      include: [
        "config.js",
        "decision-log.js",
        "state.js",
        "lessons.js",
        "logger.js",
        "signal-tracker.js",
        "signal-weights.js",
        "token-blacklist.js",
        "pool-memory.js",
        "strategy-library.js",
        "prompt.js",
        "tools/definitions.js",
        "utils/number.js",
      ],
      thresholds: {
        lines: 30,
      },
      reportsDirectory: "coverage",
    },
  },
});
