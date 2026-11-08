// Outbound notifications used by standalone runtime and transaction executor.
// 100% Strict TypeScript, Oracle Engineering Standards: Zero any, Zero unsafe assertions, Mandatory Zod boundary validation.
import fs from "node:fs";
import { config } from "./config.js";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { UserConfigSchema } from "./src/schemas/config.js";
import {
  TelegramApiResponseSchema,
  TelegramGetUpdatesResponseSchema,
  type TelegramApiResponse,
  type TelegramMessage,
  type TelegramCallbackQuery,
  type TelegramBotCommand,
  type NotifyDeployParams,
  type NotifyCloseParams,
  type NotifySwapParams,
} from "./src/schemas/api.js";

const USER_CONFIG_PATH = repoPath("user-config.json");

function getToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
}

function getBaseUrl(): string | null {
  const token = getToken();
  return token ? `https://api.telegram.org/bot${token}` : null;
}

function nonEmptyChatId(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

export function resolveChatId(): string | null {
  const fromEnv = nonEmptyChatId(process.env.TELEGRAM_CHAT_ID);
  let fromConfig: string | null = null;
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const raw: unknown = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      const parsed = UserConfigSchema.partial().passthrough().safeParse(raw);
      if (parsed.success && parsed.data.telegramChatId) {
        fromConfig = nonEmptyChatId(parsed.data.telegramChatId);
      }
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${msg}`);
  }
  // user-config wins if set; otherwise fall back to .env
  const resolved = fromConfig || fromEnv || null;
  return resolved != null ? String(resolved) : null;
}

export function isTelegramSuppressed(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.DISABLE_TELEGRAM === "true" ||
    process.env.DISABLE_TELEGRAM === "1" ||
    Boolean(process.env.VITEST) ||
    Boolean(process.env.TSX_TEST) ||
    (typeof process.env.npm_lifecycle_event === "string" && process.env.npm_lifecycle_event.startsWith("test")) ||
    process.execArgv.includes("--test") ||
    process.argv.includes("--test") ||
    process.argv.some((arg) => typeof arg === "string" && (arg.includes("test/") || arg.includes(".test.")))
  );
}

export function isEnabled(): boolean {
  if (isTelegramSuppressed()) return false;
  return Boolean(getToken());
}

async function postTelegram(method: string, body: Record<string, unknown>): Promise<TelegramApiResponse | null> {
  if (isTelegramSuppressed()) return null;
  const token = getToken();
  const base = getBaseUrl();
  const chatId = resolveChatId();
  if (!token || !base || !chatId) return null;

  try {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) {
        log(
          "telegram_error",
          `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envcrypt key)`
        );
      } else {
        log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      }
      return null;
    }
    const raw: unknown = await res.json();
    const parsed = TelegramApiResponseSchema.safeParse(raw);
    if (!parsed.success) {
      log("telegram_error", `${method} unexpected response schema: ${parsed.error.message}`);
      return null;
    }
    return parsed.data;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log("telegram_error", `${method} failed: ${msg}`);
    return null;
  }
}

export async function sendMessage(text: string): Promise<TelegramApiResponse | null> {
  if (isTelegramSuppressed()) return null;
  const token = getToken();
  const chatId = resolveChatId();
  if (!token || !chatId) return null;
  return postTelegram("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendHTML(html: string): Promise<TelegramApiResponse | null> {
  if (isTelegramSuppressed()) return null;
  const token = getToken();
  const chatId = resolveChatId();
  if (!token || !chatId) return null;
  return postTelegram("sendMessage", { text: String(html).slice(0, 4096), parse_mode: "HTML" });
}

// ─── Admin console transport: inline menus + authorized update polling ──────

export async function sendMenu(
  text: string,
  keyboard?: Array<Array<Record<string, unknown>>>
): Promise<TelegramApiResponse | null> {
  if (isTelegramSuppressed()) return null;
  const token = getToken();
  const chatId = resolveChatId();
  if (!token || !chatId) return null;
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    parse_mode: "HTML",
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

export async function editMenu(
  messageId: number,
  text: string,
  keyboard?: Array<Array<Record<string, unknown>>>
): Promise<TelegramApiResponse | null> {
  if (isTelegramSuppressed()) return null;
  const token = getToken();
  const chatId = resolveChatId();
  if (!token || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    parse_mode: "HTML",
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

export async function answerCallbackQuery(id: string, text = ""): Promise<TelegramApiResponse | null> {
  if (isTelegramSuppressed()) return null;
  const token = getToken();
  if (!token || !id) return null;
  return postTelegram("answerCallbackQuery", {
    callback_query_id: id,
    ...(text ? { text: String(text).slice(0, 190) } : {}),
  });
}

// Register bot's command list so Telegram clients show current commands
// instead of a stale cached set. Called on every startup of admin console.
export async function setBotCommands(commands: TelegramBotCommand[]): Promise<TelegramApiResponse | null> {
  if (isTelegramSuppressed()) return null;
  const token = getToken();
  if (!token || !Array.isArray(commands) || !commands.length) return null;
  return postTelegram("setMyCommands", { commands });
}

export interface AdminUpdateEvent {
  message?: TelegramMessage;
  callback?: TelegramCallbackQuery;
}

/**
 * Long-poll getUpdates for admin console. Anything queued before startup
 * is skipped. Only updates from TELEGRAM_ALLOWED_USER_IDS are forwarded;
 * if no allowlist is configured, polling stays off entirely.
 * Returns stop() function.
 */
export function startAdminPolling(onUpdate: (event: AdminUpdateEvent) => Promise<void> | void): () => void {
  if (isTelegramSuppressed()) return () => {};
  const token = getToken();
  const base = getBaseUrl();
  const allowed = String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!token || !base || !allowed.length) {
    if (token) log("telegram_warn", "Admin console disabled — set TELEGRAM_ALLOWED_USER_IDS to enable in-chat commands");
    return () => {};
  }
  let offset: number | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function poll(): Promise<void> {
    try {
      const params = new URLSearchParams({
        timeout: "25",
        allowed_updates: JSON.stringify(["message", "callback_query"]),
      });
      if (offset != null) params.set("offset", String(offset));
      const res = await fetch(`${base}/getUpdates?${params}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`getUpdates ${res.status}`);
      const raw: unknown = await res.json();
      const parsed = TelegramGetUpdatesResponseSchema.safeParse(raw);
      const updates = parsed.success ? parsed.data.result : [];
      if (offset == null) {
        // First successful poll: skip pre-start backlog entirely.
        const last = updates[updates.length - 1];
        offset = last ? last.update_id + 1 : 0;
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
          } catch (e: unknown) {
            const msgStr = e instanceof Error ? e.message : String(e);
            log("telegram_error", `admin update failed: ${msgStr}`);
          }
        }
      }
    } catch {
      /* transient network/API errors — next tick retries */
    }
    if (!stopped) timer = setTimeout(poll, 2000);
  }

  void poll();
  log("telegram", `Admin console polling active (${allowed.length} authorized user(s))`);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export async function notifyDeploy({
  pair,
  amountSol,
  position,
  tx,
  priceRange,
  rangeCoverage,
  binStep,
  baseFee,
}: NotifyDeployParams): Promise<void> {
  if (isTelegramSuppressed()) return;
  const priceStr = priceRange
    ? `Price range: ${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
    : "";
  const coverageStr = rangeCoverage
    ? `Range cover: ${fmtPct(rangeCoverage.downside_pct)} downside | ${fmtPct(rangeCoverage.upside_pct)} upside | ${fmtPct(rangeCoverage.width_pct)} total\n`
    : "";
  const poolStr =
    binStep || baseFee
      ? `Bin step: ${binStep ?? "?"} | Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n`
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

export async function notifyClose({ pair, pnlUsd, pnlSol, pnlPct, solMode }: NotifyCloseParams): Promise<void> {
  if (isTelegramSuppressed()) return;
  const useSolMode = solMode != null ? Boolean(solMode) : Boolean(config.management?.solMode);
  const rawPrimary = useSolMode ? (pnlSol ?? pnlUsd ?? 0) : (pnlUsd ?? 0);
  const val = Number(rawPrimary);
  const pct = Number(pnlPct ?? 0);
  const valSign = val >= 0 ? "+" : "-";
  const pctSign = pct >= 0 ? "+" : "";
  const pnlText = useSolMode
    ? `${valSign}◎${Math.abs(val).toFixed(4)} SOL`
    : `${valSign}$${Math.abs(val).toFixed(2)}`;
  await sendHTML(`🔒 <b>Closed</b> ${pair}\n` + `PnL: ${pnlText} (${pctSign}${pct.toFixed(2)}%)`);
}

export async function notifySwap({
  inputSymbol,
  outputSymbol,
  amountIn,
  amountOut,
  tx,
}: NotifySwapParams): Promise<void> {
  if (isTelegramSuppressed()) return;
  await sendHTML(
    `🔄 <b>Swapped</b> ${inputSymbol ?? "?"} → ${outputSymbol ?? "?"}\n` +
      `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\n` +
      `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

function fmtPct(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}
