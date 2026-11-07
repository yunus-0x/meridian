/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "node:fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import {
  StateJsonSchema,
  type StateJson,
  type TrackedPosition,
  type StateSummary,
  type StateEvent,
} from "./src/schemas/state.js";
import type { ManagementConfigInput, ChronosTacticalContext } from "./exit-rules.js";

const STATE_FILE = repoPath("state.json");

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

// Post-claim Meteora /pnl API indexer settlement window (60s).
export const POST_CLAIM_SETTLE_MS = 60_000;

function hasLastClaimAt(obj: unknown): obj is { last_claim_at: string | null } {
  return typeof obj === "object" && obj !== null && "last_claim_at" in obj;
}

export function isPostClaimSettling(posOrAddress: unknown, nowMs: number = Date.now()): boolean {
  let lastClaimAt: string | null = null;
  if (typeof posOrAddress === "string") {
    const pos = getTrackedPosition(posOrAddress);
    lastClaimAt = pos?.last_claim_at ?? null;
  } else if (hasLastClaimAt(posOrAddress)) {
    lastClaimAt = typeof posOrAddress.last_claim_at === "string" ? posOrAddress.last_claim_at : null;
  }
  if (!lastClaimAt) return false;
  const claimMs = new Date(lastClaimAt).getTime();
  return Number.isFinite(claimMs) && nowMs - claimMs >= 0 && nowMs - claimMs < POST_CLAIM_SETTLE_MS;
}

function sanitizeStoredText(text: unknown, maxLen = MAX_INSTRUCTION_LENGTH): string | null {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

export function load(): StateJson {
  if (!fs.existsSync(STATE_FILE)) {
    return StateJsonSchema.parse({});
  }
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const parsed = StateJsonSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data;
    }
    log("state_error", `Validation error reading state.json: ${parsed.error.message}`);
    return StateJsonSchema.parse({});
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log("state_error", `Failed to read state.json: ${msg}`);
    return StateJsonSchema.parse({});
  }
}

export function save(state: StateJson): void {
  try {
    state.lastUpdated = new Date().toISOString();
    const validated = StateJsonSchema.parse(state);
    const tmpFile = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(validated, null, 2));
    fs.renameSync(tmpFile, STATE_FILE);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log("state_error", `Failed to write state.json: ${msg}`);
  }
}

export const getState = load;
export const saveState = save;

// ─── Position Registry ─────────────────────────────────────────

