import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config, computeDeployAmount } from "../config.js";
import { log } from "../logger.js";
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  recordClaim,
  recordClose,
  getTrackedPosition,
  minutesOutOfRange,
  syncOpenPositions,
} from "../state.js";
import { recordPerformance } from "../lessons.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { normalizeMint } from "./wallet.js";
import { appendDecision } from "../decision-log.js";
import { agentMeridianJson, getAgentIdForRequests, getAgentMeridianHeaders } from "./agent-meridian.js";

// ─── Lazy SDK loader ───────────────────────────────────────────
// @meteora-ag/dlmm → @coral-xyz/anchor uses CJS directory imports
// that break in ESM on Node 24. Dynamic import defers loading until
// an actual on-chain call is needed (never triggered in dry-run).
let _DLMM = null;
let _StrategyType = null;
let _getBinIdFromPrice = null;
let _getPriceOfBinByBinId = null;

async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
    _getBinIdFromPrice = mod.default?.getBinIdFromPrice;
    _getPriceOfBinByBinId = mod.getPriceOfBinByBinId;
  }
  return {
    DLMM: _DLMM,
    StrategyType: _StrategyType,
    getBinIdFromPrice: _getBinIdFromPrice,
    getPriceOfBinByBinId: _getPriceOfBinByBinId,
  };
}

// ─── Lazy wallet/connection init ──────────────────────────────
// Avoids crashing on import when WALLET_PRIVATE_KEY is not yet set
// (e.g. during screening-only tests).
let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) {
    _connection = new Connection(process.env.RPC_URL, "confirmed");
  }
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) {
      throw new Error("WALLET_PRIVATE_KEY not set");
    }
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    log("init", `Wallet: ${_wallet.publicKey.toString()}`);
  }
  return _wallet;
}

function shouldUseLpAgentRelay() {
  return !!config.api.lpAgentRelayEnabled;
}

function shouldUseLpAgentRelayForDeploy() {
  // Zap-in relay is intentionally disabled; deploys use the local Meteora SDK path.
  return false;
}

function signSerializedTransaction(serialized, wallet) {
  const bytes = Buffer.from(serialized, "base64");
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    versioned.sign([wallet]);
    return Buffer.from(versioned.serialize()).toString("base64");
  } catch {
    const legacy = Transaction.from(bytes);
    legacy.partialSign(wallet);
    return legacy
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }
}

function signSerializedTransactions(serializedTxs, wallet) {
  return (serializedTxs || [])
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .map((entry) => signSerializedTransaction(entry, wallet));
}

function normalizeExecutionSignatures(result) {
  const signatures = [];
  const seen = new Set();
  for (const value of []
    .concat(result?.signatures || [])
    .concat(result?.result?.txHashes || [])
    .concat(result?.result?.signatures || [])
    .concat(result?.result?.signature ? [result.result.signature] : [])) {
    if (typeof value !== "string" || !value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    signatures.push(value);
  }
  return signatures;
}

// ─── Pool Cache ────────────────────────────────────────────────
const poolCache = new Map();
const poolMetadataCache = new Map();

async function getPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  return poolCache.get(key);
}

setInterval(() => poolCache.clear(), 5 * 60 * 1000);
setInterval(() => poolMetadataCache.clear(), 15 * 60 * 1000);

