/**
 * Interactive setup wizard.
 * Guides user through .env + user-config.json creation.
 * Run: npm run setup
 */

import "./envcrypt.js";
import readline from "readline";
import fs from "fs";
import { repoPath } from "./repo-root.js";
import { getScreeningDefaultsForTimeframe, normalizeTimeframe } from "./screening-scales.js";

const CONFIG_PATH = repoPath("user-config.json");
const ENV_PATH    = repoPath(".env");

const DEFAULT_MODEL = "openai/gpt-oss-20b:free";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question, defaultVal) {
  return new Promise((resolve) => {
    const hint = defaultVal !== undefined && defaultVal !== "" ? ` (default: ${defaultVal})` : "";
    rl.question(`${question}${hint}: `, (ans) => {
      const trimmed = ans.trim();
      resolve(trimmed === "" ? defaultVal : trimmed);
    });
  });
}

function askNum(question, defaultVal, { min, max } = {}) {
  return new Promise(async (resolve) => {
    while (true) {
      const raw = await ask(question, defaultVal);
      const n = parseFloat(raw);
      if (isNaN(n))                        { console.log(`  ⚠ Please enter a number.`); continue; }
      if (min !== undefined && n < min)    { console.log(`  ⚠ Minimum is ${min}.`);     continue; }
      if (max !== undefined && n > max)    { console.log(`  ⚠ Maximum is ${max}.`);     continue; }
      resolve(n);
      break;
    }
  });
}

function askBool(question, defaultVal) {
  return new Promise(async (resolve) => {
    while (true) {
      const hint = defaultVal ? "Y/n" : "y/N";
      const raw = await ask(`${question} [${hint}]`, "");
      if (raw === "") { resolve(defaultVal); break; }
      if (/^y(es)?$/i.test(raw)) { resolve(true);  break; }
      if (/^n(o)?$/i.test(raw))  { resolve(false); break; }
      console.log("  ⚠ Enter y or n.");
    }
  });
}

function askChoice(question, choices, { defaultKey } = {}) {
  return new Promise(async (resolve) => {
    const labels = choices.map((c, i) => `  ${i + 1}. ${c.label}`).join("\n");
    const defaultIdx = defaultKey ? choices.findIndex((c) => c.key === defaultKey) : -1;
    const defaultNum = defaultIdx >= 0 ? String(defaultIdx + 1) : "";
    while (true) {
      console.log(`\n${question}`);
      console.log(labels);
      const raw = await ask("Enter number", defaultNum);
      const idx = parseInt(raw) - 1;
      if (idx >= 0 && idx < choices.length) { resolve(choices[idx]); break; }
      console.log("  ⚠ Invalid choice.");
    }
  });
}

function parseEnv(content) {
  const map = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return map;
}

