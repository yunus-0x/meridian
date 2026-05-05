import "./envcrypt.js";
import Anthropic from "@anthropic-ai/sdk";
import cron from "node-cron";
import readline from "readline";
import { execSync } from "child_process";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, closePosition, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances, swapToken, invalidateAccountCache } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { formatGmgnCandidateForPrompt } from "./tools/gmgn.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary, getLessonsForPrompt, getPerformanceHistory } from "./lessons.js";
import { executeTool, registerCronRestarter } from "./tools/executor.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendMessageWithButtons,
  sendHTML,
  editMessage,
  editMessageWithButtons,
  answerCallbackQuery,
  notifyOutOfRange,
  isEnabled as telegramEnabled,
  createLiveMessage,
} from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, setPositionInstruction, updatePnlAndCheckExits, queuePeakConfirmation, resolvePendingPeak, queueTrailingDropConfirmation, resolvePendingTrailingDrop } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool, setManualCloseCooldown } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { stageSignals } from "./signal-tracker.js";
import { recalculateWeights } from "./signal-weights.js";
import { bootstrapHiveMind, ensureAgentId, getHiveMindPullMode, isHiveMindEnabled, pullHiveMindLessons, pullHiveMindPresets, registerHiveMindAgent, startHiveMindBackgroundSync } from "./hivemind.js";
import { appendDecision } from "./decision-log.js";

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
ensureAgentId();
bootstrapHiveMind().catch((error) => log("hivemind_warn", `Bootstrap failed: ${error.message}`));
startHiveMindBackgroundSync();

const DEPLOY = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles

const SWAP_SKIP_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // wrapped SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
]);

// Swap a single known mint back to SOL — used after close to swap only the position's base token.
async function swapMintToSol(mint) {
  if (!mint) return null;
  const SKIP = new Set([...SWAP_SKIP_MINTS, config.tokens.SOL, config.tokens.USDC].filter(Boolean));
  if (SKIP.has(mint)) return null;
  let token = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 5000));
    const balances = await getWalletBalances({});
    if (balances?.error) continue;
    token = (balances.tokens || []).find(t => t.mint === mint && t.balance > 0);
    if (token) break;
  }
  if (!token) { log("executor_warn", `swapMintToSol: ${mint.slice(0, 8)} not found in wallet after 30s`); return null; }
  try {
    log("executor", `Auto-swapping ${token.symbol || mint.slice(0, 8)} (${token.usd != null ? `$${token.usd.toFixed(2)}` : `${token.balance} tokens`}) back to SOL`);
    const swapResult = await swapToken({ input_mint: mint, output_mint: "SOL", amount: token.balance });
    if (swapResult?.success) { invalidateAccountCache(); return { symbol: token.symbol || mint.slice(0, 8), success: true, sol: swapResult.amount_out }; }
    log("executor_warn", `Auto-swap of ${token.symbol || mint.slice(0, 8)} failed: ${swapResult?.error}`);
    return { symbol: token.symbol || mint.slice(0, 8), success: false, error: swapResult?.error };
  } catch (e) {
    log("executor_warn", `Auto-swap of ${token.symbol || mint.slice(0, 8)} threw: ${e.message}`);
    return { symbol: token.symbol || mint.slice(0, 8), success: false, error: e.message };
  }
}

// Safety sweep — only used by the management cycle startup to catch tokens missed by prior closes.
// High threshold ($0.50) to avoid touching dust from old positions.
async function swapAllTokensToSol() {
  // Also skip config-defined SOL/USDC mints in case they differ
  const skipMints = new Set([...SWAP_SKIP_MINTS, config.tokens.SOL, config.tokens.USDC].filter(Boolean));
  let tokens = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 5000));
    const balances = await getWalletBalances({});
    if (balances?.error) {
      log("executor_warn", `getWalletBalances error on attempt ${attempt + 1}: ${balances.error}`);
      continue;
    }
    tokens = (balances.tokens || []).filter(t => !skipMints.has(t.mint) && t.balance > 0 && t.usd != null && t.usd >= 0.50);
    if (tokens.length > 0) break;
  }
  const results = [];
  for (let ti = 0; ti < tokens.length; ti++) {
    const token = tokens[ti];
    if (ti > 0) await new Promise(r => setTimeout(r, 1500));
    try {
      log("executor", `Auto-swapping ${token.symbol || token.mint.slice(0, 8)} (${token.usd != null ? `$${token.usd.toFixed(2)}` : `${token.balance} tokens`}) back to SOL`);
      const swapResult = await swapToken({ input_mint: token.mint, output_mint: "SOL", amount: token.balance });
      if (swapResult?.success) {
        invalidateAccountCache();
        results.push({ symbol: token.symbol || token.mint.slice(0, 8), success: true, sol: swapResult.amount_out });
      } else {
        log("executor_warn", `Auto-swap of ${token.symbol || token.mint.slice(0, 8)} returned failure: ${swapResult?.error}`);
        results.push({ symbol: token.symbol || token.mint.slice(0, 8), success: false, error: swapResult?.error || "swap returned failure" });
      }
    } catch (e) {
      log("executor_warn", `Auto-swap of ${token.symbol || token.mint.slice(0, 8)} failed: ${e.message}`);
      results.push({ symbol: token.symbol || token.mint.slice(0, 8), success: false, error: e.message });
    }
  }
  return results;
}

