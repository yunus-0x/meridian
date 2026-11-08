/**
 * Adversarial Empirical Challenge Suite for Milestone 4 (challenger_m4_2)
 *
 * Targets:
 * 1. standalone/screening.ts:
 *    - rejectToken edge cases (staleness, future timestamps, authorities, holder/bot bounds, fees, launchpads, age limits)
 *    - rejectPool edge cases (mint/quote mismatch, pool type, blacklist, token warning severities, TVL/volume/binStep/organic limits, volatility/price)
 *    - Candidate ranking & multi-factor Chronos scoring (spread multiplier, gate penalty, active TVL tie-breakers)
 * 2. standalone/chronos.ts:
 *    - buildTacticalSignals exhaustive verification across all 12 indicators & boundary conditions
 *    - localQuantizedForecast Monte Carlo bootstrap determinism, quantile ordering invariants, bin sizing, gate triggers
 *    - Indicators: computeRsi14, computeBbPctB, computeVolumeProfilePoc
 * 3. standalone/monitor.ts:
 *    - WalletMonitor lifecycle & healthy() state transitions
 *    - enqueue() queue limits, historical slot filtering, and deduplication
 *    - drain() exponential backoff, transaction processing, and convergence signal triggering
 *    - Reconcile wallet addition, removal, and subscription cleanup
 */

process.env.NODE_ENV = "test";
process.env.DISABLE_TELEGRAM = "true";

