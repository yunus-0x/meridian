import { z } from "zod";
import { SolAddressSchema, FlexibleNumberSchema } from "./common.js";

export const PositionBinRangeSchema = z.object({
  min: z.number().int().optional().default(0),
  max: z.number().int().optional().default(0),
  bins_below: z.number().int().optional(),
  bins_above: z.number().int().optional(),
  active: z.number().int().optional(),
}).default({ min: 0, max: 0 });

export const TrackedPositionSchema = z.object({
  position: z.string().min(1),
  pool: z.string().min(1),
  pool_name: z.string().optional(),
  base_mint: z.string().optional(),
  strategy: z.string().default("bid_ask"),
  bin_range: PositionBinRangeSchema.default({ min: 0, max: 0 }),
  amount_sol: z.number().default(0),
  amount_x: z.number().default(0),
  active_bin_at_deploy: z.number().int().nullable().default(null),
  bin_step: z.number().int().nullable().optional(),
  volatility: FlexibleNumberSchema,
  fee_tvl_ratio: FlexibleNumberSchema,
  initial_fee_tvl_24h: FlexibleNumberSchema.optional(),
  organic_score: FlexibleNumberSchema,
  initial_value_usd: FlexibleNumberSchema,
  signal_snapshot: z.record(z.string(), z.unknown()).nullable().default(null),
  entry_mcap: FlexibleNumberSchema,
  entry_tvl: FlexibleNumberSchema,
  entry_volume: FlexibleNumberSchema,
  entry_holders: FlexibleNumberSchema,
  deployed_at: z.string().nullable().default(null),
  out_of_range_since: z.string().nullable().default(null),
  last_claim_at: z.string().nullable().default(null),
  total_fees_claimed_usd: z.number().default(0),
  rebalance_count: z.number().default(0),
  closed: z.boolean().default(false),
  closed_at: z.string().nullable().default(null),
  notes: z.array(z.string()).default([]),
  instruction: z.string().nullable().default(null),
  peak_pnl_pct: FlexibleNumberSchema,
  pending_peak_pnl_pct: FlexibleNumberSchema,
  pending_peak_confirm_count: z.number().default(0),
  pending_peak_started_at: z.union([z.string(), z.number()]).nullable().default(null),
  pending_exit_action: z.string().nullable().default(null),
  pending_exit_count: z.number().default(0),
  pending_exit_started_at: z.union([z.string(), z.number()]).nullable().default(null),
  missing_onchain_count: z.number().int().nonnegative().default(0),
  trailing_active: z.boolean().default(false),
}).passthrough();

export const StateEventSchema = z.object({
  ts: z.string(),
  action: z.enum(["deploy", "close", "claim", "rebalance", "note"]).or(z.string()),
  position: z.string().min(1),
  pool_name: z.string().optional(),
  reason: z.string().optional(),
}).passthrough();

export const StateJsonSchema = z.object({
  positions: z.record(z.string(), TrackedPositionSchema).default({}),
  recentEvents: z.array(StateEventSchema).default([]),
  lastUpdated: z.string().nullable().default(null),
  _lastBriefingDate: z.string().nullable().optional(),
}).passthrough();

export const StateSummaryPositionSchema = z.object({
  position: z.string().min(1),
  pool: z.string().min(1),
  strategy: z.string(),
  deployed_at: z.string().nullable(),
  out_of_range_since: z.string().nullable(),
  minutes_out_of_range: z.number().int().nonnegative(),
  total_fees_claimed_usd: z.number(),
  initial_fee_tvl_24h: z.number().nullable().optional(),
  rebalance_count: z.number().int().nonnegative(),
  instruction: z.string().nullable(),
}).passthrough();

export const StateSummarySchema = z.object({
  open_positions: z.number().int().nonnegative(),
  closed_positions: z.number().int().nonnegative(),
  total_fees_claimed_usd: z.number(),
  positions: z.array(StateSummaryPositionSchema),
  last_updated: z.string().nullable(),
  recent_events: z.array(StateEventSchema),
}).passthrough();

// Aliases for compatibility with M2 contracts
export const PositionRecordSchema = TrackedPositionSchema;
export const StateSchema = StateJsonSchema;

export type PositionBinRange = z.infer<typeof PositionBinRangeSchema>;
export type TrackedPosition = z.infer<typeof TrackedPositionSchema>;
export type PositionRecord = TrackedPosition;
export type StateEvent = z.infer<typeof StateEventSchema>;
export type StateJson = z.infer<typeof StateJsonSchema>;
export type State = StateJson;
export type StateSummary = z.infer<typeof StateSummarySchema>;
