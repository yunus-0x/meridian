import { z } from "zod";
import { deployPosition, getMyPositions, claimFees, closePosition } from "./dlmm.js";
import type {
  DeployPositionResult,
  ClaimFeesResult,
  ClosePositionResult,
  DeployPositionSuccessResult,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import type { SwapTokenResult, SwapSuccessResult } from "./wallet.js";
import { withWalletLock } from "../standalone/transactions.js";
import { invalidateBalances } from "../standalone/balances.js";
import { config, MIN_SAFE_BINS_BELOW } from "../config.js";
import { addPoolNote } from "../pool-memory.js";
import { getTrackedPositions } from "../state.js";
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";
import { getCachedChronosAnalysis } from "../standalone/chronos.js";
import {
  DeployPositionToolArgsSchema,
  ClaimFeesToolArgsSchema,
  ClosePositionToolArgsSchema,
  SwapTokenToolArgsSchema,
} from "../src/schemas/api.js";
import type {
  DeployPositionToolArgs,
  ClaimFeesToolArgs,
  ClosePositionToolArgs,
  SwapTokenToolArgs,
} from "../src/schemas/api.js";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES: Record<string, number> = {
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};

export interface ToolExecutionBlocked {
  blocked: true;
  reason: string;
}

export interface ToolExecutionGeneralError {
  error: string;
  tool?: string;
}

export type ToolResult =
  | DeployPositionResult
  | ClaimFeesResult
  | ClosePositionResult
  | SwapTokenResult
  | ToolExecutionBlocked
  | ToolExecutionGeneralError
  | Record<string, unknown>;

export interface EntryMarketData {
  entry_mcap: number | null;
  entry_tvl: number | null;
  entry_volume: number | null;
  entry_holders: number | null;
}

export interface SafetyCheckResult {
  pass: boolean;
  reason?: string;
  entryMarketData?: EntryMarketData;
}

const PoolDetailResponseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            tvl: z.union([z.number(), z.string()]).nullish(),
            active_tvl: z.union([z.number(), z.string()]).nullish(),
            liquidity: z.union([z.number(), z.string()]).nullish(),
            dlmm_params: z
              .object({ bin_step: z.union([z.number(), z.string()]).nullish() })
              .nullish(),
            pool_config: z
              .object({ bin_step: z.union([z.number(), z.string()]).nullish() })
              .nullish(),
            fee_active_tvl_ratio: z.union([z.number(), z.string()]).nullish(),
            volatility: z.union([z.number(), z.string()]).nullish(),
            volume: z.union([z.number(), z.string()]).nullish(),
            is_blacklisted: z.boolean().nullish(),
            token_x: z
              .object({
                warnings: z
                  .array(z.object({ severity: z.string().optional() }).passthrough())
                  .nullish(),
                market_cap: z.union([z.number(), z.string()]).nullish(),
                holders: z.union([z.number(), z.string()]).nullish(),
              })
              .nullish(),
            token_y: z
              .object({
                warnings: z
                  .array(z.object({ severity: z.string().optional() }).passthrough())
                  .nullish(),
                organic_score: z.union([z.number(), z.string()]).nullish(),
              })
              .nullish(),
            base_token_market_cap: z.union([z.number(), z.string()]).nullish(),
            base_token_holders: z.union([z.number(), z.string()]).nullish(),
          })
          .passthrough()
      )
      .nullish(),
  })
  .passthrough();

export type PoolDiscoveryDetail = NonNullable<
  NonNullable<z.infer<typeof PoolDetailResponseSchema>["data"]>[number]
>;

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getVolatilityTimeframe(sourceTimeframe?: string): string {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && minMinutes != null && sourceMinutes >= minMinutes
    ? source
    : MIN_VOLATILITY_TIMEFRAME;
}

function poolDetailTvl(pool: PoolDiscoveryDetail | null | undefined): number | null {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl ?? pool?.liquidity);
}

function poolDetailBinStep(pool: PoolDiscoveryDetail | null | undefined): number | null {
  return numberOrNull(pool?.dlmm_params?.bin_step ?? pool?.pool_config?.bin_step);
}

function poolDetailFeeActiveTvlRatio(pool: PoolDiscoveryDetail | null | undefined): number | null {
  return numberOrNull(pool?.fee_active_tvl_ratio);
}