// ═══════════════════════════════════════════
//  CLAUDE CHAT
// ═══════════════════════════════════════════
let _anthropic = null;
function getAnthropicClient() {
  if (!_anthropic && process.env.ANTHROPIC_API_KEY) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

const _claudeHistory = []; // Claude-specific conversation history
const MAX_CLAUDE_HISTORY = 20;

async function claudeChat(userMessage, priorHistory = []) {
  const client = getAnthropicClient();
  if (!client) throw new Error("ANTHROPIC_API_KEY not set");

  // Gather live bot context
  const contextLines = [];
  try {
    const [wallet, positions] = await Promise.all([
      getWalletBalances().catch(() => null),
      getMyPositions({ force: false, silent: true }).catch(() => null),
    ]);
    if (wallet && !wallet.error) {
      contextLines.push(`Wallet: ${wallet.sol} SOL ($${wallet.sol_usd}) | SOL price: $${wallet.sol_price}`);
    }
    if (positions?.positions?.length) {
      const posLines = positions.positions.map((p) =>
        `  - ${p.pair}: PnL ${p.pnl_pct ?? "?"}% | value $${p.total_value_usd ?? "?"} | ${p.in_range ? "in range" : `OOR ${p.minutes_out_of_range ?? 0}m`}`
      );
      contextLines.push(`Open positions (${positions.total_positions}):\n${posLines.join("\n")}`);
    } else {
      contextLines.push("Open positions: none");
    }
  } catch { /* non-fatal */ }

  contextLines.push(
    `Config: deploy ${config.management.deployAmountSol} SOL | TP ${config.management.takeProfitPct}% | SL ${config.management.stopLossPct}% | max ${config.risk.maxPositions} positions | trailing TP ${config.management.trailingTakeProfit ? `on (trigger ${config.management.trailingTriggerPct}%, drop ${config.management.trailingDropPct}%)` : "off"}`
  );

  // Trade history — all-time summary + per-day breakdown + full recent list
  const tradeHistoryLines = [];
  try {
    const summary = getPerformanceSummary();
    if (summary) {
      tradeHistoryLines.push(
        `All-time: ${summary.total_positions_closed} closed | win rate ${summary.win_rate_pct}% | total PnL $${summary.total_pnl_usd} | avg ${summary.avg_pnl_pct}%`
      );
    }

    // Per-day breakdown for last 7 days
    const allHistory = getPerformanceHistory({ hours: 24 * 365, limit: 500 });
    if (allHistory.positions.length) {
      // Group by calendar date (UTC)
      const byDay = {};
      for (const t of allHistory.positions) {
        const day = (t.closed_at || "").slice(0, 10);
        if (!day) continue;
        if (!byDay[day]) byDay[day] = [];
        byDay[day].push(t);
      }
      const days = Object.keys(byDay).sort().reverse().slice(0, 7);
      if (days.length) {
        const dayLines = days.map((day) => {
          const trades = byDay[day];
          const pnl = trades.reduce((s, t) => s + (t.pnl_usd ?? 0), 0);
          const wins = trades.filter((t) => t.pnl_usd > 0).length;
          const sign = pnl >= 0 ? "+" : "";
          return `  ${day}: ${trades.length} trades | ${sign}$${pnl.toFixed(2)} | ${wins}W/${trades.length - wins}L`;
        });
        tradeHistoryLines.push(`Daily breakdown (last 7 days):\n${dayLines.join("\n")}`);
      }

      // Full individual trade list (most recent first, up to 30)
      const recent = [...allHistory.positions].reverse().slice(0, 30);
      const tradeLines = recent.map((t) => {
        const sign = t.pnl_usd >= 0 ? "+" : "";
        const date = (t.closed_at || "").slice(0, 10);
        return `  [${date}] ${t.pool_name || t.pool?.slice(0, 8)}: ${sign}$${t.pnl_usd} (${sign}${t.pnl_pct}%) | ${t.close_reason || "closed"} | ${t.minutes_held ?? "?"}m`;
      });
      tradeHistoryLines.push(`Trade history (${recent.length} most recent):\n${tradeLines.join("\n")}`);
    }
  } catch { /* non-fatal */ }

  // Learned lessons
  const lessonsText = getLessonsForPrompt({ agentType: "GENERAL", maxLessons: 10 });

  const systemPrompt = [
    "You are the AI assistant for Meridian, an autonomous DLMM liquidity provider agent running on Solana's Meteora protocol.",
    "You help the user manage their LP positions, understand market conditions, and optimize their DeFi strategy.",
    "You are knowledgeable about DLMM mechanics, bin ranges, fee/TVL ratios, impermanent loss, and Solana DeFi.",
    "Keep responses concise and practical — this is a Telegram chat interface.",
    "You are advisory — you explain, analyze, and recommend. You cannot execute trades or config changes directly. If the user wants to act, tell them to send the command (e.g. 'deploy', 'close position 1', 'set SL to -5%').",
    "",
    "=== LIVE BOT STATE ===",
    ...contextLines,
    ...(tradeHistoryLines.length ? ["", "=== TRADE HISTORY ===", ...tradeHistoryLines] : []),
    ...(lessonsText ? ["", "=== LEARNED LESSONS ===", lessonsText] : []),
    ...(() => {
      const lines = priorHistory
        .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
        .slice(-10)
        .map(m => `${m.role === "user" ? "User" : "Bot"}: ${m.content.trim()}`);
      return lines.length ? ["", "=== RECENT CONVERSATION ===", ...lines] : [];
    })(),
  ].join("\n");

  // Build messages including history
  const messages = [
    ..._claudeHistory.slice(-MAX_CLAUDE_HISTORY),
    { role: "user", content: userMessage },
  ];

  const response = await client.messages.create({
    model: config.llm.claudeModel,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system: systemPrompt,
    messages,
  });

  const replyText = response.content.find((b) => b.type === "text")?.text || "(no response)";

  // Store full content array so thinking blocks survive multi-turn
  _claudeHistory.push({ role: "user", content: userMessage });
  _claudeHistory.push({ role: "assistant", content: response.content });
  if (_claudeHistory.length > MAX_CLAUDE_HISTORY) {
    _claudeHistory.splice(0, _claudeHistory.length - MAX_CLAUDE_HISTORY);
  }

  return replyText;
}

let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
let _pollTriggeredAt = 0; // epoch ms — cooldown for poller-triggered management
const _peakConfirmTimers = new Map();
const _trailingDropConfirmTimers = new Map();
const TRAILING_PEAK_CONFIRM_DELAY_MS = 15_000;
const TRAILING_PEAK_CONFIRM_TOLERANCE = 0.85;
const TRAILING_DROP_CONFIRM_DELAY_MS = 15_000;
const TRAILING_DROP_CONFIRM_TOLERANCE_PCT = 1.0;

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

function shouldUsePnlRecheck() {
  return !config.api.lpAgentRelayEnabled;
}

function schedulePeakConfirmation(positionAddress) {
  if (!positionAddress || _peakConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _peakConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      resolvePendingPeak(positionAddress, position?.pnl_pct ?? null, TRAILING_PEAK_CONFIRM_TOLERANCE);
    } catch (error) {
      log("state_warn", `Peak confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_PEAK_CONFIRM_DELAY_MS);

  _peakConfirmTimers.set(positionAddress, timer);
}

function scheduleTrailingDropConfirmation(positionAddress) {
  if (!positionAddress || _trailingDropConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _trailingDropConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      const resolved = resolvePendingTrailingDrop(
        positionAddress,
        position?.pnl_pct ?? null,
        config.management.trailingDropPct,
        TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
      );
      if (resolved?.confirmed) {
        log("state", `[Trailing recheck] Confirmed trailing exit for ${positionAddress} — triggering management`);
        runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Trailing recheck management failed: ${e.message}`));
      }
    } catch (error) {
      log("state_warn", `Trailing drop confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_DROP_CONFIRM_DELAY_MS);

  _trailingDropConfirmTimers.set(positionAddress, timer);
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  if (_cronTasks._heartbeatInterval) clearInterval(_cronTasks._heartbeatInterval);
  _cronTasks = [];
}

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }

    // Safety sweep — catch any tokens left over from a previous close that weren't swapped
    swapAllTokensToSol().catch((e) => log("executor_warn", `Token sweep failed: ${e.message}`));

    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "No open positions. Triggering screening cycle.";
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      return mgmtReport;
    }

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    });

    // JS trailing TP check
    const exitMap = new Map();
    for (const p of positionData) {
      if (
        !p.pnl_pct_suspicious &&
        queuePeakConfirmation(p.position, p.pnl_pct, { immediate: !shouldUsePnlRecheck() }) &&
        shouldUsePnlRecheck()
      ) {
        schedulePeakConfirmation(p.position);
      }
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) {
        if (exit.action === "TRAILING_TP" && exit.needs_confirmation && shouldUsePnlRecheck()) {
          if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct)) {
            scheduleTrailingDropConfirmation(p.position);
          }
          continue;
        }
        exitMap.set(p.position, { action: exit.action, reason: exit.reason });
        log("state", `Exit alert for ${p.pair} [${exit.action}]: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
    const actionMap = new Map();
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        const exitEntry = exitMap.get(p.position);
        actionMap.set(p.position, { action: "CLOSE", rule: exitEntry.action, reason: exitEntry.reason });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      const closeRule = getDeterministicCloseRule(p, config.management);
      if (closeRule) {
        actionMap.set(p.position, closeRule);
        continue;
      }
      // Claim rule
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = config.management.solMode ? `◎${p.total_value_usd ?? "?"}` : `$${p.total_value_usd ?? "?"}`;
      const unclaimed = config.management.solMode ? `◎${p.unclaimed_fees_usd ?? "?"}` : `$${p.unclaimed_fees_usd ?? "?"}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${p.pnl_pct ?? "?"}% | Yield: ${p.fee_per_tvl_24h ?? "?"}% | ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule === "TRAILING_TP") line += `\n⚡ Trailing TP: ${act.reason}`;
      else if (act.action === "CLOSE" && act.rule && typeof act.rule === "string" && act.rule !== "TRAILING_TP") line += `\n${act.reason}`;
      else if (act.action === "CLOSE" && act.rule && typeof act.rule === "number") line += `\nRule ${act.rule}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = config.management.solMode ? "◎" : "$";
    mgmtReport = reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${positions.length} positions | ${cur}${totalValue.toFixed(4)} | fees: ${cur}${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    // ── Execute CLOSE actions directly — no LLM involvement ────────
    // SL / TP / OOR / trailing TP are deterministic rules; routing them through
    // the LLM introduces discretion where none is wanted.
    const directClosePositions = positionData.filter(p => actionMap.get(p.position)?.action === "CLOSE");
    for (const p of directClosePositions) {
      const act = actionMap.get(p.position);
      log("cron", `Direct close: ${p.pair} — ${act.reason}`);
      await liveMessage?.toolStart("close_position");
      try {
        const result = await executeTool("close_position", {
          position_address: p.position,
          reason: act.reason,
        });
        await liveMessage?.toolFinish("close_position", result, result?.success ?? false);
        mgmtReport += `\n\n✅ Closed ${p.pair}: ${act.reason}`;
        const closedOk = result?.success || result?.close_txs?.length;
        if (closedOk) {
          // SL cooldown: block re-entry for 24h after stop-loss
          if (act.rule === 1 || act.rule === "STOP_LOSS") {
            setManualCloseCooldown(p.pool, result?.base_mint || null, config.management.slReentryCooldownHours ?? 24);
          }
          // OOR upside cooldown: block re-entry after pump-above-range or above-range OOR
          const isUpsideOOR = act.rule === 3 ||
            ((act.rule === 4 || act.rule === "OUT_OF_RANGE") &&
              p.active_bin != null && p.upper_bin != null && p.active_bin > p.upper_bin);
          if (isUpsideOOR) {
            setManualCloseCooldown(p.pool, result?.base_mint || null, config.management.oorReentryCooldownHours ?? 6);
          }
        }
      } catch (e) {
        log("cron_error", `Direct close of ${p.pair} failed: ${e.message}`);
        await liveMessage?.toolFinish("close_position", { error: e.message }, false);
        mgmtReport += `\n\n❌ Close failed ${p.pair}: ${e.message}`;
      }
    }

    // ── Call LLM only for CLAIM and INSTRUCTION (need context/judgment) ──
    const llmPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action === "CLAIM" || a.action === "INSTRUCTION";
    });

    if (llmPositions.length > 0) {
      log("cron", `Management: ${llmPositions.length} LLM action(s) needed — invoking LLM [model: ${config.llm.managementModel}]`);

      const actionBlocks = llmPositions.map((p) => {
        const act = actionMap.get(p.position);
        return [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  action: ${act.action}${act.rule && act.reason ? ` — ${act.reason}` : ""}`,
          `  pnl_pct: ${p.pnl_pct}% | fee_pnl_pct: ${p.fee_pnl_pct ?? "?"}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
          `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
        ].filter(Boolean).join("\n");
      }).join("\n\n");

      const { content } = await agentLoop(`
MANAGEMENT ACTION REQUIRED — ${llmPositions.length} position(s)

${actionBlocks}

RULES:
- CLAIM: call claim_fees with position address
- INSTRUCTION: evaluate the instruction condition. If met → close_position. If not → HOLD, do nothing.

Execute the required actions. After executing, write a brief one-line result per position.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });

      mgmtReport += `\n\n${content}`;
    } else if (directClosePositions.length === 0) {
      log("cron", "Management: all positions STAY — skipping LLM");
      await liveMessage?.note("No tool actions needed.");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
        else sendMessage(`🔄 Management Cycle\n\n${stripThink(mgmtReport)}`).catch(() => { });
      }
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    const isDryRun = process.env.DRY_RUN === "true";
    if (!isDryRun && preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    _screeningBusy = false;
    return screenReport;
  }
  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    const deployAmount = computeDeployAmount(currentBalance.sol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const strategyBlock = activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
      : `No active strategy — use strategy=${config.strategy.strategy}, bins_above=0, SOL only.`;

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch((e) => ({ _error: e.message }));
    if (topCandidates?._error) {
      screenReport = `Screening failed: ${topCandidates._error}`;
      _screeningBusy = false;
      return screenReport;
    }
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];
    const gmgnStageCounts = topCandidates?.stage_counts ?? null;
    const gmgnAllFiltered = topCandidates?.all_filtered ?? [];

    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        mem: recallForPool(pool.pool),
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
    // Skipped for GMGN: platforms already filtered upstream; bundler/bot data from GMGN pipeline
    const filteredOut = [];
    const passing = allCandidates.filter(({ pool, ti }) => {
      if (pool.gmgn) return true;
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
        return false;
      }
      const top10Pct = ti?.audit?.top_holders_pct;
      const maxTop10Pct = config.screening.maxTop10Pct;
      if (top10Pct != null && maxTop10Pct != null && top10Pct > maxTop10Pct) {
        log("screening", `Top10 filter: dropped ${pool.name} — top10 ${top10Pct}% > ${maxTop10Pct}%`);
        filteredOut.push({ name: pool.name, reason: `top10 ${top10Pct}% > ${maxTop10Pct}%` });
        return false;
      }
      return true;
    });

    if (passing.length === 0) {
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 5)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      const funnelBlock = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
      const thresholds = `Thresholds: tvl>$${config.screening.minTvl} | vol>$${config.screening.minVolume} | organic>${config.screening.minOrganic}% | holders>${config.screening.minHolders} | fee/tvl>${config.screening.minFeeActiveTvlRatio}%`;
      screenReport = funnelBlock
        ? `No candidates available.\n\n${funnelBlock}`
        : combinedExamples
          ? `No candidates available.\nFiltered examples:\n${combinedExamples}`
          : `No candidates available (all filtered).\n${thresholds}`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: funnelBlock || combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry) => `${entry.name}: ${entry.reason}`),
      });
      return screenReport;
    }

    if (passing.length <= 1 && gmgnStageCounts) {
      const funnelBlock = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
      if (funnelBlock) log("screening", `GMGN funnel (sparse):\n${funnelBlock}`);
    }

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // Build compact candidate blocks
    const candidateBlocks = passing.map(({ pool, sw, n, ti, mem }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      // OKX signals
      const okxParts = [
        pool.risk_level     != null ? `risk=${pool.risk_level}`               : null,
        pool.bundle_pct     != null ? `bundle=${pool.bundle_pct}%`            : null,
        pool.sniper_pct     != null ? `sniper=${pool.sniper_pct}%`            : null,
        pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%`    : null,
        pool.new_wallet_pct != null ? `new_wallets=${pool.new_wallet_pct}%`   : null,
        pool.is_rugpull != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
        pool.is_wash != null ? `wash=${pool.is_wash ? "YES" : "NO"}` : null,
      ].filter(Boolean).join(", ");
      const okxUnavailable = !okxParts && pool.price_vs_ath_pct == null;

      const okxTags = [
        pool.smart_money_buy    ? "smart_money_buy"    : null,
        pool.kol_in_clusters    ? "kol_in_clusters"    : null,
        pool.dex_boost          ? "dex_boost"          : null,
        pool.dex_screener_paid  ? "dex_screener_paid"  : null,
        pool.dev_sold_all       ? "dev_sold_all(bullish)" : null,
      ].filter(Boolean).join(", ");
      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;
      let block;
      if (pool.gmgn) {
        block = [
          `POOL: ${pool.name} (${pool.pool})`,
          formatGmgnCandidateForPrompt(pool),
          pvpLine,
          `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
          activeBin != null ? `  active_bin: ${activeBin}` : null,
          n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
          mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
        ].filter(Boolean).join("\n");
      } else {
        const gmgnPriceLine = pool.gmgn_price_action
          ? `  gmgn_price: rsi2=${pool.gmgn_price_action.rsi2 ?? "?"}, supertrend=${pool.gmgn_price_action.supertrend?.direction || "?"}, price_vs_ath=${pool.gmgn_price_action.priceVsAthPct ?? "?"}%, 1h_change=${pool.gmgn_price_action.priceChangePct ?? "?"}%, max_vol_candle=${pool.gmgn_price_action.maxVolumeShare ?? "?"}%`
          : null;
        block = [
          `POOL: ${pool.name} (${pool.pool})`,
          `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
          `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
          gmgnPriceLine,
          pvpLine,
          okxParts ? `  okx: ${okxParts}` : okxUnavailable ? `  okx: unavailable` : null,
          okxTags  ? `  tags: ${okxTags}` : null,
          pool.price_vs_ath_pct != null ? `  ath: price_vs_ath=${pool.price_vs_ath_pct}%${pool.top_cluster_trend ? `, top_cluster=${pool.top_cluster_trend}` : ""}` : null,
          `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
          activeBin != null ? `  active_bin: ${activeBin}` : null,
          priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
          n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
          mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
        ].filter(Boolean).join("\n");
      }

      // Stage signals for Darwinian weighting — captured before LLM decides
      if (config.darwin?.enabled) {
        stageSignals(pool.pool, {
          organic_score:         pool.organic_score         ?? null,
          fee_tvl_ratio:         pool.fee_active_tvl_ratio  ?? null,
          volume:                pool.volume_window         ?? null,
          mcap:                  pool.mcap                  ?? null,
          holder_count:          ti?.holders                ?? null,
          smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
          narrative_quality:     n?.narrative ? "present" : "absent",
          volatility:            pool.volatility            ?? null,
        });
      }

      return block;
    });

    const { content } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Pick the best candidate based on narrative quality, smart wallets, and pool metrics.
2. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   strategy = ${config.strategy.strategy} (always use this, never change it).
   bins_below = round(${config.strategy.minBinsBelow} + (volatility/5)*${config.strategy.maxBinsBelow - config.strategy.minBinsBelow}) clamped to [${config.strategy.minBinsBelow},${config.strategy.maxBinsBelow}].
   bins_above = 0. Single-side SOL only: set amount_y, keep amount_x = 0.
3. Report in this exact format (no tables, no extra sections):
   🚀 DEPLOYED

   <pool name>
   <pool address>

   ◎ <deploy amount> SOL | <strategy> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Range cover: <downside %> downside | <upside %> upside | <total width %> total

   IMPORTANT:
   - Do NOT calculate the range percentages yourself.
   - Use the actual deploy_position tool result:
     range_coverage.downside_pct
     range_coverage.upside_pct
     range_coverage.width_pct

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   RISK
   <If OKX advanced/risk data exists, list only the fields that actually exist: Risk level, Bundle, Sniper, Suspicious, ATH distance, Rugpull, Wash.>
   <If only rugpull/wash exist, list just those.>
   <If OKX enrichment is missing, write exactly: OKX: unavailable>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
4. If no pool qualifies, report in this exact format instead:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Never write "unknown" for OKX. Use real values, omit missing fields, or write exactly "OKX: unavailable".
- Keep the whole report compact and highly scannable for Telegram.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });
    const funnelAppend = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
    screenReport = funnelAppend ? `${content}\n\n─────────────\n${funnelAppend}` : content;
    if (/⛔\s*NO DEPLOY/i.test(content)) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "LLM chose no deploy",
        reason: stripThink(content).slice(0, 500),
      });
    }
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled()) {
      if (screenReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
        else sendMessage(`🔍 Screening Cycle\n\n${stripThink(screenReport)}`).catch(() => { });
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Lightweight 30s PnL poller — updates trailing TP state between management cycles, no LLM
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        if (
          !p.pnl_pct_suspicious &&
          queuePeakConfirmation(p.position, p.pnl_pct, { immediate: !shouldUsePnlRecheck() }) &&
          shouldUsePnlRecheck()
        ) {
          schedulePeakConfirmation(p.position);
        }
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        if (exit) {
          if (exit.action === "TRAILING_TP" && exit.needs_confirmation && shouldUsePnlRecheck()) {
            if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct)) {
              scheduleTrailingDropConfirmation(p.position);
            }
            continue;
          }
          const EXIT_COOLDOWN_MS = 60_000; // short cooldown for exit triggers — don't wait the full management interval
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= EXIT_COOLDOWN_MS) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management`);
            runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — cooldown (${Math.round((EXIT_COOLDOWN_MS - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
        const closeRule = getDeterministicCloseRule(p, config.management);
        if (closeRule) {
          const EXIT_COOLDOWN_MS = 60_000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= EXIT_COOLDOWN_MS) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Deterministic close rule: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} — triggering management`);
            runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Deterministic close rule: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} — cooldown (${Math.round((EXIT_COOLDOWN_MS - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, 30_000);

  // Heartbeat watchdog — alert if cycles have been silent too long
  let _lastHeartbeatAlert = 0;
  const HEARTBEAT_CHECK_MS = 5 * 60 * 1000;
  const HEARTBEAT_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // max 1 alert per hour
  const heartbeatInterval = setInterval(async () => {
    if (!telegramEnabled()) return;
    const now = Date.now();
    if (now - _lastHeartbeatAlert < HEARTBEAT_ALERT_COOLDOWN_MS) return;
    const mgmtSilentMs = timers.managementLastRun ? now - timers.managementLastRun : null;
    const mgmtThresholdMs = (config.schedule.managementIntervalMin + 10) * 60 * 1000;
    if (mgmtSilentMs !== null && mgmtSilentMs > mgmtThresholdMs && !_managementBusy && !_screeningBusy) {
      _lastHeartbeatAlert = now;
      const silentMin = Math.round(mgmtSilentMs / 60_000);
      sendMessage(`⚠️ Heartbeat alert: no management cycle in ${silentMin}m (expected every ${config.schedule.managementIntervalMin}m). Bot may be stalled.`).catch(() => {});
    }
  }, HEARTBEAT_CHECK_MS);

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store interval refs so stopCronJobs can clear them
  _cronTasks._pnlPollInterval = pnlPollInterval;
  _cronTasks._heartbeatInterval = heartbeatInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
async function shutdown(signal) {
  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  const positions = await getMyPositions();
  log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

function getDeterministicCloseRule(position, managementConfig) {
  const tracked = getTrackedPosition(position.position);
  const pnlSuspect = (() => {
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct_suspicious) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% flagged suspicious by sanity check — skipping PnL rules`);
      return true;
    }
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: `Stop loss: PnL ${position.pnl_pct.toFixed(2)}% <= ${managementConfig.stopLossPct}%` };
  }
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= managementConfig.takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: `Take profit: PnL ${position.pnl_pct.toFixed(2)}% >= ${managementConfig.takeProfitPct}%` };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose &&
    (managementConfig.outOfRangePumpWaitMinutes <= 0 ||
      (position.minutes_out_of_range ?? 0) >= managementConfig.outOfRangePumpWaitMinutes)
  ) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.lower_bin != null &&
    (position.active_bin > position.upper_bin || position.active_bin < position.lower_bin) &&
    (position.minutes_out_of_range ?? 0) >= managementConfig.outOfRangeWaitMinutes
  ) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= (managementConfig.minAgeBeforeYieldCheck ?? 60)
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }

  // Long-hold decay: close when fees dried up after extended in-range hold
  const maxInRangeHours = managementConfig.maxInRangeHours ?? null;
  const minRollingFeeGrowth = managementConfig.minRollingFeeGrowthPct ?? null;
  if (maxInRangeHours != null && minRollingFeeGrowth != null && position.in_range) {
    const ageMinutes = position.age_minutes ?? 0;
    if (ageMinutes >= maxInRangeHours * 60 && tracked?.fee_snapshots?.length >= 2) {
      const lookbackMs = 60 * 60 * 1000;
      const baseline = [...tracked.fee_snapshots].reverse().find(s => s.ts <= Date.now() - lookbackMs);
      if (baseline != null && position.fee_pnl_pct != null) {
        const growth60m = position.fee_pnl_pct - baseline.fee_pnl_pct;
        if (growth60m < minRollingFeeGrowth) {
          return {
            action: "CLOSE",
            rule: 6,
            reason: `Long-hold decay: earned ${growth60m.toFixed(3)}% fees in last 60m (min: ${minRollingFeeGrowth}%) after ${ageMinutes}m in range`,
          };
        }
      }
    }
  }

  return null;
}

