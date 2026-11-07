// Local closed-position accounting. Existing lessons.json history is preserved.
import fs from "node:fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import {
  LessonsFileSchema,
  type LessonsFile,
  type PerformanceEntry,
} from "./src/schemas/storage.js";
import type { PositionBinRange } from "./src/schemas/state.js";

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
] as const;

function load(): LessonsFile {
  if (!fs.existsSync(LESSONS_FILE)) {
    return { lessons: [], performance: [] };
  }
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
    const parsed = LessonsFileSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data;
    }
    log("lessons_warn", `Failed to parse lessons.json: ${parsed.error.message}`);
    return { lessons: [], performance: [] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log("lessons_warn", `Failed to read lessons.json: ${msg}`);
    return { lessons: [], performance: [] };
  }
}

function save(data: LessonsFile): void {
  const validated = LessonsFileSchema.parse(data);
  const tmpFile = `${LESSONS_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(validated, null, 2));
  fs.renameSync(tmpFile, LESSONS_FILE);
}

export interface RecordPerformanceInput {
  pool: string;
  position?: string;
  pool_name?: string | null;
  base_mint?: string | null;
  strategy?: string;
  bin_range?: PositionBinRange;
  bin_step?: number | null;
  volatility?: number | null;
  fee_tvl_ratio?: number | null;
  organic_score?: number | null;
  amount_sol?: number | null;
  fees_earned_usd?: number | null;
  fees_earned_sol?: number | null;
  final_value_usd?: number | null;
  initial_value_usd?: number | null;
  reported_pnl_pct?: number | null;
  minutes_in_range?: number | null;
  minutes_held?: number | null;
  close_reason?: string | null;
  signal_snapshot?: Record<string, unknown> | null;
  entry_mcap?: number | null;
  entry_tvl?: number | null;
  entry_volume?: number | null;
  entry_holders?: number | null;
  exit_mcap?: number | null;
  exit_tvl?: number | null;
  exit_volume?: number | null;
  pnl_usd?: number | null;
  pnl_pct?: number | null;
  range_efficiency?: number | null;
  deployed_at?: string | null;
  volume?: number | null;
  mcap?: number | null;
  holder_count?: number | null;
  smart_wallets_present?: number | boolean | null;
  narrative_quality?: number | string | null;
  study_win_rate?: number | null;
  hive_consensus?: unknown;
  [key: string]: unknown;
}

function buildSignalSnapshot(perf: RecordPerformanceInput): Record<string, unknown> | null {
  const snapshot: Record<string, unknown> = { ...(perf.signal_snapshot || {}) };
  if (perf.base_mint && snapshot.base_mint == null) {
    snapshot.base_mint = perf.base_mint;
  }
  for (const field of PERFORMANCE_SIGNAL_FIELDS) {
    if (snapshot[field] == null && perf[field] != null) {
      snapshot[field] = perf[field];
    }
  }
  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

export async function recordPerformance(perf: RecordPerformanceInput): Promise<void> {
  const data = load();

  const initUsd = perf.initial_value_usd != null ? Number(perf.initial_value_usd) : null;
  const finalUsd = perf.final_value_usd != null ? Number(perf.final_value_usd) : null;
  const solAmt = perf.amount_sol != null ? Number(perf.amount_sol) : null;

  // Guard against unit-mixed records where a SOL-sized final value is
  // accidentally written into a USD field (e.g. final_value_usd = 2 for a 2 SOL close).
  const suspiciousUnitMix =
    initUsd != null &&
    Number.isFinite(initUsd) &&
    finalUsd != null &&
    Number.isFinite(finalUsd) &&
    solAmt != null &&
    Number.isFinite(solAmt) &&
    initUsd >= 20 &&
    solAmt >= 0.25 &&
    finalUsd > 0 &&
    finalUsd <= solAmt * 2;

  if (suspiciousUnitMix) {
    log("lessons_warn", `Skipped suspicious performance record for ${perf.pool_name || perf.pool}: initial=${perf.initial_value_usd}, final=${perf.final_value_usd}, amount_sol=${perf.amount_sol}`);
    return;
  }

  const computedPnlUsd =
    initUsd != null && Number.isFinite(initUsd) && finalUsd != null && Number.isFinite(finalUsd)
      ? (finalUsd + Number(perf.fees_earned_usd ?? 0)) - initUsd
      : Number(perf.pnl_usd ?? 0);

  const pnl_pct =
    initUsd != null && Number.isFinite(initUsd) && initUsd > 0
      ? (computedPnlUsd / initUsd) * 100
      : perf.reported_pnl_pct != null && Number.isFinite(Number(perf.reported_pnl_pct))
        ? Number(perf.reported_pnl_pct)
        : perf.pnl_pct != null && Number.isFinite(Number(perf.pnl_pct))
          ? Number(perf.pnl_pct)
          : 0;

  const minutesHeld = Number(perf.minutes_held ?? 0);
  const minutesInRange = Number(perf.minutes_in_range ?? 0);
  const range_efficiency = minutesHeld > 0
    ? (minutesInRange / minutesHeld) * 100
    : 0;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const suspiciousAbsurdClosedPnl =
    Number.isFinite(pnl_pct) &&
    initUsd != null &&
    initUsd >= 20 &&
    pnl_pct <= -90 &&
    !closeReasonText.includes("stop loss");

  if (suspiciousAbsurdClosedPnl) {
    log("lessons_warn", `Skipped absurd closed PnL record for ${perf.pool_name || perf.pool}: pnl_pct=${pnl_pct.toFixed(2)} reason=${perf.close_reason}`);
    return;
  }

  const signalSnapshot = buildSignalSnapshot(perf);
  const entry: PerformanceEntry = {
    position: perf.position || "unknown",
    pool: perf.pool,
    pool_name: perf.pool_name ?? undefined,
    base_mint: perf.base_mint ?? undefined,
    strategy: perf.strategy ?? "bid_ask",
    bin_range: perf.bin_range,
    bin_step: perf.bin_step ?? undefined,
    volatility: perf.volatility ?? undefined,
    fee_tvl_ratio: perf.fee_tvl_ratio ?? undefined,
    organic_score: perf.organic_score ?? undefined,
    amount_sol: perf.amount_sol ?? 0,
    fees_earned_usd: perf.fees_earned_usd ?? null,
    fees_earned_sol: perf.fees_earned_sol ?? null,
    final_value_usd: perf.final_value_usd ?? null,
    initial_value_usd: perf.initial_value_usd ?? null,
    reported_pnl_pct: perf.reported_pnl_pct ?? null,
    minutes_in_range: minutesInRange,
    minutes_held: minutesHeld,
    close_reason: perf.close_reason ?? "unknown",
    signal_snapshot: signalSnapshot,
    entry_mcap: perf.entry_mcap ?? null,
    entry_tvl: perf.entry_tvl ?? null,
    entry_volume: perf.entry_volume ?? null,
    entry_holders: perf.entry_holders ?? null,
    exit_mcap: perf.exit_mcap ?? null,
    exit_tvl: perf.exit_tvl ?? null,
    exit_volume: perf.exit_volume ?? null,
    pnl_usd: Math.round(computedPnlUsd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    recorded_at: new Date().toISOString(),
  };

  data.performance.push(entry);
  save(data);

  // Update pool-level memory
  if (perf.pool) {
    const { recordPoolDeploy } = await import("./pool-memory.js");
    const feeEarnedPct =
      initUsd != null && initUsd > 0
        ? ((perf.fees_earned_usd || 0) / initUsd) * 100
        : solAmt != null && solAmt > 0 && perf.fees_earned_sol != null
          ? ((perf.fees_earned_sol || 0) / solAmt) * 100
          : null;

    recordPoolDeploy(perf.pool, {
      pool_name: perf.pool_name ?? null,
      base_mint: perf.base_mint ?? null,
      deployed_at: perf.deployed_at ?? null,
      closed_at: entry.recorded_at,
      pnl_pct: entry.pnl_pct,
      pnl_usd: entry.pnl_usd,
      range_efficiency: entry.range_efficiency,
      minutes_held: perf.minutes_held ?? null,
      fees_earned_usd: perf.fees_earned_usd ?? null,
      fees_earned_sol: perf.fees_earned_sol ?? null,
      fee_earned_pct: feeEarnedPct,
      close_reason: perf.close_reason ?? null,
      strategy: perf.strategy ?? null,
      volatility: perf.volatility ?? null,
      entry_mcap: perf.entry_mcap ?? null,
      entry_tvl: perf.entry_tvl ?? null,
      entry_volume: perf.entry_volume ?? null,
      exit_mcap: perf.exit_mcap ?? null,
      exit_tvl: perf.exit_tvl ?? null,
      exit_volume: perf.exit_volume ?? null,
    });
  }
}

export interface PerformanceHistoryFilter {
  hours?: number;
  limit?: number;
}

export interface PerformanceHistoryPosition {
  pool_name?: string | null;
  pool: string;
  strategy?: string;
  pnl_usd?: number | null;
  pnl_pct?: number | null;
  fees_earned_usd?: number | null;
  range_efficiency?: number | null;
  minutes_held?: number | null;
  close_reason?: string | null;
  closed_at?: string;
}

export interface PerformanceHistoryResult {
  hours: number;
  count: number;
  total_pnl_usd: number;
  win_rate_pct: number | null;
  positions: PerformanceHistoryPosition[];
}

export function getPerformanceHistory({ hours = 24, limit = 50 }: PerformanceHistoryFilter = {}): PerformanceHistoryResult {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return { positions: [], count: 0, hours, total_pnl_usd: 0, win_rate_pct: null };

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const filtered = p
    .filter((r) => r.recorded_at != null && r.recorded_at >= cutoff)
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
  const wins = filtered.filter((r) => (r.pnl_usd ?? 0) > 0).length;

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    positions: filtered,
  };
}

export interface PerformanceSummaryResult {
  total_positions_closed: number;
  total_pnl_usd: number;
  avg_pnl_pct: number;
  avg_range_efficiency_pct: number;
  win_rate_pct: number;
}

export function getPerformanceSummary(): PerformanceSummaryResult | null {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return null;

  const totalPnl = p.reduce((s, x) => s + (x.pnl_usd ?? 0), 0);
  const avgPnlPct = p.reduce((s, x) => s + (x.pnl_pct ?? 0), 0) / p.length;
  const avgRangeEfficiency = p.reduce((s, x) => s + (x.range_efficiency ?? 0), 0) / p.length;
  const wins = p.filter((x) => (x.pnl_usd ?? 0) > 0).length;

  return {
    total_positions_closed: p.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    avg_pnl_pct: Math.round(avgPnlPct * 100) / 100,
    avg_range_efficiency_pct: Math.round(avgRangeEfficiency * 10) / 10,
    win_rate_pct: Math.round((wins / p.length) * 100),
  };
}
