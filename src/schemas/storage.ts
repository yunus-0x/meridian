import { z } from "zod";
import { SolAddressSchema, FlexibleNumberSchema } from "./common.js";
import { PositionBinRangeSchema } from "./state.js";

// ─── 1. Smart Wallets Watchlist (smart-wallets.json) ────────────
export const SmartWalletItemSchema = z.object({
  name: z.string().min(1),
  address: SolAddressSchema,
  category: z.string().default("alpha"),
  type: z.enum(["lp", "trader"]).default("lp"),
  addedAt: z.string(),
});
export const SmartWalletSchema = SmartWalletItemSchema;
export type SmartWallet = z.infer<typeof SmartWalletSchema>;

export const SmartWalletsFileSchema = z.object({
  wallets: z.array(SmartWalletItemSchema).default([]),
});
export const SmartWalletsDbSchema = SmartWalletsFileSchema;
export type SmartWalletsFile = z.infer<typeof SmartWalletsFileSchema>;
export type SmartWalletsDb = SmartWalletsFile;

// ─── 2. Token Blacklist (token-blacklist.json) ───────────────────
export const TokenBlacklistEntrySchema = z.object({
  symbol: z.string().default("UNKNOWN"),
  reason: z.string().default("no reason provided"),
  added_at: z.string(),
  added_by: z.string().default("agent"),
});
export const BlacklistEntrySchema = TokenBlacklistEntrySchema;
export type BlacklistEntry = z.infer<typeof BlacklistEntrySchema>;
export type TokenBlacklistEntry = BlacklistEntry;

export const TokenBlacklistFileSchema = z.record(SolAddressSchema, TokenBlacklistEntrySchema);
export const BlacklistDbSchema = z.record(z.string(), BlacklistEntrySchema);
export type TokenBlacklistFile = z.infer<typeof TokenBlacklistFileSchema>;
export type BlacklistDb = z.infer<typeof BlacklistDbSchema>;

// ─── 3. Dev / Deployer Blocklist (dev-blocklist.json) ───────────
export const DevBlocklistEntrySchema = z.object({
  label: z.string().default("unknown"),
  reason: z.string().default("no reason provided"),
  added_at: z.string(),
});
export const BlockedDevEntrySchema = DevBlocklistEntrySchema;
export type BlockedDevEntry = z.infer<typeof BlockedDevEntrySchema>;
export type DevBlocklistEntry = BlockedDevEntry;

export const DevBlocklistFileSchema = z.record(z.string(), DevBlocklistEntrySchema);
export const DevBlocklistDbSchema = DevBlocklistFileSchema;
export type DevBlocklistFile = z.infer<typeof DevBlocklistFileSchema>;
export type DevBlocklistDb = DevBlocklistFile;

// ─── 4. Decision Log (decision-log.json) ────────────────────────
export const DecisionLogEntrySchema = z.object({
  id: z.string(),
  ts: z.string(),
  type: z.string(),
  actor: z.string(),
  pool: z.string().nullable(),
  pool_name: z.string().nullable(),
  position: z.string().nullable(),
  summary: z.string().nullable(),
  reason: z.string().nullable(),
  risks: z.array(z.string()).default([]),
  metrics: z.record(z.string(), z.unknown()).default({}),
  rejected: z.array(z.string()).default([]),
});
export const DecisionRecordSchema = DecisionLogEntrySchema;
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const DecisionLogFileSchema = z.object({
  decisions: z.array(DecisionLogEntrySchema).default([]),
});
export const DecisionLogDbSchema = DecisionLogFileSchema;
export type DecisionLogFile = z.infer<typeof DecisionLogFileSchema>;
export type DecisionLogDb = DecisionLogFile;

// ─── 5. Pool Memory & Deploy History (pool-memory.json) ─────────
export const PoolNoteSchema = z.object({
  note: z.string(),
  added_at: z.string(),
}).passthrough();
export type PoolNote = z.infer<typeof PoolNoteSchema>;

export const PoolDeploySnapshotSchema = z.object({
  ts: z.string(),
  position: z.string(),
  pnl_pct: z.number().nullable().optional(),
  pnl_usd: z.number().nullable().optional(),
  in_range: z.boolean().nullable().optional(),
  unclaimed_fees_usd: z.number().nullable().optional(),
  minutes_out_of_range: z.number().int().nonnegative().nullable().optional(),
  age_minutes: z.number().int().nonnegative().nullable().optional(),
}).passthrough();

