/**
 * Risk & capital controls for Meridian.
 *
 * Pure decision helpers used by management exits, deploy sizing, screening gates,
 * and update_config clamps. Designed for autonomous LP: cut tails, let winners run
 * via trailing, rotate capital, and halt deploys after a bad day.
 */

import { getPerformanceHistory } from "./lessons.js";
import { config } from "./config.js";
import { log } from "./logger.js";

/** Clamp a number into [lo, hi]. */
export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Dynamic trailing drop: base drop near trigger, widen as peak rises so runners
 * are not clipped by noise, but never exceed trailingMaxDropPct.
 *
 * Example (base=1.5, widen=0.12, max=5, trigger=3):
 *   peak 3%  → 1.50% drop allowed
 *   peak 8%  → 2.10%
 *   peak 15% → 2.94%
 *   peak 30% → 4.74%
 */
export function effectiveTrailingDropPct(peakPnlPct, mgmt = config.management) {
  const base = Number(mgmt.trailingDropPct ?? 1.5);
  const trigger = Number(mgmt.trailingTriggerPct ?? 3);
  const widen = Number(mgmt.trailingDropWidenPerPeakPct ?? 0.12);
  const maxDrop = Number(mgmt.trailingMaxDropPct ?? 5);
  const peak = Number(peakPnlPct ?? 0);
  if (!Number.isFinite(base)) return 1.5;
  if (!Number.isFinite(peak) || !Number.isFinite(widen) || widen <= 0) {
    return clamp(base, 0.1, Number.isFinite(maxDrop) ? maxDrop : 20);
  }
  const extra = Math.max(0, peak - trigger) * widen;
  return clamp(base + extra, 0.1, Number.isFinite(maxDrop) ? maxDrop : base + extra);
}

/**
 * Volatility-aware position size multiplier.
 * High vol → smaller size (IL risk). At/below volSizeRef → full size.
 */
export function volatilitySizeMultiplier(volatility, mgmt = config.management) {
  if (mgmt.volatilitySizeDamping === false) return 1;
  const vol = Number(volatility);
  if (!Number.isFinite(vol) || vol <= 0) return 1;
  const ref = Number(mgmt.volSizeRef ?? 5);
  if (!Number.isFinite(ref) || ref <= 0) return 1;
  // Soft inverse: ref/vol, floored so extreme vol still deploys something.
  const minMult = Number(mgmt.minVolSizeMultiplier ?? 0.4);
  return clamp(ref / vol, minMult, 1);
}

/**
 * Deploy amount with optional volatility damping on top of wallet scaling.
 */
export function computeRiskAdjustedDeployAmount(walletSol, volatility = null) {
  const reserve = config.management.gasReserve ?? 0.2;
  const pct = config.management.positionSizePct ?? 0.35;
  const floor = config.management.deployAmountSol;
  const ceil = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  let dynamic = deployable * pct;
  const volMult = volatilitySizeMultiplier(volatility);
  dynamic *= volMult;
  const result = Math.min(ceil, Math.max(floor * volMult, dynamic));
  // Never go below absolute minimum deploy floor when damping would make it dust.
  const absMin = Math.max(0.1, Math.min(floor, ceil));
  return parseFloat(Math.max(absMin * Math.min(volMult, 1), Math.min(ceil, Math.max(absMin * 0.5, result))).toFixed(2));
}

/**
 * Realized PnL over the last N hours from closed performance records.
 * SOL estimate uses amount_sol × pnl_pct / 100 when available.
 */
