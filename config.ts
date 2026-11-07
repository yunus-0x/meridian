import fs from "node:fs";
import { REPO_ROOT, repoPath } from "./repo-root.js";
import {
  UserConfigSchema,
  RuntimeConfigSchema,
  type UserConfig,
  type RuntimeConfig,
} from "./src/schemas/config.js";

export { REPO_ROOT, repoPath };

export const MIN_SAFE_BINS_BELOW = 35;

export function scaleBinsForBinStep(bins: unknown, binStep: number = 100, minFloor: number = 22): number {
  const rawBins = Math.max(0, Math.round(Number(bins) || 0));
  const step = Number(binStep) || 100;
  if (step <= 100) return rawBins;
  return Math.max(minFloor, Math.round(rawBins * (100 / step)));
}

function numericConfig(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nonEmptyString(...values: (unknown | undefined | null)[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

const TIMEFRAMES = ["5m", "30m", "1h", "2h", "4h", "12h", "24h"] as const;
type Timeframe = typeof TIMEFRAMES[number];
function isTimeframe(val: unknown): val is Timeframe {
  return typeof val === "string" && (TIMEFRAMES as readonly string[]).includes(val);
}

const REPEAT_SCOPES = ["token", "pool", "both"] as const;
type RepeatScope = typeof REPEAT_SCOPES[number];
function isRepeatScope(val: unknown): val is RepeatScope {
  return typeof val === "string" && (REPEAT_SCOPES as readonly string[]).includes(val);
}

function parseStrategyMode(val: unknown): "spot" | "curve" | "bid_ask" {
  if (val === "spot" || val === "curve" || val === "bid_ask") return val;
  return "bid_ask";
}

function parsePnlSource(val: unknown): "meteora" | "rpc" {
  if (val === "rpc") return "rpc";
  return "meteora";
}

const USER_CONFIG_PATH = repoPath("user-config.json");

function readRawUserConfig(): Record<string, unknown> {
  if (!fs.existsSync(USER_CONFIG_PATH)) return {};
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        result[k] = v;
      }
      return result;
    }
    return {};
  } catch {
    return {};
  }
}