export const PoolDeployRecordSchema = z.object({
  deployed_at: z.string().nullable().default(null),
  closed_at: z.string().nullable().default(null),
  pnl_pct: z.number().nullable().default(null),
  pnl_usd: z.number().nullable().default(null),
  fees_earned_usd: z.number().nullable().default(null),
  fees_earned_sol: z.number().nullable().default(null),
  fee_earned_pct: z.number().nullable().default(null),
  range_efficiency: z.number().nullable().default(null),
  minutes_held: z.number().int().nonnegative().nullable().default(null),
  close_reason: z.string().nullable().default(null),
  strategy: z.string().nullable().default(null),
  volatility_at_deploy: z.number().nullable().default(null),
  entry_mcap: z.number().nullable().default(null),
  entry_tvl: z.number().nullable().default(null),
  entry_volume: z.number().nullable().default(null),
  exit_mcap: z.number().nullable().default(null),
  exit_tvl: z.number().nullable().default(null),
  exit_volume: z.number().nullable().default(null),
}).passthrough();

export const PoolMemoryItemSchema = z.object({
  name: z.string(),
  base_mint: z.string().nullable().default(null),
  deploys: z.array(PoolDeployRecordSchema).default([]),
  total_deploys: z.number().int().nonnegative().default(0),
  avg_pnl_pct: z.number().default(0),
  win_rate: z.number().min(0).max(100).default(0),
  adjusted_win_rate: z.number().min(0).max(100).default(0),
  adjusted_win_rate_sample_count: z.number().int().nonnegative().default(0),
  last_deployed_at: z.string().nullable().default(null),
  last_outcome: z.string().nullable().default(null),
  notes: z.array(PoolNoteSchema).default([]),
  snapshots: z.array(PoolDeploySnapshotSchema).default([]),
  cooldown_until: z.string().nullable().default(null),
  cooldown_reason: z.string().nullable().default(null),
  base_mint_cooldown_until: z.string().nullable().default(null),
  base_mint_cooldown_reason: z.string().nullable().default(null),
}).passthrough();

export const PoolMemoryFileSchema = z.record(z.string(), PoolMemoryItemSchema);
export const PoolMemoryDbSchema = PoolMemoryFileSchema;

