/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const STATE_FILE = repoPath("state.json");

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;
// Post-claim Meteora /pnl API indexer settlement window (60s).
// Immediately after claimSwapFee, Meteora's /pnl API can temporarily double-count
// claimed fees in both allTimeFees and unclaimedFee (or zero unclaimedFee before
// indexing allTimeFees), causing a phantom PnL spike/drop that would falsely arm
// or fire Trailing TP / Stop Loss.
export const POST_CLAIM_SETTLE_MS = 60_000;

export function isPostClaimSettling(posOrAddress, nowMs = Date.now()) {
  const pos = typeof posOrAddress === "string"
    ? getTrackedPosition(posOrAddress)
    : posOrAddress;
  if (!pos?.last_claim_at) return false;
  const claimMs = new Date(pos.last_claim_at).getTime();
  return Number.isFinite(claimMs) && nowMs - claimMs >= 0 && nowMs - claimMs < POST_CLAIM_SETTLE_MS;
}

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    const tmpFile = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
    fs.renameSync(tmpFile, STATE_FILE);
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  entry_mcap = null,
  entry_tvl = null,
  entry_volume = null,
  entry_holders = null,
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
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
export function markOutOfRange(position_address) {
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
export function markInRange(position_address) {
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
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
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
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
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

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
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
 * candidate stays above the current peak. With the 3s RPC poller this confirms a real
 * high in ~3-6s and prevents a single noisy tick from inflating the peak (which would
 * otherwise arm a false trailing-drop). Replaces the old 15s setTimeout recheck.
 * Returns true when the peak was raised this call.
 */
export function confirmPeak(position_address, candidatePnlPct, confirmTicks = 2) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  // Never confirm or raise peak_pnl_pct during the 60s post-claim settlement window,
  // because Meteora's /pnl API can double-count claimed fees in both allTimeFees and
  // unclaimedFee for ~6-15s right after claimSwapFee.
  if (isPostClaimSettling(pos)) {
    if (pos.pending_peak_pnl_pct != null) {
      pos.pending_peak_pnl_pct = null;
      pos.pending_peak_confirm_count = 0;
      pos.pending_peak_started_at = null;
      save(state);
    }
    return false;
  }

  const currentPeak = pos.peak_pnl_pct ?? 0;
  // No new high — drop any pending peak candidate.
  if (candidatePnlPct <= currentPeak) {
    if (pos.pending_peak_pnl_pct != null) {
      pos.pending_peak_pnl_pct = null;
      pos.pending_peak_confirm_count = 0;
      save(state);
    }
    return false;
  }

  // Same-or-higher candidate as the pending one → another confirming tick.
  if (pos.pending_peak_pnl_pct != null && candidatePnlPct >= pos.pending_peak_pnl_pct) {
    pos.pending_peak_confirm_count = (pos.pending_peak_confirm_count ?? 1) + 1;
    pos.pending_peak_pnl_pct = candidatePnlPct;
  } else {
    // New / lower-than-pending candidate → start a fresh confirmation streak.
    pos.pending_peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_confirm_count = 1;
    pos.pending_peak_started_at = new Date().toISOString();
  }

  if (pos.pending_peak_confirm_count >= confirmTicks) {
    pos.peak_pnl_pct = Math.max(currentPeak, pos.pending_peak_pnl_pct);
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
 * Consecutive-tick confirmation for an exit signal. The fast poller calls this every
 * tick with the exit action string detected this poll (or null when no exit). An exit
 * only fires after `confirmTicks` consecutive polls report the SAME action — so a single
 * noisy tick can't close a position. Streak resets whenever the signal clears or changes.
 * Returns { fire, action, count }.
 */
export function registerExitSignal(position_address, signal, confirmTicks = 2) {
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
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
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
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig, chronosCtx = null) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, fee_per_tvl_24h } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  const postClaimSettling = isPostClaimSettling(pos);
  const effectiveSuspicious = Boolean(pnl_pct_suspicious || postClaimSettling);
  let changed = false;

  // Touchpoint 2: Chronos-Adaptive Trailing Take-Profit (Sniper Lock vs Let Winners Run)
  const baseTriggerPct = mgmtConfig.trailingTriggerPct ?? 3.8;
  const effectiveTriggerPct = chronosCtx?.sniper_lock
    ? Math.min(baseTriggerPct, 2.2)
    : baseTriggerPct;
  const effectiveDropPct = chronosCtx?.sniper_lock
    ? Math.min(mgmtConfig.trailingDropPct ?? 1.2, 0.7)
    : chronosCtx?.let_winners_run
      ? Math.max(mgmtConfig.trailingDropPct ?? 1.2, 2.2)
      : (mgmtConfig.trailingDropPct ?? 1.2);

  // Persist trailing_active permanently only when peak reaches the standard baseTriggerPct
  if (!effectiveSuspicious && mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= baseTriggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%, trigger: ${baseTriggerPct}%)`);
  }
  // Allow transient sniper_lock activation for this tick without locking pos.trailing_active permanently
  const isTrailingActiveThisTick = Boolean(
    pos.trailing_active ||
    (mgmtConfig.trailingTakeProfit && chronosCtx?.sniper_lock && (pos.peak_pnl_pct ?? 0) >= effectiveTriggerPct),
  );

  // Update OOR state
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

  // ── Stop loss & Predictive Knife-Rescue Pre-Stop-Loss ──────────
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

  // ── Trailing TP (never close at a loss: currentPnlPct must be > 0) ─────────
  if (!effectiveSuspicious && isTrailingActiveThisTick && currentPnlPct != null && currentPnlPct > 0) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= effectiveDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${effectiveDropPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      };
    }
  }

  // ── Out of range too long (separated: Above vs Below + Touchpoint 3 Chronos OOR-Below Defense) ─────────
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

  // ── Low yield & Realized Fee Velocity (Dead Capital) ───────────
  const { age_minutes } = positionData;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  const depositUsd = Number(pos.initial_value_usd || positionData.total_value_true_usd || 0);
  const totalFeesEarnedUsd = Number(positionData.collected_fees_true_usd ?? 0) + Number(positionData.unclaimed_fees_true_usd ?? 0);
  const depositSol = Number(pos.amount_sol || positionData.total_value_usd || 0);
  const totalFeesEarnedSol = Number(positionData.collected_fees_usd ?? 0) + Number(positionData.unclaimed_fees_usd ?? 0);
  const feeEarnedPct = depositUsd > 0
    ? (totalFeesEarnedUsd / depositUsd) * 100
    : (mgmtConfig.solMode && depositSol > 0)
      ? (totalFeesEarnedSol / depositSol) * 100
      : null;
  const ageHours = age_minutes != null && age_minutes > 0 ? Math.max(0.25, age_minutes / 60) : null;
  const feeVelocityPctPerHr = (feeEarnedPct != null && ageHours != null) ? feeEarnedPct / ageHours : null;
  const minFeeVelocity = mgmtConfig.minPositionFeeVelocityPctPerHr ?? 0.45;

  // Stage 1: Early Dead-Capital Cut (age >= 40m + Chronos-2 Volume Decay + low fee velocity)
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

  // Stage 2: Standard Low Yield (Pool 24h Fee/TVL OR Realized Position Fee Velocity)
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

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
}