function buildGmgnFunnelReport(stageCounts, allFiltered = [], { fromStage = 1 } = {}) {
  if (!stageCounts) return null;
  const sc = stageCounts;
  const funnel = `GMGN funnel: ranked=${sc.ranked ?? "?"} → S1=${sc.s1 ?? "?"} → S2=${sc.s2 ?? "?"} → S3=${sc.s3 ?? "?"} → S4=${sc.s4 ?? "?"} → final=${sc.s5 ?? "?"}`;
  const byStage = {};
  for (const f of allFiltered) {
    if (f.stage < fromStage) continue;
    const key = `s${f.stage}`;
    if (!byStage[key]) byStage[key] = [];
    byStage[key].push(`${f.name}: ${f.reason}`);
  }
  const stageLabels = { s2: "S2 info", s3: "S3 pool", s4: "S4 indicators", s5: "S5 pick" };
  const details = Object.entries(byStage)
    .map(([key, items]) => `${stageLabels[key] || key}:\n${items.map(r => `  • ${r}`).join("\n")}`)
    .join("\n");
  return details ? `${funnel}\n\n${details}` : funnel;
}

function computeBinsBelow(volatility) {
  const lo = config.strategy.minBinsBelow;
  const hi = config.strategy.maxBinsBelow;
  return Math.max(lo, Math.min(hi, Math.round(lo + ((Number(volatility) || 0) / 5) * (hi - lo))));
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)
let _ttyInterface = null;
let _latestCandidates = [];
let _latestCandidatesAt = null;
let _pendingInput = null; // { key, page, menuMsgId }
let _pendingConfirmation = null; // { toolName, toolArgs } — set when agent queues a write action
let _pendingShellCmd = null;    // string — set when /run <cmd> awaits user confirmation

