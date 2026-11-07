import { z } from "zod";
import { SolAddressSchema, FlexibleNumberSchema } from "./common.js";

// ─── A. Meteora APIs ───────────────────────────────────────────
export const MeteoraTokenWarningSchema = z.object({
  severity: z.string(),
  message: z.string().optional(),
});

export const MeteoraPoolDiscoveryItemSchema = z.object({
  pool_address: SolAddressSchema,
  name: z.string().optional(),
  pool_type: z.string(),
  is_blacklisted: z.boolean(),
  tvl: FlexibleNumberSchema,
  active_tvl: FlexibleNumberSchema,
  volume: FlexibleNumberSchema,
  fee_active_tvl_ratio: FlexibleNumberSchema,
  volatility: FlexibleNumberSchema,
  pool_price: FlexibleNumberSchema,
  token_x: z.object({
    address: SolAddressSchema,
    symbol: z.string().optional(),
    warnings: z.array(MeteoraTokenWarningSchema).optional().default([]),
    organic_score: FlexibleNumberSchema,
  }),
  token_y: z.object({
    address: SolAddressSchema,
    symbol: z.string().optional(),
    warnings: z.array(MeteoraTokenWarningSchema).optional().default([]),
    organic_score: FlexibleNumberSchema,
  }),
  dlmm_params: z
    .object({
      bin_step: z.number().int(),
      base_fee_pct: z.number().optional(),
    })
    .optional(),
});

export const MeteoraPoolDiscoveryResponseSchema = z.object({
  data: z.array(MeteoraPoolDiscoveryItemSchema).optional().default([]),
});

export const MeteoraPortfolioPoolSchema = z.object({
  poolAddress: SolAddressSchema,
  listPositions: z.array(SolAddressSchema).optional().default([]),
  tokenX: z.string().optional(),
  tokenY: z.string().optional(),
  tokenXMint: SolAddressSchema.optional(),
  outOfRange: z.boolean().optional(),
  positionsOutOfRange: z.array(SolAddressSchema).optional().default([]),
});

export const MeteoraPortfolioResponseSchema = z.object({
  pools: z.array(MeteoraPortfolioPoolSchema).optional().default([]),
});

export const MeteoraPositionPnlItemSchema = z.object({
  positionAddress: SolAddressSchema.optional(),
  address: SolAddressSchema.optional(),
  position: SolAddressSchema.optional(),
  lowerBinId: z.number().int().optional(),
  upperBinId: z.number().int().optional(),
  poolActiveBinId: z.number().int().optional(),
  isOutOfRange: z.boolean().optional(),
  pnlPctChange: FlexibleNumberSchema,
  pnlSolPctChange: FlexibleNumberSchema.optional(),
  pnlUsd: FlexibleNumberSchema.optional(),
  pnlSol: FlexibleNumberSchema.optional(),
  feePerTvl24h: FlexibleNumberSchema.optional(),
  createdAt: z.number().optional(),
  tokenX: z.string().optional(),
  tokenY: z.string().optional(),
  pnl: z
    .object({
      value: FlexibleNumberSchema.optional(),
      valueNative: FlexibleNumberSchema.optional(),
      percent: FlexibleNumberSchema.optional(),
      percentNative: FlexibleNumberSchema.optional(),
    })
    .optional(),
  unrealizedPnl: z
    .object({
      balances: FlexibleNumberSchema.optional(),
      balancesSol: FlexibleNumberSchema.optional(),
      unclaimedFeeTokenX: z
        .object({
          usd: FlexibleNumberSchema.optional(),
          amountSol: FlexibleNumberSchema.optional(),
        })
        .optional(),
      unclaimedFeeTokenY: z
        .object({
          usd: FlexibleNumberSchema.optional(),
          amountSol: FlexibleNumberSchema.optional(),
        })
        .optional(),
    })
    .optional(),
  allTimeDeposits: z
    .object({
      total: z
        .object({
          usd: FlexibleNumberSchema.optional(),
          sol: FlexibleNumberSchema.optional(),
        })
        .optional(),
    })
    .optional(),
  allTimeWithdrawals: z
    .object({
      total: z
        .object({
          usd: FlexibleNumberSchema.optional(),
          sol: FlexibleNumberSchema.optional(),
        })
        .optional(),
    })
    .optional(),
  allTimeFees: z
    .object({
      total: z
        .object({
          usd: FlexibleNumberSchema.optional(),
          sol: FlexibleNumberSchema.optional(),
        })
        .optional(),
    })
    .optional(),
}).passthrough();

