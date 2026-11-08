// tools/dlmm.ts — Strict TypeScript Meteora DLMM SDK Execution & Position Engine
// Oracle Engineering Standards: Zero any, Zero unsafe assertions, Domain Purity, DRY z.infer schemas.

import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  type AccountInfo,
  type Transaction,
} from "@solana/web3.js";
import type { StrategyType as StrategyTypeEnum, PositionInfo, LbPosition } from "@meteora-ag/dlmm";
import type { Decimal } from "decimal.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config, computeDeployAmount, MIN_SAFE_BINS_BELOW, scaleBinsForBinStep } from "../config.js";
import { log } from "../logger.js";
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  recordClaim,
  recordClose,
  getTrackedPosition,
  isPostClaimSettling,
  minutesOutOfRange,
  syncOpenPositions,
} from "../state.js";
import type { TrackedPosition } from "../src/schemas/state.js";
import { recordPerformance } from "../performance.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { normalizeMint, swapToken, getWalletBalances } from "./wallet.js";
import { appendDecision } from "../decision-log.js";
import { computePositions, fetchDlmmPnlForPool } from "./pnl.js";
import {
  MeteoraPoolMetadataResponseSchema,
  MeteoraPortfolioResponseSchema,
  MeteoraPositionsPnlResponseSchema,
  MeteoraPoolDiscoveryResponseSchema,
  type MeteoraPositionPnlItem,
  type PositionPnlReport,
  type DeployPositionToolArgs,
} from "../src/schemas/api.js";

// ─── Domain & Result Interfaces ────────────────────────────────────────────

export interface DlmmPool {
  pubkey?: PublicKey;
  lbPair: {
    publicKey: PublicKey;
    tokenXMint: PublicKey | string;
    tokenYMint: PublicKey | string;
    binStep: number;
    activeId?: number;
    parameters?: { baseFactor?: number };
  };
  getActiveBin(): Promise<{ binId: number; price: { toString(): string } | number | string }>;
  fromPricePerLamport(price: number): number;
  toPricePerLamport?(price: number): number;
  refetchStates?(): Promise<void>;
  createExtendedEmptyPosition(
    minBinId: number,
    maxBinId: number,
    newPosition: PublicKey,
    wallet: PublicKey
  ): Promise<Transaction | Transaction[]>;
  addLiquidityByStrategyChunkable(params: {
    positionPubKey: PublicKey;
    user: PublicKey;
    totalXAmount: BN;
    totalYAmount: BN;
    strategy: { minBinId: number; maxBinId: number; strategyType: unknown };
    slippage: number;
  }): Promise<Transaction | Transaction[]>;
  initializePositionAndAddLiquidityByStrategy(params: {
    positionPubKey: PublicKey;
    user: PublicKey;
    totalXAmount: BN;
    totalYAmount: BN;
    strategy: { maxBinId: number; minBinId: number; strategyType: unknown };
    slippage: number;
  }): Promise<Transaction>;
  getPosition(positionPubKey: PublicKey): Promise<{
    positionData?: {
      lowerBinId?: number;
      upperBinId?: number;
      positionBinData?: Array<{ positionLiquidity?: string | number | null }>;
    };
  } | null>;
  claimSwapFee(params: { owner: PublicKey; position: unknown }): Promise<Transaction | Transaction[]>;
  removeLiquidity(params: {
    user: PublicKey;
    position: PublicKey;
    fromBinId: number;
    toBinId: number;
    bps: BN;
    shouldClaimAndClose: boolean;
  }): Promise<Transaction | Transaction[]>;
  closePosition(params: {
    owner: PublicKey;
    position: { publicKey: PublicKey };
  }): Promise<Transaction>;
}

export interface DlmmSdkModule {
  DLMM: {
    create(connection: Connection, poolPubkey: PublicKey, opt?: unknown): Promise<DlmmPool>;
    getAllLbPairPositionsByUser?(connection: Connection, userPubkey: PublicKey): Promise<Map<string, PositionInfo>>;
    getBinIdFromPrice?: (price: string | number | Decimal, binStep: number, isLower?: boolean) => number;
  };
  StrategyType: typeof StrategyTypeEnum;
  getBinIdFromPrice?: (price: string | number | Decimal, binStep: number, isLower?: boolean) => number;
  getPriceOfBinByBinId: (binId: number, binStep: number) => Decimal | BN | number | string;
  getBinArrayKeysCoverage: (lowerBinId: BN, upperBinId: BN, poolPubkey: PublicKey, programId: PublicKey) => PublicKey[];
  getBinArrayIndexesCoverage: (lowerBinId: BN, upperBinId: BN) => BN[];
  deriveBinArrayBitmapExtension?: (poolPubkey: PublicKey, programId: PublicKey) => [PublicKey, number];
  isOverflowDefaultBinArrayBitmap?: (binArrayIndex: BN) => boolean;
  BIN_ARRAY_FEE?: number;
  BIN_ARRAY_BITMAP_FEE?: number;
}

export interface ActiveBinResult {
  binId: number;
  price: number;
  pricePerLamport: string;
}

export interface RangeCoverageMetrics {
  downside_pct: number | null;
  upside_pct: number | null;
  width_pct: number | null;
  active_price: number;
}

export interface DeployPositionDryRunResult {
  dry_run: true;
  would_deploy: {
    pool_address: string;
    strategy: string;
    bins_below: number;
    bins_above: number;
    downside_pct: number | null;
    upside_pct: number | null;
    amount_x: number;
    amount_y: number;
    wide_range: boolean;
  };
  message: string;
}

export interface DeployPositionSuccessResult {
  success: true;
  position: string;
  pool: string;
  pool_name?: string;
  bin_range: { min: number; max: number; active: number };
  price_range: { min: number; max: number };
  range_coverage: RangeCoverageMetrics;
  bin_step: number;
  base_fee: number | null;
  strategy: string;
  wide_range: boolean;
  amount_x: number;
  amount_y: number;
  txs: string[];
}

export interface DeployPositionFailureResult {
  success: false;
  error: string;
  txs?: string[];
}

export type DeployPositionResult =
  | DeployPositionDryRunResult
  | DeployPositionSuccessResult
  | DeployPositionFailureResult;

export interface PositionPnlSuccessResult {
  pnl_usd: number;
  pnl_pct: number;
  current_value_usd: number;
  unclaimed_fee_usd: number;
  all_time_fees_usd: number;
  fee_per_tvl_24h: number;
  in_range: boolean;
  lower_bin: number | null;
  upper_bin: number | null;
  active_bin: number | null;
  age_minutes: number | null;
}

export interface PositionPnlErrorResult {
  error: string;
}

export type PositionPnlResult = PositionPnlSuccessResult | PositionPnlErrorResult;

export type PositionDetailItem = PositionPnlReport;

export interface PositionsPayload {
  wallet: string | null;
  total_positions: number;
  positions: PositionDetailItem[];
  source?: "meteora" | "rpc";
  error?: string;
}

export interface GetMyPositionsOptions {
  force?: boolean;
  silent?: boolean;
  wallet_address?: string | null;
  skip_sync?: boolean;
}

export type ClaimFeesResult =
  | { dry_run: true; would_claim: string; message: string }
  | { success: true; position: string; pool: string; txs: string[]; base_mint: string }
  | { success: false; error: string };

export type ClosePositionResult =
  | { dry_run: true; would_close: string; message: string }
  | {
      success: true;
      position: string;
      pool: string;
      pool_name: string | null;
      claim_txs: string[];
      close_txs: string[];
      txs: string[];
      pnl_usd?: number;
      pnl_true_usd?: number;
      pnl_sol?: number;
      pnl_pct?: number;
      base_mint?: string;
      auto_swapped?: boolean;
      auto_swap_note?: string;
      sol_received?: number;
    }
  | {
      success: false;
      error: string;
      position?: string;
      pool?: string;
      claim_txs?: string[];
      close_txs?: string[];
      txs?: string[];
    };

export interface PoolMetadata {
  address: string;
  name: string | null;
  token_x_symbol: string | null;
  token_y_symbol: string | null;
}

// ─── Lazy SDK Loader ───────────────────────────────────────────────────────

let _cachedDlmmModule: DlmmSdkModule | null = null;

function isObjectRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null;
}

function isDlmmClass(val: unknown): val is DlmmSdkModule["DLMM"] {
  return typeof val === "function" && "create" in val;
}

function isStrategyTypeEnum(val: unknown): val is typeof StrategyTypeEnum {
  return typeof val === "object" && val !== null && "Spot" in val && "Curve" in val && "BidAsk" in val;
}

function isPriceFn(val: unknown): val is DlmmSdkModule["getPriceOfBinByBinId"] {
  return typeof val === "function";
}

function isKeysCoverageFn(val: unknown): val is DlmmSdkModule["getBinArrayKeysCoverage"] {
  return typeof val === "function";
}

