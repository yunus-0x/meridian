import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId   = process.env.TELEGRAM_CHAT_ID || null;
let _offset  = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch { /**/ }
}

loadChatId();

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  if (incomingChatId !== chatId) return false;

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.");
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }

  return true;
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

async function postTelegram(method, body) {
  if (!TOKEN || !chatId) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

async function postTelegramRaw(method, body) {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

export async function sendMessage(text) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendMessageWithButtons(text, inlineKeyboard) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
}

export async function editMessage(text, messageId) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
  });
}

export async function editMessageWithButtons(text, messageId, inlineKeyboard) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

export function hasActiveLiveMessage() {
  return _liveMessageDepth > 0;
}

function createTypingIndicator() {
  if (!TOKEN || !chatId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name) {
  const labels = {
    get_token_info: "get token info",
    get_token_narrative: "get token narrative",
    get_token_holders: "get token holders",
    get_top_candidates: "get top candidates",
    get_pool_detail: "get pool detail",
    get_active_bin: "get active bin",
    deploy_position: "deploy position",
    close_position: "close position",
    claim_fees: "claim fees",
    swap_token: "swap token",
    update_config: "update config",
    get_my_positions: "get positions",
    get_wallet_balance: "get wallet balance",
    check_smart_wallets_on_pool: "check smart wallets",
    study_top_lpers: "study top LPers",
    get_top_lpers: "get top LPers",
    search_pools: "search pools",
    discover_pools: "discover pools",
  };
  return labels[name] || name.replace(/_/g, " ");
}

function cleanError(msg) {
  if (!msg) return "failed";
  // Extract the human-readable cause from Solana program logs if present
  const logCause = msg.match(/"Program log: Error: ([^"]+)"/);
  if (logCause) return `simulation failed: ${logCause[1]}`;
  // Strip the raw Logs: [...] array and trailing SDK hint
  const stripped = msg.replace(/\s*Logs:\s*\[[\s\S]*?\]\.?\s*(Catch[\s\S]*)?$/, "").trim();
  return stripped.length > 100 ? stripped.slice(0, 97) + "..." : stripped;
}

