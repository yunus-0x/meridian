import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config } from "../config.js";
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
import { normalizeMint } from "./wallet.js";

// ─── Lazy SDK loader ───────────────────────────────────────────
// @meteora-ag/dlmm → @coral-xyz/anchor uses CJS directory imports
// that break in ESM on Node 24. Dynamic import defers loading until
// an actual on-chain call is needed (never triggered in dry-run).
let _DLMM = null;
let _StrategyType = null;

async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
  }
  return { DLMM: _DLMM, StrategyType: _StrategyType };
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

// ─── Pool Cache ────────────────────────────────────────────────
const poolCache = new Map();

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
  single_sided_x,  // if true, deposit only token X across all bins (ask-side / sell wall)
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

  const activeBinsBelow = bins_below ?? config.strategy.binsBelow;
  const activeBinsAbove = bins_above ?? 0;

  if (process.env.DRY_RUN === "true") {
    const totalBins = activeBinsBelow + activeBinsAbove;
    return {
      dry_run: true,
      would_deploy: {
        pool_address,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        amount_x: amount_x || 0,
        amount_y: amount_y || amount_sol || 0,
        wide_range: totalBins > 69,
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  const { StrategyType } = await getDLMM();
  const wallet = getWallet();
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  // Range calculation
  const minBinId = activeBin.binId - activeBinsBelow;
  const maxBinId = activeBin.binId + activeBinsAbove;

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
  // If amount_y is not provided but amount_sol is, use amount_sol (for backward compatibility)
  const finalAmountY = amount_y ?? amount_sol ?? 0;
  const finalAmountX = amount_x ?? 0;

  const totalYLamports = new BN(Math.floor(finalAmountY * 1e9));
  // For X, we assume it's also 9 decimals for now, or we'd need to fetch mint decimals.
  // Most Meteora pools base tokens are 6 or 9. To be safe, we should fetch.
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
  }

  const totalBins = activeBinsBelow + activeBinsAbove;
  const isWideRange = totalBins > 69;
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
        const txHash = await sendAndConfirmTransaction(getConnection(), createTxArray[i], signers, { skipPreflight: true });
        txHashes.push(txHash);
        log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
      }

      // Phase 2: Add liquidity (may be multiple txs)
      const addTxs = await pool.addLiquidityByStrategyChunkable({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { minBinId, maxBinId, strategyType, ...(single_sided_x ? { singleSidedX: true } : {}) },
        slippage: 10, // 10%
      });
      const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
      for (let i = 0; i < addTxArray.length; i++) {
        const txHash = await sendAndConfirmTransaction(getConnection(), addTxArray[i], [wallet], { skipPreflight: true });
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
        strategy: { maxBinId, minBinId, strategyType, ...(single_sided_x ? { singleSidedX: true } : {}) },
        slippage: 1000, // 10% in bps
      });
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet, newPosition], { skipPreflight: true });
      txHashes.push(txHash);
    }

    log("deploy", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]}`);

    _positionsCacheAt = 0;
    // SOL-only bid_ask (all bins below, no token X) → management strategy is single_sided_reseed
    const trackedStrategy =
      finalAmountX === 0 && finalAmountY > 0 && activeStrategy === "bid_ask" && activeBinsAbove === 0
        ? "single_sided_reseed"
        : activeStrategy;
    trackPosition({
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      strategy: trackedStrategy,
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

    const actualBinStep = pool.lbPair.binStep;
    const activePrice = parseFloat(activeBin.price);
    const minPrice = activePrice * Math.pow(1 + actualBinStep / 10000, minBinId - activeBin.binId);
    const maxPrice = activePrice * Math.pow(1 + actualBinStep / 10000, maxBinId - activeBin.binId);

    // Read base fee directly from pool — baseFactor * binStep / 10^6 gives fee in %
    const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
    const actualBaseFee = base_fee ?? (baseFactor > 0 ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4)) : null);

    return {
      success: true,
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
      price_range: { min: minPrice, max: maxPrice },
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

// ─── Get My Positions ──────────────────────────────────────────
export async function getMyPositions({ force = false } = {}) {
  if (!force && _positionsCache && Date.now() - _positionsCacheAt < POSITIONS_CACHE_TTL) {
    return _positionsCache;
  }
  // If a scan is already in progress, wait for it instead of starting another
  if (_positionsInflight) return _positionsInflight;

  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  _positionsInflight = (async () => { try {
    log("positions", "Scanning positions via getProgramAccounts...");
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
    const walletPubkey = new PublicKey(walletAddress);

    // Owner field sits at offset 40 (8 discriminator + 32 lb_pair)
    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: walletPubkey.toBase58() } }],
    });

    log("positions", `Found ${accounts.length} position account(s)`);

    // Collect raw (pool, position) pairs
    const raw = [];
    for (const acc of accounts) {
      const positionAddress = acc.pubkey.toBase58();
      const lbPairKey = new PublicKey(acc.account.data.slice(8, 40)).toBase58();
      // Pair name: use tracked state pool_name if available
      const tracked = getTrackedPosition(positionAddress);
      const pair = tracked?.pool_name || lbPairKey.slice(0, 8);
      raw.push({
        position: positionAddress,
        pool: lbPairKey,
        pair,
        base_mint: null, // enriched from PnL API below
        lower_bin: null,
        upper_bin: null,
      });
    }

    // Enrich with DLMM PnL API for each unique pool in parallel
    const uniquePools = [...new Set(raw.map((p) => p.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, walletAddress)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });

    const positions = raw.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;

      const inRange = p ? !p.isOutOfRange : true;
      if (inRange) markInRange(r.position);
      else markOutOfRange(r.position);

      const lowerBin  = p?.lowerBinId      ?? r.lower_bin;
      const upperBin  = p?.upperBinId      ?? r.upper_bin;
      const activeBin = p?.poolActiveBinId ?? null;

      const unclaimedFees = p ? (parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) : 0;
      const totalValue    = p ? parseFloat(p.unrealizedPnl?.balances || 0) : 0;
      const collectedFees = p ? parseFloat(p.allTimeFees?.total?.usd || 0) : 0;
      const pnlUsd        = p?.pnlUsd       ?? 0;
      const pnlPct        = p?.pnlPctChange ?? 0;

      const tracked = getTrackedPosition(r.position);
      const ageFromPnlApi = p?.createdAt
        ? Math.floor((Date.now() - p.createdAt * 1000) / 60000)
        : null;
      const ageFromState = tracked?.deployed_at
        ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
        : null;
      const ageMinutes = Math.max(ageFromPnlApi ?? 0, ageFromState ?? 0) || null;

      return {
        position: r.position,
        pool: r.pool,
        pair: r.pair,
        base_mint: r.base_mint,
        lower_bin: lowerBin,
        upper_bin: upperBin,
        active_bin: activeBin,
        in_range: inRange,
        unclaimed_fees_usd: Math.round(unclaimedFees * 100) / 100,
        total_value_usd: Math.round(totalValue * 100) / 100,
        collected_fees_usd: Math.round(collectedFees * 100) / 100,
        pnl_usd: Math.round(pnlUsd * 100) / 100,
        pnl_pct: Math.round(pnlPct * 100) / 100,
        age_minutes: ageMinutes,
        minutes_out_of_range: minutesOutOfRange(r.position),
      };
    });

    const result = { wallet: walletAddress, total_positions: positions.length, positions };
    syncOpenPositions(positions.map((p) => p.position));
    _positionsCache = result;
    _positionsCacheAt = Date.now();
    return result;
  } catch (error) {
    log("positions_error", `SDK scan failed: ${error.stack || error.message}`);
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
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet], { skipPreflight: true });
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
export async function closePosition({ position_address }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

  try {
    log("close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);

    const txHashes = [];

    // ─── Step 1: Claim Fees (to clear account state) ───────────
    try {
      log("close", `Step 1: Claiming fees for ${position_address}`);
      const positionData = await pool.getPosition(positionPubKey);
      const claimTxs = await pool.claimSwapFee({
        owner: wallet.publicKey,
        position: positionData,
      });
      if (claimTxs && claimTxs.length > 0) {
        for (const tx of claimTxs) {
          const claimHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet], { skipPreflight: true });
          txHashes.push(claimHash);
        }
        log("close", `Step 1 OK: ${txHashes.join(", ")}`);
      }
    } catch (e) {
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove Liquidity & Close ──────────────────────
    log("close", `Step 2: Removing liquidity and closing account`);
    const closeTx = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionPubKey,
      fromBinId: -887272,
      toBinId: 887272,
      bps: new BN(10000),
      shouldClaimAndClose: true,
    });

    for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet], { skipPreflight: true });
      txHashes.push(txHash);
    }
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`);
    // Wait for RPC to reflect withdrawn balances before returning — prevents
    // agent from seeing zero balance when attempting post-close swap
    await new Promise(r => setTimeout(r, 5000));
    recordClose(position_address, "agent decision");

    // Record performance for learning
    const tracked = getTrackedPosition(position_address);
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      // Snapshot PnL from cache BEFORE invalidating — this was the last known state before close
      let pnlUsd = 0;
      let pnlPct = 0;
      let finalValueUsd = 0;
      let feesUsd = tracked.total_fees_claimed_usd || 0;
      const cachedPos = _positionsCache?.positions?.find(p => p.position === position_address);
      if (cachedPos) {
        pnlUsd        = cachedPos.pnl_usd   ?? 0;
        pnlPct        = cachedPos.pnl_pct   ?? 0;
        finalValueUsd = cachedPos.total_value_usd ?? 0;
        feesUsd       = (cachedPos.collected_fees_usd || 0) + (cachedPos.unclaimed_fees_usd || 0);
      }

      _positionsCacheAt = 0; // invalidate cache after snapshotting PnL
      // Use tracked initial value; if missing (legacy positions), estimate from
      // SOL amount at current price so pnl_pct isn't forced to 0
      let initialUsd = tracked.initial_value_usd || 0;
      if (!initialUsd && tracked.amount_sol > 0 && finalValueUsd > 0) {
        // Best-effort fallback: use final value as proxy (IL makes this imprecise
        // but it's much better than 0 which inflates pnl_usd and zeros pnl_pct)
        initialUsd = finalValueUsd;
        log("close", `initial_value_usd missing for ${position_address}, using finalValueUsd ($${finalValueUsd}) as fallback`);
      }

      await recordPerformance({
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolAddress.slice(0, 8),
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
        close_reason: "agent decision",
      });

      return { success: true, position: position_address, pool: poolAddress, pool_name: tracked.pool_name || null, txs: txHashes, pnl_usd: pnlUsd, pnl_pct: pnlPct, base_mint: pool.lbPair.tokenXMint.toString() };
    }

    return { success: true, position: position_address, pool: poolAddress, pool_name: null, txs: txHashes, base_mint: pool.lbPair.tokenXMint.toString() };
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