async function getPoolMetadata(poolAddress) {
  const key = String(poolAddress);
  if (poolMetadataCache.has(key)) {
    return poolMetadataCache.get(key);
  }

  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${key}`);
    if (!res.ok) {
      throw new Error(`Pool metadata API ${res.status}`);
    }

    const data = await res.json();
    const tokenX = data?.token_x?.symbol || null;
    const tokenY = data?.token_y?.symbol || null;
    const pair = data?.name || (tokenX && tokenY ? `${tokenX}-${tokenY}` : null);
    const meta = {
      address: data?.address || key,
      name: pair,
      token_x_symbol: tokenX,
      token_y_symbol: tokenY,
    };
    poolMetadataCache.set(key, meta);
    return meta;
  } catch (error) {
    log("pool_meta_warn", `Pool metadata lookup failed for ${key.slice(0, 8)}: ${error.message}`);
    const fallback = { address: key, name: null, token_x_symbol: null, token_y_symbol: null };
    poolMetadataCache.set(key, fallback);
    return fallback;
  }
}

// ─── Get Active Bin ────────────────────────────────────────────
export async function getActiveBin({ pool_address }) {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price)),
    pricePerLamport: activeBin.price.toString(),
  };
}

// ─── Deploy Position ───────────────────────────────────────────
export async function deployPosition({
  pool_address,
  amount_sol, // legacy: will be used as amount_y if amount_y is not provided
  amount_x,
  amount_y,
  strategy,
  bins_below,
  bins_above,
  downside_pct,
  upside_pct,
  // optional pool metadata for learning (passed by agent when available)
  pool_name,
  bin_step,
  base_fee,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
}) {
  pool_address = normalizeMint(pool_address);
  const activeStrategy = strategy || config.strategy.strategy;
  let activeBinsBelow = bins_below ?? config.strategy.binsBelow;
  let activeBinsAbove = bins_above ?? 0;

  if (isPoolOnCooldown(pool_address)) {
    log("deploy", `Pool ${pool_address.slice(0, 8)} is on cooldown — skipping`);
    return { success: false, error: "Pool on cooldown — was recently closed with a cooldown reason. Try a different pool." };
  }

  const { StrategyType, getBinIdFromPrice, getPriceOfBinByBinId } = await getDLMM();
  const pool = await getPool(pool_address);
  const baseMint = pool.lbPair.tokenXMint.toString();
  if (isBaseMintOnCooldown(baseMint)) {
    log("deploy", `Base mint ${baseMint.slice(0, 8)} is on cooldown — skipping deploy for pool ${pool_address.slice(0, 8)}`);
    return { success: false, error: "Token on cooldown — recently closed out-of-range too many times. Try a different token." };
  }
  const activeBin = await pool.getActiveBin();
  const actualBinStep = pool.lbPair.binStep;
  const activePrice = Number(getPriceOfBinByBinId(activeBin.binId, actualBinStep).toString());

  if (downside_pct != null || upside_pct != null) {
    const downsidePct = Math.max(0, Number(downside_pct ?? 0));
    const upsidePct = Math.max(0, Number(upside_pct ?? 0));

    if (!Number.isFinite(downsidePct) || !Number.isFinite(upsidePct)) {
      throw new Error("downside_pct and upside_pct must be valid numbers.");
    }
    if (downsidePct >= 100) {
      throw new Error("downside_pct must be less than 100.");
    }

    const lowerTargetPrice = activePrice * (1 - downsidePct / 100);
    const upperTargetPrice = activePrice * (1 + upsidePct / 100);
    const lowerBinId = getBinIdFromPrice(lowerTargetPrice, actualBinStep, true);
    const upperBinId = getBinIdFromPrice(upperTargetPrice, actualBinStep, false);

    activeBinsBelow = Math.max(0, activeBin.binId - lowerBinId);
    activeBinsAbove = Math.max(0, upperBinId - activeBin.binId);
  }

  if (process.env.DRY_RUN === "true") {
    const totalBins = activeBinsBelow + activeBinsAbove;
    return {
      dry_run: true,
      would_deploy: {
        pool_address,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
        amount_x: amount_x || 0,
        amount_y: amount_y || amount_sol || 0,
        wide_range: totalBins > 69,
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  const strategyMap = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };

  const strategyType = strategyMap[activeStrategy];
  if (strategyType === undefined) {
    throw new Error(`Invalid strategy: ${activeStrategy}. Use spot, curve, or bid_ask.`);
  }

  // Calculate amounts
  // If no explicit SOL amount is provided, fall back to the configured dynamic deploy size.
  const fallbackAmountY =
    amount_y == null && amount_sol == null
      ? computeDeployAmount((await getWalletBalances()).sol)
      : 0;
  const finalAmountY = amount_y ?? amount_sol ?? fallbackAmountY;
  const finalAmountX = amount_x ?? 0;
  const isSingleSidedSol = finalAmountX <= 0 && finalAmountY > 0;
  if (isSingleSidedSol && (Number(bins_above ?? 0) > 0 || Number(upside_pct ?? 0) > 0)) {
    throw new Error(
      "Single-side SOL deploy cannot use bins_above or upside_pct. Use amount_y with bins_below only; the upper bin is the SDK active bin.",
    );
  }
  if (isSingleSidedSol) {
    activeBinsAbove = 0;
  }
  const totalBins = activeBinsBelow + activeBinsAbove;
  const isWideRange = totalBins > 69;
  const minBinId = activeBin.binId - activeBinsBelow;
  const maxBinId = isSingleSidedSol ? activeBin.binId : activeBin.binId + activeBinsAbove;

  if (minBinId > maxBinId) {
    throw new Error(`Invalid bin range: ${minBinId} -> ${maxBinId}`);
  }
  if (isSingleSidedSol && maxBinId !== activeBin.binId) {
    throw new Error(
      `Single-side SOL deploy must end at the SDK active bin. Expected ${activeBin.binId}, got ${maxBinId}.`,
    );
  }

  const minPrice = Number(getPriceOfBinByBinId(minBinId, actualBinStep).toString());
  const maxPrice = Number(getPriceOfBinByBinId(maxBinId, actualBinStep).toString());
  const downsideCoveragePct = activePrice > 0 ? ((activePrice - minPrice) / activePrice) * 100 : null;
  const upsideCoveragePct = activePrice > 0 ? ((maxPrice - activePrice) / activePrice) * 100 : null;
  const totalWidthPct = minPrice > 0 ? ((maxPrice - minPrice) / minPrice) * 100 : null;

  // Read base fee directly from pool — baseFactor * binStep / 10^6 gives fee in %
  const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
  const actualBaseFee = base_fee ?? (baseFactor > 0 ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4)) : null);

  const totalYLamports = new BN(Math.floor(finalAmountY * 1e9));
  // Token X amount uses mint decimals when available, falling back to 9.
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
  }

  if (shouldUseLpAgentRelayForDeploy()) {
    try {
      const wallet = getWallet();
      log(
        "deploy",
        `Relay deploy via Agent Meridian: ${pool_address} activeBin ${activeBin.binId} bins ${minBinId}->${maxBinId} amountY=${finalAmountY}`,
      );
      const order = await agentMeridianJson("/execution/zap-in/order", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          agentId: getAgentIdForRequests(),
          idempotencyKey: `deploy:${pool_address}:${minBinId}:${maxBinId}:${finalAmountY}:${finalAmountX}`,
          poolId: pool_address,
          owner: wallet.publicKey.toString(),
          strategy: activeStrategy === "spot" ? "Spot" : "BidAsk",
          inputSOL: finalAmountY,
          amountY: finalAmountY,
          amountX: finalAmountX,
          percentX: finalAmountX > 0 && finalAmountY > 0 ? 0.5 : 0,
          fromBinId: minBinId,
          toBinId: maxBinId,
          slippageBps: 500,
          provider: "JUPITER_ULTRA",
        }),
      });

      const addLiquidityUnsigned = order?.order?.transactions?.addLiquidity || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (addLiquidityUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent order returned no transactions. Check the pool address, deploy amount, and selected range.");
      }

      const addLiquidity = signSerializedTransactions(addLiquidityUnsigned, wallet);
      const swap = signSerializedTransactions(swapUnsigned, wallet);
      const submit = await agentMeridianJson("/execution/zap-in/submit", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            addLiquidity,
            swap,
          },
          meta: {
            pool: pool_address,
            strategy: activeStrategy,
          },
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 5000));
      _positionsCacheAt = 0;
      const refreshed = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const matching = refreshed?.positions?.find(
        (position) => position.pool === pool_address && position.lower_bin === minBinId && position.upper_bin === maxBinId,
      ) || refreshed?.positions?.find((position) => position.pool === pool_address);

      const positionAddress = matching?.position || null;
      if (positionAddress) {
        trackPosition({
          position: positionAddress,
          pool: pool_address,
          pool_name,
          strategy: activeStrategy,
          bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
          bin_step,
          volatility,
          fee_tvl_ratio,
          organic_score,
          amount_sol: finalAmountY,
          amount_x: finalAmountX,
          active_bin: activeBin.binId,
          initial_value_usd,
        });
      }

      appendDecision({
        type: "deploy",
        actor: "SCREENER",
        pool: pool_address,
        pool_name,
        position: positionAddress,
        summary: `Relay deployed ${finalAmountY} SOL with ${activeStrategy}`,
        reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
        risks: [
          volatility != null ? `volatility ${volatility}` : null,
          fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
        ].filter(Boolean),
        metrics: {
          amount_sol: finalAmountY,
          strategy: activeStrategy,
          active_bin: activeBin.binId,
          min_bin: minBinId,
          max_bin: maxBinId,
          downside_pct: downside_pct ?? downsideCoveragePct,
          upside_pct: upside_pct ?? upsideCoveragePct,
        },
      });

      return {
        success: true,
        relay: true,
        request_id: order.requestId,
        position: positionAddress,
        pool: pool_address,
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
        txs: normalizeExecutionSignatures(submit),
      };
    } catch (error) {
      log("deploy_error", `Relay deploy failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  const wallet = getWallet();
  const newPosition = Keypair.generate();

  log("deploy", `Pool: ${pool_address}`);
  log("deploy", `Strategy: ${activeStrategy}, Bins: ${minBinId} to ${maxBinId} (${totalBins} bins${isWideRange ? " — WIDE RANGE" : ""})`);
  log("deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
  log("deploy", `Position: ${newPosition.publicKey.toString()}`);

  try {
    const txHashes = [];

    if (isWideRange) {
      // ── Wide Range Path (>69 bins) ─────────────────────────────────
      // Solana limits inner instruction realloc to 10240 bytes, so we can't create
      // a large position in a single initializePosition ix.
      // Solution: createExtendedEmptyPosition (returns Transaction | Transaction[]),
      //           then addLiquidityByStrategyChunkable (returns Transaction[]).

      // Phase 1: Create empty position (may be multiple txs)
      const createTxs = await pool.createExtendedEmptyPosition(
        minBinId,
        maxBinId,
        newPosition.publicKey,
        wallet.publicKey,
      );
      const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
      for (let i = 0; i < createTxArray.length; i++) {
        const signers = i === 0 ? [wallet, newPosition] : [wallet];
        const txHash = await sendAndConfirmTransaction(getConnection(), createTxArray[i], signers);
        txHashes.push(txHash);
        log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
      }

      // Phase 2: Add liquidity (may be multiple txs)
      const addTxs = await pool.addLiquidityByStrategyChunkable({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { minBinId, maxBinId, strategyType },
        slippage: 10, // 10%
      });
      const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
      for (let i = 0; i < addTxArray.length; i++) {
        const txHash = await sendAndConfirmTransaction(getConnection(), addTxArray[i], [wallet]);
        txHashes.push(txHash);
        log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
      }
    } else {
      // ── Standard Path (≤69 bins) ─────────────────────────────────
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { maxBinId, minBinId, strategyType },
        slippage: 1000, // 10% in bps
      });
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet, newPosition]);
      txHashes.push(txHash);
    }

    log("deploy", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]}`);

    _positionsCacheAt = 0;
    trackPosition({
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      strategy: activeStrategy,
      bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
      bin_step,
      volatility,
      fee_tvl_ratio,
      organic_score,
      amount_sol: finalAmountY,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      initial_value_usd,
    });

    appendDecision({
      type: "deploy",
      actor: "SCREENER",
      pool: pool_address,
      pool_name,
      position: newPosition.publicKey.toString(),
      summary: `Deployed ${finalAmountY} SOL with ${activeStrategy}`,
      reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
      risks: [
        volatility != null ? `volatility ${volatility}` : null,
        fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
      ].filter(Boolean),
      metrics: {
        amount_sol: finalAmountY,
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
      pool: pool_address,
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
      txs: txHashes,
    };
  } catch (error) {
    log("deploy_error", error.message);
    return { success: false, error: error.message };
  }
}

const POSITIONS_CACHE_TTL = 5 * 60_000; // 5 minutes

let _positionsCache = null;
let _positionsCacheAt = 0;
let _positionsInflight = null; // deduplicates concurrent calls
const LPAGENT_API = "https://api.lpagent.io/open-api/v1";

async function fetchLpAgentOpenPositions(walletAddress) {
  if (!process.env.LPAGENT_API_KEY) return {};

  const url = `${LPAGENT_API}/lp-positions/opening?owner=${walletAddress}`;
  try {
    const res = await fetch(url, {
      headers: {
        "x-api-key": process.env.LPAGENT_API_KEY,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("lpagent_api", `HTTP ${res.status} for owner ${walletAddress.slice(0, 8)}: ${body.slice(0, 160)}`);
      return {};
    }
    const data = await res.json();
    const positions = data?.data || [];
    const byAddress = {};
    for (const p of positions) {
      const addr = p.position || p.id || p.tokenId;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("lpagent_api", `Fetch error for owner ${walletAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── Fetch DLMM PnL API for all positions in a pool ────────────
async function fetchDlmmPnlForPool(poolAddress, walletAddress) {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("pnl_api", `HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return {};
    }
    const data = await res.json();
    const positions = data.positions || data.data || [];
    if (positions.length === 0) {
      log("pnl_api", `No positions returned for pool ${poolAddress.slice(0, 8)} — keys: ${Object.keys(data).join(", ")}`);
    }
    const byAddress = {};
    for (const p of positions) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("pnl_api", `Fetch error for pool ${poolAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── Get Position PnL (Meteora API) ─────────────────────────────
export async function getPositionPnl({ pool_address, position_address }) {
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  const walletAddress = getWallet().publicKey.toString();
  if (shouldUseLpAgentRelay()) {
    try {
      const payload = await fetchOpenPositionsFromMeridian({
        walletAddress,
        agentId: getAgentIdForRequests(),
      });
      const p = payload?.positions?.find((position) => position.position === position_address);
      if (p) {
        return {
          pnl_usd: p.pnl_usd,
          pnl_pct: p.pnl_pct,
          current_value_usd: p.total_value_usd,
          unclaimed_fee_usd: p.unclaimed_fees_usd,
          all_time_fees_usd: p.collected_fees_usd,
          fee_per_tvl_24h: p.fee_per_tvl_24h,
          in_range: p.in_range,
          lower_bin: p.lower_bin,
          upper_bin: p.upper_bin,
          active_bin: p.active_bin,
          age_minutes: p.age_minutes,
          request_id: payload?.requestId || null,
        };
      }
      log("pnl_warn", "Relay positions API did not include requested position; falling back to Meteora PnL path");
    } catch (error) {
      log("pnl_warn", `Relay PnL lookup failed; falling back to Meteora PnL path: ${error.message}`);
    }
  }
  try {
    const byAddress = await fetchDlmmPnlForPool(pool_address, walletAddress);
    const p = byAddress[position_address];
    if (!p) return { error: "Position not found in PnL API" };

    const unclaimedUsd    = parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0);
    const currentValueUsd = parseFloat(p.unrealizedPnl?.balances || 0);
    return {
      pnl_usd:           Math.round((p.pnlUsd ?? 0) * 100) / 100,
      pnl_pct:           Math.round((p.pnlPctChange ?? 0) * 100) / 100,
      current_value_usd: Math.round(currentValueUsd * 100) / 100,
      unclaimed_fee_usd: Math.round(unclaimedUsd * 100) / 100,
      all_time_fees_usd: Math.round(parseFloat(p.allTimeFees?.total?.usd || 0) * 100) / 100,
      fee_per_tvl_24h:   Math.round(parseFloat(p.feePerTvl24h || 0) * 100) / 100,
      in_range:    !p.isOutOfRange,
      lower_bin:   p.lowerBinId      ?? null,
      upper_bin:   p.upperBinId      ?? null,
      active_bin:  p.poolActiveBinId ?? null,
      age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
    };
  } catch (error) {
    log("pnl_error", error.message);
    return { error: error.message };
  }
}

function safeNum(value) {
  const n = parseFloat(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeRelayPosition(position) {
  if (!position || typeof position !== "object") return position;
  if (!config.management.solMode) return position;

  const totalValueNative = position.total_value_native ?? position.total_value_usd;
  const unclaimedFeesNative = position.unclaimed_fees_native ?? position.unclaimed_fees_usd;
  const collectedFeesNative = position.collected_fees_native ?? position.collected_fees_usd;
  const pnlNative = position.pnl_native ?? position.pnl_usd;
  const derivedPnlPct = position.pnl_pct_derived_native ?? position.pnl_pct_derived;

  return {
    ...position,
    total_value_usd: totalValueNative,
    unclaimed_fees_usd: unclaimedFeesNative,
    collected_fees_usd: collectedFeesNative,
    pnl_usd: pnlNative,
    pnl_pct_derived: derivedPnlPct,
  };
}

function deriveOpenPnlPct(binData, solMode = false) {
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

function deriveLpAgentPnlPct(lpData, solMode = false) {
  if (!lpData) return null;
  const deposit = solMode ? safeNum(lpData.inputNative) : safeNum(lpData.inputValue);
  if (deposit <= 0) return null;

  const currentValue = solMode ? safeNum(lpData.valueNative) : safeNum(lpData.value);
  const unclaimedFees = solMode ? safeNum(lpData.unCollectedFeeNative) : safeNum(lpData.unCollectedFee);
  const pnl = currentValue + unclaimedFees - deposit;
  return (pnl / deposit) * 100;
}

async function fetchOpenPositionsFromMeridian({ walletAddress, agentId }) {
  const search = new URLSearchParams({
    owner: walletAddress,
    agentId: agentId || "agent-local",
  });
  const payload = await agentMeridianJson(`/positions/open?${search.toString()}`, {
    headers: getAgentMeridianHeaders(),
    retry: {
      maxElapsedMs: 30_000,
      perAttemptTimeoutMs: 10_000,
    },
  });
  return {
    ...payload,
    positions: Array.isArray(payload?.positions)
      ? payload.positions.map((position) => normalizeRelayPosition(position))
      : [],
  };
}

// ─── Get My Positions ──────────────────────────────────────────
export async function getMyPositions({ force = false, silent = false } = {}) {
  if (!force && _positionsCache && Date.now() - _positionsCacheAt < POSITIONS_CACHE_TTL) {
    return _positionsCache;
  }
  if (_positionsInflight) return _positionsInflight;

  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  _positionsInflight = (async () => { try {
    if (shouldUseLpAgentRelay()) {
      try {
        if (!silent) log("positions", "Fetching open positions via Agent Meridian relay...");
        const result = await fetchOpenPositionsFromMeridian({
          walletAddress,
          agentId: getAgentIdForRequests(),
        });
        const normalizedPositions = Array.isArray(result.positions) ? result.positions : [];
        syncOpenPositions(normalizedPositions.map((p) => p.position));
        _positionsCache = {
          wallet: walletAddress,
          total_positions: Number(result.total_positions || 0),
          positions: normalizedPositions,
          request_id: result.requestId || null,
        };
        _positionsCacheAt = Date.now();
        return _positionsCache;
      } catch (error) {
        log("positions_warn", `Agent Meridian relay failed; falling back to Meteora/local positions path: ${error.message}`);
      }
    }

    // Portfolio API discovers open pools/positions for this wallet.
    // Detailed range data stays on Meteora PnL API; value/PnL can be overridden by LPAgent below.
    if (!silent) log("positions", "Fetching portfolio via Meteora portfolio API...");
    const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
    const res = await fetch(portfolioUrl);
    if (!res.ok) throw new Error(`Portfolio API ${res.status}: ${await res.text().catch(() => "")}`);
    const portfolio = await res.json();

    const pools = portfolio.pools || [];
    log("positions", `Found ${pools.length} pool(s) with open positions`);

    // Fetch bin data (lowerBinId, upperBinId, poolActiveBinId) for all pools in parallel
    // Needed for rules 3 & 4 (active_bin vs upper_bin comparison)
    const binDataByPool = {};
    const pnlMaps = await Promise.all(pools.map(pool => fetchDlmmPnlForPool(pool.poolAddress, walletAddress)));
    pools.forEach((pool, i) => { binDataByPool[pool.poolAddress] = pnlMaps[i]; });
    const lpAgentByPosition = await fetchLpAgentOpenPositions(walletAddress);

    const positions = [];
    for (const pool of pools) {
      for (const positionAddress of (pool.listPositions || [])) {
        const tracked = getTrackedPosition(positionAddress);
        const isOOR = pool.outOfRange || pool.positionsOutOfRange?.includes(positionAddress);

        if (isOOR) markOutOfRange(positionAddress);
        else markInRange(positionAddress);

        // Bin data: from supplemental PnL call (OOR) or tracked state (in-range)
        const binData = binDataByPool[pool.poolAddress]?.[positionAddress];
        if (!binData) {
          log("positions_warn", `PnL API missing data for ${positionAddress.slice(0, 8)} in pool ${pool.poolAddress.slice(0, 8)} — using portfolio only for open-position discovery`);
        }
        const lowerBin  = binData?.lowerBinId      ?? tracked?.bin_range?.min ?? null;
        const upperBin  = binData?.upperBinId      ?? tracked?.bin_range?.max ?? null;
        const activeBin = binData?.poolActiveBinId ?? tracked?.bin_range?.active ?? null;
        const lpData = lpAgentByPosition[positionAddress] || null;

        const ageFromState = tracked?.deployed_at
          ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
          : null;
        const reportedPnlPct = lpData
          ? parseFloat(config.management.solMode ? (lpData.pnl?.percentNative || 0) : (lpData.pnl?.percent || 0))
          : binData
            ? parseFloat(config.management.solMode ? (binData.pnlSolPctChange || 0) : (binData.pnlPctChange || 0))
            : null;
        const derivedPnlPct = lpData
          ? deriveLpAgentPnlPct(lpData, config.management.solMode)
          : binData
            ? deriveOpenPnlPct(binData, config.management.solMode)
            : null;
        const pnlPctDiff = reportedPnlPct != null && derivedPnlPct != null
          ? Math.abs(reportedPnlPct - derivedPnlPct)
          : null;
        const pnlPctSuspicious = pnlPctDiff != null && pnlPctDiff > (config.management.pnlSanityMaxDiffPct ?? 5);
        if (pnlPctSuspicious) {
          log("positions_warn", `Suspicious pnl_pct for ${positionAddress.slice(0, 8)}: reported=${reportedPnlPct.toFixed(2)} derived=${derivedPnlPct.toFixed(2)} diff=${pnlPctDiff.toFixed(2)}`);
        }

        positions.push({
          position:           positionAddress,
          pool:               pool.poolAddress,
          pair:               tracked?.pool_name || `${pool.tokenX}/${pool.tokenY}`,
          base_mint:          pool.tokenXMint,
          lower_bin:          lowerBin,
          upper_bin:          upperBin,
          active_bin:         activeBin,
          in_range:           binData ? !binData.isOutOfRange : !isOOR,
          unclaimed_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.unCollectedFeeNative)
                  : safeNum(lpData.unCollectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol || 0)
                  : parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)
              ) * 10000) / 10000
            : null,
          total_value_usd:    lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.valueNative)
                  : safeNum(lpData.value)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.balancesSol || 0)
                  : parseFloat(binData.unrealizedPnl?.balances || 0)
              ) * 10000) / 10000
            : null,
          // Always-USD fields for internal accounting and lesson recording.
          total_value_true_usd: lpData
            ? Math.round(safeNum(lpData.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.unrealizedPnl?.balances || 0) * 10000) / 10000
            : null,
          collected_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.collectedFeeNative)
                  : safeNum(lpData.collectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.allTimeFees?.total?.sol || 0) : (binData.allTimeFees?.total?.usd || 0)) * 10000) / 10000
            : null,
          collected_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.collectedFee) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.allTimeFees?.total?.usd || 0) * 10000) / 10000
            : null,
          pnl_usd:            lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.pnl?.valueNative)
                  : safeNum(lpData.pnl?.value)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.pnlSol || 0) : (binData.pnlUsd || 0)) * 10000) / 10000
            : null,
          pnl_true_usd:       lpData
            ? Math.round(safeNum(lpData.pnl?.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.pnlUsd || 0) * 10000) / 10000
            : null,
          pnl_pct:            (lpData || binData)
            ? Math.round(reportedPnlPct * 100) / 100
            : null,
          pnl_pct_derived:    derivedPnlPct != null ? Math.round(derivedPnlPct * 100) / 100 : null,
          pnl_pct_diff:       pnlPctDiff != null ? Math.round(pnlPctDiff * 100) / 100 : null,
          pnl_pct_suspicious: !!pnlPctSuspicious,
          unclaimed_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.unCollectedFee) * 10000) / 10000
            : binData
            ? Math.round((parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) * 10000) / 10000
            : null,
          fee_per_tvl_24h:    binData
            ? Math.round(parseFloat(binData.feePerTvl24h || 0) * 100) / 100
            : null,
          age_minutes:        binData?.createdAt ? Math.floor((Date.now() - binData.createdAt * 1000) / 60000) : ageFromState,
          minutes_out_of_range: minutesOutOfRange(positionAddress),
          instruction:        tracked?.instruction ?? null,
        });
      }
    }

    const result = { wallet: walletAddress, total_positions: positions.length, positions };
    syncOpenPositions(positions.map(p => p.position));
    _positionsCache = result;
    _positionsCacheAt = Date.now();
    return result;
  } catch (error) {
    log("positions_error", `Portfolio fetch failed: ${error.stack || error.message}`);
    return { wallet: walletAddress, total_positions: 0, positions: [], error: error.message };
  } finally {
    _positionsInflight = null;
  }
  })();
  return _positionsInflight;
}

