/**
 * Focused behavioral checks for fallback model resolution.
 * Run: node test/test-fallback-model.js
 */

import { INTERNAL_FALLBACK_MODEL, resolveFallbackModel } from "../config.js";

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected "${expected}", got "${actual}"`);
  }
  console.log(`PASS ${label}`);
}

function main() {
  assertEqual(resolveFallbackModel(undefined), INTERNAL_FALLBACK_MODEL, "missing fallbackModel uses internal default");
  assertEqual(resolveFallbackModel(""), INTERNAL_FALLBACK_MODEL, "blank fallbackModel uses internal default");
  assertEqual(resolveFallbackModel("   "), INTERNAL_FALLBACK_MODEL, "whitespace fallbackModel uses internal default");
  assertEqual(resolveFallbackModel("custom/provider-model"), "custom/provider-model", "custom fallbackModel is preserved");
  assertEqual(resolveFallbackModel("  custom/provider-model  "), "custom/provider-model", "custom fallbackModel is trimmed");
  console.log("Fallback model resolution checks passed.");
}

main();