export const MeteoraPositionsPnlResponseSchema = z.object({
  positions: z.array(MeteoraPositionPnlItemSchema).optional(),
  data: z.array(MeteoraPositionPnlItemSchema).optional(),
}).passthrough();

// ─── B. Jupiter APIs ───────────────────────────────────────────
export const JupiterPriceItemSchema = z.object({
  usdPrice: z.number().positive(),
  price: z.number().positive().optional(),
}).passthrough();

export const JupiterPriceResponseSchema = z.union([
  z.object({
    data: z.record(z.string(), JupiterPriceItemSchema.optional().nullable()),
  }).passthrough(),
  z.record(z.string(), JupiterPriceItemSchema.optional().nullable()),
]);

export const JupiterPriceV3EntrySchema = z.object({
  usdPrice: z.number().positive().optional(),
  price: z.number().positive().optional(),
}).passthrough();

export const JupiterPriceV3ResponseSchema = z.preprocess((val) => {
  if (val && typeof val === "object" && "data" in val) {
    const candidate = (val as Record<string, unknown>)["data"];
    if (candidate && typeof candidate === "object") {
      return candidate;
    }
  }
  return val;
}, z.record(z.string(), JupiterPriceV3EntrySchema.optional().nullable()));

export const JupiterAssetAuditSchema = z.object({
  mintAuthorityDisabled: z.boolean().optional(),
  freezeAuthorityDisabled: z.boolean().optional(),
  topHoldersPercentage: FlexibleNumberSchema,
  botHoldersPercentage: FlexibleNumberSchema,
});

export const JupiterAssetItemSchema = z.object({
  id: SolAddressSchema,
  name: z.string().optional(),
  symbol: z.string().optional(),
  dev: SolAddressSchema.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  holderCount: FlexibleNumberSchema,
  mcap: FlexibleNumberSchema,
  organicScore: FlexibleNumberSchema,
  fees: FlexibleNumberSchema,
  launchpad: z.string().nullable().optional(),
  usdPrice: FlexibleNumberSchema.optional(),
  price: FlexibleNumberSchema.optional(),
  audit: JupiterAssetAuditSchema.optional(),
}).passthrough();

export const JupiterAssetSearchResponseSchema = z.array(JupiterAssetItemSchema);

export const JupiterSwapOrderResponseSchema = z.object({
  transaction: z.string().min(1),
  requestId: z.string().min(1),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  feeBps: z.number().optional(),
  feeMint: z.string().optional().nullable(),
}).passthrough();

export const JupiterSwapExecuteResponseSchema = z.object({
  signature: z.string().optional(),
  status: z.string().optional(),
  error: z.string().optional(),
  code: z.unknown().optional(),
  inputAmountResult: z.union([z.string(), z.number()]).optional().nullable(),
  outputAmountResult: z.union([z.string(), z.number()]).optional().nullable(),
}).passthrough();

// ─── C. GeckoTerminal OHLCV API ────────────────────────────────
export const GeckoCandleTupleSchema = z.tuple([
  z.number(), // 0: timestamp in seconds
  z.number(), // 1: open
  z.number(), // 2: high
  z.number(), // 3: low
  z.number(), // 4: close
  z.number(), // 5: volume
]);

export const GeckoOhlcvResponseSchema = z.object({
  data: z.object({
    attributes: z.object({
      ohlcv_list: z.array(GeckoCandleTupleSchema).min(1),
    }),
  }),
});

