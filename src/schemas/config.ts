import { z } from "zod";
import { SolAddressSchema, PositiveNumberSchema, NonNegativeNumberSchema } from "./common.js";

/**
 * Validates raw user-config.json before application.
 */
export const UserConfigSchema = z.object({
  _readme: z.array(z.string()).optional(),
  shadowMode: z.boolean().default(true),
  walletAddress: SolAddressSchema.or(z.literal("")).default(""),
  walletThreshold: z.number().int().min(1).max(10).default(2),
  walletWindowSec: z.number().int().min(10).max(3600).default(120),
  screeningDeadlineSec: z.number().int().min(10).max(600).default(120),
  screeningRetrySec: z.number().int().min(3).max(120).default(15),
  walletReconcileSec: z.number().int().min(5).max(300).default(30),
  minSmartWalletDepositSol: NonNegativeNumberSchema.default(0.1),
  maxEntryPriceMovePct: PositiveNumberSchema.default(5),
  walletSignalCooldownSec: z.number().int().min(0).default(300),
  maxPendingWalletTransactions: z.number().int().min(10).default(1000),
  walletGroups: z.record(z.string(), z.string()).default({}),

  // Optional RPC overrides
  rpcUrl: z.string().url().or(z.literal("")).optional(),
  monitorRpcUrl: z.string().url().or(z.literal("")).optional(),
  monitorWsUrl: z.string().url().or(z.literal("")).optional(),
  balanceRpcUrl: z.string().url().or(z.literal("")).optional(),
  fallbackRpcUrl: z.string().url().or(z.literal("")).optional(),
  pnlRpcUrl: z.string().url().or(z.literal("")).optional(),
  telegramChatId: z.string().optional(),

  // Risk & Sizing limits
  maxPositions: z.number().int().min(1).max(50).default(3),
  maxDeployAmount: PositiveNumberSchema.default(50),
  deployAmountSol: PositiveNumberSchema.default(0.5),
  minSolToOpen: PositiveNumberSchema.default(0.55),
  gasReserve: NonNegativeNumberSchema.default(0.2),
  positionSizePct: z.number().min(0.01).max(1).default(0.35),

  // Strategy Mapping
  strategy: z.enum(["spot", "curve", "bid_ask"]).default("bid_ask"),
  minBinsBelow: z.number().int().min(35).default(35),
  maxBinsBelow: z.number().int().min(35).default(69),
  defaultBinsBelow: z.number().int().min(35).default(69),
  defaultBinsAbove: z.number().int().min(0).default(0),
  binsBelow: z.number().int().optional(), // Legacy support

  // Screening Filters
  timeframe: z.enum(["5m", "30m", "1h", "2h", "4h", "12h", "24h"]).default("5m"),
  minTvl: NonNegativeNumberSchema.default(10000),
  maxTvl: NonNegativeNumberSchema.default(150000),
  minVolume: NonNegativeNumberSchema.default(500),
  minOrganic: z.number().min(0).max(100).default(60),
  minQuoteOrganic: z.number().min(0).max(100).default(60),
  minHolders: z.number().int().nonnegative().default(500),
  minMcap: NonNegativeNumberSchema.default(150000),
  maxMcap: NonNegativeNumberSchema.default(10000000),
  minBinStep: z.number().int().positive().default(80),
  maxBinStep: z.number().int().positive().default(125),
  minFeeActiveTvlRatio: NonNegativeNumberSchema.default(0.05),
  minTokenFeesSol: NonNegativeNumberSchema.default(30),
  maxBotHoldersPct: z.number().min(0).max(100).default(30),
  maxTop10Pct: z.number().min(0).max(100).default(60),
  allowedLaunchpads: z.array(z.string()).default([]),
  blockedLaunchpads: z.array(z.string()).default([]),
  minTokenAgeHours: NonNegativeNumberSchema.nullable().default(null),
  maxTokenAgeHours: NonNegativeNumberSchema.nullable().default(null),

  // Deterministic Exits
  stopLossPct: z.number().max(0).default(-50),
  knifeRescueStopLossPct: z.number().max(0).default(-15),
  takeProfitPct: PositiveNumberSchema.default(5),
  trailingTakeProfit: z.boolean().default(true),
  trailingTriggerPct: PositiveNumberSchema.default(3),
  trailingDropPct: PositiveNumberSchema.default(1.5),
  outOfRangeBinsToClose: z.number().int().nonnegative().default(10),
  outOfRangeWaitMinutes: z.number().int().nonnegative().default(30),
  outOfRangeAboveWaitMinutes: z.number().int().nonnegative().optional(),
  outOfRangeBelowWaitMinutes: z.number().int().nonnegative().default(240),
  outOfRangeBelowEarlyCutMinutes: z.number().int().nonnegative().default(90),
  oorCooldownTriggerCount: z.number().int().nonnegative().default(3),
  oorCooldownHours: NonNegativeNumberSchema.default(12),
  repeatDeployCooldownEnabled: z.boolean().default(true),
  repeatDeployCooldownTriggerCount: z.number().int().nonnegative().default(3),
  repeatDeployCooldownHours: NonNegativeNumberSchema.default(12),
  repeatDeployCooldownScope: z.enum(["token", "pool", "both"]).default("token"),
  repeatDeployCooldownMinFeeEarnedPct: NonNegativeNumberSchema.default(0),
  minFeePerTvl24h: NonNegativeNumberSchema.default(7),
  minPositionFeeVelocityPctPerHr: NonNegativeNumberSchema.default(0.45),
  minAgeBeforeYieldCheck: z.number().int().nonnegative().default(60),
  minClaimAmount: NonNegativeNumberSchema.default(5),
  autoSwapAfterClaim: z.boolean().default(false),
  autoSwapRetryAttempts: z.number().int().nonnegative().default(3),
  autoSwapRetryDelayMs: z.number().int().nonnegative().default(3000),
  pnlSanityMaxDiffPct: NonNegativeNumberSchema.default(5),
  solMode: z.boolean().default(false),
  managementIntervalMin: z.number().int().positive().default(10),
  pnlSource: z.enum(["meteora", "rpc"]).default("meteora"),
  pnlPollIntervalSec: PositiveNumberSchema.default(3),
  pnlConfirmTicks: z.number().int().positive().default(2),
  pnlDepositCacheTtlSec: z.number().int().positive().default(300),

  // Tactical Forecasting (Chronos)
  chronosEnabled: z.boolean().default(true),
  chronosEndpointUrl: z.string().url().optional(),
  instaboxMachineId: z.string().optional(),
  instaboxApiKey: z.string().optional(),
  instaboxSshToken: z.string().optional(),
  chronosTimeoutMs: z.number().int().positive().default(8000),
  chronosNodes: z
    .array(
      z.object({
        name: z.string(),
        machineId: z.string(),
        endpointUrl: z.string().url(),
      })
    )
    .optional(),

  // Execution & Testing flags
  dryRun: z.boolean().optional(),
  paperTrading: z.boolean().optional(),
  walletKey: z.string().optional(),
});