// ─── Get Positions for Any Wallet ─────────────────────────────
export async function getWalletPositions({ wallet_address }) {
  try {
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: new PublicKey(wallet_address).toBase58() } }],
    });

    if (accounts.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    const raw = accounts.map((acc) => ({
      position: acc.pubkey.toBase58(),
      pool: new PublicKey(acc.account.data.slice(8, 40)).toBase58(),
    }));

    // Enrich with PnL API
    const uniquePools = [...new Set(raw.map((r) => r.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });

    const positions = raw.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;

      return {
        position:           r.position,
        pool:               r.pool,
        lower_bin:          p?.lowerBinId      ?? null,
        upper_bin:          p?.upperBinId      ?? null,
        active_bin:         p?.poolActiveBinId ?? null,
        in_range:           p ? !p.isOutOfRange : null,
        unclaimed_fees_usd: Math.round((p ? (parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) : 0) * 100) / 100,
        total_value_usd:    Math.round((p ? parseFloat(p.unrealizedPnl?.balances || 0) : 0) * 100) / 100,
        pnl_usd:            Math.round((p?.pnlUsd ?? 0) * 100) / 100,
        pnl_pct:            Math.round((p?.pnlPctChange ?? 0) * 100) / 100,
        age_minutes:        p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      };
    });

    return { wallet: wallet_address, total_positions: positions.length, positions };
  } catch (error) {
    log("wallet_positions_error", error.message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: error.message };
  }
}