// ─── D. Chronos ML API ─────────────────────────────────────────
export const ChronosAnalysisResponseSchema = z.object({
  status: z.string().optional(),
  forecast_quantiles: z.record(z.string(), z.number()).optional(),
  conviction_mult: z.number().min(0.5).max(2.0).optional().default(1.0),
  bins_recommended: z
    .object({
      bins_below: z.number().int().min(22).max(200),
      bins_above: z.number().int().min(0).max(100),
    })
    .optional(),
  strategy: z.enum(["spot", "curve", "bid_ask"]).optional(),
  oor_below_outlook: z
    .enum(["WEAK_STRUCTURAL_BREAKDOWN", "STRONG_REBOUND_PROBABILITY", "NEUTRAL"])
    .optional(),
  knife_rescue_trigger: z.boolean().optional(),
  volume_decay_warning: z.boolean().optional(),
  take_profit_mult: z.number().optional().default(1.0),
  cluster_node: z.string().optional(),
});

// ─── E. Telegram Bot API ───────────────────────────────────────
export const TelegramUserSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  username: z.string().optional(),
});

export const TelegramChatSchema = z.object({
  id: z.union([z.number().int(), z.string()]),
  type: z.string(),
});

export const TelegramMessageSchema = z.object({
  message_id: z.number().int(),
  from: TelegramUserSchema.optional(),
  chat: TelegramChatSchema,
  date: z.number().int(),
  text: z.string().optional(),
});

export const TelegramCallbackQuerySchema = z.object({
  id: z.string(),
  from: TelegramUserSchema,
  message: TelegramMessageSchema.optional(),
  data: z.string().optional(),
});

export const TelegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: TelegramMessageSchema.optional(),
  callback_query: TelegramCallbackQuerySchema.optional(),
});

export const TelegramGetUpdatesResponseSchema = z.object({
  ok: z.boolean(),
  result: z.array(TelegramUpdateSchema).default([]),
});

export const TelegramApiResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().int().optional(),
}).passthrough();

export const TelegramSendMessageResponseSchema = z.object({
  ok: z.boolean(),
  result: TelegramMessageSchema.optional(),
  description: z.string().optional(),
  error_code: z.number().int().optional(),
}).passthrough();

export const TelegramBotCommandSchema = z.object({
  command: z.string().min(1).max(32),
  description: z.string().min(1).max(256),
});

export const TelegramInlineKeyboardButtonSchema = z.object({
  text: z.string(),
  callback_data: z.string().optional(),
  url: z.string().url().optional(),
});

export const TelegramInlineKeyboardMarkupSchema = z.object({
  inline_keyboard: z.array(z.array(TelegramInlineKeyboardButtonSchema)),
});

export const PriceRangeSchema = z.object({
  min: z.number(),
  max: z.number(),
});

export const RangeCoverageSchema = z.object({
  downside_pct: z.union([z.number(), z.string()]).optional().nullable(),
  upside_pct: z.union([z.number(), z.string()]).optional().nullable(),
  width_pct: z.union([z.number(), z.string()]).optional().nullable(),
});

export const NotifyDeployParamsSchema = z.object({
  pair: z.string(),
  amountSol: z.union([z.number(), z.string()]),
  position: z.string().optional().nullable(),
  tx: z.string().optional().nullable(),
  priceRange: PriceRangeSchema.optional().nullable(),
  rangeCoverage: RangeCoverageSchema.optional().nullable(),
  binStep: z.union([z.number(), z.string()]).optional().nullable(),
  baseFee: z.union([z.number(), z.string()]).optional().nullable(),
});

export const NotifyCloseParamsSchema = z.object({
  pair: z.string(),
  pnlUsd: z.union([z.number(), z.string()]).optional().nullable(),
  pnlPct: z.union([z.number(), z.string()]).optional().nullable(),
  solMode: z.boolean().optional().nullable(),
});

export const NotifySwapParamsSchema = z.object({
  inputSymbol: z.string().optional().nullable(),
  outputSymbol: z.string().optional().nullable(),
  amountIn: z.union([z.number(), z.string()]).optional().nullable(),
  amountOut: z.union([z.number(), z.string()]).optional().nullable(),
  tx: z.string().optional().nullable(),
});

