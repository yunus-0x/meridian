/**
 * Darwinian signal weighting system.
 *
 * Tracks which screening signals actually predict profitable positions
 * and adjusts their weights over time. Signals that consistently appear
 * in winners get boosted; those associated with losers get decayed.
 *
 * Weights are persisted in signal-weights.json and injected into the
 * LLM prompt so the agent can prioritize the right screening criteria.
 */

import fs from "fs";
import { log } from "./logger.js";

const WEIGHTS_FILE = `${process.env.DATA_DIR || "."}/signal-weights.json`;

// ─── Signal Definitions ─────────────────────────────────────────

const SIGNAL_NAMES = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "hive_consensus",
  "volatility",
];

const DEFAULT_WEIGHTS = Object.fromEntries(SIGNAL_NAMES.map((s) => [s, 1.0]));

// Signals where higher values generally indicate better candidates
const HIGHER_IS_BETTER = new Set([
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "holder_count",
  "study_win_rate",
  "hive_consensus",
]);

// Boolean signals — compared by win rate when present vs absent
const BOOLEAN_SIGNALS = new Set(["smart_wallets_present"]);

// Categorical signals — compared by win rate across categories
const CATEGORICAL_SIGNALS = new Set(["narrative_quality"]);

// ─── Persistence ─────────────────────────────────────────────────

export function loadWeights() {
  if (!fs.existsSync(WEIGHTS_FILE)) {
    const initial = {
      weights: { ...DEFAULT_WEIGHTS },
      last_recalc: null,
      recalc_count: 0,
      history: [],
    };
    saveWeights(initial);
    log("signal_weights", "Created signal-weights.json with default weights");
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(WEIGHTS_FILE, "utf8"));
  } catch (err) {
    log("signal_weights_error", `Failed to read signal-weights.json: ${err.message}`);
    return {
      weights: { ...DEFAULT_WEIGHTS },
      last_recalc: null,
      recalc_count: 0,
      history: [],
    };
  }
}

export function saveWeights(data) {
  try {
    fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log("signal_weights_error", `Failed to write signal-weights.json: ${err.message}`);
  }
}

// ─── Core Algorithm ──────────────────────────────────────────────

/**
 * Recalculate signal weights based on actual position performance.
 *
 * @param {Array}  perfData - Array of performance records (from lessons.json)
 * @param {Object} cfg      - Live config object (reads cfg.darwin for tuning)
 * @returns {{ changes: Array, weights: Object }}
 */
export function recalculateWeights(perfData, cfg = {}) {
  const darwin = cfg.darwin || {};
  const windowDays    = darwin.windowDays    ?? 60;
  const minSamples    = darwin.minSamples    ?? 10;
  const boostFactor   = darwin.boostFactor   ?? 1.05;
  const decayFactor   = darwin.decayFactor   ?? 0.95;
  const weightFloor   = darwin.weightFloor   ?? 0.3;
  const weightCeiling = darwin.weightCeiling ?? 2.5;

  const data = loadWeights();
  const weights = data.weights || { ...DEFAULT_WEIGHTS };

  // Ensure all signals exist (handles new signals added after initial creation)
  for (const name of SIGNAL_NAMES) {
    if (weights[name] == null) weights[name] = 1.0;
  }

  // Filter to rolling window
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffISO = cutoff.toISOString();

  const recent = perfData.filter((p) => {
    const ts = p.recorded_at || p.closed_at || p.deployed_at;
    return ts && ts >= cutoffISO;
  });

  if (recent.length < minSamples) {
    log("signal_weights", `Only ${recent.length} records in ${windowDays}d window (need ${minSamples}), skipping recalc`);
    return { changes: [], weights };
  }

  // Classify wins and losses
  const wins   = recent.filter((p) => (p.pnl_usd ?? 0) > 0);
  const losses = recent.filter((p) => (p.pnl_usd ?? 0) <= 0);

  if (wins.length === 0 || losses.length === 0) {
    log("signal_weights", `Need both wins (${wins.length}) and losses (${losses.length}) to compute lift, skipping`);
    return { changes: [], weights };
  }

  // Compute predictive lift for each signal
  const lifts = {};
  for (const signal of SIGNAL_NAMES) {
    const lift = computeLift(signal, wins, losses, minSamples);
    if (lift !== null) lifts[signal] = lift;
  }

  const ranked = Object.entries(lifts).sort((a, b) => b[1] - a[1]);

  if (ranked.length === 0) {
    log("signal_weights", "No signals had enough samples for lift calculation");
    return { changes: [], weights };
  }

  // Split into quartiles
  const q1End    = Math.ceil(ranked.length * 0.25);
  const q3Start  = Math.floor(ranked.length * 0.75);
  const topQuartile    = new Set(ranked.slice(0, q1End).map(([name]) => name));
  const bottomQuartile = new Set(ranked.slice(q3Start).map(([name]) => name));

  // Apply boosts and decays
  const changes = [];
  for (const [signal, lift] of ranked) {
    const prev = weights[signal];
    let next = prev;

    if (topQuartile.has(signal)) {
      next = Math.min(prev * boostFactor, weightCeiling);
    } else if (bottomQuartile.has(signal)) {
      next = Math.max(prev * decayFactor, weightFloor);
    }

    next = Math.round(next * 1000) / 1000;

    if (next !== prev) {
      const dir = next > prev ? "boosted" : "decayed";
      changes.push({ signal, from: prev, to: next, lift: Math.round(lift * 1000) / 1000, action: dir });
      weights[signal] = next;
      log("signal_weights", `${signal}: ${prev} -> ${next} (${dir}, lift=${lift.toFixed(3)})`);
    }
  }

  // Persist
  data.weights = weights;
  data.last_recalc = new Date().toISOString();
  data.recalc_count = (data.recalc_count || 0) + 1;
  if (!data.history) data.history = [];
  if (changes.length > 0) {
    data.history.push({
      timestamp: data.last_recalc,
      changes,
      window_size: recent.length,
      win_count: wins.length,
      loss_count: losses.length,
    });
    if (data.history.length > 20) data.history = data.history.slice(-20);
  }
  saveWeights(data);

  log("signal_weights", changes.length > 0
    ? `Recalculated: ${changes.length} weight(s) adjusted from ${recent.length} records`
    : `Recalculated: no changes needed (${recent.length} records, ${ranked.length} signals evaluated)`);

  return { changes, weights };
}