// ─── Search Pools by Query ─────────────────────────────────────
export async function searchPools({ query, limit = 10 }) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool search API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const pools = (Array.isArray(data) ? data : data.data || []).slice(0, limit);
  return {
    query,
    total: pools.length,
    pools: pools.map((p) => ({
      pool: p.address || p.pool_address,
      name: p.name,
      bin_step: p.bin_step ?? p.dlmm_params?.bin_step,
      fee_pct: p.base_fee_percentage ?? p.fee_pct,
      tvl: p.liquidity,
      volume_24h: p.trade_volume_24h,
      token_x: { symbol: p.mint_x_symbol ?? p.token_x?.symbol, mint: p.mint_x ?? p.token_x?.address },
      token_y: { symbol: p.mint_y_symbol ?? p.token_y?.symbol, mint: p.mint_y ?? p.token_y?.address },
    })),
  };
}

// ─── Claim Fees ────────────────────────────────────────────────
export async function claimFees({ position_address }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_claim: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — fees were claimed during close" };
  }

  try {
    log("claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionData = await pool.getPosition(new PublicKey(position_address));
    const txs = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: positionData,
    });

    if (!txs || txs.length === 0) {
      return { success: false, error: "No fees to claim — transaction is empty" };
    }

    const txHashes = [];
    for (const tx of txs) {
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
      txHashes.push(txHash);
    }
    log("claim", `SUCCESS txs: ${txHashes.join(", ")}`);
    _positionsCacheAt = 0; // invalidate cache after claim
    recordClaim(position_address);

    return { success: true, position: position_address, txs: txHashes, base_mint: pool.lbPair.tokenXMint.toString() };
  } catch (error) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Close Position ────────────────────────────────────────────
