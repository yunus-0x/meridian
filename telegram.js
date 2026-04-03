import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

let chatId   = process.env.TELEGRAM_CHAT_ID || null;
let _offset  = 0;
let _polling = false;

// ─── Rate Limiting Config ────────────────────────────────────────
// Telegram Bot API limits: ~1 msg/sec per chat, 30 msg/sec globally.
// We use conservative limits to avoid soft bans.
const MIN_SEND_INTERVAL_MS = 2000;    // 2s between messages (well under 1msg/s)
const MAX_QUEUE_SIZE       = 15;      // drop oldest if queue overflows
const MAX_MSG_PER_HOUR     = 40;      // hard cap: max messages per hour
const OOR_COOLDOWN_MS      = 15 * 60 * 1000; // 15 min cooldown per pair for OOR
const MAX_RETRIES          = 3;       // max retries on 429
const MSG_CHAR_LIMIT       = 4096;    // Telegram message char limit

// ─── Rate Tracking ───────────────────────────────────────────────
let _sendQueue    = [];
let _sending      = false;
let _lastSendTime = 0;
let _hourlyLog    = [];              // timestamps of sent messages this hour
const _oorCooldowns = new Map();     // pair -> last notified timestamp

function pruneHourlyLog() {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  _hourlyLog = _hourlyLog.filter((t) => t > oneHourAgo);
}

function canSendThisHour() {
  pruneHourlyLog();
  return _hourlyLog.length < MAX_MSG_PER_HOUR;
}

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch { /**/ }
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

// ─── Message Splitting ──────────────────────────────────────────
// Split long messages at newline boundaries to stay under 4096 chars
function splitMessage(text, limit = MSG_CHAR_LIMIT) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > limit) {
    // Find last newline before limit
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0 || splitAt < limit * 0.3) {
      // No good newline — split at space
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt <= 0) {
      // No space either — hard cut
      splitAt = limit;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);

  return chunks;
}

// ─── Queue-based Sender ─────────────────────────────────────────
function enqueue(text, parseMode, priority = false) {
  if (!TOKEN || !chatId) return;

  // Split oversized messages
  const chunks = splitMessage(String(text));

  for (const chunk of chunks) {
    if (_sendQueue.length >= MAX_QUEUE_SIZE) {
      // Drop oldest non-priority message
      const dropIdx = _sendQueue.findIndex((m) => !m.priority);
      if (dropIdx >= 0) {
        _sendQueue.splice(dropIdx, 1);
        log("telegram_warn", "Send queue full — dropped oldest message");
      } else {
        _sendQueue.shift();
        log("telegram_warn", "Send queue full (all priority) — dropped oldest");
      }
    }

    if (priority) {
      // Priority messages go to front of queue (deploy/close notifications)
      _sendQueue.unshift({ text: chunk, parseMode, priority, retries: 0 });
    } else {
      _sendQueue.push({ text: chunk, parseMode, priority, retries: 0 });
    }
  }

  drainQueue();
}

