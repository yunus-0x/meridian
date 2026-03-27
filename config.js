import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
const initialDryRunEnv = process.env.DRY_RUN;

let u = {};
let configParseFailed = false;
if (fs.existsSync(USER_CONFIG_PATH)) {
  try {
    u = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
  } catch {
    configParseFailed = true;
    u = {};
  }
}

const VALID_OPERATING_MODES = new Set(["dry-run", "semi-auto", "full-auto"]);

function normalizeOperatingMode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (VALID_OPERATING_MODES.has(raw)) return raw;
  return "full-auto";
}

function normalizeLegacyDryRun(value) {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

function isValidOperatingMode(value) {
  return VALID_OPERATING_MODES.has(String(value ?? "").trim().toLowerCase());
}

function syncDryRunEnv(mode) {
  process.env.DRY_RUN = mode === "dry-run" ? "true" : "false";
}

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;

const legacyDryRun = normalizeLegacyDryRun(u.dryRun);
const configuredOperatingMode = isValidOperatingMode(u.operatingMode)
  ? normalizeOperatingMode(u.operatingMode)
  : null;
const resolvedOperatingMode = configParseFailed
  ? "dry-run"
  : (initialDryRunEnv === "true"
    ? "dry-run"
    : (configuredOperatingMode
      ?? (legacyDryRun !== undefined
        ? (legacyDryRun ? "dry-run" : "full-auto")
        : "full-auto")));

syncDryRunEnv(resolvedOperatingMode);

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
    maxBundlersPct:    u.maxBundlersPct    ?? 30,  // max bot/bundler holders % (from Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    blockedLaunchpads: u.blockedLaunchpads ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
  },

  // ─── Position Management ────────────────
  management: {
    operatingMode:        resolvedOperatingMode,
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    emergencyPriceDropPct: u.emergencyPriceDropPct ?? u.stopLossPct ?? -50,
    takeProfitFeePct:      u.takeProfitFeePct      ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minSolToOpen:          u.minSolToOpen          ?? 0.75,
    deployAmountSol:       u.deployAmountSol       ?? 0.35,
    gasReserve:            u.gasReserve            ?? 0.35,
    positionSizePct:       u.positionSizePct       ?? 0.25,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:  u.strategy  ?? "bid_ask",
    binsBelow: u.binsBelow ?? 69,
  },

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
 * Examples (defaults: gasReserve=0.35, positionSizePct=0.25, floor=0.35):
 *   0.8 SOL wallet → 0.35 SOL deploy (floor)
 *   2.0 SOL wallet → 0.41 SOL deploy
 *   3.0 SOL wallet → 0.66 SOL deploy
 *   4.0 SOL wallet → 0.91 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.35;
  const pct      = config.management.positionSizePct ?? 0.25;
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
    if (fresh.timeframe      != null) s.timeframe      = fresh.timeframe;
    if (fresh.category       != null) s.category       = fresh.category;
  } catch { /* ignore */ }
}

export function getOperatingMode() {
  const mode = normalizeOperatingMode(config.management.operatingMode);
  syncDryRunEnv(mode);
  return mode;
}
