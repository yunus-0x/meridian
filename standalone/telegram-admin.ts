// Telegram admin console: one persistent inline-menu message, grouped
// by function. The message you tap becomes the console; navigation, edit
// prompt, and confirmation re-renders that same message — no new message per
// tap. Changes persist to user-config.json (or .env) and apply live where
// possible; restart-flagged settings offer a restart button.
//
// Authorization is enforced by startAdminPolling (TELEGRAM_ALLOWED_USER_IDS).
// 100% Strict TypeScript, Oracle Engineering Standards: Zero any, Zero unsafe assertions.

import fs from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";
import { config, MIN_SAFE_BINS_BELOW } from "../config.js";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets } from "../smart-wallets.js";
import {
  sendMessage,
  sendMenu,
  editMenu,
  answerCallbackQuery,
  setBotCommands,
  startAdminPolling,
} from "../telegram.js";
import { UserConfigSchema } from "../src/schemas/config.js";
import type { TelegramCallbackQuery, TelegramBotCommand } from "../src/schemas/api.js";
import type { WalletMonitorStats } from "./monitor.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
const ENV_PATH = repoPath(".env");

export const ADMIN_COMMANDS: TelegramBotCommand[] = [
  { command: "menu", description: "Open settings console" },
  { command: "status", description: "Bot status, monitor stats, positions" },
  { command: "wallets", description: "List monitored wallets" },
  { command: "addwallet", description: "Add a monitored wallet: /addwallet <address> <name>" },
  { command: "removewallet", description: "Remove a monitored wallet: /removewallet <address>" },
  { command: "cancel", description: "Abort the current edit" },
];

export interface BaseSetting {
  k: string;
  label?: string;
  restart?: boolean;
  unit?: string;
}

export interface NumberSetting extends BaseSetting {
  type: "int" | "float";
  path: readonly string[];
  min?: number;
  max?: number;
  unit?: string;
}

export interface BoolSetting extends BaseSetting {
  type: "bool";
  path: readonly string[];
}

export interface EnumSetting extends BaseSetting {
  type: "enum";
  path: readonly string[];
  options: readonly string[];
}

export interface ListSetting extends BaseSetting {
  type: "list";
  path: readonly string[];
}

export interface NullableSetting extends BaseSetting {
  type: "nullable";
  path: readonly string[];
  unit?: string;
}

export interface EnvSetting extends BaseSetting {
  type: "env";
  kind: "url" | "secret" | "enum";
  options?: readonly string[];
}

export type AdminSetting =
  | NumberSetting
  | BoolSetting
  | EnumSetting
  | ListSetting
  | NullableSetting
  | EnvSetting;

export interface AdminSection {
  id: string;
  title: string;
  desc: string;
  settings: AdminSetting[];
}