// ─── F. Extended Meteora & DLMM Schemas ────────────────────────
export const MeteoraPoolMetadataResponseSchema = z.object({
  address: SolAddressSchema.optional(),
  name: z.string().nullable().optional(),
  token_x: z.object({ symbol: z.string().optional() }).optional(),
  token_y: z.object({ symbol: z.string().optional() }).optional(),
}).passthrough();

export const MeteoraDlmmPoolSearchItemSchema = z.object({
  address: SolAddressSchema,
  token_x: z.object({ address: SolAddressSchema }).optional(),
  token_y: z.object({ address: SolAddressSchema }).optional(),
}).passthrough();

export const MeteoraDlmmPoolSearchResponseSchema = z.object({
  data: z.array(MeteoraDlmmPoolSearchItemSchema).default([]),
});

// ─── G. LPAgent Position Valuation Boundary Schemas ───────────
export const LpAgentPositionSchema = z.object({
  position: z.string().optional(),
  id: z.string().optional(),
  tokenId: z.string().optional(),
  inputValue: FlexibleNumberSchema.optional(),
  inputNative: FlexibleNumberSchema.optional(),
  value: FlexibleNumberSchema.optional(),
  valueNative: FlexibleNumberSchema.optional(),
  unCollectedFee: FlexibleNumberSchema.optional(),
  unCollectedFeeNative: FlexibleNumberSchema.optional(),
}).passthrough();

export const LpAgentPositionsResponseSchema = z.object({
  data: z.array(LpAgentPositionSchema).optional().default([]),
}).passthrough();

// ─── H. Comprehensive Chronos AI Schemas ───────────────────────
export const ChronosGateSchema = z.object({
  action: z.enum(["PASS", "DEFER", "REJECT"]).or(z.string()),
  reason: z.string(),
});

export const ChronosRecommendedBinsSchema = z.object({
  bins_above: z.number().int().nonnegative(),
  bins_below: z.number().int().positive(),
  bin_step: z.number().int().positive(),
});

export const ChronosTacticalSignalsSchema = z.object({
  recommended_strategy: z.enum(["spot", "curve", "bid_ask"]),
  x_ratio_mult: z.number(),
  conviction_mult: z.number(),
  sniper_lock: z.boolean(),
  let_winners_run: z.boolean(),
  micro_oversold_bounce: z.boolean(),
  micro_breakout_hold: z.boolean(),
  volume_decay_warning: z.boolean(),
  knife_rescue_trigger: z.boolean(),
  claim_threshold_mult: z.number(),
  take_profit_mult: z.number(),
  spread_pct: z.number(),
});

export const ChronosSummarySchema = z.object({
  p10_pct: z.number(),
  p50_pct: z.number(),
  p90_pct: z.number(),
  macro_15m_p50_pct: z.number().optional(),
  macro_15m_p90_pct: z.number().optional(),
  micro_1m_p50_pct: z.number().optional(),
  micro_1m_rsi_14: z.number().optional(),
  micro_1m_bb_pct_b: z.number().optional(),
  rsi_14: z.number().optional(),
  bb_pct_b: z.number().optional(),
  poc_price: z.number().optional(),
  price_vs_poc_pct: z.number().optional(),
  model_agreement: z.number().optional(),
  chronos2_p50_pct: z.number().optional(),
}).passthrough();

export const ChronosAnalysisResultSchema = z.object({
  pool_address: z.string(),
  engine: z.string(),
  node: z.string().optional(),
  cluster_node: z.string().optional(),
  latency_ms: z.number().optional(),
  cached: z.boolean().default(false),
  gate: ChronosGateSchema,
  recommended_bins: ChronosRecommendedBinsSchema,
  tactical_signals: ChronosTacticalSignalsSchema,
  oor_below_outlook: z.string(),
  summary: ChronosSummarySchema,
}).passthrough();

