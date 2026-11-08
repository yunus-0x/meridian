/**
 * Empirical Challenge Test Suite for Milestone 2 (Domain Logic, Config & Position State)
 * 
 * Verifies:
 * - exit-rules.ts (all 5 deterministic rules, chronos outlooks, suspect PnL guards, computeBinsBelow)
 * - state.ts (position tracking, atomic persistence, confirmPeak, registerExitSignal, updatePnlAndCheckExits)
 * - config.ts (computeDeployAmount compounding, scaleBinsForBinStep, Zod validation)
 * - Zero Telegram test leakage verification
 */

process.env.NODE_ENV = "test";
process.env.DISABLE_TELEGRAM = "true";
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

import { describe, test, it, expect, assert, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { config, computeDeployAmount, scaleBinsForBinStep, updateConfig } from "../config.js";
import { UserConfigSchema, RuntimeConfigSchema } from "../src/schemas/config.js";
import { getDeterministicCloseRule, computeBinsBelow, type DeterministicPositionMetrics, type ManagementConfigInput, type ChronosTacticalContext } from "../exit-rules.js";
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  minutesOutOfRange,
  confirmPeak,
  registerExitSignal,
  updatePnlAndCheckExits,
  getTrackedPosition,
  getTrackedPositions,
  recordClaim,
  recordClose,
  isPostClaimSettling,
  getState,
  saveState,
  POST_CLAIM_SETTLE_MS,
} from "../state.js";
import { StateJsonSchema } from "../src/schemas/state.js";
import { repoPath } from "../repo-root.js";

const STATE_FILE = repoPath("state.json");
const USER_CONFIG_FILE = repoPath("user-config.json");

