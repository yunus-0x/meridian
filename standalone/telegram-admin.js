// Telegram admin console: one persistent inline-menu message, grouped by
// function. The message you tap becomes the console; every navigation, edit
// prompt, and confirmation re-renders that same message — no new message per
// tap. Changes persist to user-config.json (or .env) and apply live where
// possible; restart-flagged settings offer the restart button.
//
// Authorization is enforced by startAdminPolling (TELEGRAM_ALLOWED_USER_IDS).

import fs from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config, MIN_SAFE_BINS_BELOW } from "../config.js";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets } from "../smart-wallets.js";
import { sendMessage, sendMenu, editMenu, answerCallbackQuery, setBotCommands, startAdminPolling } from "../telegram.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
const ENV_PATH = repoPath(".env");

export const ADMIN_COMMANDS = [
  { command: "menu", description: "Open the settings console" },
  { command: "status", description: "Bot status, monitor stats, positions" },
  { command: "wallets", description: "List monitored wallets" },
  { command: "addwallet", description: "Add a monitored wallet: /addwallet <address> <name>" },
  { command: "removewallet", description: "Remove a monitored wallet: /removewallet <address>" },
  { command: "cancel", description: "Abort the current edit" },
];

// ─── Settings schema ─────────────────────────────────────────────────────────
// k: user-config key (or ENV: key for .env-backed entries)
// path: live config object path; type drives validation + rendering.
const SECTIONS = [
  {
    id: "trigger", title: "🚦 Trigger", desc: "Convergence detection",
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
    id: "screening", title: "🛡 Screening", desc: "Token & pool filters (per triggered mint)",
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
    id: "risk", title: "📏 Risk & sizing", desc: "Portfolio limits and deploy size",
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
    id: "strategy", title: "📐 Strategy", desc: "Position shape & bin range",
    settings: [
      { k: "strategy", path: ["strategy", "strategy"], type: "enum", options: ["spot", "curve", "bid_ask"], label: "shape" },
      { k: "minBinsBelow", path: ["strategy", "minBinsBelow"], type: "int", min: MIN_SAFE_BINS_BELOW, max: 200, unit: "bins" },
      { k: "maxBinsBelow", path: ["strategy", "maxBinsBelow"], type: "int", min: MIN_SAFE_BINS_BELOW, max: 200, unit: "bins" },
      { k: "defaultBinsBelow", path: ["strategy", "defaultBinsBelow"], type: "int", min: MIN_SAFE_BINS_BELOW, max: 200, unit: "bins" },
      { k: "defaultBinsAbove", path: ["strategy", "defaultBinsAbove"], type: "int", min: 0, max: 60, unit: "bins" },
    ],
  },
  {
    id: "exits", title: "🚪 Exits", desc: "Deterministic close rules",
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
    id: "rpc", title: "🌐 RPC & data", desc: "Endpoints (.env) — restart to apply",
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

const byKey = new Map(SECTIONS.flatMap(s => s.settings).map(s => [s.k, s]));

// ─── Persistence ─────────────────────────────────────────────────────────────

function readUserConfig() {
  try { return fs.existsSync(USER_CONFIG_PATH) ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")) : {}; }
  catch (e) { throw new Error(`user-config.json is unreadable: ${e.message}`); }
}
function writeUserConfig(patch) {
  const data = { ...readUserConfig(), ...patch };
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}
function readEnv() {
  return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
}
function envValue(key) {
  const m = readEnv().match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : "";
}
function writeEnvValue(key, value) {
  const lines = readEnv().split("\n");
  const idx = lines.findIndex(l => l.startsWith(`${key}=`));
  const entry = `${key}=${value}`;
  if (idx >= 0) lines[idx] = entry;
  else lines.push(entry);
  fs.writeFileSync(ENV_PATH, lines.join("\n"), { mode: 0o600 });
}

function currentValue(setting) {
  if (setting.type === "env") return envValue(setting.k.slice(4));
  let v = config;
  for (const p of setting.path) v = v?.[p];
  return v;
}

// ─── Console message: one message, re-rendered in place ─────────────────────

let consoleMessageId = null;
let lastRenderSig = null;
let lastRenderAt = 0;
// While the console is in active use, /menu edits it in place; once stale,
// /menu starts a fresh message at the bottom so it's actually visible.
const STALE_CONSOLE_MS = 5 * 60_000;

// Render into the console message. Tapping any older menu message adopts it
// as the console, so navigation never spawns new messages.
async function render(text, keyboard) {
  const sig = `${text}\u0000${JSON.stringify(keyboard ?? [])}`;
  if (consoleMessageId != null) {
    if (sig === lastRenderSig) { lastRenderAt = Date.now(); return consoleMessageId; }
    const res = await editMenu(consoleMessageId, text, keyboard).catch(() => null);
    if (res?.ok) { lastRenderSig = sig; lastRenderAt = Date.now(); return consoleMessageId; }
    consoleMessageId = null; // stale id (deleted or too old) — resend below
  }
  const sent = await sendMenu(text, keyboard);
  consoleMessageId = sent?.result?.message_id ?? null;
  lastRenderSig = consoleMessageId != null ? sig : null;
  lastRenderAt = Date.now();
  return consoleMessageId;
}

// ─── Validation + save ───────────────────────────────────────────────────────

function validate(setting, raw) {
  const text = String(raw).trim();
  if (setting.type === "env") {
    if (setting.kind === "enum" && !setting.options.includes(text)) throw new Error(`Must be one of: ${setting.options.join(", ")}`);
    if (setting.kind === "url" && text && !/^(https?|wss?):\/\//.test(text)) throw new Error("Must be an http(s):// or ws(s):// URL, or empty");
    if (setting.kind === "secret" && /\s/.test(text)) throw new Error("Key must not contain whitespace");
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
    return text === "" || text.toLowerCase() === "none" ? [] : text.split(",").map(s => s.trim()).filter(Boolean);
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

function applySetting(setting, value) {
  if (setting.type === "env") {
    writeEnvValue(setting.k.slice(4), value);
    return setting.restart;
  }
  writeUserConfig({ [setting.k]: value });
  // Hot-apply where the runtime reads config live; restart-flagged values say so.
  let target = config;
  for (let i = 0; i < setting.path.length - 1; i++) target = target[setting.path[i]];
  target[setting.path[setting.path.length - 1]] = value;
  return !!setting.restart;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function fmtValue(setting) {
  const v = currentValue(setting);
  if (setting.type === "bool") return v ? "ON" : "OFF";
  if (setting.type === "env" && setting.kind === "secret") return v ? "set ✓" : "not set";
  if (v == null) return "off";
  if (Array.isArray(v)) return v.length ? v.join(",") : "any";
  return `${v}${setting.unit && setting.unit !== "%" ? ` ${setting.unit}` : setting.unit === "%" ? "%" : ""}`;
}

function rootKeyboard() {
  const mode = `🌑 Shadow: ${config.standalone.shadow ? "ON" : "OFF"}`;
  return [
    [{ text: "👛 Wallets", callback_data: "s:wallets" }, { text: "🖥 Status", callback_data: "s:status" }],
    ...SECTIONS.map(s => [{ text: s.title, callback_data: `s:${s.id}` }]),
    [{ text: "🔑 Bot key", callback_data: "s:key" }, { text: mode, callback_data: "m:shadow" }],
    [{ text: "♻️ Restart bot", callback_data: "m:restart" }],
  ];
}

function rootText() {
  return `<b>⚙️ Meridian admin</b>\n<i>${config.standalone.shadow ? "🌑 SHADOW — nothing is submitted" : "🔴 LIVE — real transactions"}</i>\nPick a section:`;
}

function editHint(setting) {
  switch (setting.type) {
    case "bool": return "Send 'on' or 'off'";
    case "enum": return `Send one of: ${setting.options.join(", ")}`;
    case "list": return "Send comma-separated values, or 'none' for an empty list";
    case "nullable": return "Send a number, or 'off' for no limit";
    case "env":
      if (setting.kind === "enum") return `Send one of: ${setting.options.join(", ")}`;
      if (setting.kind === "secret") return "Send the key";
      return "Send the URL (empty clears it)";
    default: return "Send the new value";
  }
}

function sectionMenu(section) {
  const rows = section.settings.map(s => [{
    text: `${s.label ?? s.k}: ${fmtValue(s)}`,
    callback_data: s.type === "bool" ? `t:${s.k}` : `e:${s.k}`,
  }]);
  const explainers = {
    strategy:
      "Range: bins below the active bin scale with pool volatility, clamped to min–max (bins above = 0). " +
      "Shape: spot = flat, curve = bell, bid_ask = concentrated at the center. Applied per entry, no restart.",
    rpc: "Endpoints live in .env — edit, then ♻️ Restart.",
  };
  return {
    text: `<b>${section.title}</b>\n<i>${section.desc}</i>\nTap a value to edit${explainers[section.id] ? `\n\n${explainers[section.id]}` : ""}.`,
    keyboard: [...rows, [{ text: "← Back", callback_data: "s:root" }]],
  };
}

const cancelKB = () => [[{ text: "✖️ Cancel", callback_data: "x:cancel" }]];
const restartRow = () => [{ text: "♻️ Restart now", callback_data: "m:restart" }];

// ─── Views ───────────────────────────────────────────────────────────────────

async function viewRoot() {
  await render(rootText(), rootKeyboard());
}

async function viewSection(sectionId, note = "") {
  if (sectionId === "wallets") {
    const { wallets } = listSmartWallets();
    const rows = wallets.map((w, i) => [{ text: `🗑 ${w.name}`, callback_data: `w:rm:${i}` }]);
    return void await render(
      `👛 <b>Monitored wallets</b> (${wallets.length})\n${wallets.map(w => `• <b>${w.name}</b>\n<code>${w.address}</code>`).join("\n") || "none — add at least 2 to trigger entries"}${note ? `\n\n${note}` : ""}`,
      [...rows, [{ text: "➕ Add wallet", callback_data: "w:add" }, { text: "← Back", callback_data: "s:root" }]],
    );
  }
  if (sectionId === "key") {
    let deposit = config.standalone.walletAddress || null;
    let keyState = "not set";
    if (process.env.WALLET_PRIVATE_KEY) {
      try {
        deposit = parseSecretKey(process.env.WALLET_PRIVATE_KEY).publicKey.toString();
        keyState = "configured ✓";
      } catch { keyState = "configured but unreadable ⚠️"; }
    }
    let balanceLine = "";
    if (deposit) {
      try {
        const { getWalletBalances } = await import("../tools/wallet.js");
        const b = await getWalletBalances({ nativeOnly: true });
        if (!b.error && Number.isFinite(b.sol)) balanceLine = `\nSOL balance: <b>${b.sol.toFixed(4)}</b>`;
      } catch { /* balance is best-effort */ }
    }
    return void await render(
      `🔑 <b>Bot wallet</b>\n\n📥 <b>Deposit address:</b>\n<code>${deposit ?? "—"}</code>${balanceLine}\n\nSigning key: ${keyState}\nRead-only override: <code>${config.standalone.walletAddress || "not set"}</code>${note ? `\n\n${note}` : ""}`,
      [
        [{ text: "📥 Import private key", callback_data: "k:imp" }],
        [{ text: "📤 Export private key", callback_data: "k:exp" }, { text: "📍 Set read-only address", callback_data: "k:addr" }],
        [{ text: "← Back", callback_data: "s:root" }],
      ],
    );
  }
  if (sectionId === "status") {
    return void await render(await statusText(), [[{ text: "🔄 Refresh", callback_data: "s:status" }, { text: "← Back", callback_data: "s:root" }]]);
  }
  const section = SECTIONS.find(s => s.id === sectionId);
  if (!section) return void await viewRoot();
  const menu = sectionMenu(section);
  await render(note ? `${menu.text}\n\n${note}` : menu.text, menu.keyboard);
}

const hostOf = url => { try { return new URL(url).host; } catch { return "?"; } };

async function statusText() {
  const stats = adminContext.monitor?.stats ?? {};
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
    `Monitor: tx=${stats.transactions ?? 0} entries=${stats.entries ?? 0} lag=${stats.lastLagMs != null ? `${(stats.lastLagMs / 1000).toFixed(1)}s` : "n/a"} errors=${stats.errors ?? 0}`,
    `Signals active: ${adminContext.activeSignals?.() ?? 0}`,
  ];
  try {
    const { getMyPositions } = await import("../tools/dlmm.js");
    const positions = await getMyPositions({ force: true, silent: true });
    lines.push(`Positions: ${positions.total_positions}${positions.positions.length ? ` (${positions.positions.map(p => `${p.pair ?? "?"} ${p.pnl_pct ?? "?"}%`).join(", ")})` : ""}`);
  } catch { lines.push("Positions: unavailable"); }
  return lines.join("\n");
}

function parseSecretKey(raw) {
  const text = String(raw).trim();
  if (text.startsWith("[")) {
    const bytes = JSON.parse(text);
    if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error("bad array");
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }
  const bytes = bs58.decode(text);
  if (bytes.length !== 64) throw new Error("bad length");
  return Keypair.fromSecretKey(bytes);
}

function requestRestart() {
  void (async () => {
    await sendMessage("♻️ Restarting — back in a few seconds…").catch(() => {});
    await new Promise(r => setTimeout(r, 1200));
    process.exit(1); // systemd Restart=on-failure brings the bot back
  })();
}

// ─── Callbacks ───────────────────────────────────────────────────────────────

let pending = null; // { kind, setting?|address? }

async function handleCallback(cb) {
  const data = cb.data || "";
  // Whatever message the user taps becomes the console.
  if (cb.message?.message_id) consoleMessageId = cb.message.message_id;
  await answerCallbackQuery(cb.id).catch(() => {});
  try {
    if (data === "x:cancel") { pending = null; return void await viewRoot(); }
    if (data === "s:root") { pending = null; return void await viewRoot(); }
    if (data.startsWith("s:")) { pending = null; return void await viewSection(data.slice(2)); }
    if (data.startsWith("t:")) {
      const setting = byKey.get(data.slice(2));
      if (!setting) return;
      const needs = applySetting(setting, !currentValue(setting));
      return void await viewSection(SECTIONS.find(s => s.settings.includes(setting))?.id, `✅ Saved${needs ? " — ♻️ restart to apply" : ""}`);
    }
    if (data.startsWith("e:")) {
      const setting = byKey.get(data.slice(2));
      if (!setting) return;
      pending = { kind: "set", setting };
      return void await render(`✏️ <b>${setting.label ?? setting.k}</b>\nCurrent: <code>${fmtValue(setting)}</code>\n\n${editHint(setting)}`, cancelKB());
    }
    if (data === "w:add") {
      pending = { kind: "waddr" };
      return void await render("👛 Send the wallet <b>address</b>:", cancelKB());
    }
    if (data.startsWith("w:rm2:")) {
      const { wallets } = listSmartWallets();
      const w = wallets[Number(data.slice(6))];
      if (!w) return void await viewSection("wallets", "⚠️ Wallet not found.");
      const res = removeSmartWallet({ address: w.address });
      return void await viewSection("wallets", res.success ? `🗑 Removed ${w.name}` : `⚠️ ${res.error}`);
    }
    if (data.startsWith("w:rm:")) {
      const { wallets } = listSmartWallets();
      const w = wallets[Number(data.slice(5))];
      if (!w) return void await viewSection("wallets", "⚠️ Wallet not found.");
      return void await render(`Remove <b>${w.name}</b>\n<code>${w.address}</code>?`, [
        [{ text: "🗑 Confirm remove", callback_data: `w:rm2:${data.slice(5)}` }, { text: "✖️ Cancel", callback_data: "s:wallets" }],
      ]);
    }
    if (data === "k:imp") {
      pending = { kind: "pkimport" };
      return void await render("🔑 Send the private key — base58 secret <b>or</b> JSON byte array.\n\n⚠️ The message will stay in this chat until you delete it.", cancelKB());
    }
    if (data === "k:exp") {
      return void await render("⚠️ <b>Export sends the private key into this chat.</b>\nTelegram history is kept server-side. Anyone with access to this account gets the key.\n\nExport anyway?", [
        [{ text: "👁 Show key", callback_data: "k:exp2" }, { text: "✖️ Cancel", callback_data: "s:key" }],
      ]);
    }
    if (data === "k:exp2") {
      const raw = process.env.WALLET_PRIVATE_KEY;
      if (!raw) { await sendMessage("No WALLET_PRIVATE_KEY configured."); return void await viewSection("key"); }
      let kp;
      try { kp = parseSecretKey(raw); } catch { await sendMessage("⚠️ Stored key is unreadable."); return void await viewSection("key"); }
      // The key itself goes out as its own message so it is easy to find and delete.
      await sendMessage(`🔑 <code>${bs58.encode(kp.secretKey)}</code>\n\n⚠️ Delete this message from the chat history now.`);
      return void await viewSection("key", "Key shown above — delete that message now.");
    }
    if (data === "k:addr") {
      pending = { kind: "walletaddr" };
      return void await render("📍 Send the read-only wallet <b>address</b> (public key):", cancelKB());
    }
    if (data === "m:shadow") {
      const next = !config.standalone.shadow;
      return void await render(`Set mode to <b>${next ? "SHADOW (nothing submitted)" : "LIVE"}</b>?`, [
        [{ text: next ? "🌑 Shadow" : "🔴 LIVE", callback_data: "m:shadow2" }, { text: "✖️ Cancel", callback_data: "s:root" }],
      ]);
    }
    if (data === "m:shadow2") {
      const next = !config.standalone.shadow;
      writeUserConfig({ shadowMode: next });
      config.standalone.shadow = next;
      if (next) process.env.DRY_RUN = "true";
      else if (envValue("DRY_RUN") !== "true") delete process.env.DRY_RUN;
      return void await viewRoot();
    }
    if (data === "m:restart") {
      return void await render("♻️ Restart the bot? (takes ~5s)", [
        [{ text: "♻️ Confirm restart", callback_data: "m:restart2" }, { text: "✖️ Cancel", callback_data: "s:root" }],
      ]);
    }
    if (data === "m:restart2") return void requestRestart();
  } catch (e) {
    log("telegram_error", `admin callback failed: ${e.message}`);
    await viewRoot(`⚠️ ${e.message}`).catch(() => {});
  }
}

// ─── Text input ──────────────────────────────────────────────────────────────

async function handleText(text) {
  if (pending) {
    const p = pending;
    pending = null;
    try {
      if (p.kind === "set") {
        const value = validate(p.setting, text);
        const needs = applySetting(p.setting, value);
        const sectionId = SECTIONS.find(s => s.settings.includes(p.setting))?.id;
        return void await viewSection(sectionId, `✅ <b>${p.setting.label ?? p.setting.k}</b> → <code>${fmtValue(p.setting)}</code>${needs ? "\n♻️ Applies after restart" : ""}`);
      }
      if (p.kind === "waddr") {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text.trim())) {
          pending = { kind: "waddr" };
          return void await render("⚠️ Not a valid Solana address — send it again, or tap Cancel:", cancelKB());
        }
        pending = { kind: "wname", address: text.trim() };
        return void await render("Name this wallet:", cancelKB());
      }
      if (p.kind === "wname") {
        const name = text.trim().slice(0, 40) || "wallet";
        const res = addSmartWallet({ address: p.address, name });
        return void await viewSection("wallets", res.success ? `✅ Added <b>${name}</b>\n<code>${p.address}</code>` : `⚠️ ${res.error}`);
      }
      if (p.kind === "pkimport") {
        const kp = parseSecretKey(text);
        writeEnvValue("WALLET_PRIVATE_KEY", bs58.encode(kp.secretKey));
        process.env.WALLET_PRIVATE_KEY = bs58.encode(kp.secretKey); // live immediately; .env survives restarts
        return void await viewSection("key", `✅ Key imported — wallet <code>${kp.publicKey.toString()}</code>\nSigning is active now (survives restarts).`);
      }
      if (p.kind === "walletaddr") {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text.trim())) return void await render("⚠️ Not a valid address — send again, or tap Cancel:", cancelKB());
        writeUserConfig({ walletAddress: text.trim() });
        config.standalone.walletAddress = text.trim();
        return void await viewSection("key", `✅ Read-only address set: <code>${text.trim()}</code>`);
      }
    } catch (e) {
      return void await render(`⚠️ ${e.message} — try again or tap Cancel`, cancelKB());
    }
  }

  const [cmd, ...args] = text.trim().split(/\s+/);
  if (cmd === "/cancel") { pending = null; return void await viewRoot("Cancelled."); }
  if (cmd === "/start" || cmd === "/help" || cmd === "/menu") {
    // An explicit /menu must be visible: reuse the console only when it is fresh.
    if (consoleMessageId != null && Date.now() - lastRenderAt > STALE_CONSOLE_MS) {
      consoleMessageId = null;
      lastRenderSig = null;
    }
    return void await viewRoot("Commands: /addwallet <address> <name> · /removewallet <address> · /wallets · /status · /cancel");
  }
  if (cmd === "/status") return void await viewSection("status");
  if (cmd === "/wallets") return void await viewSection("wallets");
  if (cmd === "/addwallet") {
    const address = args[0];
    const name = args.slice(1).join(" ").slice(0, 40) || "wallet";
    const res = addSmartWallet({ address: address ?? "", name });
    return void await viewSection("wallets", res.success ? `✅ Added <b>${name}</b> <code>${address}</code>` : `⚠️ ${res.error}`);
  }
  if (cmd === "/removewallet") {
    const res = removeSmartWallet({ address: args[0] ?? "" });
    return void await viewSection("wallets", res.success ? `🗑 Removed ${res.removed}` : `⚠️ ${res.error}`);
  }
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

const adminContext = { monitor: null, activeSignals: null };

// Exposed for the menu-schema tests in test/cleanup.test.js.
export const _test = { SECTIONS, byKey, editHint, validate, sectionMenu, fmtValue };

export function startAdmin({ monitor = null, activeSignals = null } = {}) {
  adminContext.monitor = monitor;
  adminContext.activeSignals = activeSignals;
  const stop = startAdminPolling(async ({ message, callback }) => {
    if (callback) await handleCallback(callback);
    else if (message) await handleText(message.text);
  });
  void setBotCommands(ADMIN_COMMANDS); // register in Telegram clients on every boot
  return stop;
}