/**
 * Validates process environment variables (.env).
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  WALLET_PRIVATE_KEY: z.string().min(1, "WALLET_PRIVATE_KEY is required").optional(),
  WALLET_ADDRESS: SolAddressSchema.optional(),
  RPC_URL: z.string().url("RPC_URL must be a valid HTTP/HTTPS URL").optional(),
  MONITOR_RPC_URL: z.string().url().optional(),
  MONITOR_WS_URL: z.string().url().optional(),
  BALANCE_RPC_URL: z.string().url().optional(),
  FALLBACK_RPC_URL: z.string().url().optional(),
  PNL_RPC_URL: z.string().url().optional(),
  PNL_SOURCE: z.enum(["meteora", "rpc"]).default("meteora"),
  DRY_RUN: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((val) => val === "true" || val === "1"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_ALLOWED_USER_IDS: z.string().optional(),
  JUPITER_API_KEY: z.string().optional(),
  JUPITER_REFERRAL_ACCOUNT: SolAddressSchema.optional(),
  JUPITER_REFERRAL_FEE_BPS: z.coerce.number().min(50).max(255).optional(),
  CHRONOS_API_URL: z.string().url().optional(),
  INSTABOX_MACHINE_ID: z.string().optional(),
  INSTABOX_API_KEY: z.string().optional(),
  INSTABOX_SSH_TOKEN: z.string().optional(),
  ENVRYPT_KEY: z.string().min(8).optional(),
  ENVCRYPT_KEY: z.string().min(8).optional(),
});

/**
 * Validates the in-memory runtime configuration object exported by `config.ts`.
 */