describe("Milestone 2 Empirical Challenge: exit-rules.ts", () => {
  const baseMgmtConfig: ManagementConfigInput = {
    stopLossPct: -50,
    knifeRescueStopLossPct: -15,
    takeProfitPct: 5,
    outOfRangeBinsToClose: 10,
    outOfRangeWaitMinutes: 60,
    outOfRangeAboveWaitMinutes: 60,
    outOfRangeBelowWaitMinutes: 240,
    outOfRangeBelowEarlyCutMinutes: 90,
    minAgeBeforeYieldCheck: 60,
    minPositionFeeVelocityPctPerHr: 0.45,
    minFeePerTvl24h: 7,
    solMode: false,
  };

  test("Rule 1: Stop Loss standard trigger & boundaries", () => {
    const posAtStopLoss: DeterministicPositionMetrics = {
      position: "test-pos-sl-1",
      pnl_pct: -50,
    };
    const res1 = getDeterministicCloseRule(posAtStopLoss, baseMgmtConfig);
    assert.deepEqual(res1, { action: "CLOSE", rule: 1, reason: "stop loss" });

    const posJustAboveStopLoss: DeterministicPositionMetrics = {
      position: "test-pos-sl-2",
      pnl_pct: -49.99,
    };
    const res2 = getDeterministicCloseRule(posJustAboveStopLoss, baseMgmtConfig);
    assert.equal(res2, null);
  });

  test("Rule 1: Knife Rescue trigger with Chronos trigger or WEAK_STRUCTURAL_BREAKDOWN", () => {
    const posKnife: DeterministicPositionMetrics = {
      position: "test-pos-knife-1",
      pnl_pct: -15.5,
    };
    // No Chronos trigger -> null
    const resNoChronos = getDeterministicCloseRule(posKnife, baseMgmtConfig, null);
    assert.equal(resNoChronos, null);

    // With knife_rescue_trigger -> Rule 1 knife rescue
    const resTrigger = getDeterministicCloseRule(posKnife, baseMgmtConfig, { knife_rescue_trigger: true });
    assert.deepEqual(resTrigger, { action: "CLOSE", rule: 1, reason: "stop loss (knife rescue)" });

    // With WEAK_STRUCTURAL_BREAKDOWN -> Rule 1 knife rescue
    const resWeak = getDeterministicCloseRule(posKnife, baseMgmtConfig, { oor_below_outlook: "WEAK_STRUCTURAL_BREAKDOWN" });
    assert.deepEqual(resWeak, { action: "CLOSE", rule: 1, reason: "stop loss (knife rescue)" });

    // Boundary: PnL at -14.99% with knife trigger -> should not fire
    const posKnifeBoundary: DeterministicPositionMetrics = {
      position: "test-pos-knife-2",
      pnl_pct: -14.99,
    };
    assert.equal(getDeterministicCloseRule(posKnifeBoundary, baseMgmtConfig, { knife_rescue_trigger: true }), null);
  });

  test("Rule 2: Take Profit standard & take_profit_mult scaling", () => {
    const posTp: DeterministicPositionMetrics = {
      position: "test-pos-tp-1",
      pnl_pct: 5.0,
    };
    const resTp = getDeterministicCloseRule(posTp, baseMgmtConfig);
    assert.deepEqual(resTp, { action: "CLOSE", rule: 2, reason: "take profit" });

    const posTpUnder: DeterministicPositionMetrics = {
      position: "test-pos-tp-2",
      pnl_pct: 4.99,
    };
    assert.equal(getDeterministicCloseRule(posTpUnder, baseMgmtConfig), null);

    // With multiplier 1.5x (5% * 1.5 = 7.5%)
    const ctxMult: ChronosTacticalContext = { take_profit_mult: 1.5 };
    assert.equal(getDeterministicCloseRule({ position: "test-pos-tp-3", pnl_pct: 6.5 }, baseMgmtConfig, ctxMult), null);
    assert.deepEqual(
      getDeterministicCloseRule({ position: "test-pos-tp-4", pnl_pct: 7.5 }, baseMgmtConfig, ctxMult),
      { action: "CLOSE", rule: 2, reason: "take profit" }
    );
  });

  test("Rule 3: Pumped far above range trigger & boundary", () => {
    // upper_bin = 100, outOfRangeBinsToClose = 10 -> active_bin > 110 fires
    const posPumped: DeterministicPositionMetrics = {
      position: "test-pos-pumped",
      upper_bin: 100,
      active_bin: 111,
    };
    assert.deepEqual(getDeterministicCloseRule(posPumped, baseMgmtConfig), {
      action: "CLOSE",
      rule: 3,
      reason: "pumped far above range",
    });

    // Boundary: active_bin = 110 does not fire
    const posBoundary: DeterministicPositionMetrics = {
      position: "test-pos-pumped-bound",
      upper_bin: 100,
      active_bin: 110,
    };
    assert.equal(getDeterministicCloseRule(posBoundary, baseMgmtConfig), null);
  });

  test("Rule 4: OOR above and below duration wait with Chronos tactical outlooks", () => {
    // OOR above (limit: 60m)
    const posAboveUnder: DeterministicPositionMetrics = {
      position: "test-oor-above-1",
      active_bin: 105,
      upper_bin: 100,
      lower_bin: 90,
      minutes_out_of_range: 59,
    };
    assert.equal(getDeterministicCloseRule(posAboveUnder, baseMgmtConfig), null);

    const posAboveTrigger: DeterministicPositionMetrics = {
      position: "test-oor-above-2",
      active_bin: 105,
      upper_bin: 100,
      lower_bin: 90,
      minutes_out_of_range: 60,
    };
    assert.deepEqual(getDeterministicCloseRule(posAboveTrigger, baseMgmtConfig), {
      action: "CLOSE",
      rule: 4,
      reason: "OOR above (60m)",
    });

    // OOR below standard (limit: 240m)
    const posBelowStandardHold: DeterministicPositionMetrics = {
      position: "test-oor-below-1",
      active_bin: 85,
      upper_bin: 100,
      lower_bin: 90,
      minutes_out_of_range: 120,
    };
    assert.equal(getDeterministicCloseRule(posBelowStandardHold, baseMgmtConfig), null);

    const posBelowStandardCut: DeterministicPositionMetrics = {
      position: "test-oor-below-2",
      active_bin: 85,
      upper_bin: 100,
      lower_bin: 90,
      minutes_out_of_range: 240,
    };
    assert.deepEqual(getDeterministicCloseRule(posBelowStandardCut, baseMgmtConfig), {
      action: "CLOSE",
      rule: 4,
      reason: "OOR below (240m)",
    });

    // OOR below early cut (90m) with WEAK_STRUCTURAL_BREAKDOWN
    const ctxWeak: ChronosTacticalContext = { oor_below_outlook: "WEAK_STRUCTURAL_BREAKDOWN" };
    const posBelowWeakHold: DeterministicPositionMetrics = {
      position: "test-oor-below-3",
      active_bin: 85,
      upper_bin: 100,
      lower_bin: 90,
      minutes_out_of_range: 89,
    };
    assert.equal(getDeterministicCloseRule(posBelowWeakHold, baseMgmtConfig, ctxWeak), null);

    const posBelowWeakCut: DeterministicPositionMetrics = {
      position: "test-oor-below-4",
      active_bin: 85,
      upper_bin: 100,
      lower_bin: 90,
      minutes_out_of_range: 90,
    };
    assert.deepEqual(getDeterministicCloseRule(posBelowWeakCut, baseMgmtConfig, ctxWeak), {
      action: "CLOSE",
      rule: 4,
      reason: "OOR below (90m)",
    });

    // OOR below hold extension (+90m -> 330m) with STRONG_REBOUND_PROBABILITY
    const ctxRebound: ChronosTacticalContext = { oor_below_outlook: "STRONG_REBOUND_PROBABILITY" };
    const posBelowReboundHold: DeterministicPositionMetrics = {
      position: "test-oor-below-5",
      active_bin: 85,
      upper_bin: 100,
      lower_bin: 90,
      pnl_pct: -10,
      minutes_out_of_range: 300, // past 240m, but under 330m
    };
    assert.equal(getDeterministicCloseRule(posBelowReboundHold, baseMgmtConfig, ctxRebound), null);

    const posBelowReboundCut: DeterministicPositionMetrics = {
      position: "test-oor-below-6",
      active_bin: 85,
      upper_bin: 100,
      lower_bin: 90,
      pnl_pct: -10,
      minutes_out_of_range: 330,
    };
    assert.deepEqual(getDeterministicCloseRule(posBelowReboundCut, baseMgmtConfig, ctxRebound), {
      action: "CLOSE",
      rule: 4,
      reason: "OOR below (330m)",
    });

    // Severe loss (pnl <= -25%) negates rebound extension
    const posBelowReboundSevere: DeterministicPositionMetrics = {
      position: "test-oor-below-7",
      active_bin: 85,
      upper_bin: 100,
      lower_bin: 90,
      pnl_pct: -26,
      minutes_out_of_range: 240,
    };
    assert.deepEqual(getDeterministicCloseRule(posBelowReboundSevere, baseMgmtConfig, ctxRebound), {
      action: "CLOSE",
      rule: 4,
      reason: "OOR below (240m)",
    });
  });

  test("Rule 5: Low yield & dead capital scenarios and let_winners_run bypass", () => {
    // Scenario 1: Dead capital + volume decay warning
    const posDeadCapital: DeterministicPositionMetrics = {
      position: "test-low-yield-1",
      pnl_pct: 0.1,
      age_minutes: 45,
      total_value_true_usd: 100,
      collected_fees_true_usd: 0.05, // 0.05% fee earned in 0.75 hr = 0.067%/hr < 0.45 * 0.7 (0.315%/hr)
    };
    const ctxDecay: ChronosTacticalContext = { volume_decay_warning: true };
    assert.deepEqual(getDeterministicCloseRule(posDeadCapital, baseMgmtConfig, ctxDecay), {
      action: "CLOSE",
      rule: 5,
      reason: "low yield (dead capital + volume decay)",
    });

    // Scenario 2: Realized fee velocity low
    const posLowVelocity: DeterministicPositionMetrics = {
      position: "test-low-yield-2",
      pnl_pct: 0.5,
      age_minutes: 90,
      total_value_true_usd: 100,
      collected_fees_true_usd: 0.1, // 0.1% over 1.5 hr = 0.067%/hr < 0.45%/hr
    };
    assert.deepEqual(getDeterministicCloseRule(posLowVelocity, baseMgmtConfig), {
      action: "CLOSE",
      rule: 5,
      reason: "low yield",
    });

    // Scenario 3: Bypassed by let_winners_run
    const ctxWinnersRun: ChronosTacticalContext = { let_winners_run: true };
    assert.equal(getDeterministicCloseRule(posLowVelocity, baseMgmtConfig, ctxWinnersRun), null);

    // Scenario 4: Young position protection (age < 60m and no volume decay)
    const posYoung: DeterministicPositionMetrics = {
      position: "test-low-yield-3",
      pnl_pct: 0.5,
      age_minutes: 30,
      total_value_true_usd: 100,
      collected_fees_true_usd: 0.01,
    };
    assert.equal(getDeterministicCloseRule(posYoung, baseMgmtConfig), null);
  });

  test("Suspicious PnL Protection: pricing glitch vs real rug", () => {
    // Seed tracked position in state for deposit comparison
    const state = getState();
    state.positions["pos-pricing-glitch"] = {
      position: "pos-pricing-glitch",
      pool: "pool-glitch",
      strategy: "bid_ask",
      bin_range: { min: 100, max: 120 },
      amount_sol: 10,
      amount_x: 0,
      active_bin_at_deploy: 110,
      bin_step: 100,
      volatility: 1,
      fee_tvl_ratio: 0.1,
      initial_fee_tvl_24h: 0.1,
      organic_score: 90,
      initial_value_usd: 1000,
      entry_mcap: 1000000,
      entry_tvl: 50000,
      entry_volume: 10000,
      entry_holders: 500,
      signal_snapshot: null,
      deployed_at: new Date().toISOString(),
      out_of_range_since: null,
      last_claim_at: null,
      total_fees_claimed_usd: 0,
      rebalance_count: 0,
      missing_onchain_count: 0,
      closed: false,
      closed_at: null,
      notes: [],
      instruction: null,
      peak_pnl_pct: 0,
      pending_peak_pnl_pct: null,
      pending_peak_confirm_count: 0,
      pending_peak_started_at: null,
      pending_exit_action: null,
      pending_exit_count: 0,
      pending_exit_started_at: null,
      trailing_active: false,
    };
    saveState(state);

    try {
      // Glitch scenario: PnL is -95% but current value is $800 (>25% of $1000 deposit)
      const posGlitch: DeterministicPositionMetrics = {
        position: "pos-pricing-glitch",
        pnl_pct: -95,
        total_value_true_usd: 800,
      };
      const resGlitch = getDeterministicCloseRule(posGlitch, baseMgmtConfig);
      assert.equal(resGlitch, null, "Should skip PnL stop loss when glitch is detected (>25% value remains)");

      // Real rug scenario: PnL is -95% and current value is $10 (<=25% of $1000 deposit)
      const posRug: DeterministicPositionMetrics = {
        position: "pos-pricing-glitch",
        pnl_pct: -95,
        total_value_true_usd: 10,
      };
      const resRug = getDeterministicCloseRule(posRug, baseMgmtConfig);
      assert.deepEqual(resRug, { action: "CLOSE", rule: 1, reason: "stop loss" }, "Real crash must trigger Stop Loss");

      // Explicit pnl_pct_suspicious flag
      const posExplicitSuspect: DeterministicPositionMetrics = {
        position: "pos-pricing-glitch",
        pnl_pct: -60,
        pnl_pct_suspicious: true,
        total_value_true_usd: 10,
      };
      assert.equal(getDeterministicCloseRule(posExplicitSuspect, baseMgmtConfig), null);
    } finally {
      // Clean up test position
      const s = getState();
      delete s.positions["pos-pricing-glitch"];
      saveState(s);
    }
  });

  test("computeBinsBelow: volatility scaling & validation", () => {
    // Valid volatility
    const bins100 = computeBinsBelow(1, 100);
    assert.ok(bins100 >= 35 && bins100 <= 69);

    const bins200 = computeBinsBelow(5, 200);
    // Scaled down for 200 step
    assert.ok(bins200 >= 22 && bins200 <= 36);

    // Invalid volatility throws
    assert.throws(() => computeBinsBelow(0, 100), /Invalid volatility/);
    assert.throws(() => computeBinsBelow(-5, 100), /Invalid volatility/);
    assert.throws(() => computeBinsBelow(NaN, 100), /Invalid volatility/);
    assert.throws(() => computeBinsBelow("invalid", 100), /Invalid volatility/);
  });
});

