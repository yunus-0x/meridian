/**
 * Pool memory — persistent deploy history per pool.
 *
 * Keyed by pool address. Automatically updated when positions close
 * (via recordPerformance in performance.js). Agent can query before deploying.
 */

import fs from "node:fs";
import { z } from "zod";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getCachedChronosAnalysis } from "./standalone/chronos.js";
import { repoPath } from "./repo-root.js";
import {
  PoolMemoryDbSchema,
  type PoolMemoryDb,
  type PoolMemoryItem,
  type PoolDeployRecord,
  type PoolNote,
} from "./src/schemas/storage.js";

const POOL_MEMORY_FILE = repoPath("pool-memory.json");
const MAX_NOTE_LENGTH = 280;

function sanitizeStoredNote(text: unknown, maxLen = MAX_NOTE_LENGTH): string | null {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

export function load(): PoolMemoryDb {
  if (!fs.existsSync(POOL_MEMORY_FILE)) return {};
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
    const parsed = PoolMemoryDbSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data;
    }
    log("pool_memory_warn", `Failed to parse pool-memory.json: ${parsed.error.message}`);
    return {};
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log("pool_memory_warn", `Failed to read pool-memory.json: ${msg}`);
    return {};
  }
}

export function save(data: PoolMemoryDb): void {
  const validated = PoolMemoryDbSchema.parse(data);
  const tmpFile = `${POOL_MEMORY_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(validated, null, 2));
  fs.renameSync(tmpFile, POOL_MEMORY_FILE);
}

function isOorCloseReason(reason: unknown): boolean {
  const text = String(reason || "").trim().toLowerCase();
  return text === "oor" || text.includes("out of range") || text.includes("oor");
}

function isAdjustedWinRateExcludedReason(reason: unknown): boolean {
  const text = String(reason || "").trim().toLowerCase();
  return (
    text.includes("out of range") ||
    text.includes("pumped far above range") ||
    text === "oor" ||
    text.includes("oor")
  );
}

function isFeeGeneratingDeploy(deploy: PoolDeployRecord): boolean {
  const minFeeEarnedPct = Number(config.management.repeatDeployCooldownMinFeeEarnedPct ?? 0);
  const feeEarnedPct = Number(deploy.fee_earned_pct ?? 0);
  const feesUsd = Number(deploy.fees_earned_usd ?? 0);
  const feesSol = Number(deploy.fees_earned_sol ?? 0);
  const hasFees = (Number.isFinite(feesUsd) && feesUsd > 0) || (Number.isFinite(feesSol) && feesSol > 0);
  if (!hasFees) return false;
  return Number.isFinite(feeEarnedPct) && feeEarnedPct >= minFeeEarnedPct;
}

function setPoolCooldown(entry: PoolMemoryItem, hours: number, reason: string): string {
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  entry.cooldown_until = cooldownUntil;
  entry.cooldown_reason = reason;
  return cooldownUntil;
}

function setBaseMintCooldown(db: PoolMemoryDb, baseMint: string | null | undefined, hours: number, reason: string): string | null {
  if (!baseMint) return null;
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  for (const entry of Object.values(db)) {
    if (entry?.base_mint === baseMint) {
      entry.base_mint_cooldown_until = cooldownUntil;
      entry.base_mint_cooldown_reason = reason;
    }
  }
  return cooldownUntil;
}

export interface RecordPoolDeployData {
  pool_name?: string | null;
  base_mint?: string | null;
  deployed_at?: string | null;
  closed_at?: string | null;
  pnl_pct?: number | null;
  pnl_usd?: number | null;
  range_efficiency?: number | null;
  minutes_held?: number | null;
  fees_earned_usd?: number | null;
  fees_earned_sol?: number | null;
  fee_earned_pct?: number | null;
  close_reason?: string | null;
  strategy?: string | null;
  volatility?: number | null;
  entry_mcap?: number | null;
  entry_tvl?: number | null;
  entry_volume?: number | null;
  exit_mcap?: number | null;
  exit_tvl?: number | null;
  exit_volume?: number | null;
}

/**
 * Record a closed deploy into pool-memory.json.
 * Called automatically from recordPerformance() in performance.js.
 */
export function recordPoolDeploy(poolAddress: string, deployData: RecordPoolDeployData): void {
  if (!poolAddress) return;

  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: deployData.pool_name || poolAddress.slice(0, 8),
      base_mint: deployData.base_mint || null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
      snapshots: [],
      cooldown_until: null,
      cooldown_reason: null,
      base_mint_cooldown_until: null,
      base_mint_cooldown_reason: null,
    };
  }

  const entry = db[poolAddress];

  const deploy: PoolDeployRecord = {
    deployed_at: deployData.deployed_at || null,
    closed_at: deployData.closed_at || new Date().toISOString(),
    pnl_pct: deployData.pnl_pct ?? null,
    pnl_usd: deployData.pnl_usd ?? null,
    fees_earned_usd: deployData.fees_earned_usd ?? null,
    fees_earned_sol: deployData.fees_earned_sol ?? null,
    fee_earned_pct: deployData.fee_earned_pct ?? null,
    range_efficiency: deployData.range_efficiency ?? null,
    minutes_held: deployData.minutes_held ?? null,
    close_reason: deployData.close_reason || null,
    strategy: deployData.strategy || null,
    volatility_at_deploy: deployData.volatility ?? null,
    entry_mcap: deployData.entry_mcap ?? null,
    entry_tvl: deployData.entry_tvl ?? null,
    entry_volume: deployData.entry_volume ?? null,
    exit_mcap: deployData.exit_mcap ?? null,
    exit_tvl: deployData.exit_tvl ?? null,
    exit_volume: deployData.exit_volume ?? null,
  };

  entry.deploys.push(deploy);
  entry.total_deploys = entry.deploys.length;
  entry.last_deployed_at = deploy.closed_at;
  entry.last_outcome = (deploy.pnl_pct ?? 0) >= 0 ? "profit" : "loss";

  // Recompute aggregates
  const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
  if (withPnl.length > 0) {
    entry.avg_pnl_pct =
      Math.round((withPnl.reduce((s, d) => s + (d.pnl_pct ?? 0), 0) / withPnl.length) * 100) / 100;
    entry.win_rate =
      Math.round((withPnl.filter((d) => (d.pnl_pct ?? 0) >= 0).length / withPnl.length) * 100) / 100;
  }
  const adjusted = withPnl.filter((d) => !isAdjustedWinRateExcludedReason(d.close_reason));
  entry.adjusted_win_rate_sample_count = adjusted.length;
  entry.adjusted_win_rate =
    adjusted.length > 0
      ? Math.round((adjusted.filter((d) => (d.pnl_pct ?? 0) >= 0).length / adjusted.length) * 10000) / 100
      : 0;

  if (deployData.base_mint && !entry.base_mint) {
    entry.base_mint = deployData.base_mint;
  }

  // Set cooldown for low yield / dead capital closes
  if (String(deploy.close_reason || "").trim().toLowerCase().startsWith("low yield")) {
    const cooldownHours = 4;
    const cooldownUntil = setPoolCooldown(entry, cooldownHours, "low yield");
    log("pool-memory", `Cooldown set for ${entry.name} until ${cooldownUntil} (low yield close)`);
  }

  const oorTriggerCount = config.management.oorCooldownTriggerCount ?? 3;
  const oorCooldownHours = config.management.oorCooldownHours ?? 12;
  const recentDeploys = entry.deploys.slice(-oorTriggerCount);
  const repeatedOorCloses =
    recentDeploys.length >= oorTriggerCount &&
    recentDeploys.every((d) => isOorCloseReason(d.close_reason));

  if (repeatedOorCloses) {
    const reason = `repeated OOR closes (${oorTriggerCount}x)`;
    const poolCooldownUntil = setPoolCooldown(entry, oorCooldownHours, reason);
    const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, oorCooldownHours, reason);
    log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
    if (entry.base_mint && mintCooldownUntil) {
      log("pool-memory", `Base mint cooldown set for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
    }
  }

  if (config.management.repeatDeployCooldownEnabled) {
    const triggerCount = Math.max(1, Number(config.management.repeatDeployCooldownTriggerCount ?? 3));
    const cooldownHours = Math.max(0, Number(config.management.repeatDeployCooldownHours ?? 12));
    const rawScope = String(config.management.repeatDeployCooldownScope || "token").toLowerCase();
    const scope = ["pool", "token", "both"].includes(rawScope) ? rawScope : "token";
    const recentRepeatDeploys = entry.deploys.slice(-triggerCount);
    const repeatedFeeGeneratingDeploys =
      cooldownHours > 0 &&
      recentRepeatDeploys.length >= triggerCount &&
      recentRepeatDeploys.every((d) => d.pnl_pct != null && isFeeGeneratingDeploy(d));

    if (repeatedFeeGeneratingDeploys) {
      const reason = `repeat fee-generating deploys (${triggerCount}x)`;
      if (scope === "pool" || scope === "both" || !entry.base_mint) {
        const poolCooldownUntil = setPoolCooldown(entry, cooldownHours, reason);
        log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
      }
      if ((scope === "token" || scope === "both") && entry.base_mint) {
        const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, cooldownHours, reason);
        if (mintCooldownUntil) {
          log("pool-memory", `Base mint cooldown set for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
        }
      }
    }
  }

  save(db);
  log("pool-memory", `Recorded deploy for ${entry.name} (${poolAddress.slice(0, 8)}): PnL ${deploy.pnl_pct}%`);
}

const ChronosBypassSchema = z
  .object({
    gate: z.object({ action: z.string().optional() }).optional(),
    tactical_signals: z.object({ let_winners_run: z.boolean().optional() }).optional(),
    summary: z.object({ model_agreement: z.number().optional() }).optional(),
  })
  .passthrough();

function isRepeatWinnerBypassedByChronos(poolAddress: string, reason?: string | null): boolean {
  if (!String(reason || "").startsWith("repeat fee-generating deploys")) return false;
  const rawCh: unknown = poolAddress ? getCachedChronosAnalysis(poolAddress) : null;
  const parsed = ChronosBypassSchema.safeParse(rawCh);
  if (!parsed.success) return false;
  const ch = parsed.data;
  return Boolean(
    ch.gate?.action === "PASS" &&
    ch.tactical_signals?.let_winners_run === true &&
    Number(ch.summary?.model_agreement ?? 0) >= 0.75
  );
}

export function isPoolOnCooldown(poolAddress: string): boolean {
  if (!poolAddress) return false;
  const db = load();
  const entry = db[poolAddress];
  if (!entry?.cooldown_until) return false;
  if (new Date(entry.cooldown_until) <= new Date()) return false;
  if (isRepeatWinnerBypassedByChronos(poolAddress, entry.cooldown_reason)) return false;
  return true;
}

export function isBaseMintOnCooldown(baseMint: string): boolean {
  if (!baseMint) return false;
  const db = load();
  const now = new Date();
  return Object.entries(db).some(
    ([poolAddr, entry]) =>
      entry?.base_mint === baseMint &&
      entry?.base_mint_cooldown_until &&
      new Date(entry.base_mint_cooldown_until) > now &&
      !isRepeatWinnerBypassedByChronos(poolAddr, entry.base_mint_cooldown_reason)
  );
}

export interface GetPoolMemoryResult {
  error?: string;
  pool_address?: string;
  known?: boolean;
  message?: string;
  name?: string;
  base_mint?: string | null;
  total_deploys?: number;
  avg_pnl_pct?: number;
  win_rate?: number;
  adjusted_win_rate?: number;
  adjusted_win_rate_sample_count?: number;
  last_deployed_at?: string | null;
  last_outcome?: string | null;
  cooldown_until?: string | null;
  cooldown_reason?: string | null;
  base_mint_cooldown_until?: string | null;
  base_mint_cooldown_reason?: string | null;
  notes?: PoolNote[];
  history?: PoolDeployRecord[];
}

/**
 * Tool handler: get_pool_memory
 * Returns deploy history and summary for a pool.
 */
export function getPoolMemory({ pool_address }: { pool_address: string }): GetPoolMemoryResult {
  if (!pool_address) return { error: "pool_address required" };

  const db = load();
  const entry = db[pool_address];

  if (!entry) {
    return {
      pool_address,
      known: false,
      message: "No history for this pool — first time deploying here.",
    };
  }

  return {
    pool_address,
    known: true,
    name: entry.name,
    base_mint: entry.base_mint,
    total_deploys: entry.total_deploys,
    avg_pnl_pct: entry.avg_pnl_pct,
    win_rate: entry.win_rate,
    adjusted_win_rate: entry.adjusted_win_rate ?? 0,
    adjusted_win_rate_sample_count: entry.adjusted_win_rate_sample_count ?? 0,
    last_deployed_at: entry.last_deployed_at,
    last_outcome: entry.last_outcome,
    cooldown_until: entry.cooldown_until || null,
    cooldown_reason: entry.cooldown_reason || null,
    base_mint_cooldown_until: entry.base_mint_cooldown_until || null,
    base_mint_cooldown_reason: entry.base_mint_cooldown_reason || null,
    notes: entry.notes,
    history: entry.deploys.slice(-10),
  };
}

export interface PositionSnapshotInput {
  pair?: string | null;
  position: string;
  pnl_pct?: number | null;
  pnl_usd?: number | null;
  in_range?: boolean | null;
  unclaimed_fees_usd?: number | null;
  minutes_out_of_range?: number | null;
  age_minutes?: number | null;
}

/**
 * Record a live position snapshot during a management cycle.
 * Keeps last 48 snapshots per pool (~4h at 5min intervals).
 */
export function recordPositionSnapshot(poolAddress: string, snapshot: PositionSnapshotInput): void {
  if (!poolAddress) return;
  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: snapshot.pair || poolAddress.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
      snapshots: [],
      cooldown_until: null,
      cooldown_reason: null,
      base_mint_cooldown_until: null,
      base_mint_cooldown_reason: null,
    };
  }

  if (!db[poolAddress].snapshots) db[poolAddress].snapshots = [];

  db[poolAddress].snapshots.push({
    ts: new Date().toISOString(),
    position: snapshot.position,
    pnl_pct: snapshot.pnl_pct ?? null,
    pnl_usd: snapshot.pnl_usd ?? null,
    in_range: snapshot.in_range ?? null,
    unclaimed_fees_usd: snapshot.unclaimed_fees_usd ?? null,
    minutes_out_of_range: snapshot.minutes_out_of_range ?? null,
    age_minutes: snapshot.age_minutes ?? null,
  });

  if (db[poolAddress].snapshots.length > 48) {
    db[poolAddress].snapshots = db[poolAddress].snapshots.slice(-48);
  }

  save(db);
}

/**
 * Recall focused context for a specific pool — used before screening or management.
 */
export function recallForPool(poolAddress: string): string | null {
  if (!poolAddress) return null;
  const db = load();
  const entry = db[poolAddress];
  if (!entry) return null;

  const lines: string[] = [];

  if (entry.total_deploys > 0) {
    lines.push(
      `POOL MEMORY [${entry.name}]: ${entry.total_deploys} past deploy(s), avg PnL ${entry.avg_pnl_pct}%, win rate ${entry.win_rate}%, last outcome: ${entry.last_outcome}`
    );
  }

  if (entry.cooldown_until && new Date(entry.cooldown_until) > new Date()) {
    lines.push(
      `POOL COOLDOWN: active until ${entry.cooldown_until}${entry.cooldown_reason ? ` (${entry.cooldown_reason})` : ""}`
    );
  }

  if (entry.base_mint_cooldown_until && new Date(entry.base_mint_cooldown_until) > new Date()) {
    lines.push(
      `TOKEN COOLDOWN: active until ${entry.base_mint_cooldown_until}${entry.base_mint_cooldown_reason ? ` (${entry.base_mint_cooldown_reason})` : ""}`
    );
  }

  const snaps = (entry.snapshots || []).slice(-6);
  if (snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    if (first && last) {
      const pnlTrend =
        last.pnl_pct != null && first.pnl_pct != null ? (last.pnl_pct - first.pnl_pct).toFixed(2) : null;
      const oorCount = snaps.filter((s) => s.in_range === false).length;
      lines.push(
        `RECENT TREND: PnL drift ${pnlTrend !== null ? (Number(pnlTrend) >= 0 ? "+" : "") + pnlTrend + "%" : "unknown"} over last ${snaps.length} cycles, OOR in ${oorCount}/${snaps.length} cycles`
      );
    }
  }

  if (entry.notes && entry.notes.length > 0) {
    const lastNote = entry.notes[entry.notes.length - 1];
    if (lastNote) {
      const safeNote = sanitizeStoredNote(lastNote.note);
      if (safeNote) lines.push(`NOTE: ${safeNote}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

export interface AddPoolNoteResult {
  saved?: boolean;
  pool_address?: string;
  note?: string;
  error?: string;
}

/**
 * Tool handler: add_pool_note
 * Agent can annotate a pool with a freeform note.
 */
export function addPoolNote({ pool_address, note }: { pool_address: string; note: unknown }): AddPoolNoteResult {
  if (!pool_address) return { error: "pool_address required" };
  const safeNote = sanitizeStoredNote(note);
  if (!safeNote) return { error: "note required" };

  const db = load();

  if (!db[pool_address]) {
    db[pool_address] = {
      name: pool_address.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
      snapshots: [],
      cooldown_until: null,
      cooldown_reason: null,
      base_mint_cooldown_until: null,
      base_mint_cooldown_reason: null,
    };
  }

  db[pool_address].notes.push({
    note: safeNote,
    added_at: new Date().toISOString(),
  });

  save(db);
  log("pool-memory", `Note added to ${pool_address.slice(0, 8)}: ${safeNote}`);
  return { saved: true, pool_address, note: safeNote };
}