async function drainQueue() {
  if (_sending || _sendQueue.length === 0 || !TOKEN || !chatId) return;
  _sending = true;

  while (_sendQueue.length > 0) {
    // Check hourly cap
    if (!canSendThisHour()) {
      log("telegram_warn", `Hourly message cap reached (${MAX_MSG_PER_HOUR}). ${_sendQueue.length} message(s) waiting.`);
      // Wait 5 minutes then retry
      await sleep(5 * 60 * 1000);
      pruneHourlyLog();
      if (!canSendThisHour()) continue;
    }

    // Respect minimum interval between messages
    const elapsed = Date.now() - _lastSendTime;
    if (elapsed < MIN_SEND_INTERVAL_MS) {
      await sleep(MIN_SEND_INTERVAL_MS - elapsed);
    }

    const msg = _sendQueue.shift();

    try {
      const body = {
        chat_id: chatId,
        text: msg.text.slice(0, MSG_CHAR_LIMIT),
        disable_web_page_preview: true, // reduce API load
      };
      if (msg.parseMode) body.parse_mode = msg.parseMode;

      const res = await fetch(`${BASE}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      _lastSendTime = Date.now();

      if (res.status === 429) {
        // Rate limited by Telegram — respect retry_after
        const data = await res.json().catch(() => ({}));
        const retryAfter = Math.max((data.parameters?.retry_after ?? 10), 5) * 1000;
        log("telegram_warn", `429 Rate Limited — waiting ${retryAfter / 1000}s (retry ${msg.retries + 1}/${MAX_RETRIES})`);

        if (msg.retries < MAX_RETRIES) {
          msg.retries++;
          _sendQueue.unshift(msg); // put back at front
        } else {
          log("telegram_error", `Message dropped after ${MAX_RETRIES} retries: ${msg.text.slice(0, 80)}...`);
        }
        await sleep(retryAfter);
        continue;
      }

      if (res.ok) {
        _hourlyLog.push(Date.now());
      } else {
        const err = await res.text();
        log("telegram_error", `sendMessage ${res.status}: ${err.slice(0, 200)}`);

        // If chat not found or forbidden, stop trying
        if (res.status === 403 || res.status === 400) {
          log("telegram_error", "Chat unreachable — clearing queue");
          _sendQueue = [];
          break;
        }
      }
    } catch (e) {
      log("telegram_error", `sendMessage failed: ${e.message}`);
      // Network error — wait before retrying
      await sleep(3000);
    }
  }

  _sending = false;
}

// ─── Public Send API ────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

/**
 * Send a plain text message (queued, rate-limited).
 * @param {string} text
 * @param {Object} [opts]
 * @param {boolean} [opts.priority=false] - Priority messages skip to front of queue
 */
export async function sendMessage(text, { priority = false } = {}) {
  enqueue(text, null, priority);
}

/**
 * Send an HTML-formatted message (queued, rate-limited).
 * @param {string} html
 * @param {Object} [opts]
 * @param {boolean} [opts.priority=false]
 */
export async function sendHTML(html, { priority = false } = {}) {
  enqueue(html, "HTML", priority);
}

// ─── Long Polling ────────────────────────────────────────────────
async function poll(onMessage) {
  let backoff = 5000; // start with 5s backoff on errors

  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(40_000) } // 40s > 30s poll timeout
      );

      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const retryAfter = Math.max((data.parameters?.retry_after ?? 10), 5) * 1000;
        log("telegram_warn", `Polling 429 — waiting ${retryAfter / 1000}s`);
        await sleep(retryAfter);
        continue;
      }

      if (!res.ok) {
        log("telegram_error", `Polling error ${res.status}`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000); // exponential backoff, max 60s
        continue;
      }

      // Reset backoff on success
      backoff = 5000;

      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const incomingChatId = String(msg.chat.id);

        // Auto-register first sender as the owner
        if (!chatId) {
          chatId = incomingChatId;
          saveChatId(chatId);
          log("telegram", `Registered chat ID: ${chatId}`);
          await sendMessage("Connected! I'm your LP agent. Ask me anything or use commands like /status.");
        }

        // Only accept messages from the registered chat
        if (incomingChatId !== chatId) continue;

        await onMessage(msg.text);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage); // fire-and-forget
  log("telegram", `Bot polling started (rate-limited: 1 msg per ${MIN_SEND_INTERVAL_MS / 1000}s, max ${MAX_MSG_PER_HOUR}/hour)`);
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification Helpers ────────────────────────────────────────

/**
 * Deploy notification — sent with priority since it's a critical event.
 */
export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, binStep, baseFee }) {
  const priceStr = priceRange
    ? `Price range: ${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
    : "";
  const poolStr = (binStep || baseFee)
    ? `Bin step: ${binStep ?? "?"}  |  Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n`
    : "";
  await sendHTML(
    `✅ <b>Deployed</b> ${pair}\n` +
    `Amount: ${amountSol} SOL\n` +
    priceStr +
    poolStr +
    `Position: <code>${position?.slice(0, 8)}...</code>\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`,
    { priority: true }
  );
}

/**
 * Close notification — sent with priority.
 */
export async function notifyClose({ pair, pnlUsd, pnlPct }) {
  const sign = pnlUsd >= 0 ? "+" : "";
  await sendHTML(
    `🔒 <b>Closed</b> ${pair}\n` +
    `PnL: ${sign}$${(pnlUsd ?? 0).toFixed(2)} (${sign}${(pnlPct ?? 0).toFixed(2)}%)`,
    { priority: true }
  );
}

/**
 * Swap notification — normal priority.
 */
export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  await sendHTML(
    `🔄 <b>Swapped</b> ${inputSymbol} → ${outputSymbol}\n` +
    `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

/**
 * OOR notification for a single position — with cooldown to prevent spam.
 */
export async function notifyOutOfRange({ pair, minutesOOR }) {
  const lastNotified = _oorCooldowns.get(pair) || 0;
  if (Date.now() - lastNotified < OOR_COOLDOWN_MS) {
    log("telegram", `OOR alert suppressed for ${pair} (cooldown ${Math.round((OOR_COOLDOWN_MS - (Date.now() - lastNotified)) / 60000)}m left)`);
    return;
  }
  _oorCooldowns.set(pair, Date.now());

  await sendHTML(
    `⚠️ <b>Out of Range</b> ${pair}\n` +
    `Been OOR for ${minutesOOR} minutes`
  );
}

/**
 * Batch multiple OOR alerts into a single message.
 * Use this instead of calling notifyOutOfRange per position.
 * @param {Array<{pair: string, minutes_out_of_range: number}>} oorPositions
 */
export async function notifyOutOfRangeBatch(oorPositions) {
  if (!oorPositions || oorPositions.length === 0) return;

  // Filter out positions still in cooldown
  const toNotify = oorPositions.filter(({ pair }) => {
    const lastNotified = _oorCooldowns.get(pair) || 0;
    return Date.now() - lastNotified >= OOR_COOLDOWN_MS;
  });

  if (toNotify.length === 0) {
    log("telegram", `All ${oorPositions.length} OOR alerts suppressed (cooldown)`);
    return;
  }

  // Mark all as notified
  for (const { pair } of toNotify) {
    _oorCooldowns.set(pair, Date.now());
  }

  // Single consolidated message
  const lines = toNotify.map(({ pair, minutes_out_of_range }) =>
    `• ${pair} — ${minutes_out_of_range ?? "?"}m OOR`
  ).join("\n");

  await sendHTML(
    `⚠️ <b>Out of Range</b> (${toNotify.length} position${toNotify.length > 1 ? "s" : ""})\n${lines}`
  );
}

/**
 * Get current rate limit stats — useful for debugging.
 */
export function getRateLimitStats() {
  pruneHourlyLog();
  return {
    queue_size: _sendQueue.length,
    messages_this_hour: _hourlyLog.length,
    hourly_limit: MAX_MSG_PER_HOUR,
    remaining_this_hour: MAX_MSG_PER_HOUR - _hourlyLog.length,
    min_interval_ms: MIN_SEND_INTERVAL_MS,
    oor_cooldowns: Object.fromEntries(_oorCooldowns),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