export function getRealizedRiskWindow({ hours = 24 } = {}) {
  const hist = getPerformanceHistory({ hours, limit: 500 });
  const positions = hist.positions || [];
  let pnlUsd = 0;
  let pnlSolEst = 0;
  for (const r of positions) {
    const usd = Number(r.pnl_usd);
    if (Number.isFinite(usd)) pnlUsd += usd;
    const pct = Number(r.pnl_pct);
    const amt = Number(r.amount_sol);
    if (Number.isFinite(pct) && Number.isFinite(amt) && amt > 0) {
      pnlSolEst += (amt * pct) / 100;
    }
  }
  // Walk newest-first for consecutive loss streak.
  let consecutiveLosses = 0;
  const newestFirst = [...positions].reverse();
  for (const r of newestFirst) {
    const usd = Number(r.pnl_usd);
    const pct = Number(r.pnl_pct);
    const lost = (Number.isFinite(usd) && usd < 0) || (!Number.isFinite(usd) && Number.isFinite(pct) && pct < 0);
    if (lost) consecutiveLosses += 1;
    else break;
  }

  return {
    hours,
    count: positions.length,
    total_pnl_usd: Math.round(pnlUsd * 100) / 100,
    total_pnl_sol_est: Math.round(pnlSolEst * 1000) / 1000,
    consecutive_losses: consecutiveLosses,
    win_rate_pct: hist.win_rate_pct,
  };
}

/**
 * Circuit breaker: pause new deploys after a bad session.
 * Management/closes still run — only screening/deploy is blocked.
 */
export function getDeployCircuitBreaker(mgmt = config.management) {
  if (mgmt.dailyLossLimitEnabled === false) {
    return { blocked: false, reason: null, stats: null };
  }
  const hours = Number(mgmt.dailyLossWindowHours ?? 24);
  const stats = getRealizedRiskWindow({ hours });
  const limitUsd = Number(mgmt.dailyLossLimitUsd);
  const limitSol = Number(mgmt.dailyLossLimitSol);
  const maxConsecutive = Number(mgmt.consecutiveLossLimit ?? 0);

  if (Number.isFinite(limitUsd) && limitUsd > 0 && stats.total_pnl_usd <= -Math.abs(limitUsd)) {
    const reason = `Daily loss circuit breaker: realized PnL $${stats.total_pnl_usd} <= -$${Math.abs(limitUsd)} over ${hours}h`;
    log("risk", reason);
    return { blocked: true, reason, stats };
  }
  if (Number.isFinite(limitSol) && limitSol > 0 && stats.total_pnl_sol_est <= -Math.abs(limitSol)) {
    const reason = `Daily loss circuit breaker: estimated SOL PnL ${stats.total_pnl_sol_est} <= -${Math.abs(limitSol)} over ${hours}h`;
    log("risk", reason);
    return { blocked: true, reason, stats };
  }
  if (Number.isFinite(maxConsecutive) && maxConsecutive > 0 && stats.consecutive_losses >= maxConsecutive) {
    const reason = `Consecutive-loss circuit breaker: ${stats.consecutive_losses} losses in a row (limit ${maxConsecutive})`;
    log("risk", reason);
    return { blocked: true, reason, stats };
  }
  return { blocked: false, reason: null, stats };
}

/**
 * Bounds for update_config — prevent LLM from disabling risk controls or sizing insanely.
 * Returns { ok, value, error }.
 */