function setLatestCandidates(candidates = []) {
  _latestCandidates = Array.isArray(candidates) ? candidates : [];
  _latestCandidatesAt = new Date().toISOString();
}

function getLatestCandidatesMeta() {
  return {
    candidates: _latestCandidates,
    count: _latestCandidates.length,
    updatedAt: _latestCandidatesAt,
  };
}

function describeLatestCandidates(limit = 5) {
  if (!_latestCandidates.length) return "No cached candidates yet. Run /screen first.";
  const lines = _latestCandidates.slice(0, limit).map((pool, i) => {
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
    const vol = pool.volume_window ?? pool.volume_24h ?? "?";
    const active = pool.active_pct ?? "?";
    const organic = pool.organic_score ?? "?";
    return `${i + 1}. ${pool.name} | fee/aTVL ${feeTvl}% | vol $${vol} | in-range ${active}% | organic ${organic}`;
  });
  const age = _latestCandidatesAt ? new Date(_latestCandidatesAt).toLocaleString("en-US", { hour12: false }) : "unknown";
  return `Latest candidates (${_latestCandidates.length}) — updated ${age}\n\n${lines.join("\n")}`;
}

function formatWalletStatus(wallet, positions) {
  const deployAmount = computeDeployAmount(wallet.sol);
  const hive = isHiveMindEnabled() ? "on" : "off";
  return [
    `Wallet: ${wallet.sol} SOL ($${wallet.sol_usd})`,
    `SOL price: $${wallet.sol_price}`,
    `Open positions: ${positions.total_positions}/${config.risk.maxPositions}`,
    `Next deploy amount: ${deployAmount} SOL`,
    `Dry run: ${process.env.DRY_RUN === "true" ? "yes" : "no"}`,
    `HiveMind: ${hive}`,
  ].join("\n");
}

function formatConfigSnapshot() {
  return [
    "Config snapshot",
    "",
    `Screening source: ${config.screening.source}`,
    `Strategy: ${config.strategy.strategy} | bins: [${config.strategy.minBinsBelow}–${config.strategy.maxBinsBelow}] (volatility-scaled)`,
    `Deploy: ${config.management.deployAmountSol} SOL | gasReserve: ${config.management.gasReserve} | maxPositions: ${config.risk.maxPositions}`,
    `Stop loss: ${config.management.stopLossPct}% | take profit: ${config.management.takeProfitPct}%`,
    `Trailing: ${config.management.trailingTakeProfit ? "on" : "off"} | trigger ${config.management.trailingTriggerPct}% | drop ${config.management.trailingDropPct}%`,
    `OOR: ${config.management.outOfRangeWaitMinutes}m | cooldown ${config.management.oorCooldownTriggerCount}x / ${config.management.oorCooldownHours}h`,
    `Repeat deploy cooldown: ${config.management.repeatDeployCooldownEnabled ? "on" : "off"} | ${config.management.repeatDeployCooldownTriggerCount}x / ${config.management.repeatDeployCooldownHours}h | min fee earned ${config.management.repeatDeployCooldownMinFeeEarnedPct}% | ${config.management.repeatDeployCooldownScope}`,
    `Yield floor: ${config.management.minFeePerTvl24h}% | min age ${config.management.minAgeBeforeYieldCheck}m`,
    `Screening: ${config.screening.category} / ${config.screening.timeframe} | TVL ${config.screening.minTvl}-${config.screening.maxTvl}`,
    `GMGN interval: ${config.gmgn.interval} | OrderBy: ${config.gmgn.orderBy} | Dir: ${config.gmgn.direction}`,
    `Intervals: manage ${config.schedule.managementIntervalMin}m | screen ${config.schedule.screeningIntervalMin}m`,
    `HiveMind: ${isHiveMindEnabled() ? "enabled" : "disabled"}${config.hiveMind.agentId ? ` | ${config.hiveMind.agentId}` : ""}`,
  ].join("\n");
}

function parseConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

function settingValue(key) {
  const values = {
    solMode: config.management.solMode,
    lpAgentRelayEnabled: config.api.lpAgentRelayEnabled,
    chartIndicatorsEnabled: config.indicators.enabled,
    trailingTakeProfit: config.management.trailingTakeProfit,
    useDiscordSignals: config.screening.useDiscordSignals,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    screeningSource: config.screening.source,
    gmgnRequireKol: config.gmgn.requireKol,
    gmgnInterval: config.gmgn.interval,
    gmgnIndicatorFilter: config.gmgn.indicatorFilter,
    gmgnMinVolume: config.gmgn.minVolume,
    gmgnMinTokenAgeHours: config.gmgn.minTokenAgeHours,
    gmgnMaxTokenAgeHours: config.gmgn.maxTokenAgeHours,
    gmgnMaxBundlerRate: config.gmgn.maxBundlerRate,
    gmgnPreferredKolNames: config.gmgn.preferredKolNames,
    gmgnPreferredKolMinHoldPct: config.gmgn.preferredKolMinHoldPct,
    gmgnDumpKolNames: config.gmgn.dumpKolNames,
    gmgnDumpKolMinHoldPct: config.gmgn.dumpKolMinHoldPct,
    gmgnIndicatorInterval: config.gmgn.indicatorInterval,
    gmgnRequireBullishSt: config.gmgn.indicatorRules?.requireBullishSupertrend,
    gmgnRejectAtBottom: config.gmgn.indicatorRules?.rejectAlreadyAtBottom,
    gmgnRequireAboveSt: config.gmgn.indicatorRules?.requireAboveSupertrend,
    gmgnMinRsi: config.gmgn.indicatorRules?.minRsi,
    gmgnMaxRsi: config.gmgn.indicatorRules?.maxRsi,
    gmgnMinKolCount: config.gmgn.minKolCount,
    gmgnMinTotalFeeSol: config.gmgn.minTotalFeeSol,
    gmgnMinHolders: config.gmgn.minHolders,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxDeployAmount: config.risk.maxDeployAmount,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
  };
  return values[key];
}