function summarizeToolResult(name, result) {
  if (!result) return "";
  if (result.error) return cleanError(result.error);
  if (result.reason && result.blocked) return result.reason;
  switch (name) {
    case "deploy_position":
      return result.position ? `position ${String(result.position).slice(0, 8)}...` : "submitted";
    case "close_position":
      return result.success ? "closed" : (result.reason || "failed");
    case "claim_fees":
      return result.claimed_amount != null ? `claimed ${result.claimed_amount}` : "done";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} candidates`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} positions`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LPers`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

export async function createLiveMessage(title, intro = "Starting...") {
  if (!TOKEN || !chatId) return null;
  const typing = createTypingIndicator();

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function render() {
    const sections = [state.title];
    if (state.intro) sections.push(state.intro);
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    return sections.join("\n\n").slice(0, 4096);
  }

  async function flushNow() {
    state.flushTimer = null;
    state.flushRequested = false;
    const text = render();
    if (!state.messageId) {
      const sent = await sendMessage(text);
      state.messageId = sent?.result?.message_id ?? null;
      return;
    }
    await editMessage(text, state.messageId);
  }

  function scheduleFlush(delay = 300) {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => null);
    }, delay);
  }

  async function upsertToolLine(name, icon, suffix = "") {
    const label = toolLabel(name);
    const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name) {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name, result, success) {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const callback = update.callback_query;
        if (callback?.data && callback?.message) {
          const callbackMsg = {
            chat: callback.message.chat,
            from: callback.from,
            text: callback.data,
          };
          if (!isAuthorizedIncomingMessage(callbackMsg)) continue;
          await onMessage({
            ...callbackMsg,
            isCallback: true,
            callbackQueryId: callback.id,
            callbackData: callback.data,
            messageId: callback.message.message_id,
          });
          continue;
        }
        const msg = update.message;
        if (!msg?.text) continue;
        if (!isAuthorizedIncomingMessage(msg)) continue;
        await onMessage(msg);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

export async function startPolling(onMessage) {
  if (!TOKEN) return;
  // Drain any queued updates accumulated during downtime so they don't replay
  try {
    const res = await fetch(`${BASE}/getUpdates?offset=-1&timeout=0`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      const updates = data.result || [];
      if (updates.length > 0) {
        _offset = updates[updates.length - 1].update_id + 1;
        log("telegram", `Drained ${updates.length} queued update(s) on startup (offset → ${_offset})`);
      }
    }
  } catch { /* non-fatal — proceed with offset 0 */ }
  _polling = true;
  poll(onMessage); // fire-and-forget
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy({ pair, poolAddress, amountSol, strategy, binsBelow, binsAbove, position, tx, priceRange, rangeCoverage, binStep, baseFee, activeBin, feeTvlRatio, organicScore, volatility, tvl, entryReason }) {
  const lines = [];
  lines.push(`🚀 <b>DEPLOYED — ${esc(pair)}</b>`);
  if (poolAddress) lines.push(`Pool: <code>${esc(poolAddress)}</code>`);
  lines.push("");

  // Position details
  const stratLine = [
    amountSol ? `◎ ${amountSol} SOL` : null,
    strategy || null,
    binsBelow != null && binsAbove != null ? `bins ${binsBelow}↓ / ${binsAbove}↑` : null,
    activeBin != null ? `active bin ${activeBin}` : null,
  ].filter(Boolean).join(" | ");
  if (stratLine) lines.push(stratLine);

  if (priceRange?.min != null && priceRange?.max != null) {
    lines.push(`Range: $${Number(priceRange.min).toFixed(6)} → $${Number(priceRange.max).toFixed(6)}`);
  }
  if (rangeCoverage) {
    lines.push(`Coverage: ${fmtPct(rangeCoverage.downside_pct)} down | ${fmtPct(rangeCoverage.upside_pct)} up | ${fmtPct(rangeCoverage.width_pct)} total`);
  }
  if (binStep != null || baseFee != null) {
    lines.push(`Bin step: ${binStep ?? "?"} | Base fee: ${baseFee != null ? baseFee + "%" : "?"}`);
  }

  // Parse all sections from entry_reason, falling back to individual fields
  if (entryReason) {
    const sectionRegex = /^(MARKET|AUDIT|RISK|WHY THIS WON)\s*\n([\s\S]+?)(?=\n(?:MARKET|AUDIT|RISK|WHY THIS WON)\s*\n|$)/gim;
    const sections = {};
    let m;
    while ((m = sectionRegex.exec(entryReason)) !== null) {
      sections[m[1].toUpperCase()] = m[2].trim();
    }

    if (sections["MARKET"]) {
      lines.push("");
      lines.push("<b>MARKET</b>");
      lines.push(esc(sections["MARKET"]));
    }
    if (sections["AUDIT"]) {
      lines.push("");
      lines.push("<b>AUDIT</b>");
      lines.push(esc(sections["AUDIT"]));
    }
    if (sections["RISK"]) {
      lines.push("");
      lines.push("<b>RISK</b>");
      lines.push(esc(sections["RISK"]));
    }
    if (sections["WHY THIS WON"]) {
      lines.push("");
      lines.push("<b>WHY THIS WON</b>");
      lines.push(esc(sections["WHY THIS WON"]));
    }
  } else {
    // Fallback: build market section from individual fields
    const marketParts = [
      feeTvlRatio != null ? `Fee/TVL: ${feeTvlRatio}%` : null,
      tvl != null ? `TVL: $${Number(tvl).toLocaleString()}` : null,
      organicScore != null ? `Organic: ${organicScore}` : null,
      volatility != null ? `Volatility: ${volatility}` : null,
    ].filter(Boolean);
    if (marketParts.length) {
      lines.push("");
      lines.push("<b>MARKET</b>");
      lines.push(marketParts.join(" | "));
    }
  }

  lines.push("");
  if (position) lines.push(`Position: <code>${position}</code>`);
  if (tx) lines.push(`Tx: <code>${tx}</code>`);

  await sendHTML(lines.join("\n"));
}

export async function notifyClose({ pair, pnlUsd, pnlPct, reason, minutesHeld, amountSol, feeTvlRatio, organicScore, volatility, tx }) {
  const sign = (pnlUsd ?? 0) >= 0 ? "+" : "";
  const pnlIcon = (pnlUsd ?? 0) >= 0 ? "🟢" : "🔴";

  const lines = [];
  lines.push(`🔒 <b>CLOSED — ${esc(pair)}</b>`);
  if (reason) lines.push(`Reason: ${esc(reason)}`);
  lines.push("");
  lines.push(`${pnlIcon} PnL: <b>${sign}$${(pnlUsd ?? 0).toFixed(2)}</b> (${sign}${(pnlPct ?? 0).toFixed(2)}%)`);

  // Hold details
  const holdParts = [
    amountSol != null ? `◎ ${amountSol} SOL deployed` : null,
    minutesHeld != null ? `Held: ${minutesHeld >= 60 ? `${Math.floor(minutesHeld / 60)}h ${minutesHeld % 60}m` : `${minutesHeld}m`}` : null,
  ].filter(Boolean);
  if (holdParts.length) lines.push(holdParts.join(" | "));

  // Entry metrics
  const metricParts = [
    feeTvlRatio != null ? `Fee/TVL: ${feeTvlRatio}%` : null,
    organicScore != null ? `Organic: ${organicScore}` : null,
    volatility != null ? `Volatility: ${volatility}` : null,
  ].filter(Boolean);
  if (metricParts.length) {
    lines.push("");
    lines.push("<b>ENTRY METRICS</b>");
    lines.push(metricParts.join(" | "));
  }

  if (tx) { lines.push(""); lines.push(`Tx: <code>${tx}</code>`); }

  await sendHTML(lines.join("\n"));
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `🔄 <b>Swapped</b> ${esc(inputSymbol)} → ${esc(outputSymbol)}\n` +
    `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\n` +
    `Tx: <code>${esc(tx?.slice(0, 16))}...</code>`
  );
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `⚠️ <b>Out of Range</b> ${esc(pair)}\n` +
    `Been OOR for ${minutesOOR} minutes`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function esc(str) {
  if (str == null) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}