export function clampConfigChange(key, value) {
  const n = typeof value === "number" ? value : Number(value);
  const bounds = {
    stopLossPct: { min: -90, max: -1 },
    takeProfitPct: { min: 0.5, max: 100 },
    trailingTriggerPct: { min: 0.5, max: 50 },
    trailingDropPct: { min: 0.2, max: 20 },
    trailingMaxDropPct: { min: 0.5, max: 30 },
    trailingDropWidenPerPeakPct: { min: 0, max: 1 },
    breakevenFloorPct: { min: -5, max: 10 },
    maxHoldMinutes: { min: 15, max: 10080 },
    feeDecayExitRatio: { min: 0.05, max: 0.95 },
    feeDecayMinAgeMinutes: { min: 5, max: 1440 },
    dailyLossLimitUsd: { min: 1, max: 1_000_000 },
    dailyLossLimitSol: { min: 0.01, max: 10_000 },
    consecutiveLossLimit: { min: 2, max: 50 },
    dailyLossWindowHours: { min: 1, max: 168 },
    positionSizePct: { min: 0.05, max: 0.95 },
    maxDeployAmount: { min: 0.005, max: 500 },
    deployAmountSol: { min: 0.005, max: 100 },
    gasReserve: { min: 0.002, max: 10 },
    maxPositions: { min: 1, max: 20 },
    minClaimAmount: { min: 0.1, max: 1000 },
    outOfRangeWaitMinutes: { min: 1, max: 1440 },
    outOfRangeBinsToClose: { min: 1, max: 200 },
    minAgeBeforeYieldCheck: { min: 5, max: 1440 },
    minFeePerTvl24h: { min: 0, max: 100 },
    managementIntervalMin: { min: 1, max: 180 },
    screeningIntervalMin: { min: 5, max: 360 },
    maxBotHoldersPct: { min: 0, max: 100 },
    maxTop10Pct: { min: 10, max: 100 },
    minOrganic: { min: 0, max: 100 },
    minQuoteOrganic: { min: 0, max: 100 },
    minVolSizeMultiplier: { min: 0.1, max: 1 },
    volSizeRef: { min: 0.5, max: 100 },
  };
  const b = bounds[key];
  if (!b) return { ok: true, value };
  if (!Number.isFinite(n)) return { ok: false, value, error: `${key} must be a finite number` };
  const clamped = clamp(n, b.min, b.max);
  if (clamped !== n) {
    log("risk", `Clamped config ${key}: ${n} → ${clamped}`);
  }
  return { ok: true, value: key === "maxPositions" || key === "consecutiveLossLimit" || key.includes("Minutes") || key.includes("Hours") || key.includes("Bins") ? Math.round(clamped) : clamped };
}

/**
 * Composite LP edge score for ranking: fee efficiency vs volatility + activity + memory.
 * Higher = better candidate for single-sided bid-ask under active bin.
 */
export function compositeCandidateScore(pool, memory = null, targets = config.opportunity) {
  const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
  const organic = Number(pool.organic_score || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  const vol = Math.max(Number(pool.volatility) || 0.1, 0.1);
  const base = feeTvl * 1000 + organic * 10 + volume / 100 + holders / 100;

  // Fee / volatility edge — core LP profitability proxy (earn fees without getting blown out).
  const feeVolEdge = (feeTvl / vol) * 80;

  // Degen balance score (0..100) — geometric efficiency across activity/fees/liquidity.
  let degen = 0;
  try {
    // Lazy import avoided: screening may import risk; pass precomputed if present.
    degen = Number(pool._degen_score);
    if (!Number.isFinite(degen)) degen = 0;
  } catch { degen = 0; }

  let score = base + feeVolEdge + degen * 1.5;

  // Momentum: dying volume/fee is toxic for fee farming.
  const volChg = Number(pool.volume_change_pct);
  const feeChg = Number(pool.fee_change_pct);
  if (Number.isFinite(volChg) && volChg < -30) score *= 0.85;
  if (Number.isFinite(volChg) && volChg > 20) score *= 1.06;
  if (Number.isFinite(feeChg) && feeChg < -30) score *= 0.88;
  if (Number.isFinite(feeChg) && feeChg > 15) score *= 1.05;

  // Discord signal mild boost (already pre-checked).
  if (pool.discord_signal) score *= 1.04;

  // Pool memory: favor proven winners, penalize serial losers.
  if (memory && Number(memory.total_deploys) >= 2) {
    const adjWr = Number(memory.adjusted_win_rate ?? memory.win_rate ?? 50);
    const avgPnl = Number(memory.avg_pnl_pct ?? 0);
    if (adjWr >= 60 && avgPnl > 0) score *= 1.18;
    else if (adjWr >= 50 && avgPnl >= 0) score *= 1.08;
    else if (adjWr <= 25 || avgPnl < -8) score *= 0.55;
    else if (adjWr <= 35 || avgPnl < -3) score *= 0.75;
  }

  return score;
}

/**
 * Whether hard fixed take-profit should fire.
 * Professional default: when trailing is on, hard TP is off so winners can run.
 */
export function shouldApplyHardTakeProfit(mgmt = config.management) {
  if (mgmt.trailingTakeProfit && mgmt.hardTakeProfitWhileTrailing !== true) {
    return false;
  }
  return mgmt.takeProfitPct != null && Number(mgmt.takeProfitPct) > 0;
}