// ─── Settings schema ─────────────────────────────────────────────────────────
// k: user-config key (or ENV: key for .env-backed entries)
// path: live config object path; type drives validation + rendering.
export const SECTIONS: AdminSection[] = [
  {
    id: "trigger",
    title: "🚦 Trigger",
    desc: "Convergence detection",
    settings: [
      { k: "walletThreshold", path: ["standalone", "walletThreshold"], type: "int", min: 1, max: 10, unit: "wallets" },
      { k: "walletWindowSec", path: ["standalone", "windowSec"], type: "int", min: 10, max: 3600, unit: "s" },
      { k: "screeningDeadlineSec", path: ["standalone", "screeningDeadlineSec"], type: "int", min: 10, max: 600, unit: "s" },
      { k: "screeningRetrySec", path: ["standalone", "retrySec"], type: "int", min: 3, max: 120, unit: "s" },
      { k: "minSmartWalletDepositSol", path: ["standalone", "minDepositSol"], type: "float", min: 0, max: 1000, unit: "SOL" },
      { k: "maxEntryPriceMovePct", path: ["standalone", "maxPriceMovePct"], type: "float", min: 0.1, max: 100, unit: "%" },
      { k: "walletSignalCooldownSec", path: ["standalone", "cooldownSec"], type: "int", min: 0, max: 86400, unit: "s" },
    ],
  },
  {
    id: "screening",
    title: "🛡 Screening",
    desc: "Token & pool filters (per triggered mint)",
    settings: [
      { k: "timeframe", path: ["screening", "timeframe"], type: "enum", options: ["5m", "30m", "1h", "2h", "4h", "12h", "24h"] },
      { k: "minTvl", path: ["screening", "minTvl"], type: "int", min: 0, max: 10_000_000, unit: "$" },
      { k: "maxTvl", path: ["screening", "maxTvl"], type: "int", min: 0, max: 100_000_000, unit: "$" },
      { k: "minVolume", path: ["screening", "minVolume"], type: "int", min: 0, max: 10_000_000, unit: "$" },
      { k: "minHolders", path: ["screening", "minHolders"], type: "int", min: 0, max: 100_000 },
      { k: "minMcap", path: ["screening", "minMcap"], type: "int", min: 0, max: 100_000_000, unit: "$" },
      { k: "maxMcap", path: ["screening", "maxMcap"], type: "int", min: 0, max: 1_000_000_000, unit: "$" },
      { k: "minBinStep", path: ["screening", "minBinStep"], type: "int", min: 1, max: 5000 },
      { k: "maxBinStep", path: ["screening", "maxBinStep"], type: "int", min: 1, max: 5000 },
      { k: "minFeeActiveTvlRatio", path: ["screening", "minFeeActiveTvlRatio"], type: "float", min: 0, max: 10 },
      { k: "minTokenFeesSol", path: ["screening", "minTokenFeesSol"], type: "float", min: 0, max: 10_000, unit: "SOL" },
      { k: "maxTop10Pct", path: ["screening", "maxTop10Pct"], type: "float", min: 0, max: 100, unit: "%" },
      { k: "maxBotHoldersPct", path: ["screening", "maxBotHoldersPct"], type: "float", min: 0, max: 100, unit: "%" },
      { k: "minOrganic", path: ["screening", "minOrganic"], type: "int", min: 0, max: 100 },
      { k: "minQuoteOrganic", path: ["screening", "minQuoteOrganic"], type: "int", min: 0, max: 100 },
      { k: "minTokenAgeHours", path: ["screening", "minTokenAgeHours"], type: "nullable", unit: "h" },
      { k: "maxTokenAgeHours", path: ["screening", "maxTokenAgeHours"], type: "nullable", unit: "h" },
      { k: "allowedLaunchpads", path: ["screening", "allowedLaunchpads"], type: "list" },
      { k: "blockedLaunchpads", path: ["screening", "blockedLaunchpads"], type: "list" },
    ],
  },
  {
    id: "risk",
    title: "📏 Risk & sizing",
    desc: "Portfolio limits and deploy size",
    settings: [
      { k: "maxPositions", path: ["risk", "maxPositions"], type: "int", min: 1, max: 50 },
      { k: "deployAmountSol", path: ["management", "deployAmountSol"], type: "float", min: 0.01, max: 10_000, unit: "SOL" },
      { k: "maxDeployAmount", path: ["risk", "maxDeployAmount"], type: "float", min: 0.01, max: 10_000, unit: "SOL" },
      { k: "positionSizePct", path: ["management", "positionSizePct"], type: "float", min: 0.01, max: 1, unit: "fraction" },
      { k: "gasReserve", path: ["management", "gasReserve"], type: "float", min: 0, max: 10, unit: "SOL" },
      { k: "minSolToOpen", path: ["management", "minSolToOpen"], type: "float", min: 0, max: 100, unit: "SOL" },
    ],
  },
  {
    id: "strategy",
    title: "📐 Strategy",
    desc: "Position shape & bin range",
    settings: [
      { k: "strategy", path: ["strategy", "strategy"], type: "enum", options: ["spot", "curve", "bid_ask"], label: "shape" },
      { k: "minBinsBelow", path: ["strategy", "minBinsBelow"], type: "int", min: MIN_SAFE_BINS_BELOW, max: 200, unit: "bins" },
      { k: "maxBinsBelow", path: ["strategy", "maxBinsBelow"], type: "int", min: MIN_SAFE_BINS_BELOW, max: 200, unit: "bins" },
      { k: "defaultBinsBelow", path: ["strategy", "defaultBinsBelow"], type: "int", min: MIN_SAFE_BINS_BELOW, max: 200, unit: "bins" },
      { k: "defaultBinsAbove", path: ["strategy", "defaultBinsAbove"], type: "int", min: 0, max: 60, unit: "bins" },
    ],
  },
  {
    id: "exits",
    title: "🚪 Exits",
    desc: "Deterministic close rules",
    settings: [
      { k: "stopLossPct", path: ["management", "stopLossPct"], type: "float", min: -99, max: 0, unit: "%" },
      { k: "takeProfitPct", path: ["management", "takeProfitPct"], type: "float", min: 0, max: 1000, unit: "%" },
      { k: "trailingTakeProfit", path: ["management", "trailingTakeProfit"], type: "bool" },
      { k: "trailingTriggerPct", path: ["management", "trailingTriggerPct"], type: "float", min: 0.1, max: 1000, unit: "%" },
      { k: "trailingDropPct", path: ["management", "trailingDropPct"], type: "float", min: 0.1, max: 100, unit: "%" },
      { k: "outOfRangeBinsToClose", path: ["management", "outOfRangeBinsToClose"], type: "int", min: 0, max: 500 },
      { k: "outOfRangeWaitMinutes", path: ["management", "outOfRangeWaitMinutes"], type: "int", min: 0, max: 10_000, unit: "min" },
      { k: "outOfRangeAboveWaitMinutes", path: ["management", "outOfRangeAboveWaitMinutes"], type: "int", min: 0, max: 10_000, unit: "min" },
      { k: "outOfRangeBelowWaitMinutes", path: ["management", "outOfRangeBelowWaitMinutes"], type: "int", min: 0, max: 10_000, unit: "min" },
      { k: "minClaimAmount", path: ["management", "minClaimAmount"], type: "float", min: 0, max: 1000, unit: "$" },
      { k: "minFeePerTvl24h", path: ["management", "minFeePerTvl24h"], type: "float", min: 0, max: 1000, unit: "%" },
      { k: "oorCooldownTriggerCount", path: ["management", "oorCooldownTriggerCount"], type: "int", min: 1, max: 100 },
      { k: "oorCooldownHours", path: ["management", "oorCooldownHours"], type: "int", min: 1, max: 1000, unit: "h" },
      { k: "pnlConfirmTicks", path: ["pnl", "confirmTicks"], type: "int", min: 1, max: 10, unit: "ticks" },
      { k: "pnlPollIntervalSec", path: ["pnl", "pollIntervalSec"], type: "int", min: 1, max: 60, unit: "s", restart: true },
      { k: "managementIntervalMin", path: ["schedule", "managementIntervalMin"], type: "int", min: 1, max: 1440, unit: "min", restart: true },
      { k: "solMode", path: ["management", "solMode"], type: "bool" },
    ],
  },
  {
    id: "rpc",
    title: "🌐 RPC & data",
    desc: "Endpoints (.env) — restart to apply",
    settings: [
      { k: "ENV:RPC_URL", label: "RPC_URL (default)", type: "env", kind: "url", restart: true },
      { k: "ENV:MONITOR_RPC_URL", label: "MONITOR_RPC_URL", type: "env", kind: "url", restart: true },
      { k: "ENV:MONITOR_WS_URL", label: "MONITOR_WS_URL", type: "env", kind: "url", restart: true },
      { k: "ENV:BALANCE_RPC_URL", label: "BALANCE_RPC_URL", type: "env", kind: "url", restart: true },
      { k: "ENV:FALLBACK_RPC_URL", label: "FALLBACK_RPC_URL", type: "env", kind: "url", restart: true },
      { k: "ENV:PNL_RPC_URL", label: "PNL_RPC_URL", type: "env", kind: "url", restart: true },
      { k: "ENV:PNL_SOURCE", label: "PNL_SOURCE", type: "env", kind: "enum", options: ["meteora", "rpc"] },
      { k: "ENV:JUPITER_API_KEY", label: "JUPITER_API_KEY", type: "env", kind: "secret", restart: true },
    ],
  },
];

