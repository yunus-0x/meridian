// Local closed-position accounting. Existing lessons.json history is preserved.
import fs from "node:fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
const LESSONS_FILE = repoPath("lessons.json");
const PERFORMANCE_SIGNAL_FIELDS = [
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
  "entry_mcap",
  "entry_tvl",
  "entry_volume",
];

function load() {
  if (!fs.existsSync(LESSONS_FILE)) {
    return { lessons: [], performance: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
  } catch {
    return { lessons: [], performance: [] };
  }
}

function save(data) {
  const tmpFile = `${LESSONS_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, LESSONS_FILE);
}

function buildSignalSnapshot(perf) {
  const snapshot = { ...(perf.signal_snapshot || {}) };
  if (perf.base_mint && snapshot.base_mint == null) snapshot.base_mint = perf.base_mint;
  for (const field of PERFORMANCE_SIGNAL_FIELDS) {
    if (snapshot[field] == null && perf[field] != null) {
      snapshot[field] = perf[field];
    }
  }
  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

export async function recordPerformance(perf) {
  const data = load();

  // Guard against unit-mixed records where a SOL-sized final value is
  // accidentally written into a USD field (e.g. final_value_usd = 2 for a 2 SOL close).
  const suspiciousUnitMix =
    Number.isFinite(perf.initial_value_usd) &&
    Number.isFinite(perf.final_value_usd) &&
    Number.isFinite(perf.amount_sol) &&
    perf.initial_value_usd >= 20 &&
    perf.amount_sol >= 0.25 &&
    perf.final_value_usd > 0 &&
    perf.final_value_usd <= perf.amount_sol * 2;

  if (suspiciousUnitMix) {
    log("lessons_warn", `Skipped suspicious performance record for ${perf.pool_name || perf.pool}: initial=${perf.initial_value_usd}, final=${perf.final_value_usd}, amount_sol=${perf.amount_sol}`);
    return;
  }

  const pnl_usd = (perf.final_value_usd + perf.fees_earned_usd) - perf.initial_value_usd;
  const pnl_pct = perf.initial_value_usd > 0
    ? (pnl_usd / perf.initial_value_usd) * 100
    : Number.isFinite(perf.reported_pnl_pct)
      ? perf.reported_pnl_pct
      : 0;
  const range_efficiency = perf.minutes_held > 0
    ? (perf.minutes_in_range / perf.minutes_held) * 100
    : 0;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const suspiciousAbsurdClosedPnl =
    Number.isFinite(pnl_pct) &&
    perf.initial_value_usd >= 20 &&
    pnl_pct <= -90 &&
    !closeReasonText.includes("stop loss");

  if (suspiciousAbsurdClosedPnl) {
    log("lessons_warn", `Skipped absurd closed PnL record for ${perf.pool_name || perf.pool}: pnl_pct=${pnl_pct.toFixed(2)} reason=${perf.close_reason}`);
    return;
  }

  const signalSnapshot = buildSignalSnapshot(perf);
  const entry = {
    ...perf,
    signal_snapshot: signalSnapshot,
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    recorded_at: new Date().toISOString(),
  };

  data.performance.push(entry);

  save(data);

  // Update pool-level memory
  if (perf.pool) {
    const { recordPoolDeploy } = await import("./pool-memory.js");
    const feeEarnedPct = perf.initial_value_usd > 0
      ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100
      : perf.amount_sol > 0 && perf.fees_earned_sol != null
        ? ((perf.fees_earned_sol || 0) / perf.amount_sol) * 100
        : null;
    recordPoolDeploy(perf.pool, {
      pool_name: perf.pool_name,
      base_mint: perf.base_mint,
      deployed_at: perf.deployed_at,
      closed_at: entry.recorded_at,
      pnl_pct: entry.pnl_pct,
      pnl_usd: entry.pnl_usd,
      range_efficiency: entry.range_efficiency,
      minutes_held: perf.minutes_held,
      fees_earned_usd: perf.fees_earned_usd,
      fees_earned_sol: perf.fees_earned_sol,
      fee_earned_pct: feeEarnedPct,
      close_reason: perf.close_reason,
      strategy: perf.strategy,
      volatility: perf.volatility,
      entry_mcap: perf.entry_mcap,
      entry_tvl: perf.entry_tvl,
      entry_volume: perf.entry_volume,
      exit_mcap: perf.exit_mcap,
      exit_tvl: perf.exit_tvl,
      exit_volume: perf.exit_volume,
    });
  }

}

export function getPerformanceHistory({ hours = 24, limit = 50 } = {}) {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return { positions: [], count: 0, hours };

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const filtered = p
    .filter((r) => r.recorded_at >= cutoff)
    .slice(-limit)
    .map((r) => ({
      pool_name: r.pool_name,
      pool: r.pool,
      strategy: r.strategy,
      pnl_usd: r.pnl_usd,
      pnl_pct: r.pnl_pct,
      fees_earned_usd: r.fees_earned_usd,
      range_efficiency: r.range_efficiency,
      minutes_held: r.minutes_held,
      close_reason: r.close_reason,
      closed_at: r.recorded_at,
    }));

  const totalPnl = filtered.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = filtered.filter((r) => r.pnl_usd > 0).length;

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    positions: filtered,
  };
}

export function getPerformanceSummary() {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return null;

  const totalPnl = p.reduce((s, x) => s + x.pnl_usd, 0);
  const avgPnlPct = p.reduce((s, x) => s + x.pnl_pct, 0) / p.length;
  const avgRangeEfficiency = p.reduce((s, x) => s + x.range_efficiency, 0) / p.length;
  const wins = p.filter((x) => x.pnl_usd > 0).length;

  return {
    total_positions_closed: p.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    avg_pnl_pct: Math.round(avgPnlPct * 100) / 100,
    avg_range_efficiency_pct: Math.round(avgRangeEfficiency * 10) / 10,
    win_rate_pct: Math.round((wins / p.length) * 100),
  };
}
