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
  withdrawLiquidity,
  addLiquidity,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction } from "../state.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, getOperatingMode, reloadScreeningThresholds } from "../config.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";

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
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  withdraw_liquidity: withdrawLiquidity,
  add_liquidity: addLiquidity,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
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
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      maxBundlersPct: ["screening", "maxBundlersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      emergencyPriceDropPct: ["management", "emergencyPriceDropPct"],
      takeProfitFeePct: ["management", "takeProfitFeePct"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      operatingMode: ["management", "operatingMode"],
      // strategy
      strategy: ["strategy", "strategy"],
      binsBelow: ["strategy", "binsBelow"],
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
      applied[match[0]] = match[0] === "operatingMode"
        ? String(val ?? "").trim().toLowerCase()
        : val;
    }

    if (Object.prototype.hasOwnProperty.call(applied, "operatingMode")) {
      const validOperatingModes = new Set(["dry-run", "semi-auto", "full-auto"]);
      if (!validOperatingModes.has(applied.operatingMode)) {
        log("config", `update_config rejected invalid operatingMode: ${JSON.stringify(applied.operatingMode)}`);
        return {
          success: false,
          error: `Invalid operatingMode: ${applied.operatingMode}. Allowed values: dry-run, semi-auto, full-auto.`,
          unknown,
          reason,
        };
      }
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    // Apply to live config immediately
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }

    // Persist to user-config.json
    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /**/ }
    }
    Object.assign(userConfig, applied);
    userConfig._lastAgentTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

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
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
  "withdraw_liquidity",
  "add_liquidity",
]);

const DEPLOY_SAFETY_CODES = {
  BIN_STEP_OUT_OF_RANGE: "BIN_STEP_OUT_OF_RANGE",
  MAX_POSITIONS_REACHED: "MAX_POSITIONS_REACHED",
  DUPLICATE_POOL: "DUPLICATE_POOL",
  DUPLICATE_BASE_TOKEN: "DUPLICATE_BASE_TOKEN",
  MISSING_DEPLOY_AMOUNT: "MISSING_DEPLOY_AMOUNT",
  DEPLOY_AMOUNT_TOO_SMALL: "DEPLOY_AMOUNT_TOO_SMALL",
  DEPLOY_AMOUNT_TOO_LARGE: "DEPLOY_AMOUNT_TOO_LARGE",
  INSUFFICIENT_SOL: "INSUFFICIENT_SOL",
};

const SAFETY_BLOCK_FALLBACK_CODE = "SAFETY_BLOCK";

function createSafetyFailure(code, reason, extra = {}) {
  return {
    pass: false,
    code,
    reason,
    ...extra,
  };
}

function logModeDecisionAction({ name, args, startTime, modeDecision }) {
  if (!modeDecision || modeDecision.action === "allow") return;

  logAction({
    tool: name,
    args,
    result: summarizeResult(modeDecision.response),
    duration_ms: Date.now() - startTime,
    success: modeDecision.action === "simulate",
    mode: modeDecision.metadata,
    lifecycle: "mode_gate",
    outcome: modeDecision.action,
  });
}

function logSafetyBlockAction({ name, args, startTime, safetyCheck, mode }) {
  logAction({
    tool: name,
    args,
    result: summarizeResult({
      blocked: true,
      success: false,
      tool: name,
      code: safetyCheck.code ?? SAFETY_BLOCK_FALLBACK_CODE,
      reason: safetyCheck.reason,
      mode,
    }),
    duration_ms: Date.now() - startTime,
    success: false,
    mode,
    lifecycle: "safety_gate",
    outcome: "block",
  });
}

function getWriteToolModeDecision(name, args = {}) {
  const mode = getOperatingMode();
  const approvalProvided = args.approved === true || args.approval_token === "manual";
  const metadata = {
    operating_mode: mode,
    write_tool: name,
    approval_required: mode === "semi-auto",
    approval_provided: approvalProvided,
  };

  if (mode === "dry-run") {
    return {
      action: "simulate",
      metadata,
      response: {
        simulated: true,
        success: true,
        tool: name,
        mode: metadata,
        args,
        message: `Simulated ${name} in dry-run mode. No write executed.`,
      },
    };
  }

  if (mode === "semi-auto" && !approvalProvided) {
    return {
      action: "block",
      metadata,
      response: {
        blocked: true,
        success: false,
        tool: name,
        mode: metadata,
        reason: `Tool ${name} requires explicit approval in semi-auto mode.`,
      },
    };
  }

  return {
    action: "allow",
    metadata,
  };
}