// ─── Withdraw Liquidity (partial or full, keeps position open) ──
export async function withdrawLiquidity({
  position_address,
  pool_address,
  bps = 10000,
  claim_fees = true,
}) {
  position_address = normalizeMint(position_address);
  if (pool_address) pool_address = normalizeMint(pool_address);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_withdraw: { position_address, pool_address, bps, claim_fees },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("withdraw", `Withdrawing ${bps} bps from position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = pool_address || await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);
    const txHashes = [];

    // ─── Step 1: Claim fees if requested ────────────────────────
    if (claim_fees) {
      try {
        log("withdraw", `Step 1: Claiming fees for ${position_address}`);
        const positionData = await pool.getPosition(positionPubKey);
        const claimTxs = await pool.claimSwapFee({
          owner: wallet.publicKey,
          position: positionData,
        });
        if (claimTxs && claimTxs.length > 0) {
          for (const tx of claimTxs) {
            const claimHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet], { skipPreflight: true });
            txHashes.push(claimHash);
          }
          log("withdraw", `Step 1 OK: ${txHashes.join(", ")}`);
          recordClaim(position_address);
        }
      } catch (e) {
        log("withdraw_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
      }
    }

    // ─── Step 2: Remove liquidity (keep position open) ──────────
    log("withdraw", `Step 2: Removing ${bps} bps of liquidity`);
    const withdrawTx = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionPubKey,
      fromBinId: -887272,
      toBinId: 887272,
      bps: new BN(bps),
      shouldClaimAndClose: false,
    });

    for (const tx of Array.isArray(withdrawTx) ? withdrawTx : [withdrawTx]) {
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet], { skipPreflight: true });
      txHashes.push(txHash);
    }
    log("withdraw", `SUCCESS txs: ${txHashes.join(", ")}`);

    _positionsCacheAt = 0; // invalidate cache

    return {
      success: true,
      position: position_address,
      pool: poolAddress,
      bps,
      fees_claimed: claim_fees,
      position_still_open: true,
      txs: txHashes,
    };
  } catch (error) {
    log("withdraw_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Add Liquidity (to existing position) ───────────────────────
export async function addLiquidity({
  position_address,
  pool_address,
  amount_x = 0,
  amount_y = 0,
  strategy = "spot",
  single_sided_x = false,
}) {
  position_address = normalizeMint(position_address);
  if (pool_address) pool_address = normalizeMint(pool_address);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_add: { position_address, pool_address, amount_x, amount_y, strategy },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("add_liquidity", `Adding liquidity to position: ${position_address}`);
    const { StrategyType } = await getDLMM();
    const wallet = getWallet();
    const poolAddress = pool_address || await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);
    const positionInfo = await pool.getPosition(positionPubKey);
    const minBinId = positionInfo.positionData.lowerBinId;
    const maxBinId = positionInfo.positionData.upperBinId;

    const strategyMap = {
      spot: StrategyType.Spot,
      curve: StrategyType.Curve,
      bid_ask: StrategyType.BidAsk,
    };

    const strategyType = strategyMap[strategy];
    if (strategyType === undefined) {
      throw new Error(`Invalid strategy: ${strategy}. Use spot, curve, or bid_ask.`);
    }

    // Convert amounts — same pattern as deployPosition
    const totalYLamports = new BN(Math.floor(amount_y * 1e9));
    let totalXLamports = new BN(0);
    if (amount_x > 0) {
      const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
      const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
      totalXLamports = new BN(Math.floor(amount_x * Math.pow(10, decimals)));
    }

    log("add_liquidity", `Pool: ${poolAddress}, Bins: ${minBinId} to ${maxBinId}`);
    log("add_liquidity", `Amount: ${amount_x} X, ${amount_y} Y, Strategy: ${strategy}`);

    const tx = await pool.addLiquidityByStrategy({
      positionPubKey,
      totalXAmount: totalXLamports,
      totalYAmount: totalYLamports,
      strategy: {
        maxBinId,
        minBinId,
        strategyType,
        ...(single_sided_x ? { singleSidedX: true } : {}),
      },
      user: wallet.publicKey,
      slippage: 100,
    });

    const txHashes = [];
    for (const t of Array.isArray(tx) ? tx : [tx]) {
      const txHash = await sendAndConfirmTransaction(getConnection(), t, [wallet], { skipPreflight: true });
      txHashes.push(txHash);
    }
    log("add_liquidity", `SUCCESS txs: ${txHashes.join(", ")}`);

    _positionsCacheAt = 0; // invalidate cache

    return {
      success: true,
      position: position_address,
      pool: poolAddress,
      added_x: amount_x,
      added_y: amount_y,
      strategy,
      bin_range: { min: minBinId, max: maxBinId },
      txs: txHashes,
    };
  } catch (error) {
    log("add_liquidity_error", error.message);
    return { success: false, error: error.message };
  }
}
