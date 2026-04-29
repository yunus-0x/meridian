import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken, invalidateAccountCache } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction, getTrackedPosition } from "../state.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds } from "../config.js";
import { getRecentDecisions } from "../decision-log.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");
const GMGN_CONFIG_PATH = path.join(__dirname, "../gmgn-config.json");
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";

const SENSITIVE_CONFIG_KEYS = new Set([
  "gmgnApiKey",
  "hiveMindApiKey",
  "publicApiKey",
]);

function redactConfigValue(key, value) {
  if (!SENSITIVE_CONFIG_KEYS.has(key)) return value;
  return typeof value === "string" && value ? "***redacted***" : value;
}

function redactAppliedConfig(applied) {
  return Object.fromEntries(
    Object.entries(applied || {}).map(([key, value]) => [key, redactConfigValue(key, value)]),
  );
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
        });
        child.unref();
        process.exit(0);
      }, 3000);
      return { success: true, updated: true, message: `Updated! Restarting in 3s...\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      screeningSource: ["screening", "source"],
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minQuoteOrganic: ["screening", "minQuoteOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      useDiscordSignals: ["screening", "useDiscordSignals"],
      discordSignalMode: ["screening", "discordSignalMode"],
      avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
      blockPvpSymbols: ["screening", "blockPvpSymbols"],
      maxBundlePct:     ["screening", "maxBundlePct"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      athFilterPct:     ["screening", "athFilterPct"],
      minVolatility:    ["screening", "minVolatility"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      outOfRangePumpWaitMinutes: ["management", "outOfRangePumpWaitMinutes"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      repeatDeployCooldownEnabled: ["management", "repeatDeployCooldownEnabled"],
      repeatDeployCooldownTriggerCount: ["management", "repeatDeployCooldownTriggerCount"],
      repeatDeployCooldownHours: ["management", "repeatDeployCooldownHours"],
      repeatDeployCooldownScope: ["management", "repeatDeployCooldownScope"],
      repeatDeployCooldownMinFeeEarnedPct: ["management", "repeatDeployCooldownMinFeeEarnedPct"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitPct: ["management", "takeProfitPct"],
      takeProfitFeePct: ["management", "takeProfitPct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      claudeModel: ["llm", "claudeModel"],
      temperature: ["llm", "temperature"],
      maxTokens: ["llm", "maxTokens"],
      maxSteps: ["llm", "maxSteps"],
      // strategy
      strategy:     ["strategy", "strategy"],
      minBinsBelow: ["strategy", "minBinsBelow"],
      maxBinsBelow: ["strategy", "maxBinsBelow"],
      // hivemind
      hiveMindUrl: ["hiveMind", "url"],
      hiveMindApiKey: ["hiveMind", "apiKey"],
      agentId: ["hiveMind", "agentId"],
      hiveMindPullMode: ["hiveMind", "pullMode"],
      // meridian api / relay
      publicApiKey: ["api", "publicApiKey"],
      agentMeridianApiUrl: ["api", "url"],
      lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
      // GMGN screening
      gmgnApiKey: ["gmgn", "apiKey"],
      gmgnBaseUrl: ["gmgn", "baseUrl"],
      gmgnInterval: ["gmgn", "interval"],
      gmgnOrderBy: ["gmgn", "orderBy"],
      gmgnDirection: ["gmgn", "direction"],
      gmgnLimit: ["gmgn", "limit"],
      gmgnEnrichLimit: ["gmgn", "enrichLimit"],
      gmgnRequestDelayMs: ["gmgn", "requestDelayMs"],
      gmgnMaxRetries: ["gmgn", "maxRetries"],
      gmgnHoldersLimit: ["gmgn", "holdersLimit"],
      gmgnKlineResolution: ["gmgn", "klineResolution"],
      gmgnKlineLookbackMinutes: ["gmgn", "klineLookbackMinutes"],
      gmgnFilters: ["gmgn", "filters"],
      gmgnPlatforms: ["gmgn", "platforms"],
      gmgnMinMcap: ["gmgn", "minMcap"],
      gmgnMaxMcap: ["gmgn", "maxMcap"],
      gmgnMinVolume: ["gmgn", "minVolume"],
      gmgnMinHolders: ["gmgn", "minHolders"],
      gmgnMinTokenAgeHours: ["gmgn", "minTokenAgeHours"],
      gmgnMaxTokenAgeHours: ["gmgn", "maxTokenAgeHours"],
      gmgnAthFilterPct: ["gmgn", "athFilterPct"],
      gmgnMaxTop10HolderRate: ["gmgn", "maxTop10HolderRate"],
      gmgnMaxBundlerRate: ["gmgn", "maxBundlerRate"],
      gmgnMaxRatTraderRate: ["gmgn", "maxRatTraderRate"],
      gmgnMaxFreshWalletRate: ["gmgn", "maxFreshWalletRate"],
      gmgnMaxDevTeamHoldRate: ["gmgn", "maxDevTeamHoldRate"],
      gmgnMaxBotDegenRate: ["gmgn", "maxBotDegenRate"],
      gmgnMaxSniperCount: ["gmgn", "maxSniperCount"],
      gmgnMaxSniperHoldRate: ["gmgn", "maxSniperHoldRate"],
      gmgnPreferredKolNames: ["gmgn", "preferredKolNames"],
      gmgnPreferredKolMinHoldPct: ["gmgn", "preferredKolMinHoldPct"],
      gmgnDumpKolNames: ["gmgn", "dumpKolNames"],
      gmgnDumpKolMinHoldPct: ["gmgn", "dumpKolMinHoldPct"],
      gmgnRequireKol: ["gmgn", "requireKol"],
      gmgnMinKolCount: ["gmgn", "minKolCount"],
      gmgnMinSmartDegenCount: ["gmgn", "minSmartDegenCount"],
      gmgnMinTotalFeeSol: ["gmgn", "minTotalFeeSol"],
      gmgnRejectSingleVolumeSpike: ["gmgn", "rejectSingleVolumeSpike"],
      gmgnMaxSingleCandleVolumeShare: ["gmgn", "maxSingleCandleVolumeShare"],
      gmgnIndicatorFilter: ["gmgn", "indicatorFilter"],
      gmgnIndicatorInterval: ["gmgn", "indicatorInterval"],
      gmgnRequireBullishSt: ["gmgn", "indicatorRules", "requireBullishSupertrend"],
      gmgnRejectAtBottom: ["gmgn", "indicatorRules", "rejectAlreadyAtBottom"],
      gmgnRequireAboveSt: ["gmgn", "indicatorRules", "requireAboveSupertrend"],
      gmgnMinRsi: ["gmgn", "indicatorRules", "minRsi"],
      gmgnMaxRsi: ["gmgn", "indicatorRules", "maxRsi"],
      gmgnRequireBbPosition: ["gmgn", "indicatorRules", "requireBbPosition"],
      // chart indicators
      chartIndicatorsEnabled: ["indicators", "enabled", ["chartIndicators", "enabled"]],
      indicatorEntryPreset: ["indicators", "entryPreset", ["chartIndicators", "entryPreset"]],
      indicatorExitPreset: ["indicators", "exitPreset", ["chartIndicators", "exitPreset"]],
      rsiLength: ["indicators", "rsiLength", ["chartIndicators", "rsiLength"]],
      indicatorIntervals: ["indicators", "intervals", ["chartIndicators", "intervals"]],
      indicatorCandles: ["indicators", "candles", ["chartIndicators", "candles"]],
      rsiOversold: ["indicators", "rsiOversold", ["chartIndicators", "rsiOversold"]],
      rsiOverbought: ["indicators", "rsiOverbought", ["chartIndicators", "rsiOverbought"]],
      requireAllIntervals: ["indicators", "requireAllIntervals", ["chartIndicators", "requireAllIntervals"]],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      applied[match[0]] = val;
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    // Apply to live config immediately
    for (const [key, val] of Object.entries(applied)) {
      const [section, field, third] = CONFIG_MAP[key];
      const isNestedField = typeof third === "string"; // string = nested subfield, array = persistPath
      if (isNestedField) {
        if (!config[section][field] || typeof config[section][field] !== "object") config[section][field] = {};
        const before = config[section][field][third];
        config[section][field][third] = val;
        log("config", `update_config: config.${section}.${field}.${third} ${redactConfigValue(key, before)} → ${redactConfigValue(key, val)}`);
      } else {
        const before = config[section][field];
        config[section][field] = val;
        log("config", `update_config: config.${section}.${field} ${redactConfigValue(key, before)} → ${redactConfigValue(key, val)} (verify: ${redactConfigValue(key, config[section][field])})`);
      }
    }

    // Persist GMGN tuning to gmgn-config.json, and everything else to user-config.json.
    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /**/ }
    }
    let gmgnConfig = {};
    if (fs.existsSync(GMGN_CONFIG_PATH)) {
      try { gmgnConfig = JSON.parse(fs.readFileSync(GMGN_CONFIG_PATH, "utf8")); } catch { /**/ }
    }
    let wroteUserConfig = false;
    let wroteGmgnConfig = false;
    for (const [key, val] of Object.entries(applied)) {
      const [section, field, third] = CONFIG_MAP[key] || [];
      const persistPath = Array.isArray(third) ? third : null;
      const nestedField = typeof third === "string" ? third : null;
      if (section === "gmgn") {
        if (nestedField) {
          if (!gmgnConfig[field] || typeof gmgnConfig[field] !== "object") gmgnConfig[field] = {};
          gmgnConfig[field][nestedField] = val;
        } else {
          gmgnConfig[field] = val;
        }
        wroteGmgnConfig = true;
        continue;
      }
      if (Array.isArray(persistPath) && persistPath.length > 0) {
        let target = userConfig;
        for (const part of persistPath.slice(0, -1)) {
          if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
            target[part] = {};
          }
          target = target[part];
        }
        target[persistPath[persistPath.length - 1]] = val;
      } else {
        userConfig[key] = val;
      }
      wroteUserConfig = true;
    }
    const tunedAt = new Date().toISOString();
    if (wroteUserConfig) {
      userConfig._lastAgentTune = tunedAt;
      fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));
    }
    if (wroteGmgnConfig) {
      gmgnConfig._lastAgentTune = tunedAt;
      fs.writeFileSync(GMGN_CONFIG_PATH, JSON.stringify(gmgnConfig, null, 2));
    }

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    // Save as a lesson — but skip ephemeral per-deploy interval changes
    // (managementIntervalMin / screeningIntervalMin change every deploy based on volatility;
    //  the rule is already in the system prompt, storing it 75+ times is pure noise)
    const lessonsKeys = Object.keys(applied).filter(
      k => k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${redactConfigValue(k, applied[k])}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(redactAppliedConfig(applied))} — ${reason}`);
    return { success: true, applied: redactAppliedConfig(applied), unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      // Invalidate token account cache after any on-chain state change
      if (name === "swap_token" || name === "close_position" || name === "claim_fees") {
        invalidateAccountCache();
      }
      if (name === "swap_token" && result.tx) {
        const resolveMintSymbol = (mint) => {
          if (!mint) return "?";
          if (mint === "SOL" || mint === "So11111111111111111111111111111111111111112") return "SOL";
          if (mint === config.tokens.USDC || mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") return "USDC";
          return mint.slice(0, 8);
        };
        notifySwap({ inputSymbol: resolveMintSymbol(args.input_mint), outputSymbol: resolveMintSymbol(args.output_mint), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        notifyDeploy({
          pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8),
          poolAddress: args.pool_address,
          amountSol: args.amount_y ?? args.amount_sol ?? 0,
          strategy: result.strategy || args.strategy,
          binsBelow: args.bins_below,
          binsAbove: args.bins_above,
          position: result.position,
          tx: result.txs?.[0] ?? result.tx,
          priceRange: result.price_range,
          rangeCoverage: result.range_coverage,
          binStep: result.bin_step ?? args.bin_step,
          baseFee: result.base_fee ?? args.base_fee,
          activeBin: result.bin_range?.active,
          feeTvlRatio: args.fee_tvl_ratio ?? args.fee_active_tvl_ratio,
          organicScore: args.organic_score,
          volatility: args.volatility,
          tvl: args.initial_value_usd,
          entryReason: args.entry_reason || null,
        }).catch(() => {});
      } else if (name === "close_position") {
        const tracked = getTrackedPosition(args.position_address);
        const deployedAt = tracked?.deployed_at ? new Date(tracked.deployed_at).getTime() : null;
        const minutesHeld = deployedAt ? Math.floor((Date.now() - deployedAt) / 60000) : null;
        notifyClose({
          pair: result.pool_name || tracked?.pool_name || args.position_address?.slice(0, 8),
          pnlUsd: result.pnl_usd ?? 0,
          pnlPct: result.pnl_pct ?? 0,
          reason: args.reason,
          minutesHeld,
          amountSol: tracked?.amount_sol,
          feeTvlRatio: tracked?.fee_tvl_ratio,
          organicScore: tracked?.organic_score,
          volatility: tracked?.volatility,
          tx: result.close_txs?.[0] ?? result.txs?.[0],
        }).catch(() => {});
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Auto-swap the position's base token back to SOL after close.
        // Only targets the specific base_mint — never sweeps the whole wallet.
        if (!args.skip_swap && result.base_mint) {
          try {
            const baseMint = result.base_mint;
            const SKIP_MINTS = new Set([
              "So11111111111111111111111111111111111111112",
              "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              config.tokens.SOL,
              config.tokens.USDC,
            ].filter(Boolean));
            if (!SKIP_MINTS.has(baseMint)) {
              let token = null;
              for (let attempt = 0; attempt < 6; attempt++) {
                if (attempt > 0) await new Promise(r => setTimeout(r, 5000));
                const balances = await getWalletBalances({});
                if (balances?.error) {
                  log("executor_warn", `getWalletBalances error on attempt ${attempt + 1}: ${balances.error}`);
                  continue;
                }
                token = (balances.tokens || []).find(t => t.mint === baseMint && t.balance > 0);
                if (token) break;
              }
              if (!token) {
                log("executor_warn", `Auto-swap: base token ${baseMint.slice(0, 8)} not found after 30s — management cycle will sweep on next run`);
              } else {
                log("executor", `Auto-swapping ${token.symbol || baseMint.slice(0, 8)} (${token.usd != null ? `$${token.usd.toFixed(2)}` : `${token.balance} tokens`}) back to SOL`);
                const swapResult = await swapToken({ input_mint: baseMint, output_mint: "SOL", amount: token.balance });
                if (swapResult?.success) {
                  result.auto_swapped = true;
                  result.auto_swap_note = `Base token auto-swapped to SOL (${token.symbol || baseMint.slice(0, 8)}). Do NOT call swap_token again.`;
                  if (swapResult.amount_out) result.sol_received = swapResult.amount_out;
                } else {
                  log("executor_warn", `Auto-swap of ${token.symbol || baseMint.slice(0, 8)} failed: ${swapResult?.error}`);
                }
              }
            }
          } catch (e) {
            log("executor_warn", `Auto-swap after close failed: ${e.message}`);
          }
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        try {
          let token = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
            const balances = await getWalletBalances({});
            token = balances.tokens?.find(t => t.mint === result.base_mint);
            if (token && token.balance > 0) break;
          }
          if (token && token.balance > 0 && (token.usd == null || token.usd >= 0.10)) {
            log("executor", `Auto-swapping claimed ${token.symbol || result.base_mint.slice(0, 8)} (${token.usd != null ? `$${token.usd.toFixed(2)}` : `${token.balance} tokens`}) back to SOL`);
            const swapResult = await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
            result.auto_swapped = true;
            result.auto_swap_note = `Claimed base token already auto-swapped back to SOL (${token.symbol || result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
            if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
          }
        } catch (e) {
          log("executor_warn", `Auto-swap after claim failed: ${e.message}`);
        }
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = args.amount_y ?? args.amount_sol ?? 0;
      if (amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const minDeploy = Math.max(0.1, config.management.deployAmountSol);
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

      // Check SOL balance
      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances();
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
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