function loadAndResolveConfig(): RuntimeConfig {
  const raw = readRawUserConfig();
  const parsedUserConfig = UserConfigSchema.safeParse(raw);
  const u: UserConfig = parsedUserConfig.success ? parsedUserConfig.data : UserConfigSchema.parse({});

  const legacyBinsBelow = numericConfig(raw.binsBelow);
  const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
  const configuredMaxBinsBelow =
    numericConfig(u.maxBinsBelow) ??
    (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
  const configuredDefaultBinsBelow =
    numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;

  const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
  const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
  const strategyDefaultBinsBelow = Math.max(
    strategyMinBinsBelow,
    Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow))
  );
  const strategyDefaultBinsAbove = Math.max(0, Math.round(numericConfig(u.defaultBinsAbove) ?? 0));

  // Apply wallet/RPC from user-config if not already in env
  if (u.rpcUrl) process.env.RPC_URL ||= u.rpcUrl;
  if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
  if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
  if (u.telegramChatId) process.env.TELEGRAM_CHAT_ID ||= String(u.telegramChatId);

  const rawConfig = {
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
    risk: {
      maxPositions: u.maxPositions ?? 3,
      maxDeployAmount: u.maxDeployAmount ?? 50,
    },
    screening: {
      timeframe: isTimeframe(u.timeframe) ? u.timeframe : "5m",
      minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
      minTvl: u.minTvl ?? 10_000,
      maxTvl: u.maxTvl !== undefined ? u.maxTvl : 150_000,
      minVolume: u.minVolume ?? 500,
      minOrganic: u.minOrganic ?? 60,
      minQuoteOrganic: u.minQuoteOrganic ?? 60,
      minHolders: u.minHolders ?? 500,
      minMcap: u.minMcap ?? 150_000,
      maxMcap: u.maxMcap ?? 10_000_000,
      minBinStep: u.minBinStep ?? 80,
      maxBinStep: u.maxBinStep ?? 125,
      minTokenFeesSol: u.minTokenFeesSol ?? 30,
      maxBotHoldersPct: u.maxBotHoldersPct ?? 30,
      maxTop10Pct: u.maxTop10Pct ?? 60,
      allowedLaunchpads: u.allowedLaunchpads ?? [],
      blockedLaunchpads: u.blockedLaunchpads ?? [],
      minTokenAgeHours: u.minTokenAgeHours ?? null,
      maxTokenAgeHours: u.maxTokenAgeHours ?? null,
    },
    management: {
      minClaimAmount: u.minClaimAmount ?? 5,
      autoSwapAfterClaim: u.autoSwapAfterClaim ?? false,
      autoSwapRetryAttempts: u.autoSwapRetryAttempts ?? 3,
      autoSwapRetryDelayMs: u.autoSwapRetryDelayMs ?? 3000,
      outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
      outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
      outOfRangeAboveWaitMinutes: u.outOfRangeAboveWaitMinutes ?? u.outOfRangeWaitMinutes ?? 60,
      outOfRangeBelowWaitMinutes: u.outOfRangeBelowWaitMinutes ?? 240,
      outOfRangeBelowEarlyCutMinutes: u.outOfRangeBelowEarlyCutMinutes ?? 90,
      oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
      oorCooldownHours: u.oorCooldownHours ?? 12,
      repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
      repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
      repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
      repeatDeployCooldownScope: isRepeatScope(u.repeatDeployCooldownScope) ? u.repeatDeployCooldownScope : "token",
      repeatDeployCooldownMinFeeEarnedPct:
        u.repeatDeployCooldownMinFeeEarnedPct ?? numericConfig(raw.repeatDeployCooldownMinFeeYieldPct) ?? 0,
      stopLossPct: u.stopLossPct ?? numericConfig(raw.emergencyPriceDropPct) ?? -50,
      knifeRescueStopLossPct: u.knifeRescueStopLossPct ?? -15,
      takeProfitPct: u.takeProfitPct ?? numericConfig(raw.takeProfitFeePct) ?? 5,
      minFeePerTvl24h: u.minFeePerTvl24h ?? 7,
      minPositionFeeVelocityPctPerHr: u.minPositionFeeVelocityPctPerHr ?? 0.45,
      minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60,
      minSolToOpen: u.minSolToOpen ?? 0.55,
      deployAmountSol: u.deployAmountSol ?? 0.5,
      gasReserve: u.gasReserve ?? 0.2,
      positionSizePct: u.positionSizePct ?? 0.35,
      trailingTakeProfit: u.trailingTakeProfit ?? true,
      trailingTriggerPct: u.trailingTriggerPct ?? 3,
      trailingDropPct: u.trailingDropPct ?? 1.5,
      pnlSanityMaxDiffPct: u.pnlSanityMaxDiffPct ?? 5,
      solMode: u.solMode ?? false,
    },
    strategy: {
      mode: parseStrategyMode(u.strategy),
      strategy: parseStrategyMode(u.strategy),
      minBinsBelow: strategyMinBinsBelow,
      maxBinsBelow: strategyMaxBinsBelow,
      defaultBinsBelow: strategyDefaultBinsBelow,
      defaultBinsAbove: strategyDefaultBinsAbove,
    },
    schedule: {
      managementIntervalMin: u.managementIntervalMin ?? 10,
    },
    tokens: {
      SOL: "So11111111111111111111111111111111111111112",
      USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      solMint: "So11111111111111111111111111111111111111112",
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    },
    pnl: {
      rpcUrl:
        nonEmptyString(u.pnlRpcUrl, process.env.PNL_RPC_URL, process.env.RPC_URL, "https://api.mainnet-beta.solana.com") ??
        "https://api.mainnet-beta.solana.com",
      source: parsePnlSource(nonEmptyString(u.pnlSource, process.env.PNL_SOURCE, "meteora")),
      pollIntervalSec: Number(u.pnlPollIntervalSec ?? 3),
      depositCacheTtlSec: Number(u.pnlDepositCacheTtlSec ?? 300),
      confirmTicks: Number(u.pnlConfirmTicks ?? 2),
    },
    jupiter: {
      apiKey: process.env.JUPITER_API_KEY ?? "",
      referralAccount: process.env.JUPITER_REFERRAL_ACCOUNT ?? "",
      referralFeeBps: Number(process.env.JUPITER_REFERRAL_FEE_BPS ?? 0),
    },
    chronos: {
      enabled: u.chronosEnabled !== false,
      endpointUrl:
        nonEmptyString(process.env.CHRONOS_API_URL, u.chronosEndpointUrl, "https://8090-agq3hizmqo2kzfz3edtfttizua.instabox.tech") ??
        "https://8090-agq3hizmqo2kzfz3edtfttizua.instabox.tech",
      instaboxMachineId:
        nonEmptyString(process.env.INSTABOX_MACHINE_ID, u.instaboxMachineId, "m_agq3hizmqo2kzfz3edtfttizua") ??
        "m_agq3hizmqo2kzfz3edtfttizua",
      instaboxApiKey: nonEmptyString(process.env.INSTABOX_API_KEY, u.instaboxApiKey),
      instaboxSshToken:
        nonEmptyString(process.env.INSTABOX_SSH_TOKEN, u.instaboxSshToken, "ibssh_45rzz2u3jx6kbz2feummidjqky") ??
        "ibssh_45rzz2u3jx6kbz2feummidjqky",
      timeoutMs: Number(u.chronosTimeoutMs ?? 8000),
      nodes:
        Array.isArray(u.chronosNodes) && u.chronosNodes.length > 0
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

  return RuntimeConfigSchema.parse(rawConfig);
}

export const config: RuntimeConfig = loadAndResolveConfig();

// Shadow applies to every existing transaction path, including CLI commands.
if (config.standalone.shadow) process.env.DRY_RUN = "true";

export function computeDeployAmount(walletSol: number, convictionMult: number = 1.0): number {
  const reserve = config.management.gasReserve ?? 0.2;
  const pct = config.management.positionSizePct ?? 0.35;
  const floor = config.management.deployAmountSol;
  const ceil = config.risk.maxDeployAmount;
  const mult = Number.isFinite(Number(convictionMult))
    ? Math.max(0.75, Math.min(1.25, Number(convictionMult)))
    : 1.0;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic = deployable * pct * mult;
  const raw = Math.min(ceil, Math.max(floor * Math.min(1.0, mult), dynamic));
  const safeMax = deployable > 0 ? Math.min(raw, deployable) : raw;
  return parseFloat(Math.max(floor * 0.75, safeMax).toFixed(2));
}

export function getConfig(): RuntimeConfig {
  return config;
}

export function updateConfig(updates: Partial<UserConfig>): RuntimeConfig {
  const raw = readRawUserConfig();
  const merged = { ...raw, ...updates };
  const validated = UserConfigSchema.parse(merged);
  const tmpFile = `${USER_CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(validated, null, 2));
  fs.renameSync(tmpFile, USER_CONFIG_PATH);

  const updated = loadAndResolveConfig();
  Object.assign(config, updated);
  return config;
}