describe("Milestone 2 Empirical Challenge: state.ts", () => {
  const TEST_POS = "test-state-pos-empirical-1";

  beforeEach(() => {
    const s = getState();
    delete s.positions[TEST_POS];
    saveState(s);
  });

  afterEach(() => {
    const s = getState();
    delete s.positions[TEST_POS];
    saveState(s);
  });

  test("Position tracking and OOR timestamping lifecycle", () => {
    trackPosition({
      position: TEST_POS,
      pool: "test-pool-address",
      pool_name: "TEST/SOL",
      amount_sol: 1.5,
      bin_step: 100,
      volatility: 2.5,
    });

    const pos = getTrackedPosition(TEST_POS);
    assert.ok(pos);
    assert.equal(pos.position, TEST_POS);
    assert.equal(pos.pool_name, "TEST/SOL");
    assert.equal(pos.out_of_range_since, null);
    assert.equal(minutesOutOfRange(TEST_POS), 0);

    // Mark out of range
    markOutOfRange(TEST_POS);
    const posOor = getTrackedPosition(TEST_POS);
    assert.ok(posOor?.out_of_range_since);
    const firstOorTime = posOor.out_of_range_since;

    // Second mark does not overwrite first timestamp
    markOutOfRange(TEST_POS);
    assert.equal(getTrackedPosition(TEST_POS)?.out_of_range_since, firstOorTime);

    // Mark back in range
    markInRange(TEST_POS);
    assert.equal(getTrackedPosition(TEST_POS)?.out_of_range_since, null);
  });

  test("Atomic state persistence via .tmp and renameSync", () => {
    const state = getState();
    state.positions[TEST_POS] = {
      position: TEST_POS,
      pool: "pool-atomic",
      strategy: "bid_ask",
      bin_range: { min: 10, max: 20 },
      amount_sol: 1,
      amount_x: 0,
      active_bin_at_deploy: 15,
      bin_step: 100,
      volatility: 1,
      fee_tvl_ratio: 0.1,
      initial_fee_tvl_24h: 0.1,
      organic_score: 80,
      initial_value_usd: 200,
      entry_mcap: 100000,
      entry_tvl: 10000,
      entry_volume: 5000,
      entry_holders: 200,
      signal_snapshot: null,
      deployed_at: new Date().toISOString(),
      out_of_range_since: null,
      last_claim_at: null,
      total_fees_claimed_usd: 0,
      rebalance_count: 0,
      missing_onchain_count: 0,
      closed: false,
      closed_at: null,
      notes: [],
      instruction: null,
      peak_pnl_pct: 0,
      pending_peak_pnl_pct: null,
      pending_peak_confirm_count: 0,
      pending_peak_started_at: null,
      pending_exit_action: null,
      pending_exit_count: 0,
      pending_exit_started_at: null,
      trailing_active: false,
    };

    saveState(state);
    assert.ok(fs.existsSync(STATE_FILE));
    assert.ok(!fs.existsSync(`${STATE_FILE}.tmp`), "Temporary file must not linger after renameSync");

    const reloaded = getState();
    assert.ok(reloaded.positions[TEST_POS]);
    assert.equal(reloaded.positions[TEST_POS].pool, "pool-atomic");
  });

  test("confirmPeak: multi-tick confirmation and rejection on dip", () => {
    trackPosition({ position: TEST_POS, pool: "test-pool" });

    // Tick 1 at +5% PnL -> pending, not confirmed yet
    const t1 = confirmPeak(TEST_POS, 5.0, 2);
    assert.equal(t1, false);
    let p = getTrackedPosition(TEST_POS);
    assert.equal(p?.peak_pnl_pct, 0);
    assert.equal(p?.pending_peak_pnl_pct, 5.0);
    assert.equal(p?.pending_peak_confirm_count, 1);

    // Dip before tick 2 -> candidate drops below current peak (0%) -> resets pending
    const tDip = confirmPeak(TEST_POS, -1.0, 2);
    assert.equal(tDip, false);
    p = getTrackedPosition(TEST_POS);
    assert.equal(p?.pending_peak_pnl_pct, null);
    assert.equal(p?.pending_peak_confirm_count, 0);

    // Now tick 1 at +6% PnL
    confirmPeak(TEST_POS, 6.0, 2);
    // Tick 2 at +6.2% PnL -> confirmed!
    const t2 = confirmPeak(TEST_POS, 6.2, 2);
    assert.equal(t2, true);
    p = getTrackedPosition(TEST_POS);
    assert.equal(p?.peak_pnl_pct, 6.2);
    assert.equal(p?.pending_peak_pnl_pct, null);
  });

  test("registerExitSignal: streak tracking and confirmation", () => {
    trackPosition({ position: TEST_POS, pool: "test-pool" });

    // Tick 1
    const s1 = registerExitSignal(TEST_POS, "TRAILING_TP", 2);
    assert.equal(s1.fire, false);
    assert.equal(s1.count, 1);

    // Tick 2 with same signal -> fires!
    const s2 = registerExitSignal(TEST_POS, "TRAILING_TP", 2);
    assert.equal(s2.fire, true);
    assert.equal(s2.count, 2);

    // Tick with null resets streak
    registerExitSignal(TEST_POS, "TRAILING_TP", 2);
    const sReset = registerExitSignal(TEST_POS, null, 2);
    assert.equal(sReset.fire, false);
    assert.equal(sReset.count, 0);
  });

  test("updatePnlAndCheckExits: trailing TP, stop loss, and suspicious PnL protection", () => {
    trackPosition({ position: TEST_POS, pool: "test-pool", initial_value_usd: 100 });
    // Raise confirmed peak to 10%
    confirmPeak(TEST_POS, 10.0, 1);

    const mgmt = {
      stopLossPct: -30,
      knifeRescueStopLossPct: -15,
      takeProfitPct: 20,
      outOfRangeBinsToClose: 10,
      outOfRangeWaitMinutes: 60,
      minFeePerTvl24h: 5,
      trailingTakeProfit: true,
      trailingTriggerPct: 3.8,
      trailingDropPct: 1.5,
    };

    // Current PnL dropped from 10% to 8% (drop of 2% >= 1.5%) -> triggers TRAILING_TP
    const res = updatePnlAndCheckExits(TEST_POS, { pnl_pct: 8.0 }, mgmt);
    assert.ok(res);
    assert.equal(res.action, "TRAILING_TP");
    assert.equal(res.needs_confirmation, true);

    // But if pnl_pct_suspicious = true -> suppressed!
    const resSuspect = updatePnlAndCheckExits(TEST_POS, { pnl_pct: 8.0, pnl_pct_suspicious: true }, mgmt);
    assert.equal(resSuspect, null);
  });

  test("Corrupted state.json falls back to valid schema without crashing", () => {
    const originalState = fs.readFileSync(STATE_FILE, "utf8");
    try {
      fs.writeFileSync(STATE_FILE, "{ malformed json ");
      const recovered = getState();
      assert.deepEqual(recovered.positions, {});
      assert.ok(Array.isArray(recovered.recentEvents));
    } finally {
      fs.writeFileSync(STATE_FILE, originalState);
    }
  });
});