function fmtSettingValue(value) {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function settingButton(label, data) {
  return { text: label, callback_data: data };
}

function toggleButton(key, label) {
  return settingButton(`${label}: ${fmtSettingValue(settingValue(key))}`, `cfg:toggle:${key}`);
}

function inputButton(key, label, { digits = 0 } = {}) {
  const value = settingValue(key);
  const shown = value == null ? "off" : Number.isFinite(Number(value)) ? String(parseFloat(Number(value).toFixed(digits))) : String(value);
  return [settingButton(`${label}: ${shown} ✏`, `cfg:input:${key}`)];
}

function renderSettingsMenu(page = "main") {
  const title = page === "main" ? "Settings menu" : `Settings: ${page}`;
  const summary = [
    title,
    "",
    `Mode: ${config.management.solMode ? "SOL" : "USD"} | Relay: ${config.api.lpAgentRelayEnabled ? "on" : "off"}`,
    `Screening: ${config.screening.source} | GMGN KOL ${config.gmgn.requireKol ? "required" : "preferred"}`,
    `Strategy: ${config.strategy.strategy} | deploy ${config.management.deployAmountSol} SOL | max pos ${config.risk.maxPositions}`,
    `TP/SL: ${config.management.takeProfitPct}% / ${config.management.stopLossPct}% | trailing ${config.management.trailingTakeProfit ? "on" : "off"}`,
    `Indicators: ${config.indicators.enabled ? "on" : "off"} | entry ${config.indicators.entryPreset} | ${fmtSettingValue(config.indicators.intervals)}`,
  ].join("\n");

  const nav = [
    [
      settingButton("Main", "cfg:page:main"),
      settingButton("Risk", "cfg:page:risk"),
      settingButton("Strategy", "cfg:page:strategy"),
    ],
    [
      settingButton("Screen", "cfg:page:screen"),
      settingButton("Indicators", "cfg:page:indicators"),
      settingButton("GMGN", "cfg:page:gmgn"),
      settingButton("KOL", "cfg:page:kol"),
    ],
  ];

  const footer = [
    [
      settingButton("Refresh", `cfg:page:${page}`),
      settingButton("Close", "cfg:close"),
    ],
  ];

  let rows;
  if (page === "risk") {
    rows = [
      inputButton("deployAmountSol", "Deploy SOL", { digits: 2 }),
      inputButton("gasReserve", "Gas reserve", { digits: 2 }),
      inputButton("maxPositions", "Max positions"),
      inputButton("maxDeployAmount", "Max SOL"),
      inputButton("takeProfitPct", "TP %"),
      inputButton("stopLossPct", "SL %"),
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      inputButton("trailingTriggerPct", "Trail trigger", { digits: 1 }),
      inputButton("trailingDropPct", "Trail drop", { digits: 1 }),
      [toggleButton("repeatDeployCooldownEnabled", "Repeat cooldown")],
      inputButton("repeatDeployCooldownTriggerCount", "Repeat count"),
      inputButton("repeatDeployCooldownHours", "Repeat hrs"),
      inputButton("repeatDeployCooldownMinFeeEarnedPct", "Min fee earned %", { digits: 1 }),
    ];
  } else if (page === "screen") {
    rows = [
      [
        settingButton("Source: Meteora", "cfg:set:screeningSource:meteora"),
        settingButton("Source: GMGN", "cfg:set:screeningSource:gmgn"),
      ],
      [toggleButton("gmgnRequireKol", "GMGN require KOL")],
      [toggleButton("useDiscordSignals", "Discord signals"), toggleButton("blockPvpSymbols", "PVP hard block")],
      [
        settingButton("5m", "cfg:set:gmgnInterval:5m"),
        settingButton("1h", "cfg:set:gmgnInterval:1h"),
        settingButton("6h", "cfg:set:gmgnInterval:6h"),
        settingButton("24h", "cfg:set:gmgnInterval:24h"),
      ],
      [
        inputButton("gmgnMinVolume", "Min volume")[0],
        inputButton("gmgnMinTokenAgeHours", "Min token age (h)")[0],
      ],
      [
        inputButton("gmgnMaxTokenAgeHours", "Max token age (h)")[0],
        inputButton("gmgnMaxBundlerRate", "Max bundler %")[0],
      ],
      [settingButton("KOL settings", "cfg:page:kol")],
      inputButton("managementIntervalMin", "Manage interval (min)"),
      inputButton("screeningIntervalMin", "Screen interval (min)"),
    ];
  } else if (page === "strategy") {
    rows = [
      [
        settingButton("spot", "cfg:set:strategy:spot"),
        settingButton("bid_ask", "cfg:set:strategy:bid_ask"),
      ],
      inputButton("minBinsBelow", "Min bins"),
      inputButton("maxBinsBelow", "Max bins"),
    ];
  } else if (page === "gmgn") {
    rows = [
      [toggleButton("gmgnIndicatorFilter", "Indicator filter"), toggleButton("gmgnRequireKol", "Require KOL")],
      [
        settingButton("TF: 5m", "cfg:set:gmgnIndicatorInterval:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:gmgnIndicatorInterval:15_MINUTE"),
        settingButton("TF: 1h", "cfg:set:gmgnIndicatorInterval:1h"),
      ],
      [toggleButton("gmgnRequireBullishSt", "Bullish ST"), toggleButton("gmgnRejectAtBottom", "Reject at bottom"), toggleButton("gmgnRequireAboveSt", "Above ST")],
      inputButton("gmgnMinRsi", "Min RSI"),
      inputButton("gmgnMaxRsi", "Max RSI"),
      inputButton("gmgnMinKolCount", "Min KOL"),
      inputButton("gmgnMinTotalFeeSol", "Min fee SOL"),
      inputButton("gmgnMinHolders", "Min holders"),
      [settingButton("KOL settings", "cfg:page:kol")],
    ];
  } else if (page === "kol") {
    rows = [
      inputButton("gmgnPreferredKolNames", "Preferred KOL (comma-sep)"),
      inputButton("gmgnPreferredKolMinHoldPct", "Preferred KOL min hold %"),
      inputButton("gmgnDumpKolNames", "Dump KOL (comma-sep)"),
      inputButton("gmgnDumpKolMinHoldPct", "Dump KOL min hold %"),
    ];
  } else if (page === "indicators") {
    rows = [
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("requireAllIntervals", "Require all TF")],
      [
        settingButton("TF: 5m", "cfg:set:indicatorIntervals:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:indicatorIntervals:15_MINUTE"),
        settingButton("TF: both", "cfg:set:indicatorIntervals:both"),
      ],
      [
        settingButton("Entry: ST", "cfg:set:indicatorEntryPreset:supertrend_break"),
        settingButton("Entry: RSI", "cfg:set:indicatorEntryPreset:rsi_reversal"),
        settingButton("Entry: ST/RSI", "cfg:set:indicatorEntryPreset:supertrend_or_rsi"),
      ],
      [
        settingButton("Exit: ST", "cfg:set:indicatorExitPreset:supertrend_break"),
        settingButton("Exit: RSI", "cfg:set:indicatorExitPreset:rsi_reversal"),
        settingButton("Exit: BB+RSI", "cfg:set:indicatorExitPreset:bb_plus_rsi"),
      ],
      inputButton("rsiLength", "RSI length"),
    ];
  } else {
    rows = [
      [
        settingButton("Source: Meteora", "cfg:set:screeningSource:meteora"),
        settingButton("Source: GMGN", "cfg:set:screeningSource:gmgn"),
      ],
      [toggleButton("solMode", "SOL mode"), toggleButton("lpAgentRelayEnabled", "LPAgent relay")],
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("trailingTakeProfit", "Trailing TP")],
      [
        settingButton("Risk / deploy", "cfg:page:risk"),
        settingButton("Screening", "cfg:page:screen"),
      ],
      [
        settingButton("Indicators", "cfg:page:indicators"),
        settingButton("Show config", "cfg:show"),
      ],
    ];
  }

  return { text: summary, keyboard: [...nav, ...rows, ...footer] };
}

async function showSettingsMenu({ messageId = null, page = "main" } = {}) {
  const menu = renderSettingsMenu(page);
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard);
  }
}

function normalizeMenuValue(key, raw) {
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  if (key === "gmgnPreferredKolNames" || key === "gmgnDumpKolNames") {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return parseConfigValue(raw);
}

async function applySettingsMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];
  let page = "main";

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId);
    return;
  }
  if (action === "input") {
    const inputKey = parts[2];
    const currentVal = settingValue(inputKey);
    const inputPage = ["gmgnPreferredKolNames", "gmgnPreferredKolMinHoldPct", "gmgnDumpKolNames", "gmgnDumpKolMinHoldPct"].includes(inputKey) ? "kol"
      : ["gmgnMinVolume", "gmgnMaxBundlerRate", "gmgnMinTokenAgeHours", "gmgnMaxTokenAgeHours"].includes(inputKey) ? "screen"
      : inputKey.startsWith("gmgn") && inputKey !== "gmgnRequireKol" ? "gmgn"
      : inputKey.startsWith("indicator") || inputKey === "chartIndicatorsEnabled" || inputKey === "rsiLength" || inputKey === "requireAllIntervals" ? "indicators"
      : ["minBinsBelow", "maxBinsBelow"].includes(inputKey) ? "strategy"
      : ["useDiscordSignals", "blockPvpSymbols", "managementIntervalMin", "screeningIntervalMin", "screeningSource", "gmgnRequireKol"].includes(inputKey) ? "screen"
      : "risk";
    _pendingInput = { key: inputKey, page: inputPage, menuMsgId: msg.messageId };
    await answerCallbackQuery(msg.callbackQueryId);
    await sendMessage(`Enter new value for ${inputKey} (current: ${currentVal ?? "off"}):\nSend a number, or "off" to clear.`);
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId, "Closed");
    await editMessage("Settings menu closed.", msg.messageId);
    return;
  }
  if (action === "show") {
    await answerCallbackQuery(msg.callbackQueryId);
    await editMessageWithButtons(formatConfigSnapshot(), msg.messageId, [[settingButton("Back", "cfg:page:main")]]);
    return;
  }
  if (action === "page") {
    page = parts[2] || "main";
    await answerCallbackQuery(msg.callbackQueryId);
    await showSettingsMenu({ messageId: msg.messageId, page });
    return;
  }

  const key = parts[2];
  let value;
  if (action === "toggle") {
    value = !Boolean(settingValue(key));
  } else if (action === "step") {
    const current = Number(settingValue(key));
    const delta = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) {
      await answerCallbackQuery(msg.callbackQueryId, "Invalid setting");
      return;
    }
    value = Number((current + delta).toFixed(4));
    if (key === "maxPositions") value = Math.max(1, Math.round(value));
    if (key === "rsiLength") value = Math.max(2, Math.round(value));
    if (key === "repeatDeployCooldownTriggerCount") value = Math.max(1, Math.round(value));
    if (key === "repeatDeployCooldownHours") value = Math.max(0, Math.round(value));
    if (key === "repeatDeployCooldownMinFeeEarnedPct") value = Math.max(0, value);
    if (["deployAmountSol", "gasReserve", "maxDeployAmount"].includes(key)) value = Math.max(0, value);
  } else if (action === "set") {
    value = normalizeMenuValue(key, parts.slice(3).join(":"));
  } else {
    await answerCallbackQuery(msg.callbackQueryId, "Unknown action");
    return;
  }

  const result = await executeTool("update_config", {
    changes: { [key]: value },
    reason: "Telegram settings menu",
  });
  if (!result?.success) {
    await answerCallbackQuery(msg.callbackQueryId, "Config update failed");
    return;
  }
  page = ["gmgnPreferredKolNames", "gmgnPreferredKolMinHoldPct", "gmgnDumpKolNames", "gmgnDumpKolMinHoldPct"].includes(key) ? "kol"
    : ["gmgnMinVolume", "gmgnMaxBundlerRate", "gmgnMinTokenAgeHours", "gmgnMaxTokenAgeHours"].includes(key) ? "screen"
    : key.startsWith("gmgn") && key !== "gmgnRequireKol"
      ? "gmgn"
      : key.startsWith("indicator") || key === "chartIndicatorsEnabled" || key === "rsiLength" || key === "requireAllIntervals"
        ? "indicators"
        : ["minBinsBelow", "maxBinsBelow"].includes(key)
          ? "strategy"
          : ["useDiscordSignals", "blockPvpSymbols", "managementIntervalMin", "screeningIntervalMin", "screeningSource", "gmgnRequireKol"].includes(key)
            ? "screen"
            : "risk";
  await answerCallbackQuery(msg.callbackQueryId, `Updated ${key}`);
  await showSettingsMenu({ messageId: msg.messageId, page });
}