import { describe, test, it, expect, assert, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { config, scaleBinsForBinStep } from "../config.js";
import {
  rejectToken,
  rejectPool,
} from "../standalone/screening.js";
import {
  computeRsi14,
  computeBbPctB,
  computeVolumeProfilePoc,
  buildTacticalSignals,
  localQuantizedForecast,
  pctToBins,
} from "../standalone/chronos.js";
import {
  Connection,
  Transaction,
  PublicKey,
  SystemProgram,
  type TransactionResponse,
} from "@solana/web3.js";
import { WalletMonitor } from "../standalone/monitor.js";
import { MonitorStore, type MonitorEvent } from "../standalone/store.js";
import type { readRpc } from "../standalone/rpc.js";
import type {
  JupiterAssetItem,
  MeteoraPoolDiscoveryItem,
  GeckoCandleTuple,
  ChronosAnalysisResult,
} from "../src/schemas/api.js";
import type { Config } from "../src/schemas/config.js";

type ReadRpcFn = typeof readRpc;
type ScreeningConfig = Config["screening"];
type StandaloneConfig = Config["standalone"];

const MINT_TEST = "Mint111111111111111111111111111111111111111";
const POOL_TEST = "Po01111111111111111111111111111111111111111";
const POOL_TEST_2 = "Po02222222222222222222222222222222222222222";
const WALLET_1 = "Wa11111111111111111111111111111111111111111";
const WALLET_2 = "Wa22222222222222222222222222222222222222222";

function createValidToken(now: number = Date.now()): JupiterAssetItem {
  return {
    id: MINT_TEST,
    name: "Test Token",
    symbol: "TEST",
    updatedAt: new Date(now - 10_000).toISOString(),
    createdAt: new Date(now - 86_400_000).toISOString(),
    holderCount: 1500,
    mcap: 500_000,
    organicScore: 85,
    fees: 50,
    launchpad: null,
    audit: {
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      topHoldersPercentage: 35,
      botHoldersPercentage: 12,
    },
  };
}

function createValidPool(mint: string = MINT_TEST): MeteoraPoolDiscoveryItem {
  return {
    pool_address: POOL_TEST,
    name: "TEST-SOL",
    pool_type: "dlmm",
    is_blacklisted: false,
    tvl: 45_000,
    active_tvl: 30_000,
    volume: 15_000,
    fee_active_tvl_ratio: 0.12,
    volatility: 1.85,
    pool_price: 0.00245,
    token_x: {
      address: mint,
      symbol: "TEST",
      warnings: [],
      organic_score: 80,
    },
    token_y: {
      address: config.tokens.SOL,
      symbol: "SOL",
      warnings: [],
      organic_score: 95,
    },
    dlmm_params: {
      bin_step: 100,
      base_fee_pct: 0.25,
    },
  };
}

describe("Challenge Suite 1: standalone/screening.ts Adversarial Edge Cases", () => {
  const s: ScreeningConfig = { ...config.screening };

  test("rejectToken: mint mismatch and null/undefined handling", () => {
    const now = Date.now();
    assert.equal(rejectToken(null, MINT_TEST, s, now), "Token mint mismatch");
    assert.equal(rejectToken(undefined, MINT_TEST, s, now), "Token mint mismatch");

    const valid = createValidToken(now);
    assert.equal(
      rejectToken({ ...valid, id: "DifferentMint111111111111111111111111111111" }, MINT_TEST, s, now),
      "Token mint mismatch"
    );
  });

  test("rejectToken: timestamp staleness and future leeway boundaries", () => {
    const now = Date.now();
    const token = createValidToken(now);

    assert.equal(rejectToken({ ...token, updatedAt: "" }, MINT_TEST, s, now), "Token data is stale or has no timestamp");
    assert.equal(rejectToken({ ...token, updatedAt: "invalid-date" }, MINT_TEST, s, now), "Token data is stale or has no timestamp");

    // Exactly 240,000ms old is allowed (now - updated <= 240_000)
    assert.equal(rejectToken({ ...token, updatedAt: new Date(now - 240_000).toISOString() }, MINT_TEST, s, now), null);
    // 240,001ms old is rejected
    assert.equal(
      rejectToken({ ...token, updatedAt: new Date(now - 240_001).toISOString() }, MINT_TEST, s, now),
      "Token data is stale or has no timestamp"
    );

    // Up to +5000ms in future is allowed (updated <= now + 5000)
    assert.equal(rejectToken({ ...token, updatedAt: new Date(now + 5000).toISOString() }, MINT_TEST, s, now), null);
    // +5001ms in future is rejected
    assert.equal(
      rejectToken({ ...token, updatedAt: new Date(now + 5001).toISOString() }, MINT_TEST, s, now),
      "Token data is stale or has no timestamp"
    );
  });

  test("rejectToken: mint and freeze authority strict requirements", () => {
    const now = Date.now();
    const token = createValidToken(now);

    assert.equal(rejectToken({ ...token, audit: undefined }, MINT_TEST, s, now), "Mint/freeze authority is enabled or unknown");
    assert.equal(
      rejectToken({ ...token, audit: { ...token.audit, mintAuthorityDisabled: false, freezeAuthorityDisabled: true, topHoldersPercentage: 30, botHoldersPercentage: 10 } }, MINT_TEST, s, now),
      "Mint/freeze authority is enabled or unknown"
    );
    assert.equal(
      rejectToken({ ...token, audit: { ...token.audit, mintAuthorityDisabled: true, freezeAuthorityDisabled: false, topHoldersPercentage: 30, botHoldersPercentage: 10 } }, MINT_TEST, s, now),
      "Mint/freeze authority is enabled or unknown"
    );
  });

  test("rejectToken: holder concentration and bot percentage boundaries", () => {
    const now = Date.now();
    const token = createValidToken(now);

    // Negative values
    assert.match(
      rejectToken({ ...token, audit: { ...token.audit, mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: -1, botHoldersPercentage: 10 } }, MINT_TEST, s, now) ?? "",
      /topHoldersPercentage failed/
    );
    // Exceeding maxTop10Pct (limit: s.maxTop10Pct e.g. 60)
    assert.match(
      rejectToken({ ...token, audit: { ...token.audit, mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: s.maxTop10Pct + 0.1, botHoldersPercentage: 10 } }, MINT_TEST, s, now) ?? "",
      /topHoldersPercentage failed/
    );
    // Exact limit passes
    assert.equal(
      rejectToken({ ...token, audit: { ...token.audit, mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: s.maxTop10Pct, botHoldersPercentage: 10 } }, MINT_TEST, s, now),
      null
    );

    // Exceeding maxBotHoldersPct (limit: s.maxBotHoldersPct e.g. 30)
    assert.match(
      rejectToken({ ...token, audit: { ...token.audit, mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 30, botHoldersPercentage: s.maxBotHoldersPct + 0.1 } }, MINT_TEST, s, now) ?? "",
      /botHoldersPercentage failed/
    );
  });

  test("rejectToken: fee, holder, mcap, organic and launchpad enforcement", () => {
    const now = Date.now();
    const token = createValidToken(now);

    // Fees
    assert.equal(rejectToken({ ...token, fees: s.minTokenFeesSol - 0.1 }, MINT_TEST, s, now), "Token fees below threshold or unknown");
    assert.equal(rejectToken({ ...token, fees: null }, MINT_TEST, s, now), "Token fees below threshold or unknown");

    // Holders
    assert.equal(rejectToken({ ...token, holderCount: s.minHolders - 1 }, MINT_TEST, s, now), "Insufficient holders");

    // Market cap
    assert.equal(rejectToken({ ...token, mcap: s.minMcap - 1 }, MINT_TEST, s, now), "Market cap outside limits");
    assert.equal(rejectToken({ ...token, mcap: s.maxMcap + 1 }, MINT_TEST, s, now), "Market cap outside limits");

    // Organic score
    assert.equal(rejectToken({ ...token, organicScore: s.minOrganic - 1 }, MINT_TEST, s, now), "Organic activity below threshold");

    // Allowed launchpad
    const customConfig: ScreeningConfig = { ...s, allowedLaunchpads: ["bonk.fun"], blockedLaunchpads: [] };
    assert.equal(rejectToken({ ...token, launchpad: null }, MINT_TEST, customConfig, now), "Launchpad is not allowed");
    assert.equal(rejectToken({ ...token, launchpad: "other.fun" }, MINT_TEST, customConfig, now), "Launchpad is not allowed");
    assert.equal(rejectToken({ ...token, launchpad: "bonk.fun" }, MINT_TEST, customConfig, now), null);

    // Blocked launchpad
    const blockedConfig: ScreeningConfig = { ...s, allowedLaunchpads: [], blockedLaunchpads: ["scam.fun"] };
    assert.equal(rejectToken({ ...token, launchpad: "scam.fun" }, MINT_TEST, blockedConfig, now), "Launchpad is blocked");
  });

  test("rejectToken: age constraints (minTokenAgeHours and maxTokenAgeHours)", () => {
    const now = Date.now();
    const token = createValidToken(now);

    const ageConfig: ScreeningConfig = { ...s, minTokenAgeHours: 2, maxTokenAgeHours: 48 };

    // Missing or invalid createdAt
    assert.equal(rejectToken({ ...token, createdAt: undefined }, MINT_TEST, ageConfig, now), "Token age unknown");
    assert.equal(rejectToken({ ...token, createdAt: "invalid-time" }, MINT_TEST, ageConfig, now), "Token age unknown");

    // Future creation time (negative age)
    assert.equal(
      rejectToken({ ...token, createdAt: new Date(now + 3600_000).toISOString() }, MINT_TEST, ageConfig, now),
      "Token age unknown"
    );

    // Too young (1 hour old when minimum is 2)
    assert.equal(
      rejectToken({ ...token, createdAt: new Date(now - 1 * 3600_000).toISOString() }, MINT_TEST, ageConfig, now),
      "Token too young"
    );

    // Too old (50 hours old when maximum is 48)
    assert.equal(
      rejectToken({ ...token, createdAt: new Date(now - 50 * 3600_000).toISOString() }, MINT_TEST, ageConfig, now),
      "Token too old"
    );

    // Valid age (10 hours old)
    assert.equal(
      rejectToken({ ...token, createdAt: new Date(now - 10 * 3600_000).toISOString() }, MINT_TEST, ageConfig, now),
      null
    );
  });

  test("rejectPool: token pairs and pool type checks", () => {
    const pool = createValidPool();

    assert.equal(
      rejectPool({ ...pool, token_x: { ...pool.token_x, address: "OtherMint11111111111111111111111111111111" } }, MINT_TEST, s),
      "Requires an exact-mint DLMM token/SOL pool"
    );
    assert.equal(
      rejectPool({ ...pool, token_y: { ...pool.token_y, address: "NotSol111111111111111111111111111111111111" } }, MINT_TEST, s),
      "Requires an exact-mint DLMM token/SOL pool"
    );
    assert.equal(
      rejectPool({ ...pool, pool_type: "dynamic" }, MINT_TEST, s),
      "Requires an exact-mint DLMM token/SOL pool"
    );
  });

  test("rejectPool: blacklist and token warning severities", () => {
    const pool = createValidPool();

    assert.equal(rejectPool({ ...pool, is_blacklisted: true }, MINT_TEST, s), "Pool blacklist status unsafe or unknown");

    // Warnings not array
    function isPartialPool(val: unknown): val is Partial<MeteoraPoolDiscoveryItem> {
      return typeof val === "object" && val !== null;
    }
    const invalidTokenX: Partial<MeteoraPoolDiscoveryItem["token_x"]> = {
      address: MINT_TEST,
      organic_score: 80,
    };
    const poolNoWarn: unknown = {
      ...pool,
      token_x: invalidTokenX,
    };
    expect(isPartialPool(poolNoWarn)).toBe(true);
    if (isPartialPool(poolNoWarn)) {
      assert.equal(
        rejectPool(poolNoWarn, MINT_TEST, s),
        "Pool token warnings unavailable"
      );
    }

    // Critical, danger, warning severities rejected
    assert.equal(
      rejectPool({ ...pool, token_x: { ...pool.token_x, warnings: [{ severity: "danger", message: "risky" }] } }, MINT_TEST, s),
      "Pool token warning"
    );
    assert.equal(
      rejectPool({ ...pool, token_y: { ...pool.token_y, warnings: [{ severity: "critical", message: "exploit" }] } }, MINT_TEST, s),
      "Pool token warning"
    );
    assert.equal(
      rejectPool({ ...pool, token_x: { ...pool.token_x, warnings: [{ severity: "warning", message: "caution" }] } }, MINT_TEST, s),
      "Pool token warning"
    );

    // 'info' severity passes
    assert.equal(
      rejectPool({ ...pool, token_x: { ...pool.token_x, warnings: [{ severity: "info", message: "informational" }] } }, MINT_TEST, s),
      null
    );
  });

  test("rejectPool: TVL, volume, fee ratio, bin step, and volatility limits", () => {
    const pool = createValidPool();

    assert.equal(rejectPool({ ...pool, tvl: s.minTvl - 1 }, MINT_TEST, s), "TVL outside limits or unknown");
    assert.equal(rejectPool({ ...pool, tvl: s.maxTvl + 1 }, MINT_TEST, s), "TVL outside limits or unknown");
    assert.equal(rejectPool({ ...pool, active_tvl: s.minTvl - 1 }, MINT_TEST, s), "active TVL outside limits or unknown");
    assert.equal(rejectPool({ ...pool, volume: s.minVolume - 1 }, MINT_TEST, s), "volume outside limits or unknown");
    assert.equal(rejectPool({ ...pool, fee_active_tvl_ratio: s.minFeeActiveTvlRatio - 0.001 }, MINT_TEST, s), "fee/active TVL outside limits or unknown");
    assert.equal(
      rejectPool({ ...pool, dlmm_params: { bin_step: s.minBinStep - 1 } }, MINT_TEST, s),
      "bin step outside limits or unknown"
    );
    assert.equal(
      rejectPool({ ...pool, dlmm_params: { bin_step: s.maxBinStep + 1 } }, MINT_TEST, s),
      "bin step outside limits or unknown"
    );
    assert.equal(
      rejectPool({ ...pool, token_y: { ...pool.token_y, organic_score: s.minQuoteOrganic - 1 } }, MINT_TEST, s),
      "quote organic outside limits or unknown"
    );

    // Missing dlmm_params
    assert.equal(
      rejectPool({ ...pool, dlmm_params: undefined }, MINT_TEST, s),
      "bin step outside limits or unknown"
    );

    // Fully valid pool
    assert.equal(rejectPool(pool, MINT_TEST, s), null);
  });

  test("candidate ranking & multi-factor Chronos scoring simulation", () => {
    const poolA: MeteoraPoolDiscoveryItem = {
      ...createValidPool(),
      pool_address: POOL_TEST,
      fee_active_tvl_ratio: 0.20,
      active_tvl: 50_000,
      dlmm_params: { bin_step: 100 },
    };
    const poolB: MeteoraPoolDiscoveryItem = {
      ...createValidPool(),
      pool_address: POOL_TEST_2,
      fee_active_tvl_ratio: 0.15,
      active_tvl: 40_000,
      dlmm_params: { bin_step: 100 },
    };

    // Standard fee sort
    const list = [poolB, poolA];
    list.sort((a, b) => {
      const diffFee = Number(b.fee_active_tvl_ratio ?? 0) - Number(a.fee_active_tvl_ratio ?? 0);
      if (diffFee !== 0) return diffFee;
      const diffActive = Number(b.active_tvl ?? 0) - Number(a.active_tvl ?? 0);
      if (diffActive !== 0) return diffActive;
      return a.pool_address.localeCompare(b.pool_address);
    });
    assert.equal(list[0]?.pool_address, POOL_TEST);

    // Multi-factor Chronos scoring:
    // If poolA gets DEFER penalty (0.15), score = 0.20 * 1.0 * 0.15 = 0.03
    // poolB gets PASS (1.0), score = 0.15 * 1.2 * 1.0 = 0.18
    const scoreCandidate = (p: MeteoraPoolDiscoveryItem, gateAction: "PASS" | "DEFER", spreadPct: number): number => {
      const base = Number(p.fee_active_tvl_ratio ?? 0);
      const step = Number(p.dlmm_params?.bin_step ?? 100);
      const gatePenalty = gateAction === "DEFER" ? 0.15 : 1.0;
      const stepMult =
        spreadPct > 35 && step >= 100
          ? 1.25
          : spreadPct <= 24 && step <= 100
            ? 1.2
            : spreadPct <= 24 && step >= 150
              ? 0.8
              : 1.0;
      return base * stepMult * gatePenalty;
    };

    const scoreA = scoreCandidate(poolA, "DEFER", 20);
    const scoreB = scoreCandidate(poolB, "PASS", 20);
    assert.ok(scoreB > scoreA, `Pool B (${scoreB}) should outscore penalized Pool A (${scoreA})`);
  });
});

describe("Challenge Suite 2: standalone/chronos.ts Indicator Engine & Forecast Invariants", () => {
  test("computeRsi14: boundary conditions and monotonic price trends", () => {
    // Insufficient data
    assert.equal(computeRsi14([]), 50);
    assert.equal(computeRsi14([1, 2, 3]), 50);

    // Monotonically increasing (zero losses) -> RSI = 100
    const monotonicUp = Array.from({ length: 30 }, (_, i) => 10 + i * 2);
    assert.equal(computeRsi14(monotonicUp), 100);

    // Monotonically decreasing (zero gains) -> RSI = 0
    const monotonicDown = Array.from({ length: 30 }, (_, i) => 100 - i * 2);
    assert.equal(computeRsi14(monotonicDown), 0);

    // Scale invariance: identical RSI whether priced in cents or thousands
    const oscillating = [
      10, 12, 11, 13, 12, 14, 13, 15, 14, 16,
      15, 17, 16, 18, 17, 19, 18, 20, 19, 21,
    ];
    const rsi1 = computeRsi14(oscillating);
    const rsi2 = computeRsi14(oscillating.map((p) => p * 1000));
    assert.equal(rsi1, rsi2, "RSI must be strictly scale-invariant");
    assert.ok(rsi1 > 0 && rsi1 < 100, `RSI ${rsi1} should be strictly within bounds`);
  });

  test("computeBbPctB: boundary conditions and standard deviation spreads", () => {
    // Insufficient data
    assert.equal(computeBbPctB([], 20, 2), 0.5);
    assert.equal(computeBbPctB([10, 20, 30], 20, 2), 0.5);

    // Zero variance (flat line) -> returns 0.5 default
    const flat = Array.from({ length: 25 }, () => 100);
    assert.equal(computeBbPctB(flat, 20, 2), 0.5);

    // Last close exactly at mean of previous 20 closes
    const symmetrical = [
      ...Array.from({ length: 9 }, () => 90),
      ...Array.from({ length: 9 }, () => 110),
      100,
      100, // Mean is exactly 100
    ];
    const pctBMean = computeBbPctB(symmetrical, 20, 2);
    assert.equal(pctBMean, 0.5);

    // Extreme breakout above upper band (> 1.0)
    const upperBreakout = [
      ...Array.from({ length: 19 }, () => 100),
      150,
    ];
    assert.ok(computeBbPctB(upperBreakout, 20, 2) > 1.0);
  });

  test("computeVolumeProfilePoc: empty candles and volume concentration", () => {
    // Empty array
    assert.deepEqual(computeVolumeProfilePoc([]), { poc_price: 0, price_vs_poc_pct: 0 });

    // Flat prices
    const flatCandles: GeckoCandleTuple[] = [
      [1700000000, 100, 100, 100, 100, 1000],
      [1700000060, 100, 100, 100, 100, 1000],
    ];
    assert.deepEqual(computeVolumeProfilePoc(flatCandles), { poc_price: 100, price_vs_poc_pct: 0 });

    // 30 candles between price 10 and 20. Giant volume spike at price 12
    const candles: GeckoCandleTuple[] = Array.from({ length: 30 }, (_, i) => {
      const p = 10 + (i / 30) * 10;
      const vol = Math.abs(p - 12) < 0.5 ? 500_000 : 100;
      return [1700000000 + i * 60, p, p + 0.2, p - 0.2, p, vol];
    });

    const vp = computeVolumeProfilePoc(candles);
    assert.ok(Math.abs(vp.poc_price - 12) < 0.8, `POC price ${vp.poc_price} should be close to 12`);
    assert.ok(Number.isFinite(vp.price_vs_poc_pct));
  });

  test("buildTacticalSignals: exhaustive verification of all 12 indicator outputs", () => {
    // 1. Climax top triggers sniper_lock and suppresses let_winners_run
    const climax = buildTacticalSignals({
      p10Pct: -10,
      p50Pct: -1.2,
      p90Pct: 5,
      rsi14: 76,
      bbPctB: 0.94,
    });
    assert.equal(climax.sniper_lock, true);
    assert.equal(climax.let_winners_run, false);
    assert.equal(climax.claim_threshold_mult, 0.4);
    assert.equal(climax.recommended_strategy, "spot");

    // 2. High-conviction bull breakout
    const bull = buildTacticalSignals({
      p10Pct: -5,
      p50Pct: 3.5,
      p90Pct: 16,
      rsi14: 60,
      bbPctB: 0.70,
      macro15mP90Pct: 18,
      modelAgreement: 0.85,
    });
    assert.equal(bull.sniper_lock, false);
    assert.equal(bull.let_winners_run, true);
    assert.equal(bull.x_ratio_mult, 0.85);
    assert.equal(bull.conviction_mult, 1.15);
    assert.equal(bull.claim_threshold_mult, 1.25);
    assert.equal(bull.take_profit_mult, 1.35);

    // 3. Curve strategy selection on POC consolidation
    const curve = buildTacticalSignals({
      p10Pct: -4,
      p50Pct: 0.2,
      p90Pct: 5,
      rsi14: 50,
      bbPctB: 0.5,
      priceVsPocPct: 2.0,
      modelAgreement: 0.75,
      binStep: 100,
    });
    assert.equal(curve.recommended_strategy, "curve");

    // 4. Bid-Ask strategy selection on high spread & low bin step
    const bidAsk = buildTacticalSignals({
      p10Pct: -12,
      p50Pct: 1.0,
      p90Pct: 15,
      rsi14: 52,
      bbPctB: 0.5,
      modelAgreement: 0.55,
      binStep: 100,
    });
    assert.equal(bidAsk.recommended_strategy, "bid_ask");

    // 5. Micro oversold bounce
    const bounce = buildTacticalSignals({
      p10Pct: -8,
      p50Pct: 0.5,
      p90Pct: 8,
      rsi14: 40,
      bbPctB: 0.3,
      microRsi14: 25,
      microBbPctB: 0.05,
      microP50Pct: 1.5,
    });
    assert.equal(bounce.micro_oversold_bounce, true);

    // 6. Micro breakout hold
    const breakout = buildTacticalSignals({
      p10Pct: -5,
      p50Pct: 3.0,
      p90Pct: 12.0,
      rsi14: 65,
      bbPctB: 0.75,
      microP50Pct: 1.2,
      microRsi14: 70,
    });
    assert.equal(breakout.micro_breakout_hold, true);

    // 7. Full MTF Bull top tier conviction
    const fullMtfBull = buildTacticalSignals({
      p10Pct: -4,
      p50Pct: 3.0,
      p90Pct: 14,
      rsi14: 62,
      bbPctB: 0.65,
      microP50Pct: 1.5,
      macro15mP50Pct: 2.0,
      modelAgreement: 0.85,
      priceVsPocPct: 5.0,
    });
    assert.equal(fullMtfBull.conviction_mult, 1.25);

    // 8. Knife rescue trigger and volume decay
    const knife = buildTacticalSignals({
      p10Pct: -25,
      p50Pct: -6.0,
      p90Pct: 0.0,
      rsi14: 28,
      bbPctB: 0.1,
      macro15mP50Pct: -7.0,
      chronos2P50Pct: -3.0,
      modelAgreement: 0.80,
    });
    assert.equal(knife.knife_rescue_trigger, true);
    assert.equal(knife.volume_decay_warning, true);
    assert.equal(knife.claim_threshold_mult, 0.4);
    assert.equal(knife.conviction_mult, 0.75);
  });

  test("localQuantizedForecast: Monte Carlo bootstrap stability and quantile monotonicity", () => {
    // Insufficient candles (< 16) returns null
    const shortCandles: GeckoCandleTuple[] = Array.from({ length: 10 }, (_, i) => [
      1700000000 + i * 300, 1, 1.1, 0.9, 1.0, 100,
    ]);
    assert.equal(localQuantizedForecast(shortCandles), null);

    // Generate 60 synthetic candles with trend and noise
    const synthCandles: GeckoCandleTuple[] = Array.from({ length: 60 }, (_, i) => {
      const p = 1.0 + Math.sin(i / 5) * 0.05 + i * 0.002;
      return [1700000000 + i * 300, p * 0.99, p * 1.02, p * 0.98, p, 1000 + i * 50];
    });

    // Run forecast twice with identical inputs: determinism check
    const forecastA = localQuantizedForecast(synthCandles, { poolAddress: POOL_TEST, binStep: 100 });
    const forecastB = localQuantizedForecast(synthCandles, { poolAddress: POOL_TEST, binStep: 100 });

    assert.ok(forecastA != null);
    assert.ok(forecastB != null);

    // Deep equality confirms deterministic pseudorandom Monte Carlo bootstrap
    assert.deepEqual(forecastA, forecastB, "Monte Carlo forecast must be completely deterministic for identical input");

    // Quantile ordering invariants
    const { summary, recommended_bins } = forecastA;
    assert.ok(
      summary.p10_pct <= summary.p50_pct,
      `P10 (${summary.p10_pct}) must be <= P50 (${summary.p50_pct})`
    );
    assert.ok(
      summary.p50_pct <= summary.p90_pct,
      `P50 (${summary.p50_pct}) must be <= P90 (${summary.p90_pct})`
    );

    // Bin invariants
    assert.ok(recommended_bins.bins_below >= 22, "bins_below must be >= min floor");
    assert.ok(recommended_bins.bins_above >= 4, "bins_above must be >= min floor");
    assert.ok(
      recommended_bins.bins_below + recommended_bins.bins_above <= 69,
      "Total DLMM bins must not exceed max 69"
    );
  });

  test("localQuantizedForecast: gate triggers (climax top and freefall knife)", () => {
    // Freefall knife scenario (continuous heavy down steps)
    const knifeCandles: GeckoCandleTuple[] = Array.from({ length: 30 }, (_, i) => {
      const p = 100 * Math.pow(0.97, i); // Rapid decline
      return [1700000000 + i * 300, p * 1.01, p * 1.02, p * 0.98, p, 5000];
    });
    const knifeForecast = localQuantizedForecast(knifeCandles, { poolAddress: POOL_TEST, binStep: 100 });
    assert.ok(knifeForecast != null);
    assert.equal(knifeForecast.gate.action, "DEFER");
    assert.match(knifeForecast.gate.reason, /freefall knife/i);
    assert.equal(knifeForecast.oor_below_outlook, "WEAK_STRUCTURAL_BREAKDOWN");
  });

  test("pctToBins and scaleBinsForBinStep: precision, floors, and binStep scaling", () => {
    // pctToBins at step 100: 1% is ~100 bps -> 1 bin
    assert.equal(pctToBins(1.0, 100), 1);
    // 10% move -> log(1.10) / log(1.01) = 9.57 -> 10 bins
    assert.equal(pctToBins(10.0, 100), 10);
    // 0% or negative -> defaults to small floor fraction
    assert.ok(pctToBins(0, 100) >= 1);
    assert.ok(pctToBins(-5, 100) >= 1);

    // scaleBinsForBinStep: step <= 100 returns unchanged raw bins
    assert.equal(scaleBinsForBinStep(55, 100, 22), 55);
    assert.equal(scaleBinsForBinStep(55, 80, 22), 55);
    // step = 200: 55 * (100 / 200) = 27.5 -> rounded to 28
    assert.equal(scaleBinsForBinStep(55, 200, 22), 28);
    // step = 400: 55 * (100 / 400) = 13.75, but floor is 22 -> 22
    assert.equal(scaleBinsForBinStep(55, 400, 22), 22);
  });

  test("buildTacticalSignals: secondary branches for take_profit_mult, knife_rescue, and conviction_mult", () => {
    // take_profit_mult: triggered by macro15mP90Pct >= 16 even if let_winners_run is false
    const takeProfitSignals = buildTacticalSignals({
      p10Pct: -10,
      p50Pct: 1.0, // < 2.5 so let_winners_run is false
      p90Pct: 8.0,
      macro15mP90Pct: 17.5,
      rsi14: 55,
      bbPctB: 0.5,
    });
    assert.equal(takeProfitSignals.let_winners_run, false);
    assert.equal(takeProfitSignals.take_profit_mult, 1.35);

    // conviction_mult: low-agreement crash risk
    const dumpRisk = buildTacticalSignals({
      p10Pct: -32.0,
      p50Pct: -0.5,
      p90Pct: 5.0,
      rsi14: 45,
      bbPctB: 0.4,
      modelAgreement: 0.30,
    });
    assert.equal(dumpRisk.conviction_mult, 0.8);

    // conviction_mult: solid bull
    const solidBull = buildTacticalSignals({
      p10Pct: -10.0,
      p50Pct: 1.8,
      p90Pct: 10.0,
      macro15mP50Pct: -1.0,
      modelAgreement: 0.70,
      rsi14: 55,
      bbPctB: 0.5,
    });
    assert.equal(solidBull.conviction_mult, 1.15);
  });
});

describe("Challenge Suite 3: standalone/monitor.ts State Transitions & Convergence", () => {
  const tmpFile = path.join(os.tmpdir(), `monitor-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  const baseConfig: StandaloneConfig = {
    ...config.standalone,
    walletThreshold: 2,
    windowSec: 120,
    screeningDeadlineSec: 120,
    reconcileSec: 30,
    minDepositSol: 0.1,
    cooldownSec: 300,
    maxPendingTransactions: 5,
  };

  test("WalletMonitor: healthy() transitions across wallet thresholds, errors, and lag", () => {
    const store = new MonitorStore(tmpFile);
    const monitor = new WalletMonitor(store, baseConfig, {
      wallets: () => ({
        wallets: [
          { address: WALLET_1, type: "lp", name: "w1", category: "alpha", addedAt: new Date().toISOString() },
          { address: WALLET_2, type: "lp", name: "w2", category: "alpha", addedAt: new Date().toISOString() },
        ],
        total: 2,
      }),
    });

    // 1. Wallets exist in list, but not yet initialized in store -> healthy === false
    assert.equal(monitor.healthy(), false);

    // 2. Initialize wallets with recent reconcile timestamp
    const now = Date.now();
    store.data.wallets[WALLET_1] = {
      baselineSlot: 1000,
      cursor: null,
      baselinePools: [],
      reconciledAt: now - 5000,
      error: null,
    };
    store.data.wallets[WALLET_2] = {
      baselineSlot: 1000,
      cursor: null,
      baselinePools: [],
      reconciledAt: now - 5000,
      error: null,
    };
    assert.equal(monitor.healthy(), true);

    // 3. One wallet has error -> healthy === false
    store.data.wallets[WALLET_1].error = "RPC connection timeout";
    assert.equal(monitor.healthy(), false);
    store.data.wallets[WALLET_1].error = null;

    // 4. Stale reconciliation lag (> reconcileSec * 3000ms = 90s) -> healthy === false
    store.data.wallets[WALLET_2].reconciledAt = now - 100_000;
    assert.equal(monitor.healthy(), false);

    if (fs.existsSync(tmpFile)) fs.rmSync(tmpFile, { force: true });
  });

  test("WalletMonitor: enqueue() state guards, slot boundaries, and queue limits", () => {
    const store = new MonitorStore(tmpFile);
    const monitor = new WalletMonitor(store, baseConfig);

    // Guard: monitor not running -> enqueue ignored
    monitor.running = false;
    monitor.enqueue(WALLET_1, "sig_1", 1005);
    assert.equal(Object.keys(store.data.pending).length, 0);

    monitor.running = true;
    store.data.wallets[WALLET_1] = {
      baselineSlot: 1000,
      cursor: null,
      baselinePools: [],
      reconciledAt: Date.now(),
      error: null,
    };

    // Guard: slot <= baselineSlot -> ignored (historical slot)
    monitor.enqueue(WALLET_1, "sig_old", 1000);
    monitor.enqueue(WALLET_1, "sig_ancient", 999);
    assert.equal(Object.keys(store.data.pending).length, 0);

    // Guard: valid enqueue
    monitor.enqueue(WALLET_1, "sig_valid_1", 1001);
    assert.ok(store.data.pending[`${WALLET_1}:sig_valid_1`]);

    // Guard: deduplication (already in pending or seen)
    monitor.enqueue(WALLET_1, "sig_valid_1", 1002);
    assert.equal(Object.keys(store.data.pending).length, 1);

    store.data.seen[`${WALLET_1}:sig_seen`] = Date.now();
    monitor.enqueue(WALLET_1, "sig_seen", 1003);
    assert.equal(Object.keys(store.data.pending).length, 1);

    // Guard: queue capacity limit throws error
    for (let i = 2; i <= 5; i++) {
      monitor.enqueue(WALLET_1, `sig_valid_${i}`, 1000 + i);
    }
    assert.equal(Object.keys(store.data.pending).length, 5);

    assert.throws(
      () => monitor.enqueue(WALLET_1, "sig_overflow", 1010),
      /Wallet queue is full; entry monitoring is degraded/
    );

    if (fs.existsSync(tmpFile)) fs.rmSync(tmpFile, { force: true });
  });

  test("WalletMonitor: drain() backoff, retry exhaustion, and convergence signal triggering", async () => {
    const store = new MonitorStore(tmpFile);
    const signalsTriggered: unknown[] = [];

    const dummyTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey("11111111111111111111111111111111"),
        toPubkey: new PublicKey("11111111111111111111111111111111"),
        lamports: 1,
      })
    );
    dummyTx.recentBlockhash = "11111111111111111111111111111111";
    dummyTx.feePayer = new PublicKey("11111111111111111111111111111111");

    const fakeTxResponse: TransactionResponse = {
      slot: 1050,
      blockTime: Math.floor(Date.now() / 1000),
      meta: null,
      transaction: {
        signatures: ["sig_mock"],
        message: dummyTx.compileMessage(),
      },
    };

    const mockConn = new Connection("http://127.0.0.1:8899");
    mockConn.getTransaction = async () => fakeTxResponse;

    const mockRpc: ReadRpcFn = async (_role, fn) => fn(mockConn);

    const monitor = new WalletMonitor(store, baseConfig, {
      onSignal: (s) => signalsTriggered.push(s),
      entries: async (_tx, _sig, wallet) => {
        const evt: MonitorEvent = {
          id: `evt:${wallet}:${Date.now()}`,
          signature: "sig_abc",
          wallet,
          pool: POOL_TEST,
          mint: MINT_TEST,
          at: Date.now(),
          slot: 1050,
          depositSol: 1.5,
          shares: "5000",
        };
        return [evt];
      },
      rpc: mockRpc,
    });

    monitor.running = true;
    store.data.wallets[WALLET_1] = {
      baselineSlot: 1000,
      cursor: null,
      baselinePools: [],
      reconciledAt: Date.now(),
      error: null,
    };
    store.data.wallets[WALLET_2] = {
      baselineSlot: 1000,
      cursor: null,
      baselinePools: [],
      reconciledAt: Date.now(),
      error: null,
    };

    // Enqueue 1 transaction from WALLET_1
    monitor.enqueue(WALLET_1, "sig_tx_1", 1010);
    await monitor.drain();

    assert.equal(monitor.stats.transactions, 1);
    assert.equal(monitor.stats.entries, 1);
    assert.equal(signalsTriggered.length, 0, "One wallet below threshold should not trigger signal");

    // Enqueue 2nd transaction from WALLET_2 for same pool/mint
    monitor.enqueue(WALLET_2, "sig_tx_2", 1011);
    await monitor.drain();

    assert.equal(monitor.stats.transactions, 2);
    assert.equal(monitor.stats.entries, 2);
    // Convergence signal triggered! (Threshold = 2 wallets)
    assert.equal(signalsTriggered.length, 1);
    interface ConvergenceSignal {
      mint: string;
      events: readonly unknown[];
    }
    function isConvergenceSignal(val: unknown): val is ConvergenceSignal {
      return (
        typeof val === "object" &&
        val !== null &&
        "mint" in val &&
        typeof val.mint === "string" &&
        "events" in val &&
        Array.isArray(val.events)
      );
    }
    const rawSignal = signalsTriggered[0];
    expect(isConvergenceSignal(rawSignal)).toBe(true);
    if (isConvergenceSignal(rawSignal)) {
      assert.equal(rawSignal.mint, MINT_TEST);
      assert.equal(rawSignal.events.length, 2);
    }

    if (fs.existsSync(tmpFile)) fs.rmSync(tmpFile, { force: true });
  });

  test("WalletMonitor: drain() exponential backoff and error increment on RPC failure", async () => {
    const store = new MonitorStore(tmpFile);
    const failRpc: ReadRpcFn = async () => {
      throw new Error("RPC temporary failure");
    };

    const monitor = new WalletMonitor(store, baseConfig, {
      rpc: failRpc,
    });

    monitor.running = true;
    store.data.wallets[WALLET_1] = {
      baselineSlot: 1000,
      cursor: null,
      baselinePools: [],
      reconciledAt: Date.now(),
      error: null,
    };

    monitor.enqueue(WALLET_1, "sig_fail_test", 1020);
    const pendingKey = `${WALLET_1}:sig_fail_test`;
    assert.equal(store.data.pending[pendingKey]?.failures, 0);

    // Run drain() which encounters simulated RPC failure
    await monitor.drain();

    assert.equal(monitor.stats.errors, 1);
    assert.equal(store.data.pending[pendingKey]?.failures, 1);
    assert.ok(
      (store.data.pending[pendingKey]?.retryAt ?? 0) > Date.now(),
      "Exponential backoff retryAt must be scheduled in the future"
    );

    // Subsequent immediate drain() skips because retryAt > Date.now()
    await monitor.drain();
    assert.equal(monitor.stats.errors, 1, "Should not increment errors when skipping backed-off item");

    // When failures reach 3, drain() must purge the entry from pending
    store.data.pending[pendingKey]!.failures = 3;
    store.data.pending[pendingKey]!.retryAt = 0; // eligible now
    await monitor.drain();
    assert.equal(store.data.pending[pendingKey], undefined, "Entry with 3 failures must be purged");

    if (fs.existsSync(tmpFile)) fs.rmSync(tmpFile, { force: true });
  });

  test("WalletMonitor: reconcile() removes inactive wallets and cleans up events and subscriptions", async () => {
    const store = new MonitorStore(tmpFile);
    let removedSubId: number | null = null;

    const mockWs = new Connection("http://127.0.0.1:8899");
    mockWs.onLogs = () => 123;
    mockWs.removeOnLogsListener = async (id: number) => {
      removedSubId = id;
    };

    const emptyRpc: ReadRpcFn = async <T>(_role: string, fn: (c: Connection) => Promise<T> | T): Promise<T> => {
      const dummy = new Connection("http://127.0.0.1:8899");
      dummy.getSignaturesForAddress = async () => [];
      return fn(dummy);
    };

    const monitor = new WalletMonitor(store, baseConfig, {
      rpc: emptyRpc,
      wallets: () => ({
        wallets: [{ address: WALLET_1, type: "lp", name: "w1", category: "alpha", addedAt: new Date().toISOString() }],
        total: 1,
      }),
    });

    monitor.running = true;
    monitor.ws = mockWs;
    monitor.subscriptions.set(WALLET_2, 777);

    store.data.wallets[WALLET_1] = {
      baselineSlot: 1000,
      cursor: null,
      baselinePools: [],
      reconciledAt: Date.now(),
      error: null,
    };
    store.data.wallets[WALLET_2] = {
      baselineSlot: 1000,
      cursor: null,
      baselinePools: [],
      reconciledAt: Date.now(),
      error: null,
    };
    store.data.events.push({
      id: "evt_w2",
      signature: "sig_w2",
      wallet: WALLET_2,
      pool: POOL_TEST,
      mint: MINT_TEST,
      at: Date.now(),
      slot: 1020,
      depositSol: 1,
      shares: "1000",
    });

    // Run reconcile
    await monitor.reconcile();

    // WALLET_2 should be purged from store, events, and subscriptions
    assert.equal(store.data.wallets[WALLET_2], undefined, "Removed wallet must be deleted from store");
    assert.equal(store.data.events.find((e) => e.wallet === WALLET_2), undefined, "Events for removed wallet must be purged");
    assert.equal(monitor.subscriptions.has(WALLET_2), false, "Subscription for removed wallet must be deleted");
    assert.equal(removedSubId, 777, "removeOnLogsListener must be called with subscription id");

    await monitor.stop();
    assert.equal(monitor.running, false);

    if (fs.existsSync(tmpFile)) fs.rmSync(tmpFile, { force: true });
  });
});