describe("Milestone 2 Empirical Challenge: config.ts", () => {
  test("computeDeployAmount: compounding scaling, floor, ceil, and conviction bounds", () => {
    // Current runtime config: gasReserve = 0.085, positionSizePct = 0.85, deployAmountSol = 0.2, maxDeployAmount = 50
    // Test 1: Low balance (0.3 SOL)
    // deployable = 0.3 - 0.085 = 0.215
    // dynamic = 0.215 * 0.85 = 0.18275
    // raw = min(50, max(0.2, 0.18275)) = 0.2
    // safeMax = min(0.2, 0.215) = 0.2
    // final = max(0.2 * 0.75, 0.2) = 0.2
    const low = computeDeployAmount(0.3);
    assert.equal(low, 0.2);

    // Test 2: Standard compounding (10 SOL)
    // deployable = 10 - 0.085 = 9.915
    // dynamic = 9.915 * 0.85 = 8.42775
    // raw = min(50, max(0.2, 8.42775)) = 8.42775
    // safeMax = min(8.42775, 9.915) = 8.42775
    // final = 8.43
    const normal = computeDeployAmount(10);
    assert.equal(normal, 8.43);

    // Test 3: Large balance capping at maxDeployAmount (50 SOL)
    const large = computeDeployAmount(500);
    assert.equal(large, 50.0);

    // Test 4: Conviction multiplier clamping and deployable safety ceiling
    // For 10 SOL, deployable = 9.915 SOL. mult = 2.0 (clamped to 1.25) -> dynamic = 10.53 SOL, but clamped to deployable (9.915) -> 9.91
    const clampedToDeployable = computeDeployAmount(10, 2.0);
    assert.equal(clampedToDeployable, 9.91);

    // mult = 0.1 -> clamped to 0.75 -> 9.915 * 0.85 * 0.75 = 6.3208125 -> 6.32
    const dampened = computeDeployAmount(10, 0.1);
    assert.equal(dampened, 6.32);
  });

  test("scaleBinsForBinStep: step scaling and floor", () => {
    assert.equal(scaleBinsForBinStep(50, 100), 50);
    assert.equal(scaleBinsForBinStep(50, 80), 50);
    assert.equal(scaleBinsForBinStep(50, 200), 25);
    assert.equal(scaleBinsForBinStep(30, 200, 22), 22, "Respects minFloor");
    assert.equal(scaleBinsForBinStep(null, 100), 0);
  });

  test("Zod validation rejects invalid UserConfig schemas", () => {
    // Negative minSolToOpen
    const invalidNegative = { minSolToOpen: -1 };
    const r1 = UserConfigSchema.safeParse(invalidNegative);
    assert.equal(r1.success, false, "Must reject negative minSolToOpen");

    // Invalid timeframe
    const invalidTimeframe = { timeframe: "15m" };
    const r2 = UserConfigSchema.safeParse(invalidTimeframe);
    assert.equal(r2.success, false, "Must reject deprecated 15m timeframe");

    // Valid partial config
    const validConfig = { timeframe: "5m", maxPositions: 5 };
    const r3 = UserConfigSchema.safeParse(validConfig);
    assert.equal(r3.success, true);
  });

  test("updateConfig rejects invalid config updates with Zod error", () => {
    expect(() => updateConfig({ minSolToOpen: -1 })).toThrow();
  });
});