function buildEnv(map) {
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

// ─── Presets ──────────────────────────────────────────────────────────────────
const PRESETS = {
  degen: {
    label:                 "Degen",
    strategy:              "bid_ask",
    timeframe:             "30m",
    minBinsBelow:          35,
    maxBinsBelow:          100,
    defaultBinsBelow:      100,
    minOrganic:            60,
    minQuoteOrganic:       60,
    minHolders:            1_000,
    minMcap:               150_000,
    maxMcap:               5_000_000,
    minTvl:                5_000,
    maxTvl:                100_000,
    minVolume:             1_000,
    minBinStep:            80,
    maxBinStep:            125,
    minFeeActiveTvlRatio:  0.15,
    minTokenFeesSol:       20,
    takeProfitPct:         10,
    stopLossPct:           -25,
    outOfRangeWaitMinutes: 15,
    trailingTakeProfit:    true,
    trailingTriggerPct:    2,
    trailingDropPct:       1,
    positionSizePct:       0.5,
    gasReserve:            0.15,
    maxDeployAmount:       50,
    minFeePerTvl24h:       20,
    minAgeBeforeYieldCheck: 30,
    minClaimAmount:        3,
    oorCooldownTriggerCount: 3,
    oorCooldownHours:      8,
    managementIntervalMin: 5,
    screeningIntervalMin:  15,
    description: "30m timeframe, pumping tokens allowed, fast cycles. High risk/reward.",
  },
  moderate: {
    label:                 "Moderate",
    strategy:              "bid_ask",
    timeframe:             "4h",
    minBinsBelow:          35,
    maxBinsBelow:          69,
    defaultBinsBelow:      69,
    minOrganic:            70,
    minQuoteOrganic:       70,
    minHolders:            2_000,
    minMcap:               150_000,
    maxMcap:               10_000_000,
    minTvl:                10_000,
    maxTvl:                150_000,
    minVolume:             2_000,
    minBinStep:            80,
    maxBinStep:            125,
    minFeeActiveTvlRatio:  0.4,
    minTokenFeesSol:       30,
    takeProfitPct:         5,
    stopLossPct:           -15,
    outOfRangeWaitMinutes: 30,
    trailingTakeProfit:    true,
    trailingTriggerPct:    3,
    trailingDropPct:       1.5,
    positionSizePct:       0.35,
    gasReserve:            0.2,
    maxDeployAmount:       50,
    minFeePerTvl24h:       25,
    minAgeBeforeYieldCheck: 60,
    minClaimAmount:        5,
    oorCooldownTriggerCount: 3,
    oorCooldownHours:      12,
    managementIntervalMin: 10,
    screeningIntervalMin:  30,
    description: "4h timeframe, balanced risk/reward. Recommended for most users.",
  },
  safe: {
    label:                 "Safe",
    strategy:              "spot",
    timeframe:             "24h",
    minBinsBelow:          35,
    maxBinsBelow:          50,
    defaultBinsBelow:      50,
    minOrganic:            75,
    minQuoteOrganic:       75,
    minHolders:            5_000,
    minMcap:               500_000,
    maxMcap:               10_000_000,
    minTvl:                20_000,
    maxTvl:                200_000,
    minVolume:             10_000,
    minBinStep:            80,
    maxBinStep:            125,
    minFeeActiveTvlRatio:  2.0,
    minTokenFeesSol:       50,
    takeProfitPct:         3,
    stopLossPct:           -10,
    outOfRangeWaitMinutes: 60,
    trailingTakeProfit:    true,
    trailingTriggerPct:    5,
    trailingDropPct:       2,
    positionSizePct:       0.25,
    gasReserve:            0.25,
    maxDeployAmount:       30,
    minFeePerTvl24h:       30,
    minAgeBeforeYieldCheck: 90,
    minClaimAmount:        5,
    oorCooldownTriggerCount: 3,
    oorCooldownHours:      12,
    managementIntervalMin: 15,
    screeningIntervalMin:  60,
    description: "24h timeframe, stable pools only, avoids pumps. Lower yield, lower risk.",
  },
};

// ─── Load existing state ───────────────────────────────────────────────────────
const existingConfig = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
  : {};
const existingEnv = fs.existsSync(ENV_PATH)
  ? parseEnv(fs.readFileSync(ENV_PATH, "utf8"))
  : {};

const e  = (key, fallback) => existingConfig[key] ?? fallback;
const ev = (key, fallback) => existingEnv[key] ?? fallback;

// ─── Banner ────────────────────────────────────────────────────────────────────
console.log(`
╔═══════════════════════════════════════════════╗
║        Meridian — Setup Wizard                ║
║        Autonomous Meteora DLMM LP Agent       ║
╚═══════════════════════════════════════════════╝

This wizard creates your .env and user-config.json.
Press Enter to keep the current/default value.
`);

// ─── Section 1: API Keys & Wallet ─────────────────────────────────────────────
console.log("── API Keys & Wallet ─────────────────────────────────────────");

const alreadySet = (val) => val ? "*** (already set — Enter to keep)" : "";

const openrouterKey = await ask(
  "OpenRouter API key (sk-or-...)",
  alreadySet(ev("OPENROUTER_API_KEY", ""))
);

const walletKey = await ask(
  "Wallet private key (base58)",
  alreadySet(ev("WALLET_PRIVATE_KEY", existingConfig.walletKey || ""))
);

const rpcUrl = await ask(
  "RPC URL",
  ev("RPC_URL", e("rpcUrl", "https://api.mainnet-beta.solana.com"))
);

const heliusKey = await ask(
  "Helius API key (for balance lookups, optional)",
  alreadySet(ev("HELIUS_API_KEY", ""))
);

// ─── Section 2: Telegram ──────────────────────────────────────────────────────
console.log("\n── Telegram (optional — skip to disable) ─────────────────────");

const telegramToken = await ask(
  "Telegram bot token",
  alreadySet(ev("TELEGRAM_BOT_TOKEN", ""))
);

const telegramChatId = await ask(
  "Telegram chat ID",
  ev("TELEGRAM_CHAT_ID", e("telegramChatId", ""))
);

// ─── Section 3: Preset ────────────────────────────────────────────────────────
const presetChoice = await askChoice("Select a risk preset:", [
  { label: `🔥 Degen    — ${PRESETS.degen.description}`,    key: "degen"    },
  { label: `⚖️  Moderate — ${PRESETS.moderate.description}`, key: "moderate" },
  { label: `🛡️  Safe     — ${PRESETS.safe.description}`,     key: "safe"     },
  { label: "⚙️  Custom   — Configure every setting manually", key: "custom"  },
]);

const preset = presetChoice.key === "custom" ? null : PRESETS[presetChoice.key];
const p = (key, fallback) => preset?.[key] ?? e(key, fallback);

console.log(preset
  ? `\n✓ ${preset.label} preset selected. Override individual values below (Enter to keep).\n`
  : `\nCustom mode — configure all settings.\n`
);

// ─── Section 4: Deployment ────────────────────────────────────────────────────
console.log("── Deployment ────────────────────────────────────────────────");

const deployAmountSol = await askNum(
  "SOL to deploy per position",
  e("deployAmountSol", 0.3),
  { min: 0.01, max: 50 }
);

const maxPositions = await askNum(
  "Max concurrent positions",
  e("maxPositions", 3),
  { min: 1, max: 10 }
);

const minSolToOpen = await askNum(
  "Min SOL balance to open a new position",
  e("minSolToOpen", parseFloat((deployAmountSol + 0.05).toFixed(3))),
  { min: 0.05 }
);

const dryRun = await askBool(
  "Dry run mode? (no real transactions)",
  e("dryRun", true)
);

const minBinsBelow = await askNum(
  "Minimum bins below active bin",
  p("minBinsBelow", e("minBinsBelow", 35)),
  { min: 35, max: 1400 }
);

const maxBinsBelow = await askNum(
  "Maximum bins below active bin",
  p("maxBinsBelow", e("maxBinsBelow", e("binsBelow", 69))),
  { min: minBinsBelow, max: 1400 }
);

const defaultBinsBelow = await askNum(
  "Default bins below active bin (fallback when bins_below omitted)",
  p("defaultBinsBelow", e("defaultBinsBelow", e("binsBelow", maxBinsBelow))),
  { min: minBinsBelow, max: maxBinsBelow }
);

// ─── Section 4b: Strategy ─────────────────────────────────────────────────────
console.log("\n── Strategy ──────────────────────────────────────────────────");

const strategyChoice = await askChoice("LP strategy:", [
  { label: "bid_ask  — Concentrated at edges, best for volatile tokens", key: "bid_ask" },
  { label: "spot     — Even distribution across range",                  key: "spot" },
  { label: "curve    — Gaussian-like bell curve distribution",           key: "curve" },
], { defaultKey: p("strategy", e("strategy", "bid_ask")) });
const strategy = strategyChoice.key;

// ─── Section 4c: Position Sizing ──────────────────────────────────────────────
console.log("\n── Position Sizing ───────────────────────────────────────────");

const positionSizePct = await askNum(
  "Position size as % of wallet (0.1–1.0)",
  p("positionSizePct", 0.35),
  { min: 0.05, max: 1.0 }
);

const gasReserve = await askNum(
  "Gas reserve SOL (kept aside for tx fees)",
  p("gasReserve", 0.2),
  { min: 0.05, max: 2 }
);

const maxDeployAmount = await askNum(
  "Max deploy amount SOL (ceiling)",
  p("maxDeployAmount", 50),
  { min: 0.1 }
);

// ─── Section 5: Risk & Filters ────────────────────────────────────────────────
console.log("\n── Risk & Filters ────────────────────────────────────────────");

const timeframe = normalizeTimeframe(await ask(
  "Pool discovery timeframe (5m / 15m / 30m / 1h / 2h / 4h / 12h / 24h)",
  p("timeframe", "4h")
));

const tfScaled = getScreeningDefaultsForTimeframe(timeframe);
const usePresetScreening = preset && timeframe === preset.timeframe;

const category = await ask(
  "Pool discovery category (trending / new / bluechip)",
  p("category", e("category", "trending"))
);

const minOrganic = await askNum(
  "Min organic score (0–100)",
  p("minOrganic", 65),
  { min: 0, max: 100 }
);

const minQuoteOrganic = await askNum(
  "Min quote-token organic score (0–100)",
  usePresetScreening ? p("minQuoteOrganic", minOrganic) : p("minQuoteOrganic", minOrganic),
  { min: 0, max: 100 }
);

const minHolders = await askNum(
  "Min token holders",
  p("minHolders", 500),
  { min: 1 }
);

const minMcap = await askNum(
  "Min token market cap USD",
  p("minMcap", 150_000),
  { min: 0 }
);

const maxMcap = await askNum(
  "Max token market cap USD",
  p("maxMcap", 10_000_000),
  { min: minMcap }
);

const minTvl = await askNum(
  "Min pool TVL USD",
  p("minTvl", 10_000),
  { min: 0 }
);

const maxTvl = await askNum(
  "Max pool TVL USD (0 = no limit)",
  p("maxTvl", 150_000),
  { min: 0 }
);

const minVolume = await askNum(
  "Min pool volume USD",
  usePresetScreening ? p("minVolume", tfScaled.minVolume) : tfScaled.minVolume,
  { min: 0 }
);

const minBinStep = await askNum(
  "Min bin step",
  p("minBinStep", 80),
  { min: 1, max: 500 }
);

const maxBinStep = await askNum(
  "Max bin step",
  p("maxBinStep", 125),
  { min: minBinStep, max: 500 }
);

const minFeeActiveTvlRatio = await askNum(
  "Min fee/active-TVL ratio %",
  usePresetScreening ? p("minFeeActiveTvlRatio", tfScaled.minFeeActiveTvlRatio) : tfScaled.minFeeActiveTvlRatio,
  { min: 0 }
);

const minTokenFeesSol = await askNum(
  "Min token global fees SOL (anti-bundled filter)",
  p("minTokenFeesSol", 30),
  { min: 0 }
);

// ─── Section 6: Exit Rules ────────────────────────────────────────────────────
console.log("\n── Exit Rules ────────────────────────────────────────────────");

const takeProfitPct = await askNum(
  "Take profit when fees earned >= X% of deployed capital",
  p("takeProfitPct", 5),
  { min: 0.1, max: 100 }
);

const stopLossPct = await askNum(
  "Stop loss at X% price drop (e.g. -15)",
  p("stopLossPct", -15),
  { min: -99, max: -1 }
);

const outOfRangeWaitMinutes = await askNum(
  "Minutes out-of-range before closing",
  p("outOfRangeWaitMinutes", 30),
  { min: 1 }
);

const repeatDeployCooldownEnabled = await askBool(
  "Cooldown token/pool after repeated fee-generating deploys?",
  p("repeatDeployCooldownEnabled", true)
);

const repeatDeployCooldownTriggerCount = await askNum(
  "Repeat deploy cooldown trigger count",
  p("repeatDeployCooldownTriggerCount", 3),
  { min: 1 }
);

const repeatDeployCooldownHours = await askNum(
  "Repeat deploy cooldown hours",
  p("repeatDeployCooldownHours", 12),
  { min: 0 }
);

const repeatDeployCooldownScope = await ask(
  "Repeat deploy cooldown scope (pool/token/both)",
  p("repeatDeployCooldownScope", "token")
);

const repeatDeployCooldownMinFeeEarnedPct = await askNum(
  "Repeat deploy min fee earned %",
  p("repeatDeployCooldownMinFeeEarnedPct", 0),
  { min: 0 }
);

// ─── Section 6b: Trailing Take Profit ────────────────────────────────────────
console.log("\n── Trailing Take Profit ──────────────────────────────────────");

const trailingTakeProfit = await askBool(
  "Enable trailing take profit?",
  p("trailingTakeProfit", true)
);

const trailingTriggerPct = await askNum(
  "Trailing TP trigger % (activate trailing at this PnL)",
  p("trailingTriggerPct", 3),
  { min: 0.1 }
);

const trailingDropPct = await askNum(
  "Trailing TP drop % (close when drops this much from peak)",
  p("trailingDropPct", 1.5),
  { min: 0.1 }
);

// ─── Section 6c: Management Advanced ─────────────────────────────────────────
console.log("\n── Management Advanced ───────────────────────────────────────");

const minFeePerTvl24h = await askNum(
  "Min fee/TVL 24h % (low yield close threshold)",
  p("minFeePerTvl24h", 7),
  { min: 0 }
);

const minAgeBeforeYieldCheck = await askNum(
  "Min age (minutes) before low yield can trigger close",
  p("minAgeBeforeYieldCheck", 60),
  { min: 1 }
);

const minClaimAmount = await askNum(
  "Min unclaimed fees USD before claiming",
  p("minClaimAmount", 5),
  { min: 0 }
);

const oorCooldownTriggerCount = await askNum(
  "OOR cooldown trigger count (consecutive OOR closes)",
  p("oorCooldownTriggerCount", 3),
  { min: 1 }
);

const oorCooldownHours = await askNum(
  "OOR cooldown hours",
  p("oorCooldownHours", 12),
  { min: 0 }
);

// ─── Section 7: Scheduling ────────────────────────────────────────────────────
console.log("\n── Scheduling ────────────────────────────────────────────────");

const managementIntervalMin = await askNum(
  "Management cycle interval (minutes)",
  p("managementIntervalMin", 10),
  { min: 1 }
);

const screeningIntervalMin = await askNum(
  "Screening cycle interval (minutes)",
  p("screeningIntervalMin", 30),
  { min: 5 }
);

// ─── Section 8: LLM Provider ─────────────────────────────────────────────────
console.log("\n── LLM Provider ──────────────────────────────────────────────");

const LLM_PROVIDERS = [
  {
    label:   "OpenRouter   (openrouter.ai — many models)",
    key:     "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyHint: "sk-or-...",
    modelDefault: "nousresearch/hermes-3-llama-3.1-405b",
  },
  {
    label:   "MiniMax      (api.minimax.io)",
    key:     "minimax",
    baseUrl: "https://api.minimax.io/v1",
    keyHint: "your MiniMax API key",
    modelDefault: "MiniMax-Text-01",
  },
  {
    label:   "OpenAI       (api.openai.com)",
    key:     "openai",
    baseUrl: "https://api.openai.com/v1",
    keyHint: "sk-...",
    modelDefault: "gpt-4o",
  },
  {
    label:   "Novita       (api.novita.ai — open-source models)",
    key:     "novita",
    baseUrl: "https://api.novita.ai/openai/v1",
    keyHint: "your Novita API key",
    modelDefault: "moonshotai/kimi-k3",
  },
  {
    label:   "Local / LM Studio / Ollama (OpenAI-compatible)",
    key:     "local",
    baseUrl: "http://localhost:1234/v1",
    keyHint: "(leave blank or type any value)",
    modelDefault: "local-model",
  },
  {
    label:   "Custom       (any OpenAI-compatible endpoint)",
    key:     "custom",
    baseUrl: "",
    keyHint: "your API key",
    modelDefault: "",
  },
];

const providerChoice = await askChoice("Select LLM provider:", LLM_PROVIDERS.map((p) => ({ label: p.label, key: p.key })));
const provider = LLM_PROVIDERS.find((p) => p.key === providerChoice.key);

let llmBaseUrl = provider.baseUrl;
if (provider.key === "local" || provider.key === "custom") {
  llmBaseUrl = await ask("Base URL", e("llmBaseUrl", provider.baseUrl || "http://localhost:1234/v1"));
}

const llmApiKeyExisting = e("llmApiKey", existingEnv.LLM_API_KEY || existingEnv.OPENROUTER_API_KEY || "");
const llmApiKeyRaw = await ask("API Key", llmApiKeyExisting ? "*** (already set)" : (provider.keyHint || ""));
const llmApiKey   = llmApiKeyRaw.startsWith("***") ? llmApiKeyExisting : llmApiKeyRaw;

const llmModel = await ask(
  "Default model name",
  e("llmModel", process.env.LLM_MODEL || provider.modelDefault)
);

// ─── Section 8b: Per-Role Models ─────────────────────────────────────────────
console.log("\n── Per-Role Models (Enter to use default) ────────────────────");

const managementModel = await ask(
  "Management cycle model",
  e("managementModel", llmModel)
);

const screeningModel = await ask(
  "Screening cycle model",
  e("screeningModel", llmModel)
);

const generalModel = await ask(
  "General/chat model",
  e("generalModel", llmModel)
);

// ─── Section 9: SOL Mode ─────────────────────────────────────────────────────
console.log("\n── Display Mode ──────────────────────────────────────────────");

const solMode = await askBool(
  "SOL mode? (report PnL/balances in SOL instead of USD)",
  e("solMode", false)
);

rl.close();

// ─── Write .env ───────────────────────────────────────────────────────────────
const isKept = (val) => !val || val.startsWith("***");

const envMap = {
  ...existingEnv,
  ...(isKept(openrouterKey) ? {} : { OPENROUTER_API_KEY: openrouterKey }),
  ...(isKept(walletKey)     ? {} : { WALLET_PRIVATE_KEY: walletKey }),
  ...(rpcUrl                ? { RPC_URL: rpcUrl } : {}),
  ...(isKept(heliusKey)     ? {} : { HELIUS_API_KEY: heliusKey }),
  ...(isKept(telegramToken) ? {} : { TELEGRAM_BOT_TOKEN: telegramToken }),
  ...(telegramChatId        ? { TELEGRAM_CHAT_ID: telegramChatId } : {}),
  DRY_RUN: dryRun ? "true" : "false",
};
fs.writeFileSync(ENV_PATH, buildEnv(envMap));

// ─── Write user-config.json ────────────────────────────────────────────────────
const userConfig = {
  ...existingConfig,
  preset: presetChoice.key,
  rpcUrl,
  // Deployment
  deployAmountSol,
  maxPositions,
  minSolToOpen,
  minBinsBelow,
  maxBinsBelow,
  defaultBinsBelow,
  strategy,
  // Position sizing
  positionSizePct,
  gasReserve,
  maxDeployAmount,
  // Screening filters
  timeframe,
  category,
  minOrganic,
  minQuoteOrganic,
  minHolders,
  minMcap,
  maxMcap,
  minTvl,
  maxTvl,
  minVolume,
  minBinStep,
  maxBinStep,
  minFeeActiveTvlRatio,
  minTokenFeesSol,
  // Exit rules
  takeProfitPct,
  stopLossPct,
  outOfRangeWaitMinutes,
  repeatDeployCooldownEnabled,
  repeatDeployCooldownTriggerCount,
  repeatDeployCooldownHours,
  repeatDeployCooldownScope,
  repeatDeployCooldownMinFeeEarnedPct,
  // Trailing TP
  trailingTakeProfit,
  trailingTriggerPct,
  trailingDropPct,
  // Management advanced
  minFeePerTvl24h,
  minAgeBeforeYieldCheck,
  minClaimAmount,
  oorCooldownTriggerCount,
  oorCooldownHours,
  // Scheduling
  managementIntervalMin,
  screeningIntervalMin,
  // LLM
  llmProvider: provider.key,
  llmBaseUrl,
  llmModel,
  managementModel,
  screeningModel,
  generalModel,
  ...(llmApiKey ? { llmApiKey } : {}),
  // Telegram — keep .env and user-config in sync
  telegramChatId: telegramChatId || process.env.TELEGRAM_CHAT_ID || existingConfig.telegramChatId || "",
  // Modes
  dryRun,
  solMode,
};

// Remove legacy keys if present
delete userConfig.emergencyPriceDropPct;
delete userConfig.takeProfitFeePct;
delete userConfig.maxBundlePct;
delete userConfig.athFilterPct;

fs.writeFileSync(CONFIG_PATH, JSON.stringify(userConfig, null, 2));

// ─── Summary ──────────────────────────────────────────────────────────────────
const presetName = preset ? `${preset.label}` : "Custom";

console.log(`
╔═══════════════════════════════════════════════╗
║           Setup Complete                      ║
╚═══════════════════════════════════════════════╝

  Preset:       ${presetName}
  Dry run:      ${dryRun ? "YES — no real transactions" : "NO — live trading"}
  SOL mode:     ${solMode ? "YES" : "NO"}

  Strategy:     ${strategy}
  Deploy:       ${deployAmountSol} SOL/position  ·  max ${maxPositions} positions  ·  size ${(positionSizePct * 100).toFixed(0)}%
  Gas reserve:  ${gasReserve} SOL  ·  max deploy ${maxDeployAmount} SOL
  Min balance:  ${minSolToOpen} SOL to open new position
  Bins below:   ${minBinsBelow}–${maxBinsBelow} (default ${defaultBinsBelow})

  Timeframe:    ${timeframe}  ·  category ${category}
  Screening:    organic ≥ ${minOrganic}  ·  holders ≥ ${minHolders}  ·  fees ≥ ${minTokenFeesSol} SOL
  Market cap:   $${minMcap.toLocaleString()} – $${maxMcap.toLocaleString()}
  TVL:          $${minTvl.toLocaleString()} – $${maxTvl.toLocaleString()}  ·  vol ≥ $${minVolume}
  Bin step:     ${minBinStep}–${maxBinStep}  ·  fee/TVL ≥ ${minFeeActiveTvlRatio}%

  Take profit:  ${takeProfitPct}%  ·  stop loss ${stopLossPct}%
  Trailing TP:  ${trailingTakeProfit ? `trigger ${trailingTriggerPct}%, drop ${trailingDropPct}%` : "disabled"}
  OOR close:    after ${outOfRangeWaitMinutes} min  ·  cooldown ${oorCooldownTriggerCount}x → ${oorCooldownHours}h
  Low yield:    fee/TVL < ${minFeePerTvl24h}% after ${minAgeBeforeYieldCheck} min
  Claim min:    $${minClaimAmount}
  Repeat CD:    ${repeatDeployCooldownEnabled ? `${repeatDeployCooldownTriggerCount}x / ${repeatDeployCooldownHours}h / ${repeatDeployCooldownScope}` : "disabled"}

  Cycles:       management every ${managementIntervalMin}m  ·  screening every ${screeningIntervalMin}m

  Provider:     ${provider.label.split("(")[0].trim()}
  Default:      ${llmModel}
  Screening:    ${screeningModel}
  Management:   ${managementModel}
  General:      ${generalModel}
  Base URL:     ${llmBaseUrl}

  Telegram:     ${telegramToken ? "enabled" : "disabled"}
  .env:         ${ENV_PATH}
  Config:       ${CONFIG_PATH}

Run "npm start" to launch the agent.
${dryRun ? '\n  ⚠ DRY RUN is ON — set dryRun: false in user-config.json when ready for live trading.\n' : ""}
`);
