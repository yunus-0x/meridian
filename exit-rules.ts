// Deterministic exit and sizing rules for the standalone runtime.

import { config, scaleBinsForBinStep } from "./config.js";
import { log } from "./logger.js";
import { getTrackedPosition, isPostClaimSettling } from "./state.js";

export interface ExitRuleResult {
  action: "CLOSE";
  rule: 1 | 2 | 3 | 4 | 5;
  reason: string;
}

export interface DeterministicPositionMetrics {
  position: string;
  pair?: string;
  pnl_pct?: number | null;
  pnl_pct_suspicious?: boolean;
  total_value_usd?: number | null;
  total_value_true_usd?: number | null;
  collected_fees_usd?: number | null;
  unclaimed_fees_usd?: number | null;
  collected_fees_true_usd?: number | null;
  unclaimed_fees_true_usd?: number | null;
  active_bin?: number | null;
  upper_bin?: number | null;
  lower_bin?: number | null;
  minutes_out_of_range?: number | null;
  age_minutes?: number | null;
  fee_per_tvl_24h?: number | null;
}

export interface ManagementConfigInput {
  stopLossPct: number;
  knifeRescueStopLossPct?: number;
  takeProfitPct: number;
  outOfRangeBinsToClose: number;
  outOfRangeWaitMinutes?: number;
  outOfRangeAboveWaitMinutes?: number;
  outOfRangeBelowWaitMinutes?: number;
  outOfRangeBelowEarlyCutMinutes?: number;
  minAgeBeforeYieldCheck?: number;
  minPositionFeeVelocityPctPerHr?: number;
  minFeePerTvl24h: number;
  solMode?: boolean;
}

export interface ChronosTacticalContext {
  knife_rescue_trigger?: boolean;
  oor_below_outlook?: string;
  take_profit_mult?: number;
  volume_decay_warning?: boolean;
  let_winners_run?: boolean;
}

/**
 * Rule-based close decision for a position (stop loss, take profit, range
 * exhaustion, low yield). Returns { action: "CLOSE", rule, reason } or null.
 */