export interface TrackPositionParams {
  position: string;
  pool: string;
  pool_name?: string;
  strategy?: string;
  bin_range?: { min?: number; max?: number; bins_below?: number; bins_above?: number; active?: number };
  amount_sol?: number;
  amount_x?: number;
  active_bin?: number | null;
  bin_step?: number | null;
  volatility?: number | null;
  fee_tvl_ratio?: number | null;
  organic_score?: number | null;
  initial_value_usd?: number | null;
  signal_snapshot?: Record<string, unknown> | null;
  entry_mcap?: number | null;
  entry_tvl?: number | null;
  entry_volume?: number | null;
  entry_holders?: number | null;
}

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy = "bid_ask",
  bin_range = {},
  amount_sol = 0,
  amount_x = 0,
  active_bin = null,
  bin_step = null,
  volatility = null,
  fee_tvl_ratio = null,
  organic_score = null,
  initial_value_usd = null,
  signal_snapshot = null,
  entry_mcap = null,
  entry_tvl = null,
  entry_volume = null,
  entry_holders = null,
}: TrackPositionParams): void {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range: {
      min: bin_range.min ?? 0,
      max: bin_range.max ?? 0,
      bins_below: bin_range.bins_below,
      bins_above: bin_range.bins_above,
      active: bin_range.active,
    },
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    entry_mcap,
    entry_tvl,
    entry_volume,
    entry_holders,
    signal_snapshot: signal_snapshot || null,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
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
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address: string): void {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address: string): void {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address: string): number {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address: string, fees_usd?: number | null): void {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  // Clear any in-flight peak or exit confirmation streak so post-claim indexer lag
  // cannot combine with a pre-claim tick to falsely confirm a peak or exit.
  pos.pending_peak_pnl_pct = null;
  pos.pending_peak_confirm_count = 0;
  pos.pending_peak_started_at = null;
  pos.pending_exit_action = null;
  pos.pending_exit_count = 0;
  pos.pending_exit_started_at = null;
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state: StateJson, event: { action: string; position: string; pool_name?: string; reason?: string }): void {
  if (!state.recentEvents) state.recentEvents = [];
  const entry: StateEvent = { ts: new Date().toISOString(), ...event };
  state.recentEvents.push(entry);
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address: string, reason: string): void {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

export const closePositionRecord = recordClose;

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address: string, instruction: unknown): boolean {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

/**
 * Raise the confirmed peak PnL only after `confirmTicks` consecutive polls where the
 * candidate stays above the current peak.
 */
export function confirmPeak(position_address: string, candidatePnlPct: number | null | undefined, confirmTicks = 2): boolean {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  if (isPostClaimSettling(pos)) {
    if (pos.pending_peak_pnl_pct != null) {
      pos.pending_peak_pnl_pct = null;
      pos.pending_peak_confirm_count = 0;
      pos.pending_peak_started_at = null;
      save(state);
    }
    return false;
  }

  const currentPeak = Number(pos.peak_pnl_pct ?? 0);
  if (candidatePnlPct <= currentPeak) {
    if (pos.pending_peak_pnl_pct != null) {
      pos.pending_peak_pnl_pct = null;
      pos.pending_peak_confirm_count = 0;
      save(state);
    }
    return false;
  }

  const pendingPeak = pos.pending_peak_pnl_pct != null ? Number(pos.pending_peak_pnl_pct) : null;
  if (pendingPeak != null && candidatePnlPct >= pendingPeak) {
    pos.pending_peak_confirm_count = (pos.pending_peak_confirm_count ?? 1) + 1;
    pos.pending_peak_pnl_pct = candidatePnlPct;
  } else {
    pos.pending_peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_confirm_count = 1;
    pos.pending_peak_started_at = new Date().toISOString();
  }

  if (pos.pending_peak_confirm_count >= confirmTicks) {
    pos.peak_pnl_pct = Math.max(currentPeak, Number(pos.pending_peak_pnl_pct));
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_confirm_count = 0;
    pos.pending_peak_started_at = null;
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% (${confirmTicks} ticks)`);
    return true;
  }

  save(state);
  return false;
}

/**
 * Consecutive-tick confirmation for an exit signal.
 */
export function registerExitSignal(
  position_address: string,
  signal: string | null,
  confirmTicks = 2
): { fire: boolean; action: string | null; count: number } {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return { fire: false, action: null, count: 0 };

  if (!signal) {
    if (pos.pending_exit_action != null) {
      pos.pending_exit_action = null;
      pos.pending_exit_count = 0;
      save(state);
    }
    return { fire: false, action: null, count: 0 };
  }

  if (pos.pending_exit_action === signal) {
    pos.pending_exit_count = (pos.pending_exit_count ?? 1) + 1;
  } else {
    pos.pending_exit_action = signal;
    pos.pending_exit_count = 1;
    pos.pending_exit_started_at = new Date().toISOString();
  }

  const count = pos.pending_exit_count;
  const fire = count >= confirmTicks;
  if (fire) {
    pos.pending_exit_action = null;
    pos.pending_exit_count = 0;
    pos.pending_exit_started_at = null;
  }
  save(state);
  if (fire) log("state", `Position ${position_address} exit signal "${signal}" confirmed (${confirmTicks} ticks)`);
  return { fire, action: signal, count };
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false): TrackedPosition[] {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address: string): TrackedPosition | null {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary(): StateSummary {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h != null ? Number(p.initial_fee_tvl_24h) : null,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

export interface UpdatePnlPositionData {
  pnl_pct?: number | null;
  pnl_pct_suspicious?: boolean;
  in_range?: boolean | null;
  fee_per_tvl_24h?: number | null;
  active_bin?: number | null;
  upper_bin?: number | null;
  lower_bin?: number | null;
  age_minutes?: number | null;
  total_value_usd?: number | null;
  total_value_true_usd?: number | null;
  collected_fees_usd?: number | null;
  unclaimed_fees_usd?: number | null;
  collected_fees_true_usd?: number | null;
  unclaimed_fees_true_usd?: number | null;
}

export interface CheckExitResult {
  action: string;
  reason: string;
  needs_confirmation?: boolean;
  peak_pnl_pct?: number;
  current_pnl_pct?: number;
  drop_from_peak_pct?: number;
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 */
export function updatePnlAndCheckExits(
  position_address: string,
  positionData: UpdatePnlPositionData,
  mgmtConfig: ManagementConfigInput & {
    trailingTriggerPct?: number;
    trailingDropPct?: number;
    trailingTakeProfit?: boolean;
  },
  chronosCtx: ChronosTacticalContext & {
    sniper_lock?: boolean;
  } | null = null
): CheckExitResult | null {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, fee_per_tvl_24h } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  const postClaimSettling = isPostClaimSettling(pos);
  const effectiveSuspicious = Boolean(pnl_pct_suspicious || postClaimSettling);
  let changed = false;

  const baseTriggerPct = mgmtConfig.trailingTriggerPct ?? 3.8;
  const effectiveTriggerPct = chronosCtx?.sniper_lock
    ? Math.min(baseTriggerPct, 2.2)
    : baseTriggerPct;
  const effectiveDropPct = chronosCtx?.sniper_lock
    ? Math.min(mgmtConfig.trailingDropPct ?? 1.2, 0.7)
    : chronosCtx?.let_winners_run
      ? Math.max(mgmtConfig.trailingDropPct ?? 1.2, 2.2)
      : (mgmtConfig.trailingDropPct ?? 1.2);

  const peakPnl = Number(pos.peak_pnl_pct ?? 0);
  if (!effectiveSuspicious && mgmtConfig.trailingTakeProfit && !pos.trailing_active && peakPnl >= baseTriggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%, trigger: ${baseTriggerPct}%)`);
  }
  const isTrailingActiveThisTick = Boolean(
    pos.trailing_active ||
    (mgmtConfig.trailingTakeProfit && chronosCtx?.sniper_lock && peakPnl >= effectiveTriggerPct)
  );

  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  if (changed) save(state);

  // Stop loss & Knife rescue
  if (!effectiveSuspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }
  const knifeRescuePct = mgmtConfig.knifeRescueStopLossPct ?? -15;
  if (
    !effectiveSuspicious &&
    currentPnlPct != null &&
    currentPnlPct <= knifeRescuePct &&
    (chronosCtx?.knife_rescue_trigger || chronosCtx?.oor_below_outlook === "WEAK_STRUCTURAL_BREAKDOWN")
  ) {
    return {
      action: "STOP_LOSS",
      reason: `Knife rescue pre-stop-loss: PnL ${currentPnlPct.toFixed(2)}% <= ${knifeRescuePct}% with Chronos structural breakdown`,
    };
  }

  // Trailing TP
  if (!effectiveSuspicious && isTrailingActiveThisTick && currentPnlPct != null && currentPnlPct > 0) {
    const dropFromPeak = peakPnl - currentPnlPct;
    if (dropFromPeak >= effectiveDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${peakPnl.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${effectiveDropPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: peakPnl,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      };
    }
  }

  // Out of range too long
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    const { active_bin, upper_bin, lower_bin } = positionData;
    const isAbove = active_bin != null && upper_bin != null && active_bin > upper_bin;
    const isBelow = active_bin != null && lower_bin != null && active_bin < lower_bin;
    let oorLimit = isAbove
      ? (mgmtConfig.outOfRangeAboveWaitMinutes ?? mgmtConfig.outOfRangeWaitMinutes ?? 60)
      : isBelow
        ? (mgmtConfig.outOfRangeBelowWaitMinutes ?? mgmtConfig.outOfRangeWaitMinutes ?? 240)
        : (mgmtConfig.outOfRangeWaitMinutes ?? 60);
    if (isBelow && chronosCtx?.oor_below_outlook === "WEAK_STRUCTURAL_BREAKDOWN") {
      oorLimit = mgmtConfig.outOfRangeBelowEarlyCutMinutes ?? 90;
    } else if (
      isBelow &&
      chronosCtx?.oor_below_outlook === "STRONG_REBOUND_PROBABILITY" &&
      (currentPnlPct == null || currentPnlPct > -25)
    ) {
      oorLimit = (mgmtConfig.outOfRangeBelowWaitMinutes ?? 240) + 90;
    }
    const dirLabel = isAbove ? "ABOVE" : isBelow ? "BELOW" : "OOR";
    if (minutesOOR >= oorLimit) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range (${dirLabel}) for ${minutesOOR}m (limit: ${oorLimit}m)`,
      };
    }
  }

  // Low yield
  const { age_minutes } = positionData;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  const depositUsd = Number(pos.initial_value_usd || positionData.total_value_true_usd || 0);
  const totalFeesEarnedUsd = Number(positionData.collected_fees_true_usd ?? 0) + Number(positionData.unclaimed_fees_true_usd ?? 0);
  const depositSol = Number(pos.amount_sol || positionData.total_value_usd || 0);
  const totalFeesEarnedSol = Number(positionData.collected_fees_usd ?? 0) + Number(positionData.unclaimed_fees_usd ?? 0);
  const feeEarnedPct = depositUsd > 0
    ? (totalFeesEarnedUsd / depositUsd) * 100
    : (mgmtConfig?.solMode && depositSol > 0)
      ? (totalFeesEarnedSol / depositSol) * 100
      : null;
  const ageHours = age_minutes != null && age_minutes > 0 ? Math.max(0.25, age_minutes / 60) : null;
  const feeVelocityPctPerHr = (feeEarnedPct != null && ageHours != null) ? feeEarnedPct / ageHours : null;
  const minFeeVelocity = mgmtConfig.minPositionFeeVelocityPctPerHr ?? 0.45;

  if (
    !effectiveSuspicious &&
    currentPnlPct != null &&
    currentPnlPct >= -0.4 &&
    age_minutes != null &&
    age_minutes >= Math.min(40, minAgeForYieldCheck) &&
    feeVelocityPctPerHr != null &&
    feeVelocityPctPerHr < minFeeVelocity * 0.7 &&
    chronosCtx?.volume_decay_warning === true
  ) {
    return {
      action: "LOW_YIELD",
      reason: `low yield (dead capital + volume decay: ${feeVelocityPctPerHr.toFixed(2)}%/hr < ${(minFeeVelocity * 0.7).toFixed(2)}%/hr, age: ${age_minutes}m, PnL: ${currentPnlPct.toFixed(2)}%)`,
    };
  }

  if (
    !effectiveSuspicious &&
    currentPnlPct != null &&
    currentPnlPct >= -0.25 &&
    !chronosCtx?.let_winners_run &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    const poolFeeLow =
      fee_per_tvl_24h != null &&
      mgmtConfig.minFeePerTvl24h != null &&
      mgmtConfig.minFeePerTvl24h > 0 &&
      fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
      currentPnlPct >= 0;
    const realizedVelocityLow =
      age_minutes != null &&
      feeVelocityPctPerHr != null &&
      minFeeVelocity > 0 &&
      feeVelocityPctPerHr < minFeeVelocity;
    if (poolFeeLow || realizedVelocityLow) {
      return {
        action: "LOW_YIELD",
        reason: realizedVelocityLow && !poolFeeLow
          ? `low yield (realized fee velocity ${feeVelocityPctPerHr.toFixed(2)}%/hr < min ${minFeeVelocity}%/hr, age: ${age_minutes}m, PnL: ${currentPnlPct.toFixed(2)}%)`
          : `Low yield: fee/TVL ${(fee_per_tvl_24h ?? 0).toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m, PnL: +${currentPnlPct.toFixed(2)}%)`,
      };
    }
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

export function getLastBriefingDate(): string | null {
  const state = load();
  return state._lastBriefingDate || null;
}

export function setLastBriefingDate(): void {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10);
  save(state);
}

// ─── On-Chain State Sync ───────────────────────────────────────

const SYNC_GRACE_MS = 5 * 60_000;

export function syncOpenPositions(active_addresses: Iterable<string>): void {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (!pos || pos.closed || activeSet.has(posId)) continue;

    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push("Auto-closed during state sync (not found on-chain)");
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
}