// ─── I. Position PnL Domain Report Schemas ─────────────────────
export const PositionPnlReportSchema = z.object({
  position: SolAddressSchema,
  pool: SolAddressSchema,
  pair: z.string(),
  base_mint: SolAddressSchema.nullable(),
  lower_bin: z.number().int().nullable(),
  upper_bin: z.number().int().nullable(),
  active_bin: z.number().int().nullable(),
  in_range: z.boolean(),
  unclaimed_fees_usd: z.number().nullable(),
  unclaimed_fees_true_usd: z.number().nullable(),
  total_value_usd: z.number().nullable(),
  total_value_true_usd: z.number().nullable(),
  collected_fees_usd: z.number().nullable(),
  collected_fees_true_usd: z.number().nullable(),
  pnl_usd: z.number().nullable(),
  pnl_true_usd: z.number().nullable(),
  pnl_pct: z.number().nullable(),
  pnl_pct_derived: z.number().nullable(),
  pnl_pct_diff: z.number().nullable(),
  pnl_pct_suspicious: z.boolean(),
  fee_per_tvl_24h: z.number().nullable(),
  age_minutes: z.number().nullable(),
  minutes_out_of_range: z.number().int().nonnegative(),
  instruction: z.string().nullable(),
});

export const PositionsComputeResultSchema = z.object({
  wallet: z.string().nullable(),
  total_positions: z.number().int().nonnegative(),
  positions: z.array(PositionPnlReportSchema),
  source: z.literal("rpc"),
  error: z.string().optional(),
});

// ─── J. Tool Input Boundary Schemas ───────────────────────────
export const DeployPositionToolArgsSchema = z.object({
  pool_address: SolAddressSchema,
  amount_sol: z.number().positive().optional(),
  amount_x: z.number().nonnegative().optional(),
  amount_y: z.number().positive().optional(),
  strategy: z.enum(["spot", "curve", "bid_ask"]).optional(),
  bins_below: z.number().int().nonnegative().optional(),
  bins_above: z.number().int().nonnegative().optional(),
  downside_pct: z.number().nonnegative().nullable().optional(),
  upside_pct: z.number().nonnegative().nullable().optional(),
  pool_name: z.string().optional(),
  bin_step: z.number().int().positive().nullable().optional(),
  base_fee: z.number().nonnegative().nullable().optional(),
  volatility: z.number().positive().nullable().optional(),
  fee_tvl_ratio: z.number().nonnegative().nullable().optional(),
  organic_score: z.number().nullable().optional(),
  initial_value_usd: z.number().nullable().optional(),
  base_mint: SolAddressSchema.optional(),
  entry_mcap: z.number().nullable().optional(),
  entry_tvl: z.number().nullable().optional(),
  entry_volume: z.number().nullable().optional(),
  entry_holders: z.number().nullable().optional(),
  x_ratio_mult: z.number().nullable().optional(),
  before_submit: z
    .function()
    .args(z.enum(["swap", "lp"]), z.number().optional())
    .returns(z.union([z.promise(z.void()), z.void()]))
    .optional(),
  on_prepared: z
    .function()
    .args(z.string())
    .returns(z.union([z.promise(z.void()), z.void()]))
    .optional(),
}).passthrough();

export const ClaimFeesToolArgsSchema = z.object({
  position_address: SolAddressSchema,
  pool_address: SolAddressSchema.optional(),
}).passthrough();

export const ClosePositionToolArgsSchema = z.object({
  position_address: SolAddressSchema,
  pool_address: SolAddressSchema.optional(),
  reason: z.string().optional(),
  skip_swap: z.boolean().optional(),
}).passthrough();

export const SwapTokenToolArgsSchema = z.object({
  input_mint: z.string().min(1),
  output_mint: z.string().min(1),
  amount: z.number().positive(),
}).passthrough();