export const byKey = new Map<string, AdminSetting>(SECTIONS.flatMap((s) => s.settings).map((s) => [s.k, s]));

// ─── Persistence ─────────────────────────────────────────────────────────────

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function readUserConfig(): Record<string, unknown> {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return {};
    const raw: unknown = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const parsed = z.record(z.string(), z.unknown()).safeParse(raw);
    return parsed.success ? parsed.data : {};
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`user-config.json is unreadable: ${msg}`);
  }
}

function writeUserConfig(patch: Record<string, unknown>): void {
  const data = { ...readUserConfig(), ...patch };
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

function readEnv(): string {
  return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
}

function envValue(key: string): string {
  const m = readEnv().match(new RegExp(`^${key}=(.*)$`, "m"));
  return m && m[1] ? m[1].trim() : "";
}

function writeEnvValue(key: string, value: string): void {
  const lines = readEnv().split("\n");
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  const entry = `${key}=${value}`;
  if (idx >= 0) lines[idx] = entry;
  else lines.push(entry);
  fs.writeFileSync(ENV_PATH, lines.join("\n"), { mode: 0o600 });
}

function currentValue(setting: AdminSetting): unknown {
  if (setting.type === "env") return envValue(setting.k.slice(4));
  let v: unknown = config;
  for (const p of setting.path) {
    if (isRecord(v)) {
      v = v[p];
    } else {
      return undefined;
    }
  }
  return v;
}

// ─── Console message: one message, re-rendered in place ─────────────────────

let consoleMessageId: number | null = null;
let lastRenderSig: string | null = null;
let lastRenderAt = 0;
const STALE_CONSOLE_MS = 5 * 60_000;

async function render(
  text: string,
  keyboard?: Array<Array<{ text: string; callback_data?: string; url?: string }>>
): Promise<number | null> {
  const sig = `${text}\u0000${JSON.stringify(keyboard ?? [])}`;
  if (consoleMessageId != null) {
    if (sig === lastRenderSig) {
      lastRenderAt = Date.now();
      return consoleMessageId;
    }
    const res = await editMenu(consoleMessageId, text, keyboard).catch(() => null);
    if (res?.ok) {
      lastRenderSig = sig;
      lastRenderAt = Date.now();
      return consoleMessageId;
    }
    consoleMessageId = null;
  }
  const sent = await sendMenu(text, keyboard);
  const sentId = sent && sent.result && isRecord(sent.result) && typeof sent.result["message_id"] === "number"
    ? sent.result["message_id"]
    : null;
  consoleMessageId = sentId;
  lastRenderSig = consoleMessageId != null ? sig : null;
  lastRenderAt = Date.now();
  return consoleMessageId;
}

// ─── Validation + save ───────────────────────────────────────────────────────

export function validate(setting: AdminSetting, raw: unknown): unknown {
  const text = String(raw).trim();
  if (setting.type === "env") {
    if (setting.kind === "enum" && setting.options && !setting.options.includes(text)) {
      throw new Error(`Must be one of: ${setting.options.join(", ")}`);
    }
    if (setting.kind === "url" && text && !/^(https?|wss?):\/\//.test(text)) {
      throw new Error("Must be an http(s):// or ws(s):// URL, or empty");
    }
    if (setting.kind === "secret" && /\s/.test(text)) {
      throw new Error("Key must not contain whitespace");
    }
    return text;
  }
  if (setting.type === "bool") {
    if (!["on", "off", "true", "false"].includes(text.toLowerCase())) throw new Error("Send 'on' or 'off'");
    return ["on", "true"].includes(text.toLowerCase());
  }
  if (setting.type === "enum") {
    if (!setting.options.includes(text)) throw new Error(`Must be one of: ${setting.options.join(", ")}`);
    return text;
  }
  if (setting.type === "list") {
    return text === "" || text.toLowerCase() === "none" ? [] : text.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (setting.type === "nullable") {
    if (["off", "null", "none", "-"].includes(text.toLowerCase())) return null;
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) throw new Error("Send a number ≥ 0, or 'off' for no limit");
    return n;
  }
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Error("Must be a number");
  if (setting.type === "int" && !Number.isInteger(n)) throw new Error("Must be a whole number");
  if (setting.min != null && n < setting.min) throw new Error(`Minimum is ${setting.min}`);
  if (setting.max != null && n > setting.max) throw new Error(`Maximum is ${setting.max}`);
  return n;
}

function applySetting(setting: AdminSetting, value: unknown): boolean {
  if (setting.type === "env") {
    const envKey = setting.k.slice(4);
    const strVal = String(value ?? "");
    writeEnvValue(envKey, strVal);
    process.env[envKey] = strVal;
    if (envKey === "PNL_SOURCE" && isRecord(config.pnl) && (strVal === "rpc" || strVal === "meteora")) {
      config.pnl.source = strVal;
    }
    if (envKey === "JUPITER_API_KEY" && isRecord(config.jupiter)) {
      config.jupiter.apiKey = strVal;
    }
    return Boolean(setting.restart);
  }
  const existingCfg = readUserConfig();
  const prevWait = isRecord(config.management) ? config.management["outOfRangeWaitMinutes"] : undefined;
  const patch: Record<string, unknown> = { [setting.k]: value };
  if (
    setting.k === "outOfRangeWaitMinutes" &&
    isRecord(config.management) &&
    (existingCfg["outOfRangeAboveWaitMinutes"] === undefined ||
      existingCfg["outOfRangeAboveWaitMinutes"] === existingCfg["outOfRangeWaitMinutes"] ||
      config.management["outOfRangeAboveWaitMinutes"] === prevWait)
  ) {
    if (existingCfg["outOfRangeAboveWaitMinutes"] !== undefined) {
      patch["outOfRangeAboveWaitMinutes"] = value;
    }
    config.management["outOfRangeAboveWaitMinutes"] = value as number;
  }
  writeUserConfig(patch);

  // Hot-apply where the runtime reads config live; restart-flagged values say so.
  let target: unknown = config;
  for (let i = 0; i < setting.path.length - 1; i++) {
    const segment = setting.path[i];
    if (segment && isRecord(target)) {
      target = target[segment];
    }
  }
  const lastKey = setting.path[setting.path.length - 1];
  if (lastKey && isRecord(target)) {
    target[lastKey] = value;
  }
  return Boolean(setting.restart);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

export function fmtValue(setting: AdminSetting): string {
  const v = currentValue(setting);
  if (setting.type === "bool") return v ? "ON" : "OFF";
  if (setting.type === "env" && setting.kind === "secret") return v ? "set ✓" : "not set";
  if (v == null) return "off";
  if (Array.isArray(v)) return v.length ? v.join(",") : "any";
  return `${v}${setting.unit && setting.unit !== "%" ? ` ${setting.unit}` : setting.unit === "%" ? "%" : ""}`;
}

function rootKeyboard(): Array<Array<{ text: string; callback_data?: string }>> {
  const mode = `🌑 Shadow: ${config.standalone.shadow ? "ON" : "OFF"}`;
  return [
    [{ text: "👛 Wallets", callback_data: "s:wallets" }, { text: "🖥 Status", callback_data: "s:status" }],
    ...SECTIONS.map((s) => [{ text: s.title, callback_data: `s:${s.id}` }]),
    [{ text: "🔑 Bot key", callback_data: "s:key" }, { text: mode, callback_data: "m:shadow" }],
    [{ text: "♻️ Restart bot", callback_data: "m:restart" }],
  ];
}

export function rootText(note = ""): string {
  return `<b>⚙️ Meridian admin</b>\n<i>${
    config.standalone.shadow ? "🌑 SHADOW — nothing submitted" : "🔴 LIVE — real transactions"
  }</i>\nPick a section:${note ? `\n\n${note}` : ""}`;
}

export function editHint(setting: AdminSetting): string {
  switch (setting.type) {
    case "bool":
      return "Send 'on' or 'off'";
    case "enum":
      return `Send one of: ${setting.options.join(", ")}`;
    case "list":
      return "Send comma-separated values, or 'none' for an empty list";
    case "nullable":
      return "Send a number, or 'off' for no limit";
    case "env":
      if (setting.kind === "enum" && setting.options) return `Send one of: ${setting.options.join(", ")}`;
      if (setting.kind === "secret") return "Send the key";
      return "Send the URL (empty clears it)";
    default:
      return "Send the new value";
  }
}

export function sectionMenu(section: AdminSection): {
  text: string;
  keyboard: Array<Array<{ text: string; callback_data?: string }>>;
} {
  const rows = section.settings.map((s) => [
    {
      text: `${s.label ?? s.k}: ${fmtValue(s)}`,
      callback_data: s.type === "bool" ? `t:${s.k}` : `e:${s.k}`,
    },
  ]);
  const explainers: Record<string, string> = {
    strategy:
      "Range: bins below the active bin scale with pool volatility, clamped to min–max; bins above follow defaultBinsAbove (0 = single-sided SOL, >0 = dual-sided). " +
      "Shape: spot = flat, curve = bell, bid_ask = concentrated center. Applied per entry, no restart.",
    rpc: "Endpoints live in .env — edit, then ♻️ Restart.",
  };
  return {
    text: `<b>${section.title}</b>\n<i>${section.desc}</i>\nTap a value to edit${
      explainers[section.id] ? `\n\n${explainers[section.id]}` : ""
    }.`,
    keyboard: [...rows, [{ text: "← Back", callback_data: "s:root" }]],
  };
}

const cancelKB = (): Array<Array<{ text: string; callback_data: string }>> => [
  [{ text: "✖️ Cancel", callback_data: "x:cancel" }],
];

// ─── Views ───────────────────────────────────────────────────────────────────

async function viewRoot(note = ""): Promise<void> {
  await render(rootText(note), rootKeyboard());
}

async function viewSection(sectionId?: string, note = ""): Promise<void> {
  if (sectionId === "wallets") {
    const { wallets } = listSmartWallets();
    const rows = wallets.map((w, i) => [{ text: `🗑 ${w.name}`, callback_data: `w:rm:${i}` }]);
    await render(
      `👛 <b>Monitored wallets</b> (${wallets.length})\n${
        wallets.map((w) => `• <b>${w.name}</b>\n<code>${w.address}</code>`).join("\n") ||
        "none — add at least 2 to trigger entries"
      }${note ? `\n\n${note}` : ""}`,
      [...rows, [{ text: "➕ Add wallet", callback_data: "w:add" }, { text: "← Back", callback_data: "s:root" }]]
    );
    return;
  }
  if (sectionId === "key") {
    let deposit = config.standalone.walletAddress || null;
    let keyState = "not set";
    if (process.env.WALLET_PRIVATE_KEY) {
      try {
        deposit = parseSecretKey(process.env.WALLET_PRIVATE_KEY).publicKey.toString();
        keyState = "configured ✓";
      } catch {
        keyState = "configured but unreadable ⚠️";
      }
    }
    let balanceLine = "";
    if (deposit) {
      try {
        const { getWalletBalances } = await import("../tools/wallet.js");
        const b = await getWalletBalances({ nativeOnly: true });
        if ("sol" in b && typeof b.sol === "number" && Number.isFinite(b.sol)) {
          balanceLine = `\nSOL balance: <b>${b.sol.toFixed(4)}</b>`;
        }
      } catch {
        /* balance is best-effort */
      }
    }
    await render(
      `🔑 <b>Bot wallet</b>\n\n📥 <b>Deposit address:</b>\n<code>${
        deposit ?? "—"
      }</code>${balanceLine}\n\nSigning key: ${keyState}\nRead-only override: <code>${
        config.standalone.walletAddress || "not set"
      }</code>${note ? `\n\n${note}` : ""}`,
      [
        [{ text: "📥 Import private key", callback_data: "k:imp" }],
        [{ text: "📤 Export private key", callback_data: "k:exp" }, { text: "📍 Set read-only address", callback_data: "k:addr" }],
        [{ text: "← Back", callback_data: "s:root" }],
      ]
    );
    return;
  }
  if (sectionId === "status") {
    await render(await statusText(), [
      [{ text: "🔄 Refresh", callback_data: "s:status" }, { text: "← Back", callback_data: "s:root" }],
    ]);
    return;
  }
  const section = SECTIONS.find((s) => s.id === sectionId);
  if (!section) {
    await viewRoot();
    return;
  }
  const menu = sectionMenu(section);
  await render(note ? `${menu.text}\n\n${note}` : menu.text, menu.keyboard);
}

const hostOf = (url?: string): string => {
  if (!url) return "?";
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
};

async function statusText(): Promise<string> {
  const stats: Partial<WalletMonitorStats> = adminContext.monitor?.stats ?? {};
  const wallets = listSmartWallets();
  const monitorUrl = config.standalone.monitorRpcUrl || envValue("RPC_URL");
  const balanceUrl = config.standalone.balanceRpcUrl || envValue("RPC_URL");
  const fallbackUrl = config.standalone.fallbackRpcUrl;
  const lines = [
    `🖥 <b>Status</b>`,
    `Mode: ${config.standalone.shadow ? "🌑 SHADOW" : "🔴 LIVE"} | DRY_RUN=${process.env.DRY_RUN === "true"}`,
    `Uptime: ${Math.floor(process.uptime() / 60)} min`,
    `Wallets monitored: ${wallets.total} (trigger: ${config.standalone.walletThreshold} in ${config.standalone.windowSec}s)`,
    `RPC: monitor=${hostOf(monitorUrl)} balance=${hostOf(balanceUrl)}${fallbackUrl ? ` fallback=${hostOf(fallbackUrl)}` : ""}`,
    `Monitor: tx=${stats.transactions ?? 0} entries=${stats.entries ?? 0} lag=${
      stats.lastLagMs != null ? `${(stats.lastLagMs / 1000).toFixed(1)}s` : "n/a"
    } errors=${stats.errors ?? 0}`,
    `Signals active: ${adminContext.activeSignals?.() ?? 0}`,
  ];
  try {
    const { getMyPositions } = await import("../tools/dlmm.js");
    const positions = await getMyPositions({ force: true, silent: true });
    lines.push(
      `Positions: ${positions.total_positions}${
        positions.positions.length
          ? ` (${positions.positions.map((p) => `${p.pair ?? "?"} ${p.pnl_pct ?? "?"}%`).join(", ")})`
          : ""
      }`
    );
  } catch {
    lines.push("Positions: unavailable");
  }
  return lines.join("\n");
}

const SecretKeyByteArraySchema = z.array(z.number().int().min(0).max(255)).length(64);

export function parseSecretKey(raw: unknown): Keypair {
  const text = String(raw).trim();
  if (text.startsWith("[")) {
    const jsonParsed: unknown = JSON.parse(text);
    const parsed = SecretKeyByteArraySchema.safeParse(jsonParsed);
    if (!parsed.success) throw new Error("bad array");
    return Keypair.fromSecretKey(Uint8Array.from(parsed.data));
  }
  const bytes = bs58.decode(text);
  if (bytes.length !== 64) throw new Error("bad length");
  return Keypair.fromSecretKey(bytes);
}

function requestRestart(): void {
  void (async () => {
    await sendMessage("♻️ Restarting — back in a few seconds…").catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
    process.exit(1);
  })();
}

// ─── Callbacks ───────────────────────────────────────────────────────────────

export type PendingState =
  | { kind: "set"; setting: AdminSetting }
  | { kind: "waddr" }
  | { kind: "wname"; address: string }
  | { kind: "pkimport" }
  | { kind: "walletaddr" };

let pending: PendingState | null = null;

async function handleCallback(cb: TelegramCallbackQuery): Promise<void> {
  const data = cb.data || "";
  if (cb.message?.message_id) consoleMessageId = cb.message.message_id;
  await answerCallbackQuery(cb.id).catch(() => {});
  try {
    if (data === "x:cancel" || data === "s:root") {
      pending = null;
      await viewRoot();
      return;
    }
    if (data.startsWith("s:")) {
      pending = null;
      await viewSection(data.slice(2));
      return;
    }
    if (data.startsWith("t:")) {
      const setting = byKey.get(data.slice(2));
      if (!setting) return;
      const needs = applySetting(setting, !currentValue(setting));
      const section = SECTIONS.find((s) => s.settings.includes(setting));
      await viewSection(section?.id, `✅ Saved${needs ? " — ♻️ restart to apply" : ""}`);
      return;
    }
    if (data.startsWith("e:")) {
      const setting = byKey.get(data.slice(2));
      if (!setting) return;
      pending = { kind: "set", setting };
      await render(
        `✏️ <b>${setting.label ?? setting.k}</b>\nCurrent: <code>${fmtValue(setting)}</code>\n\n${editHint(setting)}`,
        cancelKB()
      );
      return;
    }
    if (data === "w:add") {
      pending = { kind: "waddr" };
      await render("👛 Send the wallet <b>address</b>:", cancelKB());
      return;
    }
    if (data.startsWith("w:rm2:")) {
      const { wallets } = listSmartWallets();
      const w = wallets[Number(data.slice(6))];
      if (!w) {
        await viewSection("wallets", "⚠️ Wallet not found.");
        return;
      }
      const res = removeSmartWallet({ address: w.address });
      await viewSection("wallets", res.success ? `🗑 Removed ${w.name}` : `⚠️ ${res.error}`);
      return;
    }
    if (data.startsWith("w:rm:")) {
      const { wallets } = listSmartWallets();
      const w = wallets[Number(data.slice(5))];
      if (!w) {
        await viewSection("wallets", "⚠️ Wallet not found.");
        return;
      }
      await render(`Remove <b>${w.name}</b>\n<code>${w.address}</code>?`, [
        [{ text: "🗑 Confirm remove", callback_data: `w:rm2:${data.slice(5)}` }, { text: "✖️ Cancel", callback_data: "s:wallets" }],
      ]);
      return;
    }
    if (data === "k:imp") {
      pending = { kind: "pkimport" };
      await render(
        "🔑 Send the private key — base58 secret <b>or</b> JSON byte array.\n\n⚠️ The message will stay in this chat until you delete it.",
        cancelKB()
      );
      return;
    }
    if (data === "k:exp") {
      await render(
        "⚠️ <b>Export sends the private key into this chat.</b>\nTelegram history is kept server-side. Anyone with access to this account gets the key.\n\nExport anyway?",
        [
          [{ text: "👁 Show key", callback_data: "k:exp2" }, { text: "✖️ Cancel", callback_data: "s:key" }],
        ]
      );
      return;
    }
    if (data === "k:exp2") {
      const raw = process.env.WALLET_PRIVATE_KEY;
      if (!raw) {
        await sendMessage("No WALLET_PRIVATE_KEY configured.");
        await viewSection("key");
        return;
      }
      let kp: Keypair;
      try {
        kp = parseSecretKey(raw);
      } catch {
        await sendMessage("⚠️ Stored key is unreadable.");
        await viewSection("key");
        return;
      }
      await sendMessage(`🔑 <code>${bs58.encode(kp.secretKey)}</code>\n\n⚠️ Delete this message from the chat history now.`);
      await viewSection("key", "Key shown above — delete that message now.");
      return;
    }
    if (data === "k:addr") {
      pending = { kind: "walletaddr" };
      await render("📍 Send the read-only wallet <b>address</b> (public key):", cancelKB());
      return;
    }
    if (data === "m:shadow") {
      const next = !config.standalone.shadow;
      await render(`Set mode to <b>${next ? "SHADOW (nothing submitted)" : "LIVE"}</b>?`, [
        [{ text: next ? "🌑 Shadow" : "🔴 LIVE", callback_data: "m:shadow2" }, { text: "✖️ Cancel", callback_data: "s:root" }],
      ]);
      return;
    }
    if (data === "m:shadow2") {
      const next = !config.standalone.shadow;
      writeUserConfig({ shadowMode: next });
      config.standalone.shadow = next;
      if (next) process.env.DRY_RUN = "true";
      if (envValue("DRY_RUN") !== "true") delete process.env.DRY_RUN;
      await viewRoot();
      return;
    }
    if (data === "m:restart") {
      await render("♻️ Restart bot? (takes ~5s)", [
        [{ text: "♻️ Confirm restart", callback_data: "m:restart2" }, { text: "✖️ Cancel", callback_data: "s:root" }],
      ]);
      return;
    }
    if (data === "m:restart2") {
      requestRestart();
      return;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log("telegram_error", `admin callback failed: ${msg}`);
    await viewRoot(`⚠️ ${msg}`).catch(() => {});
  }
}

// ─── Text input ──────────────────────────────────────────────────────────────

async function handleText(text?: string): Promise<void> {
  const rawText = text ?? "";
  if (pending) {
    const p = pending;
    pending = null;
    try {
      if (p.kind === "set") {
        const value = validate(p.setting, rawText);
        const needs = applySetting(p.setting, value);
        const sectionId = SECTIONS.find((s) => s.settings.includes(p.setting))?.id;
        await viewSection(
          sectionId,
          `✅ <b>${p.setting.label ?? p.setting.k}</b> → <code>${fmtValue(p.setting)}</code>${
            needs ? "\n♻️ Applies after restart" : ""
          }`
        );
        return;
      }
      if (p.kind === "waddr") {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(rawText.trim())) {
          pending = { kind: "waddr" };
          await render("⚠️ Not a valid Solana address — send it again, or tap Cancel:", cancelKB());
          return;
        }
        pending = { kind: "wname", address: rawText.trim() };
        await render("Name for this wallet:", cancelKB());
        return;
      }
      if (p.kind === "wname") {
        const name = rawText.trim().slice(0, 40) || "wallet";
        const res = addSmartWallet({ address: p.address, name });
        await viewSection("wallets", res.success ? `✅ Added <b>${name}</b>\n<code>${p.address}</code>` : `⚠️ ${res.error}`);
        return;
      }
      if (p.kind === "pkimport") {
        const kp = parseSecretKey(rawText);
        const encodedSecret = bs58.encode(kp.secretKey);
        writeEnvValue("WALLET_PRIVATE_KEY", encodedSecret);
        process.env.WALLET_PRIVATE_KEY = encodedSecret;
        try {
          const { resetWalletCache } = await import("../tools/wallet.js");
          const { resetDlmmWalletCache } = await import("../tools/dlmm.js");
          const { invalidateBalances } = await import("./balances.js");
          resetWalletCache?.();
          resetDlmmWalletCache?.();
          invalidateBalances?.();
        } catch {
          /* best-effort cache reset */
        }
        await viewSection(
          "key",
          `✅ Key imported — wallet <code>${kp.publicKey.toString()}</code>\nSigning is active now (survives restarts).`
        );
        return;
      }
      if (p.kind === "walletaddr") {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(rawText.trim())) {
          await render("⚠️ Not a valid address — send again, or tap Cancel:", cancelKB());
          return;
        }
        writeUserConfig({ walletAddress: rawText.trim() });
        config.standalone.walletAddress = rawText.trim();
        await viewSection("key", `✅ Read-only address set: <code>${rawText.trim()}</code>`);
        return;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await render(`⚠️ ${msg} — try again or tap Cancel`, cancelKB());
      return;
    }
  }

  const parts = rawText.trim().split(/\s+/);
  const cmd = parts[0] || "";
  const args = parts.slice(1);
  if (cmd === "/cancel") {
    pending = null;
    await viewRoot("Cancelled.");
    return;
  }
  if (cmd === "/start" || cmd === "/help" || cmd === "/menu") {
    if (consoleMessageId != null && Date.now() - lastRenderAt > STALE_CONSOLE_MS) {
      consoleMessageId = null;
      lastRenderSig = null;
    }
    await viewRoot("Commands: /addwallet <address> <name> · /removewallet <address> · /wallets · /status · /cancel");
    return;
  }
  if (cmd === "/status") {
    await viewSection("status");
    return;
  }
  if (cmd === "/wallets") {
    await viewSection("wallets");
    return;
  }
  if (cmd === "/addwallet") {
    const address = args[0] || "";
    const name = args.slice(1).join(" ").slice(0, 40) || "wallet";
    const res = addSmartWallet({ address, name });
    await viewSection("wallets", res.success ? `✅ Added <b>${name}</b> <code>${address}</code>` : `⚠️ ${res.error}`);
    return;
  }
  if (cmd === "/removewallet") {
    const res = removeSmartWallet({ address: args[0] ?? "" });
    await viewSection("wallets", res.success ? `🗑 Removed ${res.removed}` : `⚠️ ${res.error}`);
    return;
  }
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

export interface AdminContextOptions {
  monitor?: { stats?: WalletMonitorStats } | null;
  activeSignals?: (() => number) | null;
}

const adminContext: {
  monitor: { stats?: WalletMonitorStats } | null;
  activeSignals: (() => number) | null;
} = { monitor: null, activeSignals: null };

// Exposed for menu-schema tests in test/cleanup.test.js.
export const _test = { SECTIONS, byKey, editHint, validate, sectionMenu, fmtValue, rootText };

export function startAdmin({ monitor = null, activeSignals = null }: AdminContextOptions = {}): () => void {
  adminContext.monitor = monitor;
  adminContext.activeSignals = activeSignals;
  const stop = startAdminPolling(async ({ message, callback }) => {
    if (callback) await handleCallback(callback);
    else if (message) await handleText(message.text);
  });
  void setBotCommands(ADMIN_COMMANDS);
  return stop;
}