// ─── Lift Computation ────────────────────────────────────────────

function computeLift(signal, wins, losses, minSamples) {
  if (BOOLEAN_SIGNALS.has(signal))      return computeBooleanLift(signal, wins, losses, minSamples);
  if (CATEGORICAL_SIGNALS.has(signal))  return computeCategoricalLift(signal, wins, losses, minSamples);
  return computeNumericLift(signal, wins, losses, minSamples);
}

function computeNumericLift(signal, wins, losses, minSamples) {
  const winVals  = extractNumeric(signal, wins);
  const lossVals = extractNumeric(signal, losses);
  if (winVals.length + lossVals.length < minSamples) return null;
  if (winVals.length === 0 || lossVals.length === 0) return null;

  const all = [...winVals, ...lossVals];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = max - min;
  if (range === 0) return 0;

  const normalize = (v) => (v - min) / range;
  const winMean  = mean(winVals.map(normalize));
  const lossMean = mean(lossVals.map(normalize));

  return HIGHER_IS_BETTER.has(signal) ? winMean - lossMean : Math.abs(winMean - lossMean);
}

function computeBooleanLift(signal, wins, losses, minSamples) {
  const allEntries = [...wins.map((w) => ({ w: true, snap: w })), ...losses.map((l) => ({ w: false, snap: l }))];
  let trueWins = 0, trueTotal = 0, falseWins = 0, falseTotal = 0;

  for (const { w, snap } of allEntries) {
    const val = snap.signal_snapshot?.[signal];
    if (val === undefined || val === null) continue;
    if (val) { trueTotal++; if (w) trueWins++; }
    else      { falseTotal++; if (w) falseWins++; }
  }

  if (trueTotal + falseTotal < minSamples) return null;
  if (trueTotal === 0 || falseTotal === 0) return null;
  return (trueWins / trueTotal) - (falseWins / falseTotal);
}

function computeCategoricalLift(signal, wins, losses, minSamples) {
  const allEntries = [...wins.map((w) => ({ w: true, snap: w })), ...losses.map((l) => ({ w: false, snap: l }))];
  const buckets = {};

  for (const { w, snap } of allEntries) {
    const val = snap.signal_snapshot?.[signal];
    if (val === undefined || val === null) continue;
    if (!buckets[val]) buckets[val] = { wins: 0, total: 0 };
    buckets[val].total++;
    if (w) buckets[val].wins++;
  }

  const totalSamples = Object.values(buckets).reduce((s, b) => s + b.total, 0);
  if (totalSamples < minSamples) return null;

  const rates = Object.values(buckets).filter((b) => b.total >= 2).map((b) => b.wins / b.total);
  if (rates.length < 2) return null;
  return Math.max(...rates) - Math.min(...rates);
}

// ─── Helpers ─────────────────────────────────────────────────────

function extractNumeric(signal, entries) {
  const vals = [];
  for (const entry of entries) {
    const snap = entry.signal_snapshot;
    if (!snap) continue;
    const v = snap[signal];
    if (v != null && typeof v === "number" && isFinite(v)) vals.push(v);
  }
  return vals;
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ─── Summary for LLM Prompt Injection ────────────────────────────

export function getWeightsSummary() {
  const data = loadWeights();
  const w = data.weights || {};

  const lines = ["Signal Weights (Darwinian — learned from past positions):"];
  const sorted = SIGNAL_NAMES
    .filter((s) => w[s] != null)
    .sort((a, b) => (w[b] ?? 1) - (w[a] ?? 1));

  for (const signal of sorted) {
    const val = w[signal] ?? 1.0;
    const label = interpretWeight(val);
    const bar   = weightBar(val);
    lines.push(`  ${signal.padEnd(24)} ${val.toFixed(2)}  ${bar}  ${label}`);
  }

  if (data.last_recalc) {
    lines.push(`\nLast recalculated: ${data.last_recalc} (${data.recalc_count || 0} total)`);
  } else {
    lines.push("\nWeights have not been recalculated yet (using defaults).");
  }

  return lines.join("\n");
}

function interpretWeight(val) {
  if (val >= 1.8) return "[STRONG]";
  if (val >= 1.2) return "[above avg]";
  if (val >= 0.8) return "[neutral]";
  if (val >= 0.5) return "[below avg]";
  return "[weak]";
}

function weightBar(val) {
  const filled  = Math.round(((val - 0.3) / (2.5 - 0.3)) * 10);
  const clamped = Math.max(0, Math.min(10, filled));
  return "#".repeat(clamped) + ".".repeat(10 - clamped);
}