export const RuntimeConfigSchema = z.object({
  standalone: z.object({
    shadow: z.boolean(),
    monitorRpcUrl: z.string().nullable(),
    monitorWsUrl: z.string().nullable(),
    balanceRpcUrl: z.string().nullable(),
    fallbackRpcUrl: z.string().nullable(),
    walletAddress: z.string().nullable(),
    walletThreshold: z.number().int(),
    windowSec: z.number().int(),
    screeningDeadlineSec: z.number().int(),
    retrySec: z.number().int(),
    reconcileSec: z.number().int(),
    minDepositSol: z.number(),
    maxPriceMovePct: z.number(),
    cooldownSec: z.number().int(),
    maxPendingTransactions: z.number().int(),
    walletGroups: z.record(z.string(), z.string()),
  }),
  risk: z.object({
    maxPositions: z.number().int(),
    maxDeployAmount: z.number(),
  }),
  screening: z.object({
    timeframe: z.enum(["5m", "30m", "1h", "2h", "4h", "12h", "24h"]),
    minTvl: z.number(),
    maxTvl: z.number(),
    minVolume: z.number(),
    minOrganic: z.number(),
    minQuoteOrganic: z.number(),
    minHolders: z.number().int(),
    minMcap: z.number(),
    maxMcap: z.number(),
    minBinStep: z.number().int(),
    maxBinStep: z.number().int(),
    minFeeActiveTvlRatio: z.number(),
    minTokenFeesSol: z.number(),
    maxBotHoldersPct: z.number(),
    maxTop10Pct: z.number(),
    allowedLaunchpads: z.array(z.string()),
    blockedLaunchpads: z.array(z.string()),
    minTokenAgeHours: z.number().nullable(),
    maxTokenAgeHours: z.number().nullable(),
  }),
  management: z.object({
    deployAmountSol: z.number(),
    minSolToOpen: z.number(),
    gasReserve: z.number(),
    positionSizePct: z.number(),
    stopLossPct: z.number(),
    knifeRescueStopLossPct: z.number(),
    takeProfitPct: z.number(),
    trailingTakeProfit: z.boolean(),
    trailingTriggerPct: z.number(),
    trailingDropPct: z.number(),
    outOfRangeBinsToClose: z.number().int(),
    outOfRangeWaitMinutes: z.number().int(),
    outOfRangeAboveWaitMinutes: z.number().int(),
    outOfRangeBelowWaitMinutes: z.number().int(),
    outOfRangeBelowEarlyCutMinutes: z.number().int(),
    oorCooldownTriggerCount: z.number().int(),
    oorCooldownHours: z.number(),
    repeatDeployCooldownEnabled: z.boolean(),
    repeatDeployCooldownTriggerCount: z.number().int(),
    repeatDeployCooldownHours: z.number(),
    repeatDeployCooldownScope: z.enum(["token", "pool", "both"]),
    repeatDeployCooldownMinFeeEarnedPct: z.number(),
    minFeePerTvl24h: z.number(),
    minPositionFeeVelocityPctPerHr: z.number(),
    minAgeBeforeYieldCheck: z.number().int(),
    minClaimAmount: z.number(),
    autoSwapAfterClaim: z.boolean(),
    autoSwapRetryAttempts: z.number().int(),
    autoSwapRetryDelayMs: z.number().int(),
    pnlSanityMaxDiffPct: z.number(),
    solMode: z.boolean(),
  }),
  strategy: z.object({
    mode: z.enum(["spot", "curve", "bid_ask"]),
    strategy: z.enum(["spot", "curve", "bid_ask"]).default("bid_ask"),
    minBinsBelow: z.number().int(),
    maxBinsBelow: z.number().int(),
    defaultBinsBelow: z.number().int(),
    defaultBinsAbove: z.number().int(),
  }),
  schedule: z.object({
    managementIntervalMin: z.number().int(),
  }),
  tokens: z.object({
    SOL: SolAddressSchema.default("So11111111111111111111111111111111111111112"),
    USDC: SolAddressSchema.default("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    USDT: SolAddressSchema.default("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
    solMint: SolAddressSchema.default("So11111111111111111111111111111111111111112"),
    usdcMint: SolAddressSchema.default("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  }),
  pnl: z.object({
    rpcUrl: z.string(),
    source: z.enum(["meteora", "rpc"]),
    pollIntervalSec: z.number(),
    depositCacheTtlSec: z.number(),
    confirmTicks: z.number().int(),
  }),
  jupiter: z.object({
    apiKey: z.string(),
    referralAccount: z.string(),
    referralFeeBps: z.number(),
  }),
  chronos: z.object({
    enabled: z.boolean(),
    endpointUrl: z.string(),
    instaboxMachineId: z.string(),
    instaboxApiKey: z.string().nullable().optional(),
    instaboxSshToken: z.string(),
    timeoutMs: z.number(),
    nodes: z.array(
      z.object({
        name: z.string(),
        machineId: z.string(),
        endpointUrl: z.string(),
      })
    ),
  }),
});

export const ConfigSchema = RuntimeConfigSchema;
export const ResolvedConfigSchema = RuntimeConfigSchema;

export type UserConfig = z.infer<typeof UserConfigSchema>;
export type EnvConfig = z.infer<typeof EnvSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type Config = RuntimeConfig;
export type ResolvedConfig = RuntimeConfig;