function formatHelpText() {
  return [
    "Telegram commands",
    "",
    "/help — show commands",
    "/status — wallet + positions snapshot",
    "/wallet — wallet, deploy amount, HiveMind status",
    "/positions — list open positions",
    "/pool <n> — detailed info for one open position",
    "/close <n> — close one position by index",
    "/closeall — close all open positions",
    "/swapall — swap all non-SOL tokens in wallet back to SOL",
    "/set <n> <note> — set note/instruction on position",
    "/config — show important runtime config",
    "/settings — button menu for common config",
    "/setcfg <key> <value> — update persisted config",
    "/screen — refresh deterministic candidate list",
    "/candidates — show latest cached candidates",
    "/deploy <n> — deploy candidate by cached index",
    "/learn — study top LPers and save lessons",
    "/learn <pool> — study top LPers for a specific pool address",
    "/thresholds — show current screening thresholds + performance",
    "/evolve — evolve screening thresholds from closed position data",
    "/briefing — morning briefing",
    "/hive — HiveMind sync status",
    "/hive pull — manual HiveMind pull now",
    "/pause — stop cron cycles",
    "/resume — start cron cycles again",
    "/logs [n] — tail last n stdout log lines (default 50)",
    "/errors [n] — tail last n error log lines (default 30)",
    "/restart — restart the meridian PM2 process",
    "/run <command> — run a shell command (requires confirmation)",
    "/stop — shut down agent",
  ].join("\n");
}

async function runDeterministicScreen(limit = 5) {
  const top = await getTopCandidates({ limit });
  const candidates = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(candidates);
  if (candidates.length > 0) {
    const lines = candidates.map((pool, i) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      const source = pool.gmgn ? ` | GMGN smart ${pool.gmgn_smart_wallets ?? "?"}, KOL ${pool.gmgn_kol_wallets ?? "?"}, total fee ${pool.gmgn_total_fee_sol ?? "?"} SOL` : ` | organic ${pool.organic_score ?? "?"}`;
      return `${i + 1}. ${pool.name} | ${pool.pool}\n   fee/aTVL ${feeTvl}% | vol $${vol}${source}`;
    });
    return `Top candidates (${candidates.length})\n\n${lines.join("\n")}`;
  }
  const examples = (top?.filtered_examples || []).slice(0, 3)
    .map((entry) => `- ${entry.name}: ${entry.reason}`)
    .join("\n");
  return examples
    ? `No candidates available.\nFiltered examples:\n${examples}`
    : "No candidates available right now.";
}

async function deployLatestCandidate(index) {
  const candidate = _latestCandidates[index];
  if (!candidate) {
    throw new Error("Invalid candidate index. Run /screen first.");
  }
  const deployAmount = computeDeployAmount((await getWalletBalances()).sol);
  const binsBelow = computeBinsBelow(candidate.volatility);
  const result = await executeTool("deploy_position", {
    pool_address: candidate.pool,
    amount_y: deployAmount,
    strategy: config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    pool_name: candidate.name,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
    initial_value_usd: candidate.active_tvl ?? candidate.tvl ?? null,
  });
  if (result?.success === false || result?.error) {
    throw new Error(result.error || "Deploy failed");
  }
  return { result, candidate, deployAmount, binsBelow };
}

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