async function maybeAutoSwapToSol({ baseMint, contextLabel }) {
  if (!baseMint) {
    return {
      status: "skipped",
      reason: "No base mint available for auto-swap.",
    };
  }

  const balances = await getWalletBalances({});
  const token = balances.tokens?.find((t) => t.mint === baseMint);
  if (!token) {
    return {
      status: "skipped",
      reason: `Base token ${baseMint} not found in wallet.`,
    };
  }
  if (token.usd < 0.10) {
    return {
      status: "skipped",
      reason: `Base token value $${token.usd.toFixed(2)} is below auto-swap threshold.`,
      mint: baseMint,
      symbol: token.symbol || baseMint.slice(0, 8),
      amount: token.balance,
      usd: token.usd,
    };
  }

  const symbol = token.symbol || baseMint.slice(0, 8);
  log("executor", `Auto-swapping ${contextLabel} ${symbol} ($${token.usd.toFixed(2)}) back to SOL`);

  const swapResult = await executeTool("swap_token", {
    input_mint: baseMint,
    output_mint: "SOL",
    amount: token.balance,
  });

  if (swapResult?.blocked) {
    log("executor", `Auto-swap ${contextLabel} blocked by operating mode: ${swapResult.reason}`);
    return {
      status: "blocked",
      reason: swapResult.reason,
      mint: baseMint,
      symbol,
      amount: token.balance,
      usd: token.usd,
      mode: swapResult.mode,
    };
  } else if (swapResult?.simulated) {
    log("executor", `Auto-swap ${contextLabel} simulated in ${swapResult.mode?.operating_mode ?? "unknown"} mode`);
    return {
      status: "simulated",
      reason: swapResult.message,
      mint: baseMint,
      symbol,
      amount: token.balance,
      usd: token.usd,
      mode: swapResult.mode,
    };
  }

  if (swapResult?.error) {
    return {
      status: "error",
      reason: swapResult.error,
      mint: baseMint,
      symbol,
      amount: token.balance,
      usd: token.usd,
    };
  }

  return {
    status: "executed",
    mint: baseMint,
    symbol,
    amount: token.balance,
    usd: token.usd,
    tx: swapResult?.tx,
  };
}

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  let modeDecision = null;
  if (WRITE_TOOLS.has(name)) {
    modeDecision = getWriteToolModeDecision(name, args);
  }

  // ─── Pre-execution safety checks ──────────
  if (WRITE_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      const mode = modeDecision?.metadata ?? {
        operating_mode: getOperatingMode(),
        write_tool: name,
      };
      logSafetyBlockAction({ name, args, startTime, safetyCheck, mode });
      return {
        blocked: true,
        success: false,
        tool: name,
        code: safetyCheck.code ?? SAFETY_BLOCK_FALLBACK_CODE,
        reason: safetyCheck.reason,
        mode,
      };
    }
  }

  if (WRITE_TOOLS.has(name)) {
    if (modeDecision?.action === "simulate") {
      log("write_simulated", `${name} simulated in ${modeDecision.metadata.operating_mode} mode`);
      logModeDecisionAction({ name, args, startTime, modeDecision });
      return modeDecision.response;
    }
    if (modeDecision?.action === "block") {
      log("write_blocked", `${name} blocked in ${modeDecision.metadata.operating_mode} mode`);
      logModeDecisionAction({ name, args, startTime, modeDecision });
      return modeDecision.response;
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
      const notificationMode = modeDecision?.metadata?.operating_mode ?? getOperatingMode();
      const notificationStatus = "executed";
      if (name === "swap_token" && result.tx) {
        notifySwap({
          inputSymbol: args.input_mint?.slice(0, 8),
          outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8),
          amountIn: result.amount_in,
          amountOut: result.amount_out,
          tx: result.tx,
          mode: notificationMode,
          status: notificationStatus,
        }).catch(() => {});
      } else if (name === "deploy_position") {
        notifyDeploy({
          pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8),
          amountSol: args.amount_y ?? args.amount_sol ?? 0,
          position: result.position,
          tx: result.txs?.[0] ?? result.tx,
          priceRange: result.price_range,
          binStep: result.bin_step,
          baseFee: result.base_fee,
          mode: notificationMode,
          status: notificationStatus,
        }).catch(() => {});
      } else if (name === "close_position") {
        notifyClose({
          pair: result.pool_name || args.position_address?.slice(0, 8),
          pnlUsd: result.pnl_usd ?? 0,
          pnlPct: result.pnl_pct ?? 0,
          mode: notificationMode,
          status: notificationStatus,
          reason: result.close_reason ?? result.reason,
        }).catch(() => {});
        // Auto-swap base token back to SOL unless user said to hold
        if (!args.skip_swap && result.base_mint) {
          try {
            result.auto_swap = await maybeAutoSwapToSol({ baseMint: result.base_mint, contextLabel: "after close" });
          } catch (e) {
            log("executor_warn", `Auto-swap after close failed: ${e.message}`);
            result.auto_swap = {
              status: "error",
              reason: e.message,
            };
          }
        } else {
          result.auto_swap = {
            status: "skipped",
            reason: args.skip_swap ? "Auto-swap skipped because skip_swap was requested." : "No base mint available for auto-swap.",
          };
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        try {
          result.auto_swap = await maybeAutoSwapToSol({ baseMint: result.base_mint, contextLabel: "after claim" });
        } catch (e) {
          log("executor_warn", `Auto-swap after claim failed: ${e.message}`);
          result.auto_swap = {
            status: "error",
            reason: e.message,
          };
        }
      } else if (name === "claim_fees") {
        result.auto_swap = {
          status: "skipped",
          reason: !config.management.autoSwapAfterClaim
            ? "Auto-swap after claim is disabled in config."
            : "No base mint available for auto-swap.",
        };
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
        return createSafetyFailure(
          DEPLOY_SAFETY_CODES.BIN_STEP_OUT_OF_RANGE,
          `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        );
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return createSafetyFailure(
          DEPLOY_SAFETY_CODES.MAX_POSITIONS_REACHED,
          `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        );
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool && !args.allow_duplicate_pool) {
        return createSafetyFailure(
          DEPLOY_SAFETY_CODES.DUPLICATE_POOL,
          `Already have an open position in pool ${args.pool_address}. Cannot open duplicate. Pass allow_duplicate_pool: true for multi-layer strategy.`,
        );
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return createSafetyFailure(
            DEPLOY_SAFETY_CODES.DUPLICATE_BASE_TOKEN,
            `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          );
        }
      }

      // Check amount limits
      const amountX = args.amount_x ?? 0;
      const amountY = args.amount_y ?? args.amount_sol ?? 0;

      // tokenX-only deploy: skip SOL amount checks
      if (amountX > 0 && amountY === 0) {
        // No SOL needed — tokenX-only deploy
      } else if (amountX > 0 && amountY > 0) {
        // Custom ratio dual-sided: skip minimum SOL check, only enforce max
        if (amountY > config.risk.maxDeployAmount) {
          return createSafetyFailure(
            DEPLOY_SAFETY_CODES.DEPLOY_AMOUNT_TOO_LARGE,
            `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
          );
        }
      } else {
        // Standard SOL-sided deploy
        if (amountY <= 0) {
          return createSafetyFailure(
            DEPLOY_SAFETY_CODES.MISSING_DEPLOY_AMOUNT,
            `Must provide a positive SOL amount (amount_y).`,
          );
        }

        const minDeploy = Math.max(0.1, config.management.deployAmountSol);
        if (amountY < minDeploy) {
          return createSafetyFailure(
            DEPLOY_SAFETY_CODES.DEPLOY_AMOUNT_TOO_SMALL,
            `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
          );
        }
        if (amountY > config.risk.maxDeployAmount) {
          return createSafetyFailure(
            DEPLOY_SAFETY_CODES.DEPLOY_AMOUNT_TOO_LARGE,
            `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
          );
        }
      }

      // Check SOL balance (skip for tokenX-only deploys)
      if (amountY > 0) {
        const balance = await getWalletBalances();
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return createSafetyFailure(
            DEPLOY_SAFETY_CODES.INSUFFICIENT_SOL,
            `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          );
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
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