function isIndexesCoverageFn(val: unknown): val is DlmmSdkModule["getBinArrayIndexesCoverage"] {
  return typeof val === "function";
}

function isDeriveBitmapFn(val: unknown): val is NonNullable<DlmmSdkModule["deriveBinArrayBitmapExtension"]> {
  return typeof val === "function";
}

function isOverflowFn(val: unknown): val is NonNullable<DlmmSdkModule["isOverflowDefaultBinArrayBitmap"]> {
  return typeof val === "function";
}

function isGetBinIdFn(val: unknown): val is NonNullable<DlmmSdkModule["getBinIdFromPrice"]> {
  return typeof val === "function";
}

async function getDLMM(): Promise<DlmmSdkModule> {
  if (!_cachedDlmmModule) {
    const rawImport: unknown = await import("@meteora-ag/dlmm");
    if (!isObjectRecord(rawImport)) {
      throw new Error("Failed to load DLMM SDK: import is not an object");
    }

    const defaultExport = rawImport["default"];
    const m = isObjectRecord(defaultExport) ? defaultExport : rawImport;

    const dlmmCandidate: unknown = typeof defaultExport === "function" ? defaultExport : (rawImport["DLMM"] ?? defaultExport);
    if (!isDlmmClass(dlmmCandidate)) {
      throw new Error("Failed to load DLMM SDK: DLMM class constructor not found");
    }

    const strategyTypeCandidate: unknown = rawImport["StrategyType"] ?? m["StrategyType"];
    if (!isStrategyTypeEnum(strategyTypeCandidate)) {
      throw new Error("Failed to load DLMM SDK: StrategyType enum not found");
    }

    const getPriceFn: unknown = rawImport["getPriceOfBinByBinId"] ?? m["getPriceOfBinByBinId"];
    const getKeysCoverageFn: unknown = rawImport["getBinArrayKeysCoverage"] ?? m["getBinArrayKeysCoverage"];
    const getIndexesCoverageFn: unknown = rawImport["getBinArrayIndexesCoverage"] ?? m["getBinArrayIndexesCoverage"];

    if (
      !isPriceFn(getPriceFn) ||
      !isKeysCoverageFn(getKeysCoverageFn) ||
      !isIndexesCoverageFn(getIndexesCoverageFn)
    ) {
      throw new Error("Failed to load DLMM SDK: coverage or price calculation helpers missing");
    }

    const deriveBitmapFn: unknown = rawImport["deriveBinArrayBitmapExtension"] ?? m["deriveBinArrayBitmapExtension"];
    const isOverflowFnVal: unknown = rawImport["isOverflowDefaultBinArrayBitmap"] ?? m["isOverflowDefaultBinArrayBitmap"];
    const getBinIdFnCandidate: unknown = rawImport["getBinIdFromPrice"] ?? ("getBinIdFromPrice" in dlmmCandidate ? dlmmCandidate.getBinIdFromPrice : undefined);

    const binArrayFee = typeof rawImport["BIN_ARRAY_FEE"] === "number" ? rawImport["BIN_ARRAY_FEE"] : typeof m["BIN_ARRAY_FEE"] === "number" ? m["BIN_ARRAY_FEE"] : undefined;
    const bitmapFee = typeof rawImport["BIN_ARRAY_BITMAP_FEE"] === "number" ? rawImport["BIN_ARRAY_BITMAP_FEE"] : typeof m["BIN_ARRAY_BITMAP_FEE"] === "number" ? m["BIN_ARRAY_BITMAP_FEE"] : undefined;

    _cachedDlmmModule = {
      DLMM: dlmmCandidate,
      StrategyType: strategyTypeCandidate,
      getBinIdFromPrice: isGetBinIdFn(getBinIdFnCandidate) ? getBinIdFnCandidate : undefined,
      getPriceOfBinByBinId: getPriceFn,
      getBinArrayKeysCoverage: getKeysCoverageFn,
      getBinArrayIndexesCoverage: getIndexesCoverageFn,
      deriveBinArrayBitmapExtension: isDeriveBitmapFn(deriveBitmapFn) ? deriveBitmapFn : undefined,
      isOverflowDefaultBinArrayBitmap: isOverflowFn(isOverflowFnVal) ? isOverflowFnVal : undefined,
      BIN_ARRAY_FEE: binArrayFee,
      BIN_ARRAY_BITMAP_FEE: bitmapFee,
    };
  }
  return _cachedDlmmModule;
}

// ─── Lazy Wallet/Connection Init ───────────────────────────────────────────

let _connection: Connection | null = null;
let _connectionUrl: string | null = null;
let _wallet: Keypair | null = null;
let _walletSecret: string | null = null;
let _positionsCache: PositionsPayload | null = null;
let _positionsCacheAt = 0;
let _positionsInflight: Promise<PositionsPayload> | null = null;

export function resetDlmmWalletCache(): void {
  _wallet = null;
  _walletSecret = null;
  _connection = null;
  _connectionUrl = null;
  _positionsCacheAt = 0;
  _positionsCache = null;
  _positionsInflight = null;
}

function getConnection(): Connection {
  const url = process.env.RPC_URL;
  if (!url) {
    throw new Error("RPC_URL environment variable is not configured");
  }
  if (!_connection || _connectionUrl !== url) {
    _connection = new Connection(url, "confirmed");
    _connectionUrl = url;
  }
  return _connection;
}

function getWallet(): Keypair {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) {
    throw new Error("WALLET_PRIVATE_KEY not set");
  }
  if (!_wallet || _walletSecret !== raw) {
    const text = String(raw).trim();
    const bytes = text.startsWith("[")
      ? Uint8Array.from(JSON.parse(text) as number[])
      : bs58.decode(text);
    _wallet = Keypair.fromSecretKey(bytes);
    _walletSecret = raw;
    log("init", `Wallet: ${_wallet.publicKey.toString()}`);
  }
  return _wallet;
}

function getDlmmProgramId(): PublicKey {
  return new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
}

function formatSolFee(value: unknown): string {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : "unknown";
}

function safeNum(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function maybeNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function roundNum(value: unknown, decimals = 4): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

// ─── Bin Array Initialization Guard ────────────────────────────────────────

async function assertRangeDoesNotRequireBinArrayInitialization(
  pool: DlmmPool,
  minBinId: number,
  maxBinId: number
): Promise<void> {
  const {
    getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE,
  } = await getDLMM();

  const programId = getDlmmProgramId();
  const poolPubkey = pool.pubkey ?? pool.lbPair.publicKey;
  const lower = new BN(Math.min(minBinId, maxBinId));
  const upper = new BN(Math.max(minBinId, maxBinId));
  const indexes = getBinArrayIndexesCoverage(lower, upper);
  const keys = getBinArrayKeysCoverage(lower, upper, poolPubkey, programId);
  const accounts = await getConnection().getMultipleAccountsInfo(keys, "confirmed");

  interface MissingItem {
    index: string;
    address: string;
  }

  const missing: MissingItem[] = [];
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const key = keys[i];
    const idx = indexes[i];
    if (!acc && key) {
      missing.push({
        index: idx ? idx.toString() : String(i),
        address: key.toString(),
      });
    }
  }

  if (missing.length > 0) {
    const totalFee = missing.length * Number(BIN_ARRAY_FEE ?? 0.07143744);
    const sample = missing
      .slice(0, 3)
      .map((entry) => `${entry.index}:${entry.address.slice(0, 8)}`)
      .join(", ");
    throw new Error(
      `Deploy skipped: selected range requires ${missing.length} missing Meteora bin-array initialization(s) ` +
        `(~${formatSolFee(totalFee)} SOL non-refundable pool rent; ${formatSolFee(BIN_ARRAY_FEE ?? 0.07143744)} SOL each). ` +
        `Missing indexes: ${sample}${missing.length > 3 ? ", ..." : ""}. Pick an already-initialized range/pool.`
    );
  }

  if (deriveBinArrayBitmapExtension && isOverflowDefaultBinArrayBitmap) {
    const needsBitmapExtension = indexes.some((index) => isOverflowDefaultBinArrayBitmap(index));
    if (needsBitmapExtension) {
      const [bitmapExtension] = deriveBinArrayBitmapExtension(poolPubkey, programId);
      const account: AccountInfo<Buffer> | null = await getConnection().getAccountInfo(bitmapExtension, "confirmed");
      if (!account) {
        throw new Error(
          `Deploy skipped: selected range requires Meteora bin-array bitmap extension initialization ` +
            `(~${formatSolFee(BIN_ARRAY_BITMAP_FEE ?? 0.01180416)} SOL non-refundable pool rent). Pick a closer initialized range/pool.`
        );
      }
    }
  }
}

// ─── Pool & Metadata Caching ───────────────────────────────────────────────

const poolCache = new Map<string, DlmmPool>();
const poolMetadataCache = new Map<string, PoolMetadata>();

async function getPool(poolAddress: string): Promise<DlmmPool> {
  const key = poolAddress.toString();
  const cached = poolCache.get(key);
  if (cached) return cached;

  const { DLMM } = await getDLMM();
  const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
  poolCache.set(key, pool);
  return pool;
}