// ─── 6. Performance & Closed Trades (lessons.json) ──────────────
export const LessonSchema = z.object({
  id: z.string().optional(),
  created_at: z.string().optional(),
  category: z.string().optional(),
  lesson: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const PerformanceEntrySchema = z.object({
  position: z.string().min(1),
  pool: z.string().min(1),
  pool_name: z.string().nullable().optional(),
  base_mint: z.string().nullable().optional(),
  strategy: z.string().optional().default("bid_ask"),
  bin_range: PositionBinRangeSchema.optional(),
  bin_step: z.number().int().nullable().optional(),
  volatility: z.number().nullable().optional(),
  fee_tvl_ratio: z.number().nullable().optional(),
  organic_score: z.number().nullable().optional(),
  amount_sol: z.number().optional().default(0),
  fees_earned_usd: z.number().nullable().optional(),
  fees_earned_sol: z.number().nullable().optional(),
  fee_earned_pct: z.number().nullable().optional(),
  final_value_usd: z.number().nullable().optional(),
  initial_value_usd: z.number().nullable().optional(),
  reported_pnl_pct: z.number().nullable().optional(),
  minutes_in_range: z.number().int().nonnegative().optional().default(0),
  minutes_held: z.number().int().nonnegative().optional().default(0),
  close_reason: z.string().optional().default("unknown"),
  signal_snapshot: z.record(z.string(), z.unknown()).nullable().optional(),
  entry_mcap: z.number().nullable().optional(),
  entry_tvl: z.number().nullable().optional(),
  entry_volume: z.number().nullable().optional(),
  entry_holders: z.number().nullable().optional(),
  exit_mcap: z.number().nullable().optional(),
  exit_tvl: z.number().nullable().optional(),
  exit_volume: z.number().nullable().optional(),
  pnl_usd: z.number().nullable().optional(),
  pnl_pct: z.number().nullable().optional(),
  range_efficiency: z.number().nullable().optional(),
  recorded_at: z.string().optional(),
}).passthrough();

export const LessonsFileSchema = z.object({
  lessons: z.array(LessonSchema).default([]),
  performance: z.array(PerformanceEntrySchema).default([]),
}).passthrough();

// ─── 7. Wallet Monitor State (wallet-monitor-state.json) ────────
export const MonitorWalletStateSchema = z.object({
  baselineSlot: z.number().int().nonnegative(),
  cursor: z.string().nullable().default(null),
  baselinePools: z.array(z.string()).default([]),
  reconciledAt: z.number().nonnegative().default(0),
  error: z.string().nullable().optional().default(null),
}).passthrough();

export const MonitorPendingTxSchema = z.object({
  wallet: z.string(),
  signature: z.string(),
  slot: z.number().int().nonnegative(),
  queuedAt: z.number().nonnegative(),
  retryAt: z.number().nonnegative().default(0),
  failures: z.number().int().nonnegative().default(0),
}).passthrough();

export const MonitorEventSchema = z.object({
  id: z.string(),
  wallet: z.string(),
  mint: z.string(),
  depositSol: z.number().nonnegative(),
  at: z.number().nonnegative(),
  signature: z.string().optional(),
  position: z.string().optional(),
  pool: z.string().optional(),
  slot: z.number().int().nonnegative().optional(),
  shares: z.string().optional(),
  binsBelow: z.number().int().optional(),
  binsAbove: z.number().int().optional(),
}).passthrough();

export const MonitorSignalSchema = z.object({
  mint: z.string(),
  createdAt: z.number().nonnegative(),
  deadline: z.number().nonnegative(),
  nextCheck: z.number().nonnegative().default(0),
  events: z.array(MonitorEventSchema).default([]),
  done: z.boolean().default(false),
  reason: z.string().optional(),
  closedAt: z.number().nonnegative().optional(),
  cooldownUntil: z.number().nonnegative().optional(),
}).passthrough();

export const MonitorAttemptSchema = z.object({
  at: z.number().nonnegative(),
  status: z.string(), // "submitting" | "proposed" | "entered" | "failed" | string
  mint: z.string().optional(),
  pool: z.string().optional(),
  wallets: z.array(z.string()).optional(),
  failures: z.number().int().nonnegative().optional().default(0),
  position: z.string().nullable().optional(),
  txs: z.array(z.string()).optional().default([]),
  amountSol: z.number().optional(),
  error: z.string().optional(),
  note: z.string().optional(),
  reason: z.string().optional(),
  poolAddress: z.string().optional(),
  positionAddress: z.string().optional(),
}).passthrough();

export const MonitorStateSchema = z.object({
  version: z.literal(1).default(1),
  wallets: z.record(z.string(), MonitorWalletStateSchema).default({}),
  pending: z.record(z.string(), MonitorPendingTxSchema).default({}),
  seen: z.record(z.string(), z.number()).default({}),
  events: z.array(MonitorEventSchema).default([]),
  signals: z.record(z.string(), MonitorSignalSchema).default({}),
  attempts: z.record(z.string(), MonitorAttemptSchema).default({}),
  paused: z.boolean().default(false),
}).passthrough();

export type PoolDeploySnapshot = z.infer<typeof PoolDeploySnapshotSchema>;
export type PoolDeployRecord = z.infer<typeof PoolDeployRecordSchema>;
export type PoolMemoryItem = z.infer<typeof PoolMemoryItemSchema>;
export type PoolMemoryFile = z.infer<typeof PoolMemoryFileSchema>;
export type PoolMemoryDb = z.infer<typeof PoolMemoryDbSchema>;
export type Lesson = z.infer<typeof LessonSchema>;
export type PerformanceEntry = z.infer<typeof PerformanceEntrySchema>;
export type LessonsFile = z.infer<typeof LessonsFileSchema>;
export type MonitorWalletState = z.infer<typeof MonitorWalletStateSchema>;
export type MonitorPendingTx = z.infer<typeof MonitorPendingTxSchema>;
export type MonitorEvent = z.infer<typeof MonitorEventSchema>;
export type MonitorSignal = z.infer<typeof MonitorSignalSchema>;
export type MonitorAttempt = z.infer<typeof MonitorAttemptSchema>;
export type MonitorState = z.infer<typeof MonitorStateSchema>;
