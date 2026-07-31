/**
 * Unit tests for risk controls (no network / wallet required).
 * Run: node test/test-risk.js
 */

import {
  clamp,
  effectiveTrailingDropPct,
  volatilitySizeMultiplier,
  shouldApplyHardTakeProfit,
  compositeCandidateScore,
  clampConfigChange,
} from "../risk.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// clamp
assert(clamp(5, 0, 10) === 5, "clamp mid");
assert(clamp(-1, 0, 10) === 0, "clamp lo");
assert(clamp(99, 0, 10) === 10, "clamp hi");

// dynamic trailing
const dropAt3 = effectiveTrailingDropPct(3, {
  trailingDropPct: 1.5,
  trailingTriggerPct: 3,
  trailingDropWidenPerPeakPct: 0.12,
  trailingMaxDropPct: 5,
});
assert(Math.abs(dropAt3 - 1.5) < 1e-9, `drop at trigger should be base, got ${dropAt3}`);

const dropAt13 = effectiveTrailingDropPct(13, {
  trailingDropPct: 1.5,
  trailingTriggerPct: 3,
  trailingDropWidenPerPeakPct: 0.12,
  trailingMaxDropPct: 5,
});
// 1.5 + (13-3)*0.12 = 2.7
assert(Math.abs(dropAt13 - 2.7) < 1e-9, `drop at 13% peak expected 2.7, got ${dropAt13}`);

const dropCapped = effectiveTrailingDropPct(100, {
  trailingDropPct: 1.5,
  trailingTriggerPct: 3,
  trailingDropWidenPerPeakPct: 0.12,
  trailingMaxDropPct: 5,
});
assert(dropCapped === 5, `max drop cap expected 5, got ${dropCapped}`);

// vol size
assert(volatilitySizeMultiplier(5, { volatilitySizeDamping: true, volSizeRef: 5, minVolSizeMultiplier: 0.4 }) === 1, "vol at ref = full size");
assert(volatilitySizeMultiplier(10, { volatilitySizeDamping: true, volSizeRef: 5, minVolSizeMultiplier: 0.4 }) === 0.5, "vol 2x ref = half size");
assert(volatilitySizeMultiplier(100, { volatilitySizeDamping: true, volSizeRef: 5, minVolSizeMultiplier: 0.4 }) === 0.4, "extreme vol floored");

// hard TP policy
assert(shouldApplyHardTakeProfit({ trailingTakeProfit: true, hardTakeProfitWhileTrailing: false, takeProfitPct: 5 }) === false, "trailing on → no hard TP");
assert(shouldApplyHardTakeProfit({ trailingTakeProfit: false, takeProfitPct: 5 }) === true, "trailing off → hard TP");
assert(shouldApplyHardTakeProfit({ trailingTakeProfit: true, hardTakeProfitWhileTrailing: true, takeProfitPct: 5 }) === true, "explicit hard TP while trailing");

// composite score prefers high fee / low vol
const strong = compositeCandidateScore({
  fee_active_tvl_ratio: 0.5,
  organic_score: 80,
  volume_window: 50_000,
  holders: 2000,
  volatility: 1,
  _degen_score: 70,
  volume_change_pct: 30,
  fee_change_pct: 20,
}, null);
const weak = compositeCandidateScore({
  fee_active_tvl_ratio: 0.05,
  organic_score: 40,
  volume_window: 5_000,
  holders: 500,
  volatility: 20,
  _degen_score: 10,
  volume_change_pct: -40,
  fee_change_pct: -40,
}, null);
assert(strong > weak, `strong pool should rank higher (${strong} vs ${weak})`);

// memory boost
const withWins = compositeCandidateScore({
  fee_active_tvl_ratio: 0.2,
  organic_score: 60,
  volume_window: 10_000,
  holders: 800,
  volatility: 3,
  _degen_score: 40,
}, { total_deploys: 5, adjusted_win_rate: 70, avg_pnl_pct: 4 });
const withLosses = compositeCandidateScore({
  fee_active_tvl_ratio: 0.2,
  organic_score: 60,
  volume_window: 10_000,
  holders: 800,
  volatility: 3,
  _degen_score: 40,
}, { total_deploys: 5, adjusted_win_rate: 20, avg_pnl_pct: -10 });
assert(withWins > withLosses, "winning memory should boost score");

// config clamps
const sl = clampConfigChange("stopLossPct", -200);
assert(sl.ok && sl.value === -90, "stopLoss clamped to -90");
const pos = clampConfigChange("positionSizePct", 2);
assert(pos.ok && pos.value === 0.95, "positionSizePct clamped");
const free = clampConfigChange("unknownKey", 42);
assert(free.ok && free.value === 42, "unknown keys pass through");

console.log("✓ risk unit tests passed");