describe("Milestone 2 Empirical Challenge: Zero Telegram Test Leakage", () => {
  test("Telegram notifications are strictly suppressed during testing", async () => {
    // Import telegram module
    const telegram = await import("../telegram.js");

    assert.equal(telegram.isTelegramSuppressed(), true, "isTelegramSuppressed must return true in test env");
    assert.equal(telegram.isEnabled(), false, "isEnabled must return false in test env");

    // Spy on globalThis.fetch to guarantee zero network traffic to Telegram API
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("LEAK: Network request initiated to Telegram API!");
    });

    try {
      // Attempt all notification types
      await telegram.notifyDeploy({
        pair: "TEST/SOL",
        amountSol: 1.0,
        position: "TEST_POS",
        tx: "TEST_TX",
        priceRange: { min: 0.001, max: 0.002 },
        rangeCoverage: { downside_pct: 10, upside_pct: 10, width_pct: 20 },
        binStep: 100,
        baseFee: 0.25,
      });
      await telegram.notifyClose({ pair: "TEST/SOL", pnlUsd: 10, pnlPct: 5, solMode: false });
      await telegram.notifySwap({ inputSymbol: "TEST", outputSymbol: "SOL", amountIn: 100, amountOut: 1, tx: "TEST_TX" });
      await telegram.sendMessage("Test direct message");
      await telegram.sendMenu("Test menu", [[{ text: "Btn", callback_data: "data" }]]);

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
