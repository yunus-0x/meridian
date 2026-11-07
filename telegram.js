// Outbound notifications used by the standalone runtime and transaction executor.
import fs from "node:fs";
import { config } from "./config.js";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
const USER_CONFIG_PATH = repoPath("user-config.json");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const chatId = resolveChatId();

function nonEmptyChatId(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function resolveChatId() {
  const fromEnv = nonEmptyChatId(process.env.TELEGRAM_CHAT_ID);
  let fromConfig = null;
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      fromConfig = nonEmptyChatId(cfg.telegramChatId);
    }
  } catch (error) {
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${error.message}`);
  }
  // user-config wins when set; otherwise fall back to .env
  const resolved = fromConfig || fromEnv || null;
  return resolved != null ? String(resolved) : null;
}

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
      if (res.status === 401) {
        log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envrypt key)`);
      } else {
        log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      }
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

async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: String(html).slice(0, 4096), parse_mode: "HTML" });
}

// ─── Admin console transport: inline menus + authorized update polling ──────

export async function sendMenu(text, keyboard) {
  if (!TOKEN || !chatId) return null;
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    parse_mode: "HTML",
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

export async function editMenu(messageId, text, keyboard) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    parse_mode: "HTML",
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

export async function answerCallbackQuery(id, text = "") {
  if (!TOKEN || !id) return null;
  return postTelegram("answerCallbackQuery", { callback_query_id: id, ...(text ? { text: String(text).slice(0, 190) } : {}) });
}

// Register the bot's command list so Telegram clients show current commands
// instead of a stale cached set. Called on every startup by the admin console.
export async function setBotCommands(commands) {
  if (!TOKEN || !Array.isArray(commands) || !commands.length) return null;
  return postTelegram("setMyCommands", { commands });
}

/**
 * Long-poll getUpdates for the admin console. Anything queued before startup
 * is skipped. Only updates from TELEGRAM_ALLOWED_USER_IDS are forwarded;
 * with no allowlist configured, polling stays off entirely.
 * Returns a stop() function.
 */
export function startAdminPolling(onUpdate) {
  const allowed = String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (!TOKEN || !allowed.length) {
    if (TOKEN) log("telegram_warn", "Admin console disabled — set TELEGRAM_ALLOWED_USER_IDS to enable in-chat commands");
    return () => {};
  }
  let offset = null;
  let stopped = false;
  let timer = null;

  async function poll() {
    try {
      const params = new URLSearchParams({
        timeout: "25",
        allowed_updates: JSON.stringify(["message", "callback_query"]),
      });
      if (offset != null) params.set("offset", String(offset));
      const res = await fetch(`${BASE}/getUpdates?${params}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`getUpdates ${res.status}`);
      const updates = (await res.json()).result || [];
      if (offset == null) {
        // First successful poll: skip the pre-start backlog entirely.
        offset = updates.length ? updates[updates.length - 1].update_id + 1 : 0;
      } else {
        for (const u of updates) {
          offset = u.update_id + 1;
          const msg = u.message;
          const cb = u.callback_query;
          const fromId = msg?.from?.id ?? cb?.from?.id;
          if (fromId == null) continue;
          if (!allowed.includes(String(fromId))) {
            log("telegram_warn", `Ignored update from unauthorized user ${fromId}`);
            continue;
          }
          try {
            if (msg?.text) await onUpdate({ message: msg });
            else if (cb) await onUpdate({ callback: cb });
          } catch (e) {
            log("telegram_error", `admin update failed: ${e.message}`);
          }
        }
      }
    } catch { /* transient network/API errors — next tick retries */ }
    if (!stopped) timer = setTimeout(poll, 2000);
  }

  void poll();
  log("telegram", `Admin console polling active (${allowed.length} authorized user(s))`);
  return () => { stopped = true; clearTimeout(timer); };
}

export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, rangeCoverage, binStep, baseFee }) {
  const priceStr = priceRange
    ? `Price range: ${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
    : "";
  const coverageStr = rangeCoverage
    ? `Range cover: ${fmtPct(rangeCoverage.downside_pct)} downside | ${fmtPct(rangeCoverage.upside_pct)} upside | ${fmtPct(rangeCoverage.width_pct)} total\n`
    : "";
  const poolStr = (binStep || baseFee)
    ? `Bin step: ${binStep ?? "?"}  |  Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n`
    : "";
  await sendHTML(
    `✅ <b>Deployed</b> ${pair}\n` +
    `Amount: ${amountSol} SOL\n` +
    priceStr +
    coverageStr +
    poolStr +
    `Position: <code>${position?.slice(0, 8)}...</code>\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyClose({ pair, pnlUsd, pnlPct, solMode }) {
  const useSolMode = solMode != null ? Boolean(solMode) : Boolean(config.management?.solMode);
  const val = Number(pnlUsd ?? 0);
  const pct = Number(pnlPct ?? 0);
  const valSign = val >= 0 ? "+" : "-";
  const pctSign = pct >= 0 ? "+" : "";
  const pnlText = useSolMode
    ? `${valSign}◎${Math.abs(val).toFixed(4)} SOL`
    : `${valSign}$${Math.abs(val).toFixed(2)}`;
  await sendHTML(
    `🔒 <b>Closed</b> ${pair}\n` +
    `PnL: ${pnlText} (${pctSign}${pct.toFixed(2)}%)`
  );
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  await sendHTML(
    `🔄 <b>Swapped</b> ${inputSymbol} → ${outputSymbol}\n` +
    `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}