export async function closePosition({ position_address, reason }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);

  try {
    log("close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const poolMeta = await getPoolMetadata(poolAddress);
    if (shouldUseLpAgentRelay()) {
      const livePositions = await getMyPositions({ force: true, silent: true });
      const livePosition = livePositions?.positions?.find((position) => position.position === position_address);
      const closeFromBinId = livePosition?.lower_bin ?? tracked?.bin_range?.min ?? -887272;
      const closeToBinId = livePosition?.upper_bin ?? tracked?.bin_range?.max ?? 887272;
      const closeOutput = "allToken1";

      const quotes = await agentMeridianJson("/execution/zap-out/quotes", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          agentId: getAgentIdForRequests(),
          positionId: position_address,
          bps: 10000,
        }),
      });

      const order = await agentMeridianJson("/execution/zap-out/order", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          agentId: getAgentIdForRequests(),
          idempotencyKey: `close:${position_address}:10000`,
          positionId: position_address,
          owner: wallet.publicKey.toString(),
          bps: 10000,
          slippageBps: 5000,
          output: closeOutput,
          provider: "OKX",
          type: "meteora",
          fromBinId: closeFromBinId,
          toBinId: closeToBinId,
          quoteRequestId: quotes.requestId,
        }),
      });

      const closeUnsigned = order?.order?.transactions?.close || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (closeUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent close order returned no transactions. Check the position, quote response, and selected output.");
      }

      const submit = await agentMeridianJson("/execution/zap-out/submit", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            close: signSerializedTransactions(closeUnsigned, wallet),
            swap: signSerializedTransactions(swapUnsigned, wallet),
          },
        }),
      });

      const claimTxHashes = [];
      const closeTxHashes = normalizeExecutionSignatures(submit);
      const txHashes = [...claimTxHashes, ...closeTxHashes];

      await new Promise((resolve) => setTimeout(resolve, 5000));
      _positionsCacheAt = 0;

      let closedConfirmed = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const refreshed = await getMyPositions({ force: true, silent: true });
          const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
          if (!stillOpen) {
            closedConfirmed = true;
            break;
          }
          log("close_warn", `Relay close still appears open after submit (attempt ${attempt + 1}/4)`);
        } catch (e) {
          log("close_warn", `Relay close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      if (!closedConfirmed) {
        return {
          success: false,
          error: "Close submit succeeded but position still appears open after verification window",
          position: position_address,
          pool: poolAddress,
          close_txs: closeTxHashes,
          txs: txHashes,
        };
      }

      recordClose(position_address, reason || "agent decision");

      if (tracked) {
        const deployedAt = new Date(tracked.deployed_at).getTime();
        const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);
        let minutesOOR = 0;
        if (tracked.out_of_range_since) {
          minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
        }

        let pnlUsd = 0;
        let pnlPct = 0;
        let finalValueUsd = 0;
        let initialUsd = 0;
        let feesUsd = tracked.total_fees_claimed_usd || 0;
        try {
          const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
          for (let attempt = 0; attempt < 6; attempt++) {
            const res = await fetch(closedUrl);
            if (res.ok) {
              const data = await res.json();
              const posEntry = (data.positions || []).find((entry) => entry.positionAddress === position_address);
              if (posEntry) {
                pnlUsd = parseFloat(posEntry.pnlUsd || 0);
                pnlPct = parseFloat(posEntry.pnlPctChange || 0);
                finalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
                initialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
                feesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;
                break;
              }
            }
            if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        } catch (e) {
          log("close_warn", `Relay closed PnL fetch failed: ${e.message}`);
        }

        await recordPerformance({
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
          base_mint: livePosition?.base_mint || null,
          strategy: tracked.strategy,
          bin_range: tracked.bin_range,
          bin_step: tracked.bin_step || null,
          volatility: tracked.volatility || null,
          fee_tvl_ratio: tracked.fee_tvl_ratio || null,
          organic_score: tracked.organic_score || null,
          amount_sol: tracked.amount_sol,
          fees_earned_usd: feesUsd,
          final_value_usd: finalValueUsd,
          initial_value_usd: initialUsd,
          minutes_in_range: minutesHeld - minutesOOR,
          minutes_held: minutesHeld,
          close_reason: reason || "agent decision",
        });

        appendDecision({
          type: "close",
          actor: "MANAGER",
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
          position: position_address,
          summary: `Relay closed at ${pnlPct.toFixed(2)}%`,
          reason: reason || "agent decision",
          risks: [
            minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
            tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
          ].filter(Boolean),
          metrics: {
            pnl_usd: pnlUsd,
            pnl_pct: pnlPct,
            fees_usd: feesUsd,
            minutes_held: minutesHeld,
          },
        });

        return {
          success: true,
          relay: true,
          request_id: order.requestId,
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || null,
          claim_txs: claimTxHashes,
          close_txs: closeTxHashes,
          txs: txHashes,
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          base_mint: livePosition?.base_mint || null,
        };
      }

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: "Relay closed position",
        reason: reason || "agent decision",
        metrics: {},
      });

      return {
        success: true,
        relay: true,
        request_id: order.requestId,
        position: position_address,
        pool: poolAddress,
        pool_name: poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        base_mint: livePosition?.base_mint || null,
      };
    }

    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);
    const claimTxHashes = [];
    const closeTxHashes = [];

    // ─── Step 1: Claim Fees (to clear account state) ───────────
    const recentlyClaimed = tracked?.last_claim_at && (Date.now() - new Date(tracked.last_claim_at).getTime()) < 60_000;
    try {
      if (recentlyClaimed) {
        log("close", `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at).getTime()) / 1000)}s ago`);
      } else {
        log("close", `Step 1: Claiming fees for ${position_address}`);
        const positionData = await pool.getPosition(positionPubKey);
        const claimTxs = await pool.claimSwapFee({
          owner: wallet.publicKey,
          position: positionData,
        });
        if (claimTxs && claimTxs.length > 0) {
          for (const tx of claimTxs) {
            const claimHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
            claimTxHashes.push(claimHash);
          }
          log("close", `Step 1 OK (claim only): ${claimTxHashes.join(", ")}`);
        }
      }
    } catch (e) {
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove Liquidity & Close ──────────────────────
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
        hasLiquidity = bins.some((bin) => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
      }
    } catch (e) {
      log("close_warn", `Could not check liquidity state: ${e.message}`);
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

      for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
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
    // Wait for RPC to reflect withdrawn balances before returning — prevents
    // agent from seeing zero balance when attempting post-close swap
    await new Promise(r => setTimeout(r, 5000));
    _positionsCacheAt = 0;

    let closedConfirmed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const refreshed = await getMyPositions({ force: true, silent: true });
        const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
        if (!stillOpen) {
          closedConfirmed = true;
          break;
        }
        log("close_warn", `Position ${position_address} still appears open after close txs (attempt ${attempt + 1}/4)`);
      } catch (e) {
        log("close_warn", `Close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }

    if (!closedConfirmed) {
      return {
        success: false,
        error: "Close transactions sent but position still appears open after verification window",
        position: position_address,
        pool: poolAddress,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
      };
    }

    recordClose(position_address, reason || "agent decision");

    // Record performance for learning
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      const shouldRejectClosedPnl = (pct, closeReasonText) => {
        if (!Number.isFinite(pct)) return false;
        const reasonText = String(closeReasonText || "").toLowerCase();
        const stopLossTriggered = reasonText.includes("stop loss");
        // Meteora sometimes briefly reports absurd closed pnl while the record is settling.
        // Trust legitimate stop-loss disasters, but reject obviously unsettled outliers otherwise.
        return !stopLossTriggered && pct <= -90;
      };

      // Fetch closed PnL from API — authoritative source after withdrawal settles
      let pnlUsd = 0;
      let pnlPct = 0;
      let finalValueUsd = 0;
      let initialUsd = 0;
      let feesUsd = tracked.total_fees_claimed_usd || 0;
      try {
        const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
        for (let attempt = 0; attempt < 6; attempt++) {
          const res = await fetch(closedUrl);
          if (res.ok) {
            const data = await res.json();
            const posEntry = (data.positions || []).find(p => p.positionAddress === position_address);
            if (posEntry) {
              const nextPnlUsd = parseFloat(posEntry.pnlUsd || 0);
              const nextPnlPct = parseFloat(posEntry.pnlPctChange || 0);
              const nextFinalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
              const nextInitialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
              const nextFeesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;

              if (shouldRejectClosedPnl(nextPnlPct, reason || tracked?.close_reason)) {
                log("close_warn", `Rejected unsettled closed PnL for ${position_address.slice(0, 8)} on attempt ${attempt + 1}/6: ${nextPnlPct.toFixed(2)}%`);
              } else {
                pnlUsd        = nextPnlUsd;
                pnlPct        = nextPnlPct;
                finalValueUsd = nextFinalValueUsd;
                initialUsd    = nextInitialUsd;
                feesUsd       = nextFeesUsd;
                log("close", `Closed PnL from API: pnl=${pnlUsd.toFixed(2)} USD (${pnlPct.toFixed(2)}%), withdrawn=${finalValueUsd.toFixed(2)}, deposited=${initialUsd.toFixed(2)}`);
                break;
              }
            } else {
              log("close_warn", `Position not found in status=closed response (attempt ${attempt + 1}/6) — may still be settling`);
            }
          }
          if (attempt < 5) await new Promise((r) => setTimeout(r, 5000));
        }
      } catch (e) {
        log("close_warn", `Closed PnL fetch failed: ${e.message}`);
      }
      // Fallback to pre-close cache snapshot if closed API had no data
      if (finalValueUsd === 0) {
        const cachedPos = _positionsCache?.positions?.find(p => p.position === position_address);
        if (cachedPos) {
          pnlUsd        = cachedPos.pnl_true_usd ?? cachedPos.pnl_usd ?? 0;
          pnlPct        = cachedPos.pnl_pct   ?? 0;
          feesUsd       = (cachedPos.collected_fees_true_usd || 0) + (cachedPos.unclaimed_fees_true_usd || 0);
          initialUsd    = tracked.initial_value_usd || 0;
          if (initialUsd > 0) {
            // Keep fallback internally consistent using USD-only cached metrics.
            finalValueUsd = Math.max(0, initialUsd + pnlUsd - feesUsd);
            pnlPct = (pnlUsd / initialUsd) * 100;
          } else {
            finalValueUsd = cachedPos.total_value_true_usd ?? cachedPos.total_value_usd ?? 0;
            initialUsd = Math.max(0, finalValueUsd + feesUsd - pnlUsd);
          }
          log("close_warn", `Using cached pnl fallback because closed API has not settled yet`);
        }
      }

      await recordPerformance({
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        base_mint: pool.lbPair.tokenXMint.toString(),
        strategy: tracked.strategy,
        bin_range: tracked.bin_range,
        bin_step: tracked.bin_step || null,
        volatility: tracked.volatility || null,
        fee_tvl_ratio: tracked.fee_tvl_ratio || null,
        organic_score: tracked.organic_score || null,
        amount_sol: tracked.amount_sol,
        fees_earned_usd: feesUsd,
        final_value_usd: finalValueUsd,
        initial_value_usd: initialUsd,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: reason || "agent decision",
      });

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: `Closed at ${pnlPct.toFixed(2)}%`,
        reason: reason || "agent decision",
        risks: [
          minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
          tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
        ].filter(Boolean),
        metrics: {
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          fees_usd: feesUsd,
          minutes_held: minutesHeld,
        },
      });

      return {
        success: true,
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        pnl_usd: pnlUsd,
        pnl_pct: pnlPct,
        base_mint: pool.lbPair.tokenXMint.toString(),
      };
    }

    appendDecision({
      type: "close",
      actor: "MANAGER",
      pool: poolAddress,
      pool_name: poolMeta.name || poolAddress.slice(0, 8),
      position: position_address,
      summary: "Closed position",
      reason: reason || "agent decision",
      metrics: {},
    });

    return {
      success: true,
      position: position_address,
      pool: poolAddress,
      pool_name: poolMeta.name || null,
      claim_txs: claimTxHashes,
      close_txs: closeTxHashes,
      txs: txHashes,
      base_mint: pool.lbPair.tokenXMint.toString(),
    };
  } catch (error) {
    log("close_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────
async function lookupPoolForPosition(position_address, walletAddress) {
  // Check state registry first (fast path)
  const tracked = getTrackedPosition(position_address);
  if (tracked?.pool) return tracked.pool;

  // Check in-memory positions cache
  const cached = _positionsCache?.positions?.find((p) => p.position === position_address);
  if (cached?.pool) return cached.pool;

  // SDK scan (last resort)
  const { DLMM } = await getDLMM();
  const allPositions = await DLMM.getAllLbPairPositionsByUser(
    getConnection(),
    new PublicKey(walletAddress)
  );

  for (const [lbPairKey, positionData] of Object.entries(allPositions)) {
    for (const pos of positionData.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === position_address) return lbPairKey;
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}
