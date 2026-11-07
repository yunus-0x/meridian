import fs from "fs";
import { REPO_ROOT, repoPath } from "./repo-root.js";

export { REPO_ROOT, repoPath };

const USER_CONFIG_PATH = repoPath("user-config.json");

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
export const MIN_SAFE_BINS_BELOW = 35;

export function scaleBinsForBinStep(bins, binStep = 100, minFloor = 22) {
  const rawBins = Math.max(0, Math.round(Number(bins) || 0));
  const step = Number(binStep) || 100;
  if (step <= 100) return rawBins;
  return Math.max(minFloor, Math.round(rawBins * (100 / step)));
}

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);
const strategyDefaultBinsAbove = Math.max(0, Math.round(numericConfig(u.defaultBinsAbove) ?? 0));

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.telegramChatId) process.env.TELEGRAM_CHAT_ID ||= String(u.telegramChatId);

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const config = {
  // The standalone wallet-triggered bot IS the app — there is no mode toggle.
  // The LLM/server-driven flow lives on the `legacy` branch.
  // Shadow mode never submits transactions.
  standalone: {
    shadow: u.shadowMode !== false,
    monitorRpcUrl: nonEmptyString(process.env.MONITOR_RPC_URL, u.monitorRpcUrl, process.env.RPC_URL),
    monitorWsUrl: nonEmptyString(process.env.MONITOR_WS_URL, u.monitorWsUrl),
    balanceRpcUrl: nonEmptyString(process.env.BALANCE_RPC_URL, u.balanceRpcUrl, process.env.RPC_URL),
    fallbackRpcUrl: nonEmptyString(process.env.FALLBACK_RPC_URL, u.fallbackRpcUrl),
    walletAddress: nonEmptyString(process.env.WALLET_ADDRESS, u.walletAddress),
    walletThreshold: u.walletThreshold ?? 2,
    windowSec: u.walletWindowSec ?? 120,
    screeningDeadlineSec: u.screeningDeadlineSec ?? 120,
    retrySec: u.screeningRetrySec ?? 15,
    reconcileSec: u.walletReconcileSec ?? 30,
    minDepositSol: u.minSmartWalletDepositSol ?? 0.1,
    maxPriceMovePct: u.maxEntryPriceMovePct ?? 5,
    cooldownSec: u.walletSignalCooldownSec ?? 300,
    maxPendingTransactions: u.maxPendingWalletTransactions ?? 1000,
    walletGroups: u.walletGroups ?? {},
  },
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    autoSwapRetryAttempts: u.autoSwapRetryAttempts ?? 3,    // retries for base→SOL auto-swap on Jupiter failure
    autoSwapRetryDelayMs:  u.autoSwapRetryDelayMs  ?? 3000, // delay between auto-swap retries
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    outOfRangeAboveWaitMinutes: u.outOfRangeAboveWaitMinutes ?? u.outOfRangeWaitMinutes ?? 60,
    outOfRangeBelowWaitMinutes: u.outOfRangeBelowWaitMinutes ?? 240,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    knifeRescueStopLossPct: u.knifeRescueStopLossPct ?? -15,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minPositionFeeVelocityPctPerHr: u.minPositionFeeVelocityPctPerHr ?? 0.45,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
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
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
    defaultBinsAbove: strategyDefaultBinsAbove,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── PnL fetcher / poller (public infra: Meteora APIs) ──
  pnl: {
    // Position discovery, value, fees, and PnL come from the Meteora portfolio
    // + /pnl APIs — no per-tick on-chain reads, so the poller stays cheap.
    // "rpc" keeps the on-chain engine (DLMM SDK + Jupiter) available as an
    // explicit opt-in.
    rpcUrl: nonEmptyString(u.pnlRpcUrl, process.env.PNL_RPC_URL, process.env.RPC_URL, "https://api.mainnet-beta.solana.com"),
    source: nonEmptyString(u.pnlSource, process.env.PNL_SOURCE, "meteora"), // meteora | rpc
    pollIntervalSec: Number(u.pnlPollIntervalSec ?? 3),
    depositCacheTtlSec: Number(u.pnlDepositCacheTtlSec ?? 300),
    // Consecutive confirming polls required before a peak is raised or an exit fires.
    // At a 3s poll cadence, 2 ticks ≈ 3-6s — filters single-tick noise without the
    // old fixed 15s setTimeout recheck.
    confirmTicks: Number(u.pnlConfirmTicks ?? 2),
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount: process.env.JUPITER_REFERRAL_ACCOUNT ?? "",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 0,
    ),
  },

  chronos: {
    enabled: u.chronosEnabled !== false,
    endpointUrl: nonEmptyString(
      process.env.CHRONOS_API_URL,
      u.chronosEndpointUrl,
      "https://8090-agq3hizmqo2kzfz3edtfttizua.instabox.tech",
    ),
    instaboxMachineId: nonEmptyString(
      process.env.INSTABOX_MACHINE_ID,
      u.instaboxMachineId,
      "m_agq3hizmqo2kzfz3edtfttizua",
    ),
    instaboxApiKey: nonEmptyString(process.env.INSTABOX_API_KEY, u.instaboxApiKey),
    instaboxSshToken: nonEmptyString(
      process.env.INSTABOX_SSH_TOKEN,
      u.instaboxSshToken,
      "ibssh_45rzz2u3jx6kbz2feummidjqky",
    ),
    timeoutMs: Number(u.chronosTimeoutMs ?? 8000),
    nodes: Array.isArray(u.chronosNodes) && u.chronosNodes.length > 0
      ? u.chronosNodes
      : [
          {
            name: "meridian-chronos",
            machineId: "m_agq3hizmqo2kzfz3edtfttizua",
            endpointUrl: "https://8090-agq3hizmqo2kzfz3edtfttizua.instabox.tech",
          },
          {
            name: "coolify-cloud",
            machineId: "m_agqu3gj6jnzpa3zeav4krldmvq",
            endpointUrl: "https://8090-agqu3gj6jnzpa3zeav4krldmvq.instabox.tech",
          },
          {
            name: "kev-server",
            machineId: "m_agqvhqbopynhj2yvmrr6adqbfm",
            endpointUrl: "https://8090-agqvhqbopynhj2yvmrr6adqbfm.instabox.tech",
          },
          {
            name: "ci-runner",
            machineId: "m_agqu2xvhzdofeofeiddtsavlrzb6m".replace("feofe", "fe"),
            endpointUrl: "https://8090-agqu2xvhzdofeiddtsavlrzb6m.instabox.tech",
          },
          {
            name: "hermes-cloud",
            machineId: "m_agquh5zcw7xda4jdasnkusef3i",
            endpointUrl: "https://8090-agquh5zcw7xda4jdasnkusef3i.instabox.tech",
          },
        ],
  },

};

// Shadow applies to every existing transaction path, including CLI commands.
if (config.standalone.shadow) process.env.DRY_RUN = "true";

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding) and optional Chronos conviction multiplier.
 *
 * Formula: clamp(deployable × positionSizePct × convictionMult, floor=deployAmountSol, ceil=min(maxDeployAmount, deployable))
 */
export function computeDeployAmount(walletSol, convictionMult = 1.0) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const mult     = Number.isFinite(Number(convictionMult))
    ? Math.max(0.75, Math.min(1.25, Number(convictionMult)))
    : 1.0;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct * mult;
  const raw        = Math.min(ceil, Math.max(floor * Math.min(1.0, mult), dynamic));
  const safeMax    = deployable > 0 ? Math.min(raw, deployable) : raw;
  return parseFloat(Math.max(floor * 0.75, safeMax).toFixed(2));
}