async function telegramHandler(msg) {
  const text = msg?.text?.trim();
  if (!text) return;

  if (_pendingInput && !msg.isCallback && !text.startsWith("/")) {
    const { key, page, menuMsgId } = _pendingInput;
    _pendingInput = null;
    let value;
    if (text.toLowerCase() === "off" || text.toLowerCase() === "null") {
      value = null;
    } else {
      value = Number(text);
      if (!Number.isFinite(value)) {
        await sendMessage(`Invalid value "${text}" — must be a number or "off".`);
        return;
      }
    }
    const result = await executeTool("update_config", { changes: { [key]: value }, reason: "Telegram input field" });
    if (!result?.success) {
      await sendMessage(`Failed to update ${key}.`);
      return;
    }
    await showSettingsMenu({ messageId: menuMsgId, page });
    return;
  }
  if (msg?.isCallback && text.startsWith("cfg:")) {
    try {
      await applySettingsMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }
  if (text === "/settings" || text === "/menu" || text === "/configmenu") {
    await showSettingsMenu().catch((e) => sendMessage(`Settings error: ${e.message}`).catch(() => {}));
    return;
  }

  // Read-only commands — bypass busy gate so they always respond instantly
  if (text === "/help") {
    await sendMessage(formatHelpText()).catch(() => {});
    return;
  }
  if (text === "/wallet" || text === "/status") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const suffix = text === "/status" && positions.total_positions
        ? `\n\nUse /positions for the numbered list.`
        : "";
      await sendMessage(`${formatWalletStatus(wallet, positions)}${suffix}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }
  if (text === "/config") {
    await sendMessage(formatConfigSnapshot()).catch(() => {});
    return;
  }
  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendMessage("No open positions."); return; }
      const cur = config.management.solMode ? "◎" : "$";
      const lines = positions.map((p, i) => {
        const pnl = p.pnl_usd >= 0 ? `+${cur}${p.pnl_usd}` : `-${cur}${Math.abs(p.pnl_usd)}`;
        const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
        const oor = !p.in_range ? " ⚠️OOR" : "";
        const strat = p.strategy ? ` [${p.strategy}]` : "";
        return `${i + 1}. ${p.pair}${strat} | ${cur}${p.total_value_usd} | PnL: ${pnl} | fees: ${cur}${p.unclaimed_fees_usd} | ${age}${oor}`;
      });
      await sendMessage(`📊 Open Positions (${total_positions}):\n\n${lines.join("\n")}\n\n/close <n> to close | /set <n> <note> to set instruction`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }
  if (text === "/thresholds") {
    try {
      const s = config.screening;
      const perf = getPerformanceSummary();
      const lines = [
        "📊 Current screening thresholds:",
        `  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`,
        `  minOrganic:           ${s.minOrganic}`,
        `  minVolatility:        ${s.minVolatility}`,
        `  maxVolatility:        ${s.maxVolatility ?? "off"}`,
        `  minHolders:           ${s.minHolders}`,
        `  minTvl:               ${s.minTvl}`,
        `  maxTvl:               ${s.maxTvl}`,
        `  minVolume:            ${s.minVolume}`,
        `  minTokenFeesSol:      ${s.minTokenFeesSol}`,
        `  maxBundlePct:         ${s.maxBundlePct}`,
        `  maxBotHoldersPct:     ${s.maxBotHoldersPct}`,
        `  maxTop10Pct:          ${s.maxTop10Pct}`,
        `  timeframe:            ${s.timeframe}`,
        perf
          ? `\n📈 Based on ${perf.total_positions_closed} closed positions\n  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`
          : "\nNo closed positions yet — thresholds are preset defaults.",
      ];
      await sendMessage(lines.join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (_managementBusy || _screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
    } else {
      sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx = parseInt(poolMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage([
        `${idx + 1}. ${pos.pair}`,
        `Pool: ${pos.pool}`,
        `Position: ${pos.position}`,
        `Range: ${pos.lower_bin} → ${pos.upper_bin} | active ${pos.active_bin}`,
        `PnL: ${pos.pnl_pct ?? "?"}% | fees: ${config.management.solMode ? "◎" : "$"}${pos.unclaimed_fees_usd ?? "?"}`,
        `Value: ${config.management.solMode ? "◎" : "$"}${pos.total_value_usd ?? "?"}`,
        `Age: ${pos.age_minutes ?? "?"}m | ${pos.in_range ? "IN RANGE" : `OOR ${pos.minutes_out_of_range ?? 0}m`}`,
        pos.instruction ? `Note: ${pos.instruction}` : null,
      ].filter(Boolean).join("\n"));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    busy = true;
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const posResult = await getMyPositions({ force: true });
      const positions = posResult?.positions || [];
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair}...`);
      const result = await closePosition({ position_address: pos.position });
      if (result.success) {
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const claimNote = result.claim_txs?.length ? `\nClaim txs: ${result.claim_txs.join(", ")}` : "";
        await sendMessage(`✅ Closed ${pos.pair}\nPnL: ${config.management.solMode ? "◎" : "$"}${result.pnl_usd ?? "?"} | close txs: ${closeTxs?.join(", ") || "n/a"}${claimNote}`);
        if (result.base_mint) {
          const swap = await swapMintToSol(result.base_mint).catch(() => null);
          if (swap) await sendMessage(`🔄 ${swap.success ? `✅ ${swap.symbol} → ${swap.sol ? swap.sol.toFixed(4) + " SOL" : "SOL"}` : `❌ ${swap.symbol}: ${swap.error}`}`).catch(() => {});
        }
      } else {
        await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    finally { busy = false; drainTelegramQueue().catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    busy = true;
    try {
      const posResult = await getMyPositions({ force: true });
      const positions = posResult?.positions || [];
      if (!positions.length) { await sendMessage("No open positions."); return; }
      await sendMessage(`Closing ${positions.length} position(s)...`);
      const results = [];
      const baseMints = [];
      for (const pos of positions) {
        try {
          const result = await closePosition({ position_address: pos.position });
          results.push(`${pos.pair}: ${result.success ? "closed" : `failed (${result.error || "unknown"})`}`);
          if (result.success) {
            if (result.base_mint) baseMints.push({ mint: result.base_mint, pair: pos.pair });
            setManualCloseCooldown(pos.pool, result.base_mint || null, 2);
          }
        } catch (error) {
          results.push(`${pos.pair}: failed (${error.message})`);
        }
      }
      await sendMessage(`Close-all finished.\n\n${results.join("\n")}`).catch(() => {});
      const swapLines = [];
      for (const { mint } of baseMints) {
        const swap = await swapMintToSol(mint).catch(() => null);
        if (swap) swapLines.push(swap.success ? `✅ ${swap.symbol} → ${swap.sol ? swap.sol.toFixed(4) + " SOL" : "SOL"}` : `❌ ${swap.symbol}: ${swap.error}`);
      }
      if (swapLines.length) await sendMessage(`🔄 Auto-swapped:\n${swapLines.join("\n")}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    } finally { busy = false; drainTelegramQueue().catch(() => {}); }
    return;
  }

  if (text === "/swapall") {
    try {
      await sendMessage("Scanning wallet for tokens to swap...");
      const swaps = await swapAllTokensToSol();
      if (!swaps.length) { await sendMessage("No tokens found to swap (all dust or already SOL)."); return; }
      await sendMessage(`Swap-all done:\n\n${swaps.map(s => s.success ? `✅ ${s.symbol} → ${s.sol ? s.sol.toFixed(4) + " SOL" : "SOL"}` : `❌ ${s.symbol}: ${s.error}`).join("\n")}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const posResult = await getMyPositions({ force: true });
      const positions = posResult?.positions || [];
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const setCfgMatch = text.match(/^\/setcfg\s+([A-Za-z0-9_]+)\s+(.+)$/i);
  if (setCfgMatch) {
    try {
      const key = setCfgMatch[1];
      const value = parseConfigValue(setCfgMatch[2]);
      const result = await executeTool("update_config", {
        changes: { [key]: value },
        reason: "Telegram slash command /setcfg",
      });
      if (!result?.success) {
        await sendMessage(`Config update failed.\nUnknown: ${(result?.unknown || []).join(", ") || "none"}`).catch(() => {});
        return;
      }
      await sendMessage(`✅ Updated ${key} = ${JSON.stringify(value)}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/screen") {
    try {
      await sendMessage(await runDeterministicScreen(5)).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/evolve") {
    busy = true;
    try {
      const perf = getPerformanceSummary();
      if (!perf || perf.total_positions_closed < 5) {
        const needed = 5 - (perf?.total_positions_closed || 0);
        await sendMessage(`Need at least 5 closed positions to evolve. ${needed} more needed.`).catch(() => {});
        return;
      }
      await sendMessage("⚙️ Evolving thresholds and signal weights from performance data...").catch(() => {});
      const fs = await import("fs");
      const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
      const lines = [];

      const result = evolveThresholds(lessonsData.performance, config);
      if (result && Object.keys(result.changes).length > 0) {
        reloadScreeningThresholds();
        lines.push("✅ Thresholds evolved:");
        for (const [key] of Object.entries(result.changes)) {
          lines.push(`  ${key}: ${result.rationale[key]}`);
        }
      } else {
        lines.push("Thresholds: no changes needed.");
      }

      const wResult = recalculateWeights(lessonsData.performance, config);
      if (wResult.changes.length > 0) {
        lines.push("\n📊 Signal weights updated:");
        for (const c of wResult.changes) {
          lines.push(`  ${c.signal}: ${c.from.toFixed(3)} → ${c.to.toFixed(3)} (${c.action}, lift=${c.lift})`);
        }
      } else {
        lines.push("Signal weights: no changes needed.");
      }

      lines.push("\nSaved to disk. Applied immediately.");
      await sendMessage(lines.join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    } finally {
      busy = false;
      drainTelegramQueue().catch(() => {});
    }
    return;
  }

  const learnMatch = text.match(/^\/learn(?:\s+(\S+))?$/i);
  if (learnMatch) {
    const poolArg = learnMatch[1] || null;
    busy = true;
    try {
      let poolsToStudy = [];
      if (poolArg) {
        poolsToStudy = [{ pool: poolArg, name: poolArg }];
      } else {
        await sendMessage("🔍 Fetching top pool candidates to study...").catch(() => {});
        const { candidates } = await getTopCandidates({ limit: 10 });
        if (!candidates.length) {
          await sendMessage("No eligible pools found to study right now.").catch(() => {});
          return;
        }
        poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
      }
      await sendMessage(`📚 Studying top LPers across ${poolsToStudy.length} pool(s):\n${poolsToStudy.map(p => `  • ${p.name || p.pool}`).join("\n")}\n\nThis takes a minute...`).catch(() => {});
      const poolList = poolsToStudy.map((p, i) => `${i + 1}. ${p.name} (${p.pool})`).join("\n");
      const { content: reply } = await agentLoop(
        `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:\n\n${poolList}\n\nFor each pool, call study_top_lpers then move to the next. After studying all pools:\n1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).\n2. Note pool-specific patterns where behaviour differs significantly.\n3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.\n4. Summarize what you learned.\n\nFocus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
        config.llm.maxSteps,
        [],
        "GENERAL"
      );
      await sendMessage(stripThink(reply)).catch(() => {});

      // After learning, auto-evolve thresholds and weights if we have enough data
      const perf = getPerformanceSummary();
      if (perf && perf.total_positions_closed >= 5) {
        try {
          const fs = await import("fs");
          const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
          const evolveResult = evolveThresholds(lessonsData.performance, config);
          const wResult = recalculateWeights(lessonsData.performance, config);
          const evolveChanged = evolveResult && Object.keys(evolveResult.changes).length > 0;
          const weightsChanged = wResult.changes.length > 0;
          if (evolveChanged) reloadScreeningThresholds();
          if (evolveChanged || weightsChanged) {
            const lines = ["⚙️ Auto-evolved from study:"];
            if (evolveChanged) {
              for (const [key] of Object.entries(evolveResult.changes)) {
                lines.push(`  threshold ${key}: ${evolveResult.rationale[key]}`);
              }
            }
            if (weightsChanged) {
              for (const c of wResult.changes) {
                lines.push(`  weight ${c.signal}: ${c.from.toFixed(3)} → ${c.to.toFixed(3)} (${c.action})`);
              }
            }
            await sendMessage(lines.join("\n")).catch(() => {});
          }
        } catch (e) {
          log("evolve_warn", `Post-learn evolve failed: ${e.message}`);
        }
      }
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    } finally {
      busy = false;
      drainTelegramQueue().catch(() => {});
    }
    return;
  }

  if (text === "/candidates") {
    await sendMessage(describeLatestCandidates(5)).catch(() => {});
    return;
  }

  const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx = parseInt(deployMatch[1]) - 1;
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
      const coverage = result.range_coverage
        ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `Strategy: ${config.strategy.strategy} | binsBelow: ${binsBelow}`;
      await sendMessage([
        `✅ Deployed ${candidate.name}`,
        `Pool: ${candidate.pool}`,
        `Amount: ${deployAmount} SOL`,
        coverage,
        `Position: ${result.position || "n/a"}`,
        result.txs?.length ? `Tx: ${result.txs[0]}` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/pause") {
    stopCronJobs();
    cronStarted = false;
    await sendMessage("⏸ Paused autonomous cycles. Telegram control still works. Use /resume to start again.").catch(() => {});
    return;
  }

  if (text === "/resume") {
    if (!cronStarted) {
      cronStarted = true;
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      await sendMessage("▶️ Autonomous cycles resumed.").catch(() => {});
    } else {
      await sendMessage("Autonomous cycles are already running.").catch(() => {});
    }
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      const enabled = isHiveMindEnabled();
      const agentId = ensureAgentId();
      if (!enabled) {
        await sendMessage(`HiveMind: disabled\nAgent ID: ${agentId}\nSet hiveMindApiKey to connect.`).catch(() => {});
        return;
      }
      const isManualPull = text === "/hive pull";
      const pullMode = getHiveMindPullMode();
      const [registerResult, lessons, presets] = await Promise.all([
        registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
        (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
        (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
      ]);
      await sendMessage([
        "HiveMind: enabled",
        `Agent ID: ${agentId}`,
        `URL: ${config.hiveMind.url}`,
        `Pull mode: ${pullMode}`,
        `Register: ${registerResult ? "ok" : "warn"}`,
        `Shared lessons: ${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}`,
        `Presets: ${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}`,
        isManualPull ? "Manual pull: completed" : null,
      ].join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`HiveMind error: ${e.message}`).catch(() => {});
    }
    return;
  }

  // ─── /logs [n] — tail PM2 stdout log ─────────────────────────────────────
  const logsMatch = text.match(/^\/logs(?:\s+(\d+))?$/i);
  if (logsMatch) {
    try {
      const n = Math.min(parseInt(logsMatch[1] || "50", 10), 200);
      const out = execSync(`tail -n ${n} ~/.pm2/logs/meridian-out.log 2>/dev/null || echo "(log file not found)"`, { encoding: "utf8" });
      const trimmed = out.slice(-3800); // Telegram limit safe
      await sendMessage(`📋 Last ${n} log lines:\n\n${trimmed || "(empty)"}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error reading logs: ${e.message}`).catch(() => {});
    }
    return;
  }

  // ─── /errors [n] — tail PM2 stderr log ───────────────────────────────────
  const errorsMatch = text.match(/^\/errors(?:\s+(\d+))?$/i);
  if (errorsMatch) {
    try {
      const n = Math.min(parseInt(errorsMatch[1] || "30", 10), 200);
      const out = execSync(`tail -n ${n} ~/.pm2/logs/meridian-error.log 2>/dev/null || echo "(error log not found)"`, { encoding: "utf8" });
      const trimmed = out.slice(-3800);
      await sendMessage(`⚠️ Last ${n} error lines:\n\n${trimmed || "(empty)"}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error reading error log: ${e.message}`).catch(() => {});
    }
    return;
  }

  // ─── /restart — restart PM2 meridian process ─────────────────────────────
  if (text === "/restart") {
    _pendingShellCmd = "__restart__";
    await sendMessage("⚠️ Restart meridian PM2 process?\n\nReply yes to confirm or no to cancel.").catch(() => {});
    return;
  }

  if (text === "/stop") {
    _pendingShellCmd = "__stop__";
    await sendMessage("⚠️ Graceful shutdown — this will stop the agent. PM2 will restart it unless you run `pm2 stop meridian`.\n\nReply yes to confirm or no to cancel.").catch(() => {});
    return;
  }

  // ─── /run <command> — execute arbitrary shell command ────────────────────
  const runMatch = text.match(/^\/run\s+(.+)$/i);
  if (runMatch) {
    const cmd = runMatch[1].trim();
    const BLOCKED_RUN_PATTERNS = [
      /\brm\s+-[^\s]*r/i,           // rm -rf, rm -r
      /\bdd\s+if=/i,                 // dd if=... (disk overwrite)
      /\bmkfs\b/i,                   // format filesystem
      />\s*\/dev\//i,                // redirect to device
      /\bshred\b/i,                  // shred files
      /:\(\)\s*\{.*:\|:.*\}/,        // fork bomb pattern
      /\bchmod\s+-[^\s]*R.*\//i,     // recursive chmod on /
      /\bcurl\b.*\|\s*(ba)?sh/i,     // curl|bash download-and-exec
      /\bwget\b.*\|\s*(ba)?sh/i,     // wget|bash
    ];
    const blocked = BLOCKED_RUN_PATTERNS.find(p => p.test(cmd));
    if (blocked) {
      await sendMessage(`❌ Command blocked — matches a destructive pattern. Use /restart for restarts or run the command directly on the server.`).catch(() => {});
      return;
    }
    _pendingShellCmd = cmd;
    await sendMessage(`⚠️ Run shell command:\n\`${cmd}\`\n\nReply yes to confirm or no to cancel.`).catch(() => {});
    return;
  }

  // ─── Shell command confirmation ───────────────────────────────────────────
  if (_pendingShellCmd) {
    const trimmed = text.trim();
    const isConfirm = /^(yes|y|confirm|proceed|go|do it|execute|sure|yep|yeah|ok)$/i.test(trimmed);
    const isCancel = /^(no|n|cancel|stop|abort|nope|nah)$/i.test(trimmed);
    if (isConfirm || isCancel) {
      const cmd = _pendingShellCmd;
      _pendingShellCmd = null;
      if (isCancel) {
        await sendMessage("Cancelled.").catch(() => {});
        return;
      }
      try {
        if (cmd === "__restart__") {
          // Let PM2 auto-restart naturally — preserves env vars loaded by envcrypt.js
          await sendMessage("🔄 Restarting...").catch(() => {});
          setTimeout(() => process.exit(0), 800);
          return;
        }
        if (cmd === "__stop__") {
          await sendMessage("🛑 Shutting down...").catch(() => {});
          await shutdown("telegram /stop");
          return;
        }
        await sendMessage(`Running: \`${cmd}\`...`).catch(() => {});
        const out = execSync(cmd, { encoding: "utf8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
        const result = (out || "(no output)").slice(-3800);
        await sendMessage(`✅ Done:\n\n${result}`).catch(() => {});
      } catch (e) {
        const errOut = (e.stdout || e.stderr || e.message || "unknown error").slice(0, 1000);
        await sendMessage(`❌ Command failed:\n${errOut}`).catch(() => {});
      }
      return;
    }
    _pendingShellCmd = null; // non-yes/no clears it
  }

  // Confirmation reply — user responding to an AI-proposed action
  if (_pendingConfirmation) {
    const trimmed = text.trim();
    const isConfirm = /^(yes|y|confirm|proceed|go|do it|execute|sure|yep|yeah|ok)$/i.test(trimmed);
    const isCancel = /^(no|n|cancel|stop|abort|nope|nah)$/i.test(trimmed);
    if (isConfirm || isCancel) {
      if (isCancel) {
        _pendingConfirmation = null;
        await sendMessage("Cancelled.").catch(() => {});
        return;
      }
      const { toolName, toolArgs } = _pendingConfirmation;
      _pendingConfirmation = null;
      busy = true;
      try {
        await sendMessage(`Executing ${toolName.replace(/_/g, " ")}...`).catch(() => {});
        const result = await executeTool(toolName, toolArgs);
        if (result?.error) {
          await sendMessage(`❌ ${result.error}`).catch(() => {});
        } else if (result?.success === false) {
          await sendMessage(`❌ ${result.reason || "failed"}`).catch(() => {});
        } else {
          const summary = result?.position
            ? `Position: ${String(result.position).slice(0, 12)}...`
            : result?.tx ? `Tx: ${String(result.tx).slice(0, 16)}...`
            : "Done";
          await sendMessage(`✅ ${summary}`).catch(() => {});
        }
      } catch (e) {
        await sendMessage(`❌ Error: ${e.message}`).catch(() => {});
      } finally {
        busy = false;
        drainTelegramQueue().catch(() => {});
      }
      return;
    }
    // Not a yes/no — treat as a new message and clear pending
    _pendingConfirmation = null;
  }

  busy = true;
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent = /\bclose (my |the |all |position|positions)\b|\bclose all\b|\bsell (all|everything|my tokens)\b|\bexit (my |the |all |position|positions)\b|\bwithdraw (my |all |liquidity)\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen (a )?position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const isConfigChange = /\b(set|change|update|increase|decrease|lower|raise)\s+(stop.?loss|take.?profit|sl|tp|max\s*pos|deploy\s*amount|position\s*size|min\s*(tvl|mcap|vol)|max\s*(tvl|mcap|pos)|threshold|config|setting|interval)\b/i.test(text);
    const isSwapRequest = /\bswap\b.{1,30}\bto\b|\bconvert\b.{1,20}\bto\b/i.test(text);
    const isActionRequest = hasCloseIntent || isDeployRequest || isConfigChange || isSwapRequest;

    // Route to Claude for general chat when ANTHROPIC_API_KEY is available
    if (!isActionRequest && process.env.ANTHROPIC_API_KEY) {
      liveMessage = await createLiveMessage("🤖 Claude", `Thinking...`);
      const reply = await claudeChat(text, sessionHistory);
      appendHistory(text, reply);
      if (liveMessage) await liveMessage.finalize(reply);
      else await sendMessage(reply);
    } else {
      // Action requests (deploy/close) and fallback go through agentLoop with tool use
      const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
      const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
      liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
      const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
        interactive: true,
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
        onBeforeWrite: async (toolName, toolArgs) => { _pendingConfirmation = { toolName, toolArgs }; },
      });
      appendHistory(text, content);
      if (liveMessage) await liveMessage.finalize(stripThink(content));
      else await sendMessage(stripThink(content));
    }
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    setLatestCandidates(candidates);

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    const latest = getLatestCandidatesMeta().candidates;
    if (!isNaN(pick) && pick >= 1 && pick <= latest.length) {
      await runBusy(async () => {
        const pool = latest[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${DEPLOY} SOL. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        setLatestCandidates(candidates);
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBundlePct:         ${s.maxBundlePct}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);

        // Auto-evolve after learning
        const perf = getPerformanceSummary();
        if (perf && perf.total_positions_closed >= 5) {
          const fs = await import("fs");
          const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
          const evolveResult = evolveThresholds(lessonsData.performance, config);
          const wResult = recalculateWeights(lessonsData.performance, config);
          if (evolveResult && Object.keys(evolveResult.changes).length > 0) {
            reloadScreeningThresholds();
            console.log("Thresholds evolved:");
            for (const [key] of Object.entries(evolveResult.changes)) {
              console.log(`  ${key}: ${evolveResult.rationale[key]}`);
            }
          }
          if (wResult.changes.length > 0) {
            console.log("Signal weights updated:");
            for (const c of wResult.changes) {
              console.log(`  ${c.signal}: ${c.from.toFixed(3)} → ${c.to.toFixed(3)} (${c.action})`);
            }
          }
          if ((evolveResult && Object.keys(evolveResult.changes).length > 0) || wResult.changes.length > 0) {
            console.log("Saved to disk.\n");
          }
        }
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));

        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nThresholds: no changes needed.");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
        }

        const wResult = recalculateWeights(lessonsData.performance, config);
        if (wResult.changes.length === 0) {
          console.log("Signal weights: no changes needed.");
        } else {
          console.log("\nSignal weights updated:");
          for (const c of wResult.changes) {
            console.log(`  ${c.signal}: ${c.from.toFixed(3)} → ${c.to.toFixed(3)} (${c.action}, lift=${c.lift})`);
          }
        }
        console.log("\nSaved to disk. Applied immediately.\n");
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  (async () => {
    try {
      const startupStep3 = process.env.DRY_RUN === "true"
        ? `3. Ignore wallet SOL threshold in dry run: get_top_candidates then simulate deploy ${DEPLOY} SOL.`
        : `3. If SOL >= ${config.management.minSolToOpen}: get_top_candidates then deploy ${DEPLOY} SOL.`;
      await agentLoop(`
STARTUP CHECK
1. get_wallet_balance. 2. get_my_positions. ${startupStep3} 4. Report.
      `, config.llm.maxSteps, [], "SCREENER");
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