export function getDeterministicCloseRule(
  position: DeterministicPositionMetrics,
  managementConfig: ManagementConfigInput,
  chronosCtx: ChronosTacticalContext | null = null
): ExitRuleResult | null {
  const tracked = getTrackedPosition(position.position);
  const pnlSuspect = (() => {
    // Couldn't-price-this-tick flag (e.g. Jupiter outage) or 60s post-claim settlement window — never act on PnL rules.
    if (position.pnl_pct_suspicious || isPostClaimSettling(tracked)) return true;
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    // Only treat <= -90% PnL as a pricing glitch when remaining value still exceeds 25% of initial deposit
    // Match units cleanly: solMode compares SOL (amount_sol), USD mode compares USD (initial_value_usd)
    const isSolMode = Boolean(managementConfig?.solMode);
    const depositRef = isSolMode
      ? Number(tracked?.amount_sol ?? 0)
      : Number(tracked?.initial_value_usd ?? 0);
    const currentVal = isSolMode
      ? Number(position.total_value_usd ?? 0)
      : Number(position.total_value_true_usd ?? position.total_value_usd ?? 0);
    if (depositRef > 0 && currentVal > depositRef * 0.25) {
      log("cron_warn", `Suspect PnL for ${position.pair ?? position.position}: ${position.pnl_pct}% but position still has >25% value (${currentVal}) — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  const knifeRescuePct = managementConfig.knifeRescueStopLossPct ?? -15;
  if (
    !pnlSuspect &&
    position.pnl_pct != null &&
    position.pnl_pct <= knifeRescuePct &&
    (chronosCtx?.knife_rescue_trigger || chronosCtx?.oor_below_outlook === "WEAK_STRUCTURAL_BREAKDOWN")
  ) {
    return { action: "CLOSE", rule: 1, reason: "stop loss (knife rescue)" };
  }
  const tpMult = Number.isFinite(Number(chronosCtx?.take_profit_mult)) ? Number(chronosCtx?.take_profit_mult) : 1.0;
  const effectiveTpPct = managementConfig.takeProfitPct * tpMult;
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= effectiveTpPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose
  ) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }
  const oorAboveLimit = managementConfig.outOfRangeAboveWaitMinutes ?? managementConfig.outOfRangeWaitMinutes ?? 60;
  let oorBelowLimit = managementConfig.outOfRangeBelowWaitMinutes ?? managementConfig.outOfRangeWaitMinutes ?? 240;
  if (chronosCtx?.oor_below_outlook === "WEAK_STRUCTURAL_BREAKDOWN") {
    oorBelowLimit = managementConfig.outOfRangeBelowEarlyCutMinutes ?? 90;
  } else if (
    chronosCtx?.oor_below_outlook === "STRONG_REBOUND_PROBABILITY" &&
    (position.pnl_pct == null || position.pnl_pct > -25)
  ) {
    oorBelowLimit = (managementConfig.outOfRangeBelowWaitMinutes ?? 240) + 90;
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= oorAboveLimit
  ) {
    return { action: "CLOSE", rule: 4, reason: `OOR above (${oorAboveLimit}m)` };
  }
  if (
    position.active_bin != null &&
    position.lower_bin != null &&
    position.active_bin < position.lower_bin &&
    (position.minutes_out_of_range ?? 0) >= oorBelowLimit
  ) {
    return { action: "CLOSE", rule: 4, reason: `OOR below (${oorBelowLimit}m)` };
  }
  const minAgeBeforeYieldCheck = managementConfig.minAgeBeforeYieldCheck ?? 60;
  const depositUsd = Number(tracked?.initial_value_usd || position.total_value_true_usd || 0);
  const totalFeesEarnedUsd = Number(position.collected_fees_true_usd ?? 0) + Number(position.unclaimed_fees_true_usd ?? 0);
  const depositSol = Number(tracked?.amount_sol || position.total_value_usd || 0);
  const totalFeesEarnedSol = Number(position.collected_fees_usd ?? 0) + Number(position.unclaimed_fees_usd ?? 0);
  const feeEarnedPct = depositUsd > 0
    ? (totalFeesEarnedUsd / depositUsd) * 100
    : (managementConfig?.solMode && depositSol > 0)
      ? (totalFeesEarnedSol / depositSol) * 100
      : null;
  const ageMin = position.age_minutes ?? null;
  const ageHours = ageMin != null && ageMin > 0 ? Math.max(0.25, ageMin / 60) : null;
  const feeVelocityPctPerHr = (feeEarnedPct != null && ageHours != null) ? feeEarnedPct / ageHours : null;
  const minFeeVelocity = managementConfig.minPositionFeeVelocityPctPerHr ?? 0.45;

  if (
    !pnlSuspect &&
    position.pnl_pct != null &&
    position.pnl_pct >= -0.4 &&
    ageMin != null &&
    ageMin >= Math.min(40, minAgeBeforeYieldCheck) &&
    feeVelocityPctPerHr != null &&
    feeVelocityPctPerHr < minFeeVelocity * 0.7 &&
    chronosCtx?.volume_decay_warning === true
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield (dead capital + volume decay)" };
  }

  if (
    !pnlSuspect &&
    position.pnl_pct != null &&
    position.pnl_pct >= -0.25 &&
    !chronosCtx?.let_winners_run &&
    (ageMin ?? 0) >= minAgeBeforeYieldCheck
  ) {
    const poolFeeLow =
      managementConfig.minFeePerTvl24h > 0 &&
      position.fee_per_tvl_24h != null &&
      position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
      position.pnl_pct >= 0;
    const realizedVelocityLow =
      feeVelocityPctPerHr != null &&
      minFeeVelocity > 0 &&
      feeVelocityPctPerHr < minFeeVelocity;
    if (poolFeeLow || realizedVelocityLow) {
      return { action: "CLOSE", rule: 5, reason: "low yield" };
    }
  }
  return null;
}

/**
 * Volatility-scaled bins below active bin, clamped to the configured range
 * and scaled by bin_step when bin_step > 100 so 200-step pools don't stretch -66%.
 * Throws on unknown volatility — never deploy a blind fixed range.
 */
export function computeBinsBelow(volatility: unknown, binStep: number = 100): number {
  const parsedVolatility = Number(volatility);
  if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0) {
    throw new Error(`Invalid volatility ${volatility ?? "unknown"} — refusing volatility-scaled deploy.`);
  }
  const lo = scaleBinsForBinStep(config.strategy.minBinsBelow, binStep, 22);
  const hi = scaleBinsForBinStep(config.strategy.maxBinsBelow, binStep, 36);
  return Math.max(lo, Math.min(hi, Math.round(lo + (parsedVolatility / 5) * (hi - lo))));
}
