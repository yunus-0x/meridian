import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl            ?? 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    maxBundlePct:      u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    athFilterPct:       u.athFilterPct       ?? -15,  // skip if price > 85% of ATH (don't deploy at top)
    maxVolatility:      u.maxVolatility      ?? null, // null = no max; e.g. 5.0 = skip pools with volatility > 5
    // Price momentum guard — skip pools where price moved too fast in the timeframe window
    // maxEntry5mPricePct: e.g. 20 = skip if price already +20% (deploying at the top)
    // minEntry5mPricePct: e.g. -15 = skip if price already -15% (token in freefall)
    maxEntry5mPricePct: u.maxEntry5mPricePct ?? 12,   // skip if price already +12% in window (deploying at top)
    minEntry5mPricePct: u.minEntry5mPricePct ?? -20,  // skip if price dumped >-20% in window (freefall)
    // Pool age window: avoid very new pools (inflated metrics) and very old (saturated).
    // Uses token_age_hours as proxy. null = disabled.
    minPoolAgeHours:    u.minPoolAgeHours    ?? 6,    // skip pools where token < 6h old (metrics unreliable)
    maxPoolAgeHours:    u.maxPoolAgeHours    ?? 168,  // skip pools where token > 7 days old
    // Volume acceleration: bonus/penalty based on whether volume is growing or shrinking.
    // minVolumeAccelPct: skip pools where volume_change_pct < this value (e.g. -50 = volume collapsing)
    minVolumeAccelPct:  u.minVolumeAccelPct  ?? -40,  // skip if volume fell >40% (stricter than before)
    // Time-of-day bias: during off-peak hours (low global volume), apply stricter thresholds.
    // off-peak = outside US hours (14:00-22:00 UTC) and Asian hours (01:00-08:00 UTC)
    timeOfDayBias:      u.timeOfDayBias      ?? true,
    offPeakMultiplier:  u.offPeakMultiplier  ?? 1.3,  // raise volume/fee thresholds by 30% off-peak
    // Position sizing multipliers by quality_score bracket
    // Final deploy = computeDeployAmount(wallet) × sizeMultiplier, capped at maxDeployAmount
    highScoreSizeMult:  u.highScoreSizeMult  ?? 1.3,  // score ≥ 70 → deploy 30% more
    lowScoreSizeMult:   u.lowScoreSizeMult   ?? 0.75, // score < 50 → deploy 25% less
    // Min expected fee per LP position — filters out overcrowded pools where your slice is dust.
    // e.g. 1.5 = skip pools where your expected fee < $1.50 per timeframe window
    minFeePerPosition:  u.minFeePerPosition  ?? 1.5,
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    // belowOORWaitMinutes: when price drops BELOW your range (token dumping), close faster.
    // Position is now 100% base token with IL maximized — waiting helps nothing.
    belowOORWaitMinutes: u.belowOORWaitMinutes ?? 15,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -35,
    // Tighter SL for bid_ask (meme/volatile) positions — don't ride losers down.
    // If null, falls back to stopLossPct for all strategies.
    bidAskStopLossPct:     u.bidAskStopLossPct     ?? -20,
    spotStopLossPct:       u.spotStopLossPct       ?? -35,
    // Adaptive (PnL-based) stop-loss: as position peaks, stop-loss floor rises automatically.
    // effectiveSL = max(stopLossPct, peak_pnl - maxDrawdownFromPeak)
    // Example: peak=+8%, maxDrawdown=8 → floor=0% (never go below break-even after peaking)
    // Set to 0 to disable (use fixed stopLossPct only).
    maxDrawdownFromPeak:   u.maxDrawdownFromPeak   ?? 8,
    takeProfitFeePct:      u.takeProfitFeePct      ?? 20,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    // Fee velocity: how fast fees accumulate vs. the position's peak rate.
    // If fees slow to minFeeVelocityPct% of their peak rate, the pool is dying.
    // 0 = disabled, 20 = exit when fees drop to 20% of peak rate
    minFeeVelocityPct:     u.minFeeVelocityPct     ?? 20,
    feeVelocityMinAgeMin:  u.feeVelocityMinAgeMin  ?? 120, // wait 2h before checking fee velocity
    // Rebalance instead of plain-close when position goes OOR:
    // close the position and immediately redeploy at the new active bin in the same pool.
    // Skips screening cycle and keeps capital working with zero dead time.
    rebalanceOnOOR:        u.rebalanceOnOOR        ?? true,
    // Smart rebalance: only rebalance if pool fee velocity is still healthy.
    // If fee_velocity_pct < this value at OOR time → pool is dying → CLOSE instead.
    rebalanceMinFeeVelocity: u.rebalanceMinFeeVelocity ?? 30,
    // Smart claim: dynamic threshold based on fee velocity.
    // When fees are hot (velocity >150%), claim at minClaimAmount × smartClaimHotMult (lower threshold = capture more).
    // When fees are slow (velocity <50%), claim at minClaimAmount × smartClaimColdMult (save gas).
    smartClaimHotMult:     u.smartClaimHotMult     ?? 0.4,  // hot: claim at 40% of base threshold
    smartClaimColdMult:    u.smartClaimColdMult    ?? 2.0,  // cold: claim at 200% of base threshold
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:  u.strategy  ?? "bid_ask",
    binsBelow: u.binsBelow ?? 69,
    binsAbove: u.binsAbove ?? 0,  // bins above active price (0 = single-sided below only)
  },

  // ─── Market Mode ────────────────────────
  // Preset parameter bundles for different market conditions.
  // "auto" = use base config values (no preset applied)
  // "bullish" | "bearish" | "sideways" | "volatile" | "conservative"
  marketMode: u.marketMode ?? "auto",

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return;
  try {
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         != null) s.maxTvl         = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.maxVolatility         !== undefined) s.maxVolatility         = fresh.maxVolatility;
    if (fresh.maxEntry5mPricePct    !== undefined) s.maxEntry5mPricePct    = fresh.maxEntry5mPricePct;
    if (fresh.minEntry5mPricePct    !== undefined) s.minEntry5mPricePct    = fresh.minEntry5mPricePct;
    if (fresh.minPoolAgeHours       !== undefined) s.minPoolAgeHours       = fresh.minPoolAgeHours;
    if (fresh.maxPoolAgeHours       !== undefined) s.maxPoolAgeHours       = fresh.maxPoolAgeHours;
    if (fresh.minVolumeAccelPct     !== undefined) s.minVolumeAccelPct     = fresh.minVolumeAccelPct;
    if (fresh.timeOfDayBias         !== undefined) s.timeOfDayBias         = fresh.timeOfDayBias;
    if (fresh.offPeakMultiplier     !== undefined) s.offPeakMultiplier     = fresh.offPeakMultiplier;
    if (fresh.highScoreSizeMult     !== undefined) s.highScoreSizeMult     = fresh.highScoreSizeMult;
    if (fresh.lowScoreSizeMult      !== undefined) s.lowScoreSizeMult      = fresh.lowScoreSizeMult;
    if (fresh.belowOORWaitMinutes   != null) config.management.belowOORWaitMinutes   = fresh.belowOORWaitMinutes;
    if (fresh.binsAbove             != null) config.strategy.binsAbove               = fresh.binsAbove;
    if (fresh.marketMode            != null) config.marketMode                       = fresh.marketMode;
    if (fresh.minFeeVelocityPct     != null) config.management.minFeeVelocityPct     = fresh.minFeeVelocityPct;
    if (fresh.feeVelocityMinAgeMin  != null) config.management.feeVelocityMinAgeMin  = fresh.feeVelocityMinAgeMin;
    if (fresh.rebalanceOnOOR        != null) config.management.rebalanceOnOOR        = fresh.rebalanceOnOOR;
    if (fresh.maxDrawdownFromPeak   != null) config.management.maxDrawdownFromPeak   = fresh.maxDrawdownFromPeak;
    if (fresh.smartClaimHotMult     != null) config.management.smartClaimHotMult     = fresh.smartClaimHotMult;
    if (fresh.smartClaimColdMult    != null) config.management.smartClaimColdMult    = fresh.smartClaimColdMult;
  } catch { /* ignore */ }
}