const poolTimer = setInterval(() => poolCache.clear(), 5 * 60 * 1000);
if (typeof poolTimer.unref === "function") poolTimer.unref();

const metaTimer = setInterval(() => poolMetadataCache.clear(), 15 * 60 * 1000);
if (typeof metaTimer.unref === "function") metaTimer.unref();

async function getPoolMetadata(poolAddress: string): Promise<PoolMetadata> {
  const key = String(poolAddress);
  const cached = poolMetadataCache.get(key);
  if (cached) return cached;

  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${key}`);
    if (!res.ok) throw new Error(`Pool metadata API ${res.status}`);

    const raw: unknown = await res.json();
    const parsed = MeteoraPoolMetadataResponseSchema.safeParse(raw);
    const tokenX = parsed.success ? parsed.data.token_x?.symbol || null : null;
    const tokenY = parsed.success ? parsed.data.token_y?.symbol || null : null;
    const pair = parsed.success ? parsed.data.name || (tokenX && tokenY ? `${tokenX}-${tokenY}` : null) : null;
    const meta: PoolMetadata = {
      address: parsed.success && parsed.data.address ? parsed.data.address : key,
      name: pair,
      token_x_symbol: tokenX,
      token_y_symbol: tokenY,
    };
    poolMetadataCache.set(key, meta);
    return meta;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log("pool_meta_warn", `Pool metadata lookup failed for ${key.slice(0, 8)}: ${message}`);
    const fallback: PoolMetadata = { address: key, name: null, token_x_symbol: null, token_y_symbol: null };
    poolMetadataCache.set(key, fallback);
    return fallback;
  }
}

// ─── Get Active Bin ────────────────────────────────────────────────────────

export async function getActiveBin({ pool_address }: { pool_address: string }): Promise<ActiveBinResult> {
  const normAddress = normalizeMint(pool_address) ?? pool_address;
  const pool = await getPool(normAddress);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price)),
    pricePerLamport: activeBin.price.toString(),
  };
}

// ─── Deploy Position ───────────────────────────────────────────────────────

export async function deployPosition({
  pool_address,
  amount_sol,
  amount_x,
  amount_y,
  strategy,
  bins_below,
  bins_above,
  downside_pct,
  upside_pct,
  pool_name,
  bin_step,
  base_fee,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  entry_mcap,
  entry_tvl,
  entry_volume,
  entry_holders,
  x_ratio_mult,
  before_submit,
  on_prepared,
}: DeployPositionToolArgs): Promise<DeployPositionResult> {
  const normPoolAddress = normalizeMint(pool_address) ?? pool_address;
  if (typeof before_submit !== "function") {
    throw new Error("Deploy requires a wallet-signal recheck (before_submit)");
  }
  const activeStrategy = strategy || config.strategy.strategy;
  let activeBinsBelow = bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow;
  let activeBinsAbove = bins_above ?? 0;
  const parsedVolatility = volatility == null ? null : Number(volatility);
  const normalizedVolatility =
    parsedVolatility != null && Number.isFinite(parsedVolatility) ? parsedVolatility : null;

  if (volatility != null && (normalizedVolatility == null || normalizedVolatility <= 0)) {
    throw new Error(`Invalid volatility ${volatility} — refusing deploy because the volatility feed is unusable.`);
  }

  if (isPoolOnCooldown(normPoolAddress)) {
    log("deploy", `Pool ${normPoolAddress.slice(0, 8)} is on cooldown — skipping`);
    return {
      success: false,
      error: "Pool on cooldown — was recently closed with a cooldown reason. Try a different pool.",
    };
  }

  const { StrategyType, getBinIdFromPrice, getPriceOfBinByBinId } = await getDLMM();
  poolCache.delete(normPoolAddress);
  const pool = await getPool(normPoolAddress);
  const baseMint = pool.lbPair.tokenXMint.toString();
  if (pool.lbPair.tokenYMint.toString() !== config.tokens.SOL) {
    throw new Error("Execution requires SOL as token Y");
  }
  if (isBaseMintOnCooldown(baseMint)) {
    log("deploy", `Base mint ${baseMint.slice(0, 8)} is on cooldown — skipping deploy for pool ${normPoolAddress.slice(0, 8)}`);
    return {
      success: false,
      error: "Token on cooldown — recently closed out-of-range too many times. Try a different token.",
    };
  }

  let activeBin = await pool.getActiveBin();
  const actualBinStep = pool.lbPair.binStep;
  let activePrice = Number(getPriceOfBinByBinId(activeBin.binId, actualBinStep).toString());

  if (downside_pct != null || upside_pct != null) {
    const downsidePct = Math.max(0, Number(downside_pct ?? 0));
    const upsidePct = Math.max(0, Number(upside_pct ?? 0));

    if (!Number.isFinite(downsidePct) || !Number.isFinite(upsidePct)) {
      throw new Error("downside_pct and upside_pct must be valid numbers.");
    }
    if (downsidePct >= 100) {
      throw new Error("downside_pct must be less than 100.");
    }
    if (!getBinIdFromPrice) {
      throw new Error("getBinIdFromPrice helper not available on DLMM SDK");
    }

    const lowerTargetPrice = activePrice * (1 - downsidePct / 100);
    const upperTargetPrice = activePrice * (1 + upsidePct / 100);
    const lowerBinId = getBinIdFromPrice(lowerTargetPrice, actualBinStep, true);
    const upperBinId = getBinIdFromPrice(upperTargetPrice, actualBinStep, false);

    activeBinsBelow = Math.max(0, activeBin.binId - lowerBinId);
    activeBinsAbove = Math.max(0, upperBinId - activeBin.binId);
  }

  const strategyMap: Record<string, StrategyTypeEnum | undefined> = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };

  const strategyType = strategyMap[activeStrategy];
  if (strategyType === undefined) {
    throw new Error(`Invalid strategy: ${activeStrategy}. Use spot, curve, or bid_ask.`);
  }

  const walletBal = await getWalletBalances();
  const walletSol = "sol" in walletBal && typeof walletBal.sol === "number" ? walletBal.sol : 0;
  const fallbackAmountY =
    amount_y == null && amount_sol == null
      ? computeDeployAmount(walletSol)
      : 0;
  let finalAmountY = Number(amount_y ?? amount_sol ?? fallbackAmountY);
  let finalAmountX = Number(amount_x ?? 0);
  const totalDeploySol = finalAmountY;

  if (!Number.isFinite(finalAmountY) || !Number.isFinite(finalAmountX) || finalAmountY < 0 || finalAmountX < 0) {
    throw new Error("Invalid deploy amount: amount_x and amount_y must be valid non-negative numbers.");
  }
  if (finalAmountY <= 0 && finalAmountX <= 0) {
    throw new Error("Invalid deploy amount: provide a positive amount_y/amount_sol or amount_x.");
  }

  activeBinsBelow = Number(activeBinsBelow);
  activeBinsAbove = Number(activeBinsAbove);
  if (!Number.isFinite(activeBinsBelow) || !Number.isFinite(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be valid numbers.");
  }
  if (activeBinsBelow < 0 || activeBinsAbove < 0) {
    throw new Error("Invalid bin range: bins_below and bins_above cannot be negative.");
  }
  if (!Number.isInteger(activeBinsBelow) || !Number.isInteger(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be whole-bin integers.");
  }

  const rawMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
  const minBinsBelow = scaleBinsForBinStep(rawMinBinsBelow, actualBinStep, 22);
  const totalBins = activeBinsBelow + activeBinsAbove;
  if (totalBins < minBinsBelow) {
    throw new Error(
      `Invalid deploy range: total bins ${totalBins} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`
    );
  }

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_deploy: {
        pool_address: normPoolAddress,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        wide_range: totalBins > 69,
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  const txHashes: string[] = [];
  let preSwapTxHash: string | null = null;
  let spentSwapSol = 0;
  let preSwapRaw = 0n;
  let swappedRawDeltaX = 0n;
  let swappedDeltaXUi = 0;

  const rollbackSwappedTokenX = async (reason: string): Promise<boolean> => {
    if (swappedRawDeltaX <= 0n && swappedDeltaXUi <= 0) return false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const freshBal = await getWalletBalances({ force: true }).catch(() => null);
        const curTok = "tokens" in (freshBal ?? {}) ? (freshBal as { tokens?: Array<{ mint: string; raw_balance: string; decimals: number }> })?.tokens?.find((t) => t.mint === baseMint) : null;
        const curRaw = BigInt(curTok?.raw_balance ?? "0");
        const tokDecimals = Number(curTok?.decimals ?? 9);
        const rawToSell = curRaw > preSwapRaw
          ? (curRaw - preSwapRaw < swappedRawDeltaX ? curRaw - preSwapRaw : swappedRawDeltaX)
          : curRaw;
        if (rawToSell <= 0n) return true;
        const exactUi = Number(rawToSell) / Math.pow(10, tokDecimals);
        const safeUi = Math.floor(exactUi * 1e6) / 1e6;
        const sellAmount = safeUi > 0 ? safeUi : exactUi;
        log(
          "deploy_warn",
          `Rolling back pre-deploy swapped ${sellAmount} ${baseMint.slice(0, 8)} -> SOL after deploy failure (${reason}, attempt ${attempt}/3)`
        );
        const res = await swapToken({ input_mint: baseMint, output_mint: "SOL", amount: sellAmount });
        if ("success" in res && res.success && ("tx" in res || "amount_out" in res)) {
          return true;
        }
        log("deploy_warn", `Rollback swap attempt ${attempt}/3 returned error: ${"error" in res ? res.error : "no tx"}`);
      } catch (rollbackErr: unknown) {
        const msg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        log("deploy_error", `Rollback swap attempt ${attempt}/3 threw for ${baseMint.slice(0, 8)}: ${msg}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  };

  try {
    if (activeBinsAbove > 0 && finalAmountX <= 0 && finalAmountY > 0) {
      const initialTotalBins = activeBinsBelow + activeBinsAbove;
      const rawRatio = activeBinsAbove / initialTotalBins;
      const customMult = Number.isFinite(Number(x_ratio_mult))
        ? Math.max(0.25, Math.min(1.0, Number(x_ratio_mult)))
        : 0.65;
      const xRatio = activeStrategy === "bid_ask" ? rawRatio * customMult : rawRatio;
      const swapSolAmount = parseFloat((finalAmountY * xRatio).toFixed(6));
      if (swapSolAmount >= 0.005) {
        const preSwapMinBinId = activeBin.binId - activeBinsBelow;
        const preSwapMaxBinId = activeBin.binId + activeBinsAbove;
        if (preSwapMinBinId > preSwapMaxBinId) {
          throw new Error(`Invalid bin range: ${preSwapMinBinId} -> ${preSwapMaxBinId}`);
        }
        await assertRangeDoesNotRequireBinArrayInitialization(pool, preSwapMinBinId, preSwapMaxBinId);
        const preSwapBal = await getWalletBalances({ force: true }).catch(() => null);
        const preSwapTok = "tokens" in (preSwapBal ?? {}) ? (preSwapBal as { tokens?: Array<{ mint: string; raw_balance: string }> })?.tokens?.find((t) => t.mint === baseMint) : null;
        preSwapRaw = BigInt(preSwapTok?.raw_balance ?? "0");
        log(
          "deploy",
          `Dual-sided deploy (${activeBinsBelow} below, ${activeBinsAbove} above): swapping ${swapSolAmount} SOL (${(xRatio * 100).toFixed(1)}%) -> ${baseMint.slice(0, 8)}`
        );
        await before_submit("swap", undefined);
        const swapRes = await swapToken({ input_mint: "SOL", output_mint: baseMint, amount: swapSolAmount });
        if (!("success" in swapRes && swapRes.success)) {
          throw new Error(`Dual-sided pre-deploy swap failed: ${"error" in swapRes ? swapRes.error : "unknown error"}`);
        }
        if ("tx" in swapRes && swapRes.tx) preSwapTxHash = swapRes.tx;
        spentSwapSol = swapSolAmount;
        finalAmountY = parseFloat((finalAmountY - swapSolAmount).toFixed(6));
        let tok: { mint: string; raw_balance: string; decimals: number } | undefined;
        for (let attempt = 0; attempt < 6; attempt++) {
          await new Promise((r) => setTimeout(r, 1500));
          const freshBal = await getWalletBalances({ force: true });
          if ("tokens" in freshBal) {
            tok = freshBal.tokens?.find((t) => t.mint === baseMint);
            if (tok && BigInt(tok.raw_balance ?? "0") > preSwapRaw) break;
          }
        }
        const postSwapRaw = BigInt(tok?.raw_balance ?? "0");
        if (!tok || postSwapRaw <= preSwapRaw) {
          throw new Error(
            `Dual-sided pre-deploy swap succeeded (${"tx" in swapRes ? swapRes.tx : "tx"}), but token balance delta not yet readable`
          );
        }
        swappedRawDeltaX = postSwapRaw - preSwapRaw;
        const tokDecimals = Number(tok.decimals ?? 9);
        swappedDeltaXUi = Number(swappedRawDeltaX) / Math.pow(10, tokDecimals);
        finalAmountX = swappedDeltaXUi;
        if (typeof pool.refetchStates === "function") await pool.refetchStates();
        activeBin = await pool.getActiveBin();
        activePrice = Number(getPriceOfBinByBinId(activeBin.binId, actualBinStep).toString());
      } else {
        activeBinsAbove = 0;
      }
    }

    const finalTotalBins = activeBinsBelow + activeBinsAbove;
    const isWideRange = finalTotalBins > 69;
    const minBinId = activeBin.binId - activeBinsBelow;
    const maxBinId = activeBin.binId + activeBinsAbove;

    if (minBinId > maxBinId) {
      throw new Error(`Invalid bin range: ${minBinId} -> ${maxBinId}`);
    }

    await assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId);

    const minPrice = Number(getPriceOfBinByBinId(minBinId, actualBinStep).toString());
    const maxPrice = Number(getPriceOfBinByBinId(maxBinId, actualBinStep).toString());
    const downsideCoveragePct = activePrice > 0 ? ((activePrice - minPrice) / activePrice) * 100 : null;
    const upsideCoveragePct = activePrice > 0 ? ((maxPrice - activePrice) / activePrice) * 100 : null;
    const totalWidthPct = minPrice > 0 ? ((maxPrice - minPrice) / minPrice) * 100 : null;

    const baseFactor = (pool.lbPair.parameters as { baseFactor?: number } | undefined)?.baseFactor ?? 0;
    const actualBaseFee =
      base_fee ?? (baseFactor > 0 ? parseFloat(((baseFactor * actualBinStep) / 1e6 * 100).toFixed(4)) : null);

    const totalYLamports = new BN(Math.floor(finalAmountY * 1e9));
    let totalXLamports = new BN(0);
    if (swappedRawDeltaX > 0n) {
      totalXLamports = new BN(swappedRawDeltaX.toString());
    } else if (finalAmountX > 0) {
      const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
      const parsedData = mintInfo.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined;
      const decimals = parsedData?.parsed?.info?.decimals ?? 9;
      totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
    }

    const wallet = getWallet();
    const newPosition = Keypair.generate();
    await on_prepared?.(newPosition.publicKey.toString());

    log("deploy", `Pool: ${normPoolAddress}`);
    log(
      "deploy",
      `Strategy: ${activeStrategy}, Bins: ${minBinId} to ${maxBinId} (${totalBins} bins${isWideRange ? " — WIDE RANGE" : ""})`
    );
    log("deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
    log("deploy", `Position: ${newPosition.publicKey.toString()}`);

    if (isWideRange) {
      const createTxs = await pool.createExtendedEmptyPosition(
        minBinId,
        maxBinId,
        newPosition.publicKey,
        wallet.publicKey
      );
      const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
      for (let i = 0; i < createTxArray.length; i++) {
        const currentTx = createTxArray[i];
        if (!currentTx) continue;
        const signers = i === 0 ? [wallet, newPosition] : [wallet];
        await before_submit("lp", spentSwapSol);
        const txHash = await sendAndConfirmTransaction(getConnection(), currentTx, signers);
        txHashes.push(txHash);
        log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
      }

      const addTxs = await pool.addLiquidityByStrategyChunkable({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { minBinId, maxBinId, strategyType },
        slippage: 1,
      });
      const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
      for (let i = 0; i < addTxArray.length; i++) {
        const currentTx = addTxArray[i];
        if (!currentTx) continue;
        await before_submit("lp", spentSwapSol);
        const txHash = await sendAndConfirmTransaction(getConnection(), currentTx, [wallet]);
        txHashes.push(txHash);
        log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
      }
    } else {
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { maxBinId, minBinId, strategyType },
        slippage: 1,
      });
      await before_submit("lp", spentSwapSol);
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet, newPosition]);
      txHashes.push(txHash);
    }

    log("deploy", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0] ?? ""}`);
    const allDeployTxs = preSwapTxHash ? [preSwapTxHash, ...txHashes] : txHashes;

    _positionsCacheAt = 0;
    const signalSnapshot = baseMint ? { base_mint: baseMint } : null;
    let resolvedInitialValueUsd = initial_value_usd;
    if (resolvedInitialValueUsd == null) {
      const balForPrice = await getWalletBalances().catch(() => null);
      const solPrice = balForPrice && "sol_price" in balForPrice ? Number(balForPrice.sol_price) : 0;
      if (solPrice > 0) {
        resolvedInitialValueUsd = parseFloat((totalDeploySol * solPrice).toFixed(2));
      }
    }

    trackPosition({
      position: newPosition.publicKey.toString(),
      pool: normPoolAddress,
      pool_name,
      strategy: activeStrategy,
      bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
      bin_step: bin_step ?? actualBinStep,
      volatility: normalizedVolatility,
      fee_tvl_ratio: fee_tvl_ratio ?? null,
      organic_score: organic_score ?? null,
      amount_sol: totalDeploySol,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      initial_value_usd: resolvedInitialValueUsd ?? null,
      signal_snapshot: signalSnapshot,
      entry_mcap: entry_mcap ?? null,
      entry_tvl: entry_tvl ?? null,
      entry_volume: entry_volume ?? null,
      entry_holders: entry_holders ?? null,
    });

    const risks: string[] = [];
    if (normalizedVolatility != null) risks.push(`volatility ${normalizedVolatility}`);
    if (fee_tvl_ratio != null) risks.push(`fee/TVL ${fee_tvl_ratio}%`);

    appendDecision({
      type: "deploy",
      actor: "SCREENER",
      pool: normPoolAddress,
      pool_name,
      position: newPosition.publicKey.toString(),
      summary: `Deployed ${totalDeploySol} SOL with ${activeStrategy}`,
      reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
      risks,
      metrics: {
        amount_sol: totalDeploySol,
        strategy: activeStrategy,
        active_bin: activeBin.binId,
        min_bin: minBinId,
        max_bin: maxBinId,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
      },
    });

    return {
      success: true,
      position: newPosition.publicKey.toString(),
      pool: normPoolAddress,
      pool_name,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
      price_range: { min: minPrice, max: maxPrice },
      range_coverage: {
        downside_pct: downsideCoveragePct,
        upside_pct: upsideCoveragePct,
        width_pct: totalWidthPct,
        active_price: activePrice,
      },
      bin_step: actualBinStep,
      base_fee: actualBaseFee,
      strategy: activeStrategy,
      wide_range: isWideRange,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      txs: allDeployTxs,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log("deploy_error", message);
    const rolledBack = await rollbackSwappedTokenX(message);
    const unrecoveredTxs = txHashes.length > 0
      ? (preSwapTxHash ? [preSwapTxHash, ...txHashes] : txHashes)
      : (!rolledBack && preSwapTxHash ? [preSwapTxHash] : []);
    return { success: false, error: message, txs: unrecoveredTxs };
  }
}

// ─── Get Position PnL ──────────────────────────────────────────────────────

function deriveOpenPnlPct(binData: MeteoraPositionPnlItem | null | undefined, solMode = false): number | null {
  if (!binData) return null;
  const deposit = solMode
    ? safeNum(binData.allTimeDeposits?.total?.sol)
    : safeNum(binData.allTimeDeposits?.total?.usd);
  if (deposit <= 0) return null;

  const balances = solMode
    ? safeNum(binData.unrealizedPnl?.balancesSol)
    : safeNum(binData.unrealizedPnl?.balances);
  const unclaimedFees = solMode
    ? safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
    : safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd);
  const withdrawals = solMode
    ? safeNum(binData.allTimeWithdrawals?.total?.sol)
    : safeNum(binData.allTimeWithdrawals?.total?.usd);
  const fees = solMode
    ? safeNum(binData.allTimeFees?.total?.sol)
    : safeNum(binData.allTimeFees?.total?.usd);

  const pnl = balances + unclaimedFees + withdrawals + fees - deposit;
  return (pnl / deposit) * 100;
}

export async function getPositionPnl({
  pool_address,
  position_address,
}: {
  pool_address: string;
  position_address: string;
}): Promise<PositionPnlResult> {
  const normPool = normalizeMint(pool_address) ?? pool_address;
  const normPos = normalizeMint(position_address) ?? position_address;
  const walletAddress = getWallet().publicKey.toString();

  if (config.pnl.source === "rpc") {
    try {
      const payload = await getMyPositions({ force: true, silent: true });
      const p = payload.positions.find((position) => position.position === normPos);
      if (p) {
        return {
          pnl_usd: p.pnl_usd ?? 0,
          pnl_pct: p.pnl_pct ?? 0,
          current_value_usd: p.total_value_usd ?? 0,
          unclaimed_fee_usd: p.unclaimed_fees_usd ?? 0,
          all_time_fees_usd: p.collected_fees_usd ?? 0,
          fee_per_tvl_24h: p.fee_per_tvl_24h ?? 0,
          in_range: p.in_range,
          lower_bin: p.lower_bin,
          upper_bin: p.upper_bin,
          active_bin: p.active_bin,
          age_minutes: p.age_minutes,
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log("pnl_warn", `RPC PnL lookup failed; falling back to direct Meteora PnL path: ${message}`);
    }
  }

  try {
    const byAddress = await fetchDlmmPnlForPool(normPool, walletAddress);
    const p = byAddress[normPos];
    if (!p) return { error: "Position not found in PnL API" };

    const solMode = config.management.solMode;
    const unclaimedValue = solMode
      ? safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
      : safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.usd);
    const currentValue = solMode ? safeNum(p.unrealizedPnl?.balancesSol) : safeNum(p.unrealizedPnl?.balances);
    const reportedPnlPct = solMode ? maybeNum(p.pnlSolPctChange) : maybeNum(p.pnlPctChange);
    const derivedPnlPct = deriveOpenPnlPct(p, solMode);

    return {
      pnl_usd: roundNum(solMode ? p.pnlSol : p.pnlUsd, 4),
      pnl_pct: roundNum(reportedPnlPct ?? derivedPnlPct ?? 0, 2),
      current_value_usd: roundNum(currentValue, 4),
      unclaimed_fee_usd: roundNum(unclaimedValue, 4),
      all_time_fees_usd: roundNum(solMode ? p.allTimeFees?.total?.sol : p.allTimeFees?.total?.usd, 4),
      fee_per_tvl_24h: Math.round(parseFloat(String(p.feePerTvl24h || 0)) * 100) / 100,
      in_range: !p.isOutOfRange,
      lower_bin: p.lowerBinId ?? null,
      upper_bin: p.upperBinId ?? null,
      active_bin: p.poolActiveBinId ?? null,
      age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log("pnl_error", message);
    return { error: message };
  }
}

// ─── Get My Positions ──────────────────────────────────────────────────────

export async function getMyPositions({
  force = false,
  silent = false,
  wallet_address = null,
  skip_sync = false,
}: GetMyPositionsOptions = {}): Promise<PositionsPayload> {
  let walletOverride: string | null = null;
  try {
    walletOverride = wallet_address ? new PublicKey(wallet_address).toString() : null;
  } catch {
    return { wallet: wallet_address || null, total_positions: 0, positions: [], error: "Invalid wallet address" };
  }

  const useLocalWallet = !walletOverride;
  if (useLocalWallet && !force && _positionsCache && Date.now() - _positionsCacheAt < 5 * 60_000) {
    return _positionsCache;
  }
  if (useLocalWallet && _positionsInflight) return _positionsInflight;

  let walletAddress: string;
  try {
    walletAddress = walletOverride || config.standalone.walletAddress || getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  const loadPositions = async (): Promise<PositionsPayload> => {
    try {
      if (config.pnl.source === "rpc") {
        try {
          if (!silent) log("positions", `Computing PnL from RPC (${config.pnl.rpcUrl})...`);
          const rpcResult = await computePositions(walletAddress);
          if (useLocalWallet) {
            if (!skip_sync) syncOpenPositions(rpcResult.positions.map((p) => p.position));
            _positionsCache = rpcResult;
            _positionsCacheAt = Date.now();
          }
          return rpcResult;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          log("positions_warn", `RPC PnL path failed; falling back to Meteora portfolio API: ${message}`);
        }
      }

      let portfolio: { pools?: Array<{ poolAddress: string; listPositions?: string[]; outOfRange?: boolean; positionsOutOfRange?: string[]; tokenX?: string; tokenY?: string; tokenXMint?: string }> };
      try {
        if (!silent) log("positions", "Fetching portfolio via Meteora portfolio API...");
        const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
        const res = await fetch(portfolioUrl);
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`Portfolio API ${res.status}: ${body}`);
        }
        const rawJson: unknown = await res.json();
        const parsedPortfolio = MeteoraPortfolioResponseSchema.parse(rawJson);
        portfolio = parsedPortfolio;
      } catch (error: unknown) {
        if (config.pnl.source === "meteora") {
          const message = error instanceof Error ? error.message : String(error);
          log("positions_warn", `Meteora PnL path failed (${message}); falling back to on-chain RPC engine`);
          const rpcResult = await computePositions(walletAddress);
          if (useLocalWallet) {
            if (!skip_sync) syncOpenPositions(rpcResult.positions.map((p) => p.position));
            _positionsCache = rpcResult;
            _positionsCacheAt = Date.now();
          }
          return rpcResult;
        }
        throw error;
      }

      const pools = portfolio.pools || [];
      log("positions", `Found ${pools.length} pool(s) with open positions`);

      const binDataByPool: Record<string, Record<string, MeteoraPositionPnlItem>> = {};
      const pnlMaps = await Promise.all(
        pools.map((pool) => fetchDlmmPnlForPool(pool.poolAddress, walletAddress))
      );
      pools.forEach((pool, i) => {
        const pnlMap = pnlMaps[i];
        if (pool && pnlMap) {
          binDataByPool[pool.poolAddress] = pnlMap;
        }
      });

      const positions: PositionDetailItem[] = [];
      for (const pool of pools) {
        for (const positionAddress of pool.listPositions || []) {
          const tracked = getTrackedPosition(positionAddress);
          const isOOR = Boolean(pool.outOfRange || pool.positionsOutOfRange?.includes(positionAddress));

          if (isOOR) markOutOfRange(positionAddress);
          else markInRange(positionAddress);

          const binData = binDataByPool[pool.poolAddress]?.[positionAddress];
          if (!binData) {
            log(
              "positions_warn",
              `PnL API missing data for ${positionAddress.slice(0, 8)} in pool ${pool.poolAddress.slice(0, 8)} — using portfolio only for open-position discovery`
            );
          }

          const lowerBin = binData?.lowerBinId ?? tracked?.bin_range?.min ?? null;
          const upperBin = binData?.upperBinId ?? tracked?.bin_range?.max ?? null;
          const activeBin = binData?.poolActiveBinId ?? tracked?.bin_range?.active ?? null;

          const ageFromState = tracked?.deployed_at
            ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
            : null;
          const reportedPnlPct = binData
            ? parseFloat(String(config.management.solMode ? binData.pnlSolPctChange || 0 : binData.pnlPctChange || 0))
            : null;
          const derivedPnlPct = binData ? deriveOpenPnlPct(binData, config.management.solMode) : null;
          const pnlPctDiff =
            reportedPnlPct != null && derivedPnlPct != null ? Math.abs(reportedPnlPct - derivedPnlPct) : null;

          const postClaimSettling = isPostClaimSettling(tracked);
          const pnlPctSuspicious = (reportedPnlPct == null && derivedPnlPct == null) || postClaimSettling;

          if (postClaimSettling) {
            log(
              "positions_warn",
              `Post-claim settlement window active for ${positionAddress.slice(0, 8)} (last_claim_at=${tracked?.last_claim_at}) — PnL exit/peak rules paused for 60s to prevent Meteora double-count`
            );
          } else if (pnlPctSuspicious) {
            log(
              "positions_warn",
              `Unpriceable pnl_pct for ${positionAddress.slice(0, 8)}: no valid reported/derived value this tick — PnL rules paused`
            );
          } else if (pnlPctDiff != null && pnlPctDiff > (config.management.pnlSanityMaxDiffPct ?? 5)) {
            log(
              "positions_warn",
              `pnl_pct divergence for ${positionAddress.slice(0, 8)}: reported=${reportedPnlPct != null ? reportedPnlPct.toFixed(2) : "null"} derived=${derivedPnlPct != null ? derivedPnlPct.toFixed(2) : "null"} diff=${pnlPctDiff.toFixed(2)} (informational)`
            );
          }

          positions.push({
            position: positionAddress,
            pool: pool.poolAddress,
            pair: tracked?.pool_name || `${pool.tokenX ?? "?"}/${pool.tokenY ?? "SOL"}`,
            base_mint: pool.tokenXMint ?? null,
            lower_bin: lowerBin,
            upper_bin: upperBin,
            active_bin: activeBin,
            in_range: binData ? !binData.isOutOfRange : !isOOR,
            unclaimed_fees_usd: binData
              ? Math.round(
                  (config.management.solMode
                    ? parseFloat(String(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol || 0)) +
                      parseFloat(String(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol || 0))
                    : parseFloat(String(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0)) +
                      parseFloat(String(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0))) * 10000
                ) / 10000
              : null,
            total_value_usd: binData
              ? Math.round(
                  (config.management.solMode
                    ? parseFloat(String(binData.unrealizedPnl?.balancesSol || 0))
                    : parseFloat(String(binData.unrealizedPnl?.balances || 0))) * 10000
                ) / 10000
              : null,
            total_value_true_usd: binData
              ? Math.round(parseFloat(String(binData.unrealizedPnl?.balances || 0)) * 10000) / 10000
              : null,
            collected_fees_usd: binData
              ? Math.round(
                  parseFloat(
                    String(config.management.solMode ? binData.allTimeFees?.total?.sol || 0 : binData.allTimeFees?.total?.usd || 0)
                  ) * 10000
                ) / 10000
              : null,
            collected_fees_true_usd: binData
              ? Math.round(parseFloat(String(binData.allTimeFees?.total?.usd || 0)) * 10000) / 10000
              : null,
            pnl_usd: binData
              ? Math.round(
                  parseFloat(String(config.management.solMode ? binData.pnlSol || 0 : binData.pnlUsd || 0)) * 10000
                ) / 10000
              : null,
            pnl_true_usd: binData
              ? Math.round(parseFloat(String(binData.pnlUsd || 0)) * 10000) / 10000
              : null,
            pnl_pct: binData && reportedPnlPct != null ? Math.round(reportedPnlPct * 100) / 100 : null,
            pnl_pct_derived: derivedPnlPct != null ? Math.round(derivedPnlPct * 100) / 100 : null,
            pnl_pct_diff: pnlPctDiff != null ? Math.round(pnlPctDiff * 100) / 100 : null,
            pnl_pct_suspicious: Boolean(pnlPctSuspicious),
            unclaimed_fees_true_usd: binData
              ? Math.round(
                  (parseFloat(String(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0)) +
                    parseFloat(String(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0))) * 10000
                ) / 10000
              : null,
            fee_per_tvl_24h: binData
              ? Math.round(parseFloat(String(binData.feePerTvl24h || 0)) * 100) / 100
              : null,
            age_minutes: binData?.createdAt ? Math.floor((Date.now() - binData.createdAt * 1000) / 60000) : ageFromState,
            minutes_out_of_range: minutesOutOfRange(positionAddress),
            instruction: tracked?.instruction ?? null,
          });
        }
      }

      const result: PositionsPayload = {
        wallet: walletAddress,
        total_positions: positions.length,
        positions,
        source: "meteora",
      };
      if (useLocalWallet) {
        if (!skip_sync) syncOpenPositions(positions.map((p) => p.position));
        _positionsCache = result;
        _positionsCacheAt = Date.now();
      }
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log("positions_error", `Portfolio fetch failed: ${message}`);
      return { wallet: walletAddress, total_positions: 0, positions: [], error: message };
    } finally {
      if (useLocalWallet) _positionsInflight = null;
    }
  };

  if (useLocalWallet) {
    _positionsInflight = loadPositions();
    return _positionsInflight;
  }

  return loadPositions();
}

// ─── Claim Fees ────────────────────────────────────────────────────────────

export async function claimFees({ position_address }: { position_address: string }): Promise<ClaimFeesResult> {
  const normPos = normalizeMint(position_address) ?? position_address;
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_claim: normPos, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(normPos);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — fees were claimed during close" };
  }

  try {
    log("claim", `Claiming fees for position: ${normPos}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(normPos, wallet.publicKey.toString());
    poolCache.delete(poolAddress);
    const pool = await getPool(poolAddress);

    const positionData = await pool.getPosition(new PublicKey(normPos));
    const txs = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: positionData,
    });

    const txArray = Array.isArray(txs) ? txs : txs ? [txs] : [];
    if (txArray.length === 0) {
      return { success: false, error: "No fees to claim — transaction is empty" };
    }

    const txHashes: string[] = [];
    for (const tx of txArray) {
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
      txHashes.push(txHash);
    }
    log("claim", `SUCCESS txs: ${txHashes.join(", ")}`);
    const cachedPos = _positionsCache?.positions?.find((p) => p.position === normPos);
    const claimedUsd =
      cachedPos?.unclaimed_fees_true_usd != null && cachedPos.unclaimed_fees_true_usd > 0
        ? cachedPos.unclaimed_fees_true_usd
        : !config.management.solMode
          ? (cachedPos?.unclaimed_fees_usd ?? 0)
          : 0;
    _positionsCacheAt = 0;
    recordClaim(normPos, claimedUsd);

    return {
      success: true,
      position: normPos,
      pool: poolAddress,
      txs: txHashes,
      base_mint: pool.lbPair.tokenXMint.toString(),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log("claim_error", message);
    return { success: false, error: message };
  }
}