export type MeteoraPoolDiscoveryItem = z.infer<typeof MeteoraPoolDiscoveryItemSchema>;
export type MeteoraPoolDiscoveryResponse = z.infer<typeof MeteoraPoolDiscoveryResponseSchema>;
export type MeteoraPortfolioPool = z.infer<typeof MeteoraPortfolioPoolSchema>;
export type MeteoraPortfolioResponse = z.infer<typeof MeteoraPortfolioResponseSchema>;
export type MeteoraPositionPnlItem = z.infer<typeof MeteoraPositionPnlItemSchema>;
export type MeteoraPositionsPnlResponse = z.infer<typeof MeteoraPositionsPnlResponseSchema>;
export type MeteoraPoolMetadataResponse = z.infer<typeof MeteoraPoolMetadataResponseSchema>;
export type MeteoraDlmmPoolSearchItem = z.infer<typeof MeteoraDlmmPoolSearchItemSchema>;
export type MeteoraDlmmPoolSearchResponse = z.infer<typeof MeteoraDlmmPoolSearchResponseSchema>;
export type LpAgentPosition = z.infer<typeof LpAgentPositionSchema>;
export type LpAgentPositionsResponse = z.infer<typeof LpAgentPositionsResponseSchema>;
export type JupiterPriceItem = z.infer<typeof JupiterPriceItemSchema>;
export type JupiterPriceResponse = z.infer<typeof JupiterPriceResponseSchema>;
export type JupiterPriceV3Entry = z.infer<typeof JupiterPriceV3EntrySchema>;
export type JupiterPriceV3Response = z.infer<typeof JupiterPriceV3ResponseSchema>;
export type JupiterAssetAudit = z.infer<typeof JupiterAssetAuditSchema>;
export type JupiterAssetItem = z.infer<typeof JupiterAssetItemSchema>;
export type JupiterAssetSearchResponse = z.infer<typeof JupiterAssetSearchResponseSchema>;
export type JupiterSwapOrderResponse = z.infer<typeof JupiterSwapOrderResponseSchema>;
export type JupiterSwapExecuteResponse = z.infer<typeof JupiterSwapExecuteResponseSchema>;
export type GeckoCandleTuple = z.infer<typeof GeckoCandleTupleSchema>;
export type GeckoOhlcvResponse = z.infer<typeof GeckoOhlcvResponseSchema>;
export type ChronosAnalysisResponse = z.infer<typeof ChronosAnalysisResponseSchema>;
export type ChronosGate = z.infer<typeof ChronosGateSchema>;
export type ChronosRecommendedBins = z.infer<typeof ChronosRecommendedBinsSchema>;
export type ChronosTacticalSignals = z.infer<typeof ChronosTacticalSignalsSchema>;
export type ChronosSummary = z.infer<typeof ChronosSummarySchema>;
export type ChronosAnalysisResult = z.infer<typeof ChronosAnalysisResultSchema>;
export type PositionPnlReport = z.infer<typeof PositionPnlReportSchema>;
export type PositionsComputeResult = z.infer<typeof PositionsComputeResultSchema>;
export type DeployPositionToolArgs = z.infer<typeof DeployPositionToolArgsSchema>;
export type ClaimFeesToolArgs = z.infer<typeof ClaimFeesToolArgsSchema>;
export type ClosePositionToolArgs = z.infer<typeof ClosePositionToolArgsSchema>;
export type SwapTokenToolArgs = z.infer<typeof SwapTokenToolArgsSchema>;
export type TelegramUser = z.infer<typeof TelegramUserSchema>;
export type TelegramChat = z.infer<typeof TelegramChatSchema>;
export type TelegramMessage = z.infer<typeof TelegramMessageSchema>;
export type TelegramCallbackQuery = z.infer<typeof TelegramCallbackQuerySchema>;
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;
export type TelegramGetUpdatesResponse = z.infer<typeof TelegramGetUpdatesResponseSchema>;
export type TelegramApiResponse = z.infer<typeof TelegramApiResponseSchema>;
export type TelegramSendMessageResponse = z.infer<typeof TelegramSendMessageResponseSchema>;
export type TelegramBotCommand = z.infer<typeof TelegramBotCommandSchema>;
export type TelegramInlineKeyboardButton = z.infer<typeof TelegramInlineKeyboardButtonSchema>;
export type TelegramInlineKeyboardMarkup = z.infer<typeof TelegramInlineKeyboardMarkupSchema>;
export type PriceRange = z.infer<typeof PriceRangeSchema>;
export type RangeCoverage = z.infer<typeof RangeCoverageSchema>;
export type NotifyDeployParams = z.infer<typeof NotifyDeployParamsSchema>;
export type NotifyCloseParams = z.infer<typeof NotifyCloseParamsSchema>;
export type NotifySwapParams = z.infer<typeof NotifySwapParamsSchema>;