function poolDetailVolatility(pool: PoolDiscoveryDetail | null | undefined): number | null {
  return numberOrNull(pool?.volatility);
}

async function fetchFreshPoolDetail(
  poolAddress: string,
  timeframe: string = config.screening.timeframe || "5m"
): Promise<PoolDiscoveryDetail | null> {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  const raw: unknown = await res.json();
  const parsed = PoolDetailResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Failed to parse pool discovery response: ${parsed.error.message}`);
  }
  const items = parsed.data.data;
  return items && items.length > 0 && items[0] ? items[0] : null;
}

async function validateDeployPoolThresholds(
  args: DeployPositionToolArgs
): Promise<SafetyCheckResult> {
  let detail: PoolDiscoveryDetail | null;
  try {
    detail = await fetchFreshPoolDetail(args.pool_address);
    if (!detail) throw new Error(`Pool ${args.pool_address} not found`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      pass: false,
      reason: `Could not verify pool screening thresholds before deploy: ${msg}`,
    };
  }

  if (detail.is_blacklisted !== false) {
    return {
      pass: false,
      reason: "Pool blacklist status is unsafe or unknown.",
    };
  }
  const xWarnings = Array.isArray(detail.token_x?.warnings) ? detail.token_x.warnings : [];
  const yWarnings = Array.isArray(detail.token_y?.warnings) ? detail.token_y.warnings : [];
  if (
    [...xWarnings, ...yWarnings].some(
      (w) => w?.severity && ["critical", "danger", "warning"].includes(w.severity)
    )
  ) {
    return {
      pass: false,
      reason: "Pool has critical/danger/warning token flags.",
    };
  }

  const tvl = poolDetailTvl(detail);
  const activeTvl = numberOrNull(detail.active_tvl);
  const minTvl = numberOrNull(config.screening.minTvl);
  const maxTvl = numberOrNull(config.screening.maxTvl);
  if (tvl == null) {
    return {
      pass: false,
      reason: "Could not verify pool TVL before deploy.",
    };
  }
  if (minTvl != null && minTvl > 0 && tvl < minTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is below configured minTvl $${minTvl}.`,
    };
  }
  if (minTvl != null && minTvl > 0 && activeTvl != null && activeTvl < minTvl) {
    return {
      pass: false,
      reason: `Pool active TVL $${activeTvl} is below configured minTvl $${minTvl}.`,
    };
  }
  if (maxTvl != null && maxTvl > 0 && tvl > maxTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is above configured maxTvl $${maxTvl}.`,
    };
  }

  const volume = numberOrNull(detail.volume);
  const minVolume = numberOrNull(config.screening.minVolume);
  if (minVolume != null && minVolume > 0 && (volume == null || volume < minVolume)) {
    return {
      pass: false,
      reason: `Pool volume $${volume ?? "unknown"} is below configured minVolume $${minVolume}.`,
    };
  }

  const quoteOrganic = numberOrNull(detail.token_y?.organic_score);
  const minQuoteOrganic = numberOrNull(config.screening.minQuoteOrganic);
  if (
    minQuoteOrganic != null &&
    minQuoteOrganic > 0 &&
    quoteOrganic != null &&
    quoteOrganic < minQuoteOrganic
  ) {
    return {
      pass: false,
      reason: `Pool quote organic score ${quoteOrganic} is below configured minQuoteOrganic ${minQuoteOrganic}.`,
    };
  }

  const feeActiveTvlRatio = poolDetailFeeActiveTvlRatio(detail);
  const minFeeActiveTvlRatio = numberOrNull(config.screening.minFeeActiveTvlRatio);
  if (
    minFeeActiveTvlRatio != null &&
    minFeeActiveTvlRatio > 0 &&
    (feeActiveTvlRatio == null || feeActiveTvlRatio < minFeeActiveTvlRatio)
  ) {
    return {
      pass: false,
      reason: `Pool fee/active-TVL ${feeActiveTvlRatio ?? "unknown"}% is below configured minFeeActiveTvlRatio ${minFeeActiveTvlRatio}%.`,
    };
  }

  const volatilityTimeframe = getVolatilityTimeframe(config.screening.timeframe || "5m");
  let volatilityDetail: PoolDiscoveryDetail | null = detail;
  if ((config.screening.timeframe || "5m") !== volatilityTimeframe) {
    try {
      volatilityDetail = await fetchFreshPoolDetail(args.pool_address, volatilityTimeframe);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        pass: false,
        reason: `Could not verify pool ${volatilityTimeframe} volatility before deploy: ${msg}`,
      };
    }
  }

  let volatility = poolDetailVolatility(volatilityDetail);
  if ((volatility == null || volatility <= 0) && volatilityTimeframe !== "1h") {
    try {
      const fallback1h = await fetchFreshPoolDetail(args.pool_address, "1h");
      volatility = poolDetailVolatility(fallback1h);
    } catch {
      /* ignore fallback error */
    }
  }
  if (volatility == null || volatility <= 0) {
    return {
      pass: false,
      reason: `Pool ${volatilityTimeframe} volatility ${volatility ?? "unknown"} is unusable. Refusing deploy.`,
    };
  }

  const actualBinStep = poolDetailBinStep(detail);
  const minStep = numberOrNull(config.screening.minBinStep);
  const maxStep = numberOrNull(config.screening.maxBinStep);
  if (actualBinStep != null && minStep != null && actualBinStep < minStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is below configured minBinStep ${minStep}.`,
    };
  }
  if (actualBinStep != null && maxStep != null && actualBinStep > maxStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is above configured maxBinStep ${maxStep}.`,
    };
  }

  const entryMarketData: EntryMarketData = {
    entry_mcap: numberOrNull(detail.token_x?.market_cap ?? detail.base_token_market_cap),
    entry_tvl: tvl,
    entry_volume: volume,
    entry_holders: numberOrNull(detail.base_token_holders ?? detail.token_x?.holders),
  };

  return { pass: true, entryMarketData };
}

type ToolHandler = (args: unknown) => Promise<unknown>;

const toolMap: Record<string, ToolHandler> = {
  deploy_position: (args) => deployPosition(DeployPositionToolArgsSchema.parse(args ?? {})),
  claim_fees: (args) => claimFees(ClaimFeesToolArgsSchema.parse(args ?? {})),
  close_position: (args) => closePosition(ClosePositionToolArgsSchema.parse(args ?? {})),
  swap_token: (args) => swapToken(SwapTokenToolArgsSchema.parse(args ?? {})),
};

const WRITE_TOOLS = new Set(["deploy_position", "claim_fees", "close_position", "swap_token"]);
const PROTECTED_TOOLS = new Set([...WRITE_TOOLS]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface SwapBaseToSolResult {
  swapped: boolean;
  result: SwapSuccessResult | null;
  token: { mint: string; symbol?: string; balance: number; usd?: number | null } | null;
}

/**
 * Swap a base token back to SOL with retry. Jupiter can transiently fail (no route,
 * quote error) and a single attempt silently leaves the token unsold — retries with
 * delay, re-fetching balance each attempt (amounts shift on partial
 * fills). Treats both throw AND result.success===false / missing tx as failure.
 * Returns { swapped, result, token } — swapped=false if nothing to do or all attempts failed.
 */
async function swapBaseToSolWithRetry(
  baseMint: string,
  label: string,
  poolAddress: string | null = null
): Promise<SwapBaseToSolResult> {
  const tracked = getTrackedPositions(true);
  const openInSamePool = tracked.filter((p) => {
    const snapshotMint =
      p.signal_snapshot && typeof p.signal_snapshot === "object" && "base_mint" in p.signal_snapshot
        ? String(p.signal_snapshot.base_mint || "")
        : "";
    return p.pool === poolAddress || (Boolean(baseMint) && snapshotMint === baseMint);
  }).length;

  const maxOpenForBounce = label === "after claim" ? 1 : 0;
  if (poolAddress && process.env.DRY_RUN !== "true" && openInSamePool <= maxOpenForBounce) {
    const cachedChronos = getCachedChronosAnalysis(poolAddress);
    const isBounce = Boolean(cachedChronos?.tactical_signals?.micro_oversold_bounce);
    const isBreakout = Boolean(!isBounce && cachedChronos?.tactical_signals?.micro_breakout_hold);
    if (isBounce || isBreakout) {
      const targetMovePct = isBreakout ? 2.0 : 1.2;
      const stopMovePct = isBreakout ? -1.2 : -1.5;
      const modeLabel = isBreakout ? "micro-breakout rider" : "micro-bounce";
      try {
        const initBal = await getWalletBalances({ force: true }).catch(() => null);
        const initTok = initBal?.tokens?.find((t) => t.mint === baseMint);
        const initUsd = Number(initTok?.usd ?? 0);
        if (initTok && initTok.balance > 0 && initUsd >= 0.5) {
          log(
            "executor",
            `Chronos ${modeLabel} active for ${baseMint.slice(0, 8)} (${label}): holding up to 24s for +${targetMovePct}%...`
          );
          for (let tick = 1; tick <= 3; tick++) {
            await sleep(8_000);
            const curBal = await getWalletBalances({ force: true }).catch(() => null);
            const curTok = curBal?.tokens?.find((t) => t.mint === baseMint);
            const curUsd = Number(curTok?.usd ?? 0);
            if (!curTok || curUsd <= 0) break;
            const movePct = ((curUsd - initUsd) / initUsd) * 100;
            if (movePct >= targetMovePct) {
              log(
                "executor",
                `Chronos ${modeLabel} captured +${movePct.toFixed(2)}% on ${baseMint.slice(0, 8)} after ${tick * 8}s — swapping now`
              );
              break;
            }
            if (movePct <= stopMovePct) {
              log(
                "executor_warn",
                `Chronos ${modeLabel} stop hit (${movePct.toFixed(2)}%) on ${baseMint.slice(0, 8)} — swapping immediately`
              );
              break;
            }
          }
        }
      } catch {
        // Proceed immediately to swap if bounce/breakout polling fails
      }
    }
  }

  const attempts = Math.max(1, Number(config.management.autoSwapRetryAttempts ?? 3));
  const delayMs = Math.max(0, Number(config.management.autoSwapRetryDelayMs ?? 3000));
  let lastErr = "";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const balances = await getWalletBalances({ force: true });
      if ("error" in balances) throw new Error("Balance unavailable after transaction");
      const token = balances.tokens?.find((t) => t.mint === baseMint);
      if (!token || token.balance <= 0 || (token.usd != null && token.usd < 0.1)) {
        return { swapped: attempt > 1, result: null, token: null };
      }
      log(
        "executor",
        `Auto-swapping ${label} ${token.symbol || baseMint.slice(0, 8)} ($${token.usd == null ? "unknown" : token.usd.toFixed(2)}) back to SOL (attempt ${attempt}/${attempts})`
      );
      const swapResult = await swapToken({
        input_mint: baseMint,
        output_mint: "SOL",
        amount: token.balance,
      });
      const ok =
        swapResult &&
        !("success" in swapResult && swapResult.success === false) &&
        !("error" in swapResult && Boolean(swapResult.error)) &&
        ("tx" in swapResult || "amount_out" in swapResult);
      if (ok && "success" in swapResult && swapResult.success) {
        return { swapped: true, result: swapResult, token };
      }
      lastErr =
        ("error" in swapResult && typeof swapResult.error === "string" && swapResult.error) ||
        ("reason" in swapResult && typeof swapResult.reason === "string" && swapResult.reason) ||
        "swap returned no tx";
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    log("executor_warn", `Auto-swap ${label} attempt ${attempt}/${attempts} failed: ${lastErr}`);
    if (attempt < attempts) await sleep(delayMs);
  }

  log(
    "executor_warn",
    `Auto-swap ${label} failed after ${attempts} attempts — base token left unsold (${baseMint.slice(0, 8)})`
  );
  return { swapped: false, result: null, token: null };
}

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name: string, args: unknown = {}): Promise<ToolResult> {
  const cleanName = name.replace(/<.*$/, "").trim();
  if (WRITE_TOOLS.has(cleanName)) {
    return withWalletLock(
      async () => {
        try {
          return await executeToolUnlocked(cleanName, args);
        } finally {
          invalidateBalances();
        }
      },
      cleanName === "close_position" ? 10 : cleanName === "deploy_position" ? 0 : 5
    );
  }
  return executeToolUnlocked(cleanName, args);
}

async function executeToolUnlocked(name: string, rawArgs: unknown): Promise<ToolResult> {
  const startTime = Date.now();
  const cleanName = name.replace(/<.*$/, "").trim();

  const fn = toolMap[cleanName];
  if (!fn) {
    const error = `Unknown tool: ${cleanName}`;
    log("error", error);
    return { error };
  }

  const argsObj =
    typeof rawArgs === "object" && rawArgs !== null
      ? (rawArgs as Record<string, unknown>)
      : {};

  if (PROTECTED_TOOLS.has(cleanName)) {
    const safetyCheck = await runSafetyChecks(cleanName, argsObj);
    if (!safetyCheck.pass) {
      const reason = safetyCheck.reason ?? "Safety check rejected execution";
      log("safety_block", `${cleanName} blocked: ${reason}`);
      return {
        blocked: true,
        reason,
      };
    }
  }

  try {
    const result = (await fn(argsObj)) as Record<string, unknown>;
    const duration = Date.now() - startTime;
    const success = result.success !== false && !result.error;

    logAction({
      tool: cleanName,
      args: argsObj,
      result: summarizeResult(result),
      duration_ms: duration,
      success: Boolean(success),
    });

    if (success) {
      if (cleanName === "swap_token" && typeof result.tx === "string") {
        const inputMint = typeof argsObj.input_mint === "string" ? argsObj.input_mint : "";
        const outputMint = typeof argsObj.output_mint === "string" ? argsObj.output_mint : "";
        notifySwap({
          inputSymbol: inputMint.slice(0, 8),
          outputSymbol:
            outputMint === "So11111111111111111111111111111111111111112" || outputMint === "SOL"
              ? "SOL"
              : outputMint.slice(0, 8),
          amountIn: Number(result.amount_in ?? 0),
          amountOut: Number(result.amount_out ?? 0),
          tx: result.tx,
        }).catch(() => {});
      } else if (cleanName === "deploy_position") {
        const poolName =
          typeof result.pool_name === "string"
            ? result.pool_name
            : typeof argsObj.pool_name === "string"
              ? argsObj.pool_name
              : typeof argsObj.pool_address === "string"
                ? argsObj.pool_address.slice(0, 8)
                : "";
        const amountSol = Number(argsObj.amount_y ?? argsObj.amount_sol ?? 0);
        const position = typeof result.position === "string" ? result.position : "";
        const txs = Array.isArray(result.txs) ? (result.txs as string[]) : [];
        const tx = txs[0] ?? (typeof result.tx === "string" ? result.tx : "");

        notifyDeploy({
          pair: poolName,
          amountSol,
          position,
          tx,
          priceRange: result.price_range as { min: number; max: number } | undefined,
          rangeCoverage: result.range_coverage as
            | { downside_pct: number | null; upside_pct: number | null; width_pct: number | null }
            | undefined,
          binStep: typeof result.bin_step === "number" ? result.bin_step : undefined,
          baseFee: typeof result.base_fee === "number" ? result.base_fee : null,
        }).catch(() => {});
      } else if (cleanName === "close_position") {
        const pair =
          typeof result.pool_name === "string"
            ? result.pool_name
            : typeof argsObj.position_address === "string"
              ? argsObj.position_address.slice(0, 8)
              : "";
        notifyClose({
          pair,
          pnlUsd: Number(result.pnl_usd ?? 0),
          pnlSol: typeof result.pnl_sol === "number" ? result.pnl_sol : undefined,
          pnlPct: Number(result.pnl_pct ?? 0),
          solMode: config.management.solMode,
        }).catch(() => {});

        const reason = typeof argsObj.reason === "string" ? argsObj.reason : "";
        if (reason && reason.toLowerCase().includes("yield")) {
          const poolAddr =
            typeof result.pool === "string"
              ? result.pool
              : typeof argsObj.pool_address === "string"
                ? argsObj.pool_address
                : "";
          if (poolAddr) {
            try {
              addPoolNote({
                pool_address: poolAddr,
                note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0, 10)}`,
              });
            } catch {
              // ignore note errors
            }
          }
        }

        const baseMint = typeof result.base_mint === "string" ? result.base_mint : "";
        if (!argsObj.skip_swap && baseMint) {
          const poolAddr =
            typeof result.pool === "string"
              ? result.pool
              : typeof argsObj.pool_address === "string"
                ? argsObj.pool_address
                : null;
          const { swapped, result: swapResult } = await swapBaseToSolWithRetry(
            baseMint,
            "after close",
            poolAddr
          );
          if (swapped) {
            result.auto_swapped = true;
            result.auto_swap_note = `Base token already auto-swapped back to SOL (${baseMint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
            if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
          }
        }
      } else if (cleanName === "claim_fees" && config.management.autoSwapAfterClaim) {
        const baseMint = typeof result.base_mint === "string" ? result.base_mint : "";
        const poolAddr =
          typeof result.pool === "string"
            ? result.pool
            : typeof argsObj.pool_address === "string"
              ? argsObj.pool_address
              : null;
        if (baseMint) {
          await swapBaseToSolWithRetry(baseMint, "after claim", poolAddr);
        }
      }
    }

    return result as ToolResult;
  } catch (error: unknown) {
    const duration = Date.now() - startTime;
    const msg = error instanceof Error ? error.message : String(error);

    logAction({
      tool: cleanName,
      args: argsObj,
      error: msg,
      duration_ms: duration,
      success: false,
    });

    return {
      error: msg,
      tool: cleanName,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(
  name: string,
  args: Record<string, unknown>
): Promise<SafetyCheckResult> {
  switch (name) {
    case "deploy_position": {
      if (typeof args.before_submit !== "function") {
        return { pass: false, reason: "Entries require wallet-convergence signal" };
      }

      const parsedDeployArgs = DeployPositionToolArgsSchema.safeParse(args);
      if (!parsedDeployArgs.success) {
        return {
          pass: false,
          reason: `Invalid deploy_position arguments: ${parsedDeployArgs.error.message}`,
        };
      }

      const poolThresholds = await validateDeployPoolThresholds(parsedDeployArgs.data);
      if (!poolThresholds.pass) return poolThresholds;
      if (poolThresholds.entryMarketData) Object.assign(args, poolThresholds.entryMarketData);

      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (
        typeof args.bin_step === "number" &&
        (args.bin_step < minStep || args.bin_step > maxStep)
      ) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      const deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      const requestedBinsBelow = Number(
        args.bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow
      );
      const requestedBinsAbove = Number(args.bins_above ?? 0);
      const minBinsBelow = Math.max(
        MIN_SAFE_BINS_BELOW,
        Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW)
      );
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0 && requestedBinsAbove <= 0;
      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);

      if (
        args.volatility != null &&
        (!Number.isFinite(requestedVolatility) || (requestedVolatility != null && requestedVolatility <= 0))
      ) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} invalid. Refusing deploy because volatility feed unusable.`,
        };
      }

      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }

      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsBelow) ||
          requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }

      if (
        isSingleSidedSol &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsAbove !== 0)
      ) {
        return {
          pass: false,
          reason: "Single-side SOL deploy must have bins_above=0.",
        };
      }

      const positions = await getMyPositions({ force: true });
      if (positions.error || !Array.isArray(positions.positions)) {
        return { pass: false, reason: "Position read unavailable" };
      }
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }

      const targetPool = typeof args.pool_address === "string" ? args.pool_address : "";
      const alreadyInPool = positions.positions.some((p) => p.pool === targetPool);
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already open position in pool ${targetPool}. Cannot open duplicate.`,
        };
      }

      if (typeof args.base_mint === "string" && args.base_mint) {
        const alreadyHasMint = positions.positions.some((p) => p.base_mint === args.base_mint);
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      const amountY = deployAmountY;
      if (!Number.isFinite(amountY) || amountY <= 0) {
        return {
          pass: false,
          reason: "Must provide a positive SOL amount (amount_y).",
        };
      }

      const minDeploy = Math.max(
        0.1,
        parseFloat((config.management.deployAmountSol * 0.75).toFixed(2))
      );
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances({ force: true, nativeOnly: true });
        if ("error" in balance || balance.sol == null || !Number.isFinite(balance.sol)) {
          return { pass: false, reason: "Balance read unavailable" };
        }
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

function summarizeResult(result: unknown): string | Record<string, unknown> | null {
  try {
    const str = JSON.stringify(result);
    if (str && str.length > 1000) {
      return str.slice(0, 1000) + "...(truncated)";
    }
    if (typeof result === "object" && result !== null) {
      return result as Record<string, unknown>;
    }
    return str ?? null;
  } catch {
    return String(result);
  }
}