// ─── Close Position ────────────────────────────────────────────────────────

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
] as const;

function resolvePerformanceSignalSnapshot({
  poolAddress,
  baseMint,
  tracked,
}: {
  poolAddress: string;
  baseMint: string;
  tracked: TrackedPosition | null;
}): Record<string, unknown> | null {
  const snapshot: Record<string, unknown> = {
    ...(tracked?.signal_snapshot || {}),
  };

  if (baseMint && snapshot["base_mint"] == null) snapshot["base_mint"] = baseMint;
  for (const field of PERFORMANCE_SIGNAL_FIELDS) {
    if (snapshot[field] == null && tracked && field in tracked) {
      const val = Reflect.get(tracked, field);
      if (val != null) snapshot[field] = val;
    }
  }

  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

function getClosedPnlValue(posEntry: MeteoraPositionPnlItem, solMode = false): number {
  const reported = solMode
    ? maybeNum(posEntry.pnlSol) ?? maybeNum(posEntry.pnl?.valueNative)
    : maybeNum(posEntry.pnlUsd) ?? maybeNum(posEntry.pnl?.value);
  if (reported != null && reported !== 0) return reported;

  const withdrawn = solMode
    ? safeNum(posEntry.allTimeWithdrawals?.total?.sol)
    : safeNum(posEntry.allTimeWithdrawals?.total?.usd);
  const deposited = solMode
    ? safeNum(posEntry.allTimeDeposits?.total?.sol)
    : safeNum(posEntry.allTimeDeposits?.total?.usd);
  const fees = solMode
    ? safeNum(posEntry.allTimeFees?.total?.sol)
    : safeNum(posEntry.allTimeFees?.total?.usd);
  if (withdrawn > 0 && deposited > 0) {
    return withdrawn + fees - deposited;
  }

  const pct = solMode
    ? maybeNum(posEntry.pnlSolPctChange) ?? maybeNum(posEntry.pnl?.percentNative)
    : maybeNum(posEntry.pnlPctChange) ?? maybeNum(posEntry.pnl?.percent);
  if (pct != null && pct !== 0 && deposited > 0) {
    return (pct / 100) * deposited;
  }
  return reported ?? 0;
}

function getClosedPnlPct(posEntry: MeteoraPositionPnlItem, solMode = false): number {
  const reported = solMode
    ? maybeNum(posEntry.pnlSolPctChange) ?? maybeNum(posEntry.pnl?.percentNative)
    : maybeNum(posEntry.pnlPctChange) ?? maybeNum(posEntry.pnl?.percent);
  if (reported != null) return reported;

  const pnl = getClosedPnlValue(posEntry, solMode);
  const deposit = solMode
    ? maybeNum(posEntry.allTimeDeposits?.total?.sol)
    : maybeNum(posEntry.allTimeDeposits?.total?.usd);
  return deposit && deposit > 0 ? (pnl / deposit) * 100 : 0;
}

export async function closePosition({
  position_address,
  reason,
}: {
  position_address: string;
  reason?: string;
}): Promise<ClosePositionResult> {
  const normPos = normalizeMint(position_address) ?? position_address;
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: normPos, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(normPos);
  const preCloseCachedPos = _positionsCache?.positions?.find((p) => p.position === normPos) ?? null;

  try {
    log("close", `Closing position: ${normPos}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(normPos, wallet.publicKey.toString());
    const poolMeta = await getPoolMetadata(poolAddress);

    poolCache.delete(poolAddress);
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(normPos);
    const claimTxHashes: string[] = [];
    const closeTxHashes: string[] = [];

    const recentlyClaimed =
      tracked?.last_claim_at && Date.now() - new Date(tracked.last_claim_at).getTime() < 60_000;
    try {
      if (recentlyClaimed) {
        log(
          "close",
          `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at!).getTime()) / 1000)}s ago`
        );
      } else {
        log("close", `Step 1: Claiming fees for ${normPos}`);
        const positionData = await pool.getPosition(positionPubKey);
        const claimTxs = await pool.claimSwapFee({
          owner: wallet.publicKey,
          position: positionData,
        });
        const claimArray = Array.isArray(claimTxs) ? claimTxs : claimTxs ? [claimTxs] : [];
        if (claimArray.length > 0) {
          for (const tx of claimArray) {
            const claimHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
            claimTxHashes.push(claimHash);
          }
          log("close", `Step 1 OK (claim only): ${claimTxHashes.join(", ")}`);
          const step1ClaimedUsd =
            preCloseCachedPos?.unclaimed_fees_true_usd != null && preCloseCachedPos.unclaimed_fees_true_usd > 0
              ? preCloseCachedPos.unclaimed_fees_true_usd
              : !config.management.solMode
                ? (preCloseCachedPos?.unclaimed_fees_usd ?? 0)
                : 0;
          recordClaim(normPos, step1ClaimedUsd);
          if (tracked && step1ClaimedUsd > 0) {
            tracked.total_fees_claimed_usd = (tracked.total_fees_claimed_usd || 0) + step1ClaimedUsd;
          }
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${msg}`);
    }

    let hasLiquidity = false;
    let closeFromBinId = -887272;
    let closeToBinId = 887272;
    try {
      const positionDataForClose = await pool.getPosition(positionPubKey);
      const processed = positionDataForClose?.positionData;
      if (processed) {
        closeFromBinId = processed.lowerBinId ?? closeFromBinId;
        closeToBinId = processed.upperBinId ?? closeToBinId;
        const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
        hasLiquidity = bins.some((bin: { positionLiquidity?: string | number | null }) => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log("close_warn", `Could not check liquidity state: ${msg}`);
    }

    if (hasLiquidity) {
      log("close", `Step 2: Removing liquidity and closing account`);
      const closeTx = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubKey,
        fromBinId: closeFromBinId,
        toBinId: closeToBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });

      const closeArray = Array.isArray(closeTx) ? closeTx : [closeTx];
      for (const tx of closeArray) {
        const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
        closeTxHashes.push(txHash);
      }
    } else {
      log("close", `Step 2: No position liquidity detected, closing account`);
      const closeTx = await pool.closePosition({
        owner: wallet.publicKey,
        position: { publicKey: positionPubKey },
      });
      const txHash = await sendAndConfirmTransaction(getConnection(), closeTx, [wallet]);
      closeTxHashes.push(txHash);
    }

    const txHashes = [...claimTxHashes, ...closeTxHashes];
    log("close", `Step 2 OK (close only): ${closeTxHashes.join(", ") || "none"}`);
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`);

    await new Promise((r) => setTimeout(r, 5000));
    _positionsCacheAt = 0;

    let closedConfirmed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const refreshed = await getMyPositions({ force: true, silent: true, skip_sync: true });
        const stillOpen = refreshed?.positions?.some((p) => p.position === normPos);
        if (!stillOpen) {
          closedConfirmed = true;
          break;
        }
        log("close_warn", `Position ${normPos} still appears open after close txs (attempt ${attempt + 1}/4)`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log("close_warn", `Close verification failed (attempt ${attempt + 1}/4): ${msg}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }

    if (!closedConfirmed) {
      return {
        success: false,
        error: "Close transactions sent but position still appears open after verification window",
        position: normPos,
        pool: poolAddress,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
      };
    }

    recordClose(normPos, reason || "agent decision");

    if (tracked) {
      const deployedAt = tracked.deployed_at ? new Date(tracked.deployed_at).getTime() : Date.now();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      const shouldRejectClosedPnl = (pct: number, closeReasonText: unknown): boolean => {
        if (!Number.isFinite(pct)) return false;
        const reasonText = String(closeReasonText || "").toLowerCase();
        const stopLossTriggered = reasonText.includes("stop loss");
        return !stopLossTriggered && pct <= -90;
      };

      let pnlUsd = 0;
      let pnlTrueUsd = 0;
      let pnlSol = 0;
      let pnlPct = 0;
      let finalValueUsd = 0;
      let initialUsd = 0;
      let feesUsd = tracked.total_fees_claimed_usd || 0;
      let feesSol: number | null = null;

      try {
        const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
        for (let attempt = 0; attempt < 6; attempt++) {
          const res = await fetch(closedUrl);
          if (res.ok) {
            const rawData: unknown = await res.json();
            const parsedData = MeteoraPositionsPnlResponseSchema.safeParse(rawData);
            const posList = parsedData.success ? parsedData.data.positions ?? parsedData.data.data ?? [] : [];
            const posEntry = posList.find(
              (p) => (p.positionAddress ?? p.address ?? p.position) === normPos
            );
            if (posEntry) {
              const nextPnlTrueUsd = getClosedPnlValue(posEntry, false);
              const nextPnlSol = getClosedPnlValue(posEntry, true);
              const nextPnlValue = config.management.solMode ? nextPnlSol : nextPnlTrueUsd;
              const nextPnlPct = getClosedPnlPct(posEntry, config.management.solMode);
              const nextFinalValueUsd = parseFloat(String(posEntry.allTimeWithdrawals?.total?.usd || 0));
              const nextFinalValueSol = parseFloat(String(posEntry.allTimeWithdrawals?.total?.sol || 0));
              const nextInitialUsd = parseFloat(String(posEntry.allTimeDeposits?.total?.usd || 0));
              const nextFeesUsd = parseFloat(String(posEntry.allTimeFees?.total?.usd || 0)) || feesUsd;
              const nextFeesSol = maybeNum(posEntry.allTimeFees?.total?.sol);

              if (shouldRejectClosedPnl(nextPnlPct, reason || tracked.close_reason)) {
                log(
                  "close_warn",
                  `Rejected unsettled closed PnL for ${normPos.slice(0, 8)} on attempt ${attempt + 1}/6: ${nextPnlPct.toFixed(2)}%`
                );
              } else if (nextFinalValueUsd <= 0 && nextFinalValueSol <= 0 && attempt < 5) {
                log(
                  "close_warn",
                  `Closed PnL withdrawal not indexed yet for ${normPos.slice(0, 8)} on attempt ${attempt + 1}/6 — retrying`
                );
              } else {
                pnlTrueUsd = nextPnlTrueUsd;
                pnlSol = nextPnlSol;
                pnlUsd = nextPnlValue;
                pnlPct = nextPnlPct;
                finalValueUsd = nextFinalValueUsd;
                initialUsd = nextInitialUsd;
                feesUsd = nextFeesUsd;
                if (nextFeesSol != null) feesSol = nextFeesSol;
                if (pnlSol === 0 && pnlPct !== 0 && tracked.amount_sol > 0) {
                  pnlSol = (pnlPct / 100) * tracked.amount_sol;
                  if (config.management.solMode) pnlUsd = pnlSol;
                }
                if (pnlTrueUsd === 0 && pnlPct !== 0 && initialUsd > 0) {
                  pnlTrueUsd = (pnlPct / 100) * initialUsd;
                  if (!config.management.solMode) pnlUsd = pnlTrueUsd;
                }
                const logPnlFormatted = config.management.solMode ? pnlUsd.toFixed(4) : pnlUsd.toFixed(2);
                log(
                  "close",
                  `Closed PnL from API: pnl=${logPnlFormatted} ${config.management.solMode ? "SOL" : "USD"} (${pnlPct.toFixed(2)}%), withdrawn=${finalValueUsd.toFixed(2)} USD, deposited=${initialUsd.toFixed(2)} USD`
                );
                break;
              }
            } else {
              log("close_warn", `Position not found in status=closed response (attempt ${attempt + 1}/6) — may still be settling`);
            }
          }
          if (attempt < 5) await new Promise((r) => setTimeout(r, 5000));
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log("close_warn", `Closed PnL fetch failed: ${msg}`);
      }

      if (finalValueUsd === 0) {
        const cachedPos = preCloseCachedPos ?? _positionsCache?.positions?.find((p) => p.position === normPos);
        if (cachedPos) {
          pnlTrueUsd = cachedPos.pnl_true_usd ?? (config.management.solMode ? 0 : cachedPos.pnl_usd) ?? 0;
          pnlSol = config.management.solMode ? (cachedPos.pnl_usd ?? 0) : 0;
          pnlUsd = config.management.solMode ? pnlSol : pnlTrueUsd;
          pnlPct = cachedPos.pnl_pct ?? 0;
          feesUsd = Math.max(
            feesUsd,
            (cachedPos.collected_fees_true_usd || 0) + (cachedPos.unclaimed_fees_true_usd || 0)
          );
          if (config.management.solMode && feesSol == null) {
            feesSol = (cachedPos.collected_fees_usd || 0) + (cachedPos.unclaimed_fees_usd || 0);
          }
          initialUsd = tracked.initial_value_usd || 0;
          finalValueUsd =
            cachedPos.total_value_true_usd ??
            (!config.management.solMode ? cachedPos.total_value_usd : null) ??
            Math.max(0, initialUsd + pnlTrueUsd - feesUsd);
          if (initialUsd > 0) {
            if (!config.management.solMode && cachedPos.pnl_pct == null) pnlPct = (pnlTrueUsd / initialUsd) * 100;
          } else {
            initialUsd = Math.max(0, finalValueUsd + feesUsd - pnlTrueUsd);
          }
          if (config.management.solMode && cachedPos.pnl_pct == null && tracked.amount_sol > 0) {
            pnlPct = (pnlSol / tracked.amount_sol) * 100;
          }
          if (pnlSol === 0 && pnlPct !== 0 && tracked.amount_sol > 0) {
            pnlSol = (pnlPct / 100) * tracked.amount_sol;
            if (config.management.solMode) pnlUsd = pnlSol;
          }
          log("close_warn", `Using cached pnl fallback because closed API has not settled yet`);
        }
      }

      const closeBaseMint = pool.lbPair.tokenXMint.toString();
      const signalSnapshot = resolvePerformanceSignalSnapshot({
        poolAddress,
        baseMint: closeBaseMint,
        tracked,
      });

      let exitMarket: { exit_mcap?: number | null; exit_tvl?: number | null; exit_volume?: number | null } = {};
      try {
        const timeframe = encodeURIComponent(config.screening?.timeframe || "5m");
        const filter = encodeURIComponent(`pool_address=${poolAddress}`);
        const res = await fetch(`https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${filter}&timeframe=${timeframe}`);
        if (res.ok) {
          const rawDiscovery: unknown = await res.json();
          const parsedDiscovery = MeteoraPoolDiscoveryResponseSchema.safeParse(rawDiscovery);
          const ep = parsedDiscovery.success ? parsedDiscovery.data.data?.[0] : undefined;
          if (ep) {
            exitMarket = {
              exit_mcap: safeNum(ep.token_x?.mcap ?? ep.token_x?.market_cap ?? ep.mcap ?? ep.market_cap) || null,
              exit_tvl: safeNum(ep.tvl ?? ep.active_tvl) || null,
              exit_volume: safeNum(ep.volume) || null,
            };
          }
        }
      } catch {
        // non-blocking
      }

      await recordPerformance({
        position: normPos,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        base_mint: closeBaseMint,
        strategy: tracked.strategy,
        bin_range: tracked.bin_range,
        bin_step: tracked.bin_step || null,
        volatility: tracked.volatility ?? null,
        fee_tvl_ratio: tracked.fee_tvl_ratio || null,
        organic_score: tracked.organic_score || null,
        amount_sol: tracked.amount_sol,
        fees_earned_usd: feesUsd,
        fees_earned_sol: feesSol,
        final_value_usd: finalValueUsd,
        initial_value_usd: initialUsd,
        reported_pnl_pct: pnlPct,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: reason || "agent decision",
        signal_snapshot: signalSnapshot,
        entry_mcap: tracked.entry_mcap ?? null,
        entry_tvl: tracked.entry_tvl ?? null,
        entry_volume: tracked.entry_volume ?? null,
        entry_holders: tracked.entry_holders ?? null,
        ...exitMarket,
      });

      const risks: string[] = [];
      if (minutesOOR > 0) risks.push(`out of range ${minutesOOR}m`);
      if (tracked.volatility != null) risks.push(`volatility ${tracked.volatility}`);

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        position: normPos,
        summary: `Closed at ${pnlPct.toFixed(2)}%`,
        reason: reason || "agent decision",
        risks,
        metrics: {
          pnl_usd: pnlTrueUsd,
          pnl_sol: pnlSol,
          pnl_pct: pnlPct,
          fees_usd: feesUsd,
          minutes_held: minutesHeld,
        },
      });

      return {
        success: true,
        position: normPos,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        pnl_usd: pnlUsd,
        pnl_true_usd: pnlTrueUsd,
        pnl_sol: pnlSol,
        pnl_pct: pnlPct,
        base_mint: closeBaseMint,
      };
    }

    appendDecision({
      type: "close",
      actor: "MANAGER",
      pool: poolAddress,
      pool_name: poolMeta.name || poolAddress.slice(0, 8),
      position: normPos,
      summary: "Closed position",
      reason: reason || "agent decision",
      metrics: {},
    });

    return {
      success: true,
      position: normPos,
      pool: poolAddress,
      pool_name: poolMeta.name || null,
      claim_txs: claimTxHashes,
      close_txs: closeTxHashes,
      txs: txHashes,
      base_mint: pool.lbPair.tokenXMint.toString(),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log("close_error", message);
    return { success: false, error: message };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function lookupPoolForPosition(position_address: string, walletAddress: string): Promise<string> {
  const tracked = getTrackedPosition(position_address);
  if (tracked?.pool) return tracked.pool;

  const cached = _positionsCache?.positions?.find((p) => p.position === position_address);
  if (cached?.pool) return cached.pool;

  const { DLMM } = await getDLMM();
  if (typeof DLMM.getAllLbPairPositionsByUser === "function") {
    const allPositions = await DLMM.getAllLbPairPositionsByUser(
      getConnection(),
      new PublicKey(walletAddress)
    );

    const entries = allPositions instanceof Map ? [...allPositions.entries()] : Object.entries(allPositions as Record<string, PositionInfo>);
    for (const [lbPairKey, positionData] of entries) {
      for (const pos of positionData.lbPairPositionsData || []) {
        if (pos.publicKey.toString() === position_address) return lbPairKey;
      }
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}
