/**
 * Interactive setup wizard.
 * Runs before the agent starts. Saves settings to user-config.json.
 * Run: npm run setup
 */

import "dotenv/config";
import readline from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "user-config.json");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question, defaultVal) {
  return new Promise((resolve) => {
    const hint = defaultVal !== undefined ? ` (default: ${defaultVal})` : "";
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

function askChoice(question, choices) {
  return new Promise(async (resolve) => {
    const labels = choices.map((c, i) => `  ${i + 1}. ${c.label}`).join("\n");
    while (true) {
      console.log(`\n${question}`);
      console.log(labels);
      const raw = await ask("Enter number", "");
      const idx = parseInt(raw) - 1;
      if (idx >= 0 && idx < choices.length) { resolve(choices[idx]); break; }
      console.log("  ⚠ Invalid choice.");
    }
  });
}

// ─── Presets ──────────────────────────────────────────────────────────────────
const PRESETS = {
  degen: {
    label:                 "🔥 Degen",
    timeframe:             "30m",
    maxVolatility:         12.0,   // pumping meme coins welcome
    maxPriceChangePct:     1000,   // don't filter pumps — high fee/TVL is the gate
    minOrganic:            60,
    minHolders:            200,
    maxMcap:               5_000_000,
    takeProfitFeePct:      10,
    outOfRangeWaitMinutes: 15,
    managementIntervalMin: 5,
    screeningIntervalMin:  15,
    description: "30m timeframe, pumping tokens allowed, fast cycles. High risk/reward.",
  },
  moderate: {
    label:                 "⚖️  Moderate",
    timeframe:             "4h",
    maxVolatility:         8.0,    // allow active meme coins
    maxPriceChangePct:     300,    // allow up to 3x pump if fee/TVL justifies it
    minOrganic:            65,
    minHolders:            500,
    maxMcap:               10_000_000,
    takeProfitFeePct:      5,
    outOfRangeWaitMinutes: 30,
    managementIntervalMin: 10,
    screeningIntervalMin:  30,
    description: "4h timeframe, balanced risk/reward. Recommended for most users.",
  },
  safe: {
    label:                 "🛡️  Safe",
    timeframe:             "24h",
    maxVolatility:         2.5,
    maxPriceChangePct:     80,     // avoid pumped coins
    minOrganic:            75,
    minHolders:            1000,
    maxMcap:               10_000_000,
    takeProfitFeePct:      3,
    outOfRangeWaitMinutes: 60,
    managementIntervalMin: 15,
    screeningIntervalMin:  60,
    description: "24h timeframe, stable pools only, avoids pumps. Lower yield, lower risk.",
  },
};

// Load existing config
const existing = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
  : {};

const e = (key, fallback) => existing[key] ?? fallback;

console.log(`
╔═══════════════════════════════════════════╗
║       DLMM LP Agent — Setup Wizard        ║
╚═══════════════════════════════════════════╝
`);

// ─── Preset selection ─────────────────────────────────────────────────────────
const presetChoice = await askChoice("Select a risk preset:", [
  { label: `Degen    — ${PRESETS.degen.description}`,    key: "degen"    },
  { label: `Moderate — ${PRESETS.moderate.description}`, key: "moderate" },
  { label: `Safe     — ${PRESETS.safe.description}`,     key: "safe"     },
  { label: "Custom   — Configure every setting manually", key: "custom"  },
]);

let preset = presetChoice.key === "custom" ? null : PRESETS[presetChoice.key];

console.log(preset
  ? `\n✓ Using ${preset.label} preset. You can still override individual values below.\n`
  : `\nCustom mode — configure everything manually.\n`
);

const p = (key, fallback) => preset?.[key] ?? e(key, fallback);

// ─── Wallet & RPC ─────────────────────────────────────────────────────────────
console.log("── Wallet & RPC ──────────────────────────────");

const rpcUrl = await ask(
  "RPC URL",
  e("rpcUrl", process.env.RPC_URL || "https://api.mainnet-beta.solana.com")
);

const walletKey = await ask(
  "Wallet private key (base58)",
  e("walletKey", process.env.WALLET_PRIVATE_KEY ? "*** (already set in .env)" : "")
);

// ─── Deployment ───────────────────────────────────────────────────────────────
console.log("\n── Deployment ────────────────────────────────");

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

const maxDeployAmount = await askNum(
  "Max SOL per single position (safety cap)",
  e("maxDeployAmount", 50),
  { min: deployAmountSol }
);

// ─── Risk ─────────────────────────────────────────────────────────────────────
console.log("\n── Risk & Filters ────────────────────────────");

const timeframe = await ask(
  "Pool discovery timeframe (30m / 1h / 4h / 12h / 24h)",
  p("timeframe", "4h")
);

const maxVolatility = await askNum(
  "Max pool volatility",
  p("maxVolatility", 8.0),
  { min: 0.5, max: 20 }
);

const maxPriceChangePct = await askNum(
  "Max price change % allowed (e.g. 300 = allow 3x pumps)",
  p("maxPriceChangePct", 300),
  { min: 10 }
);

const minOrganic = await askNum(
  "Min organic score (0-100)",
  p("minOrganic", 65),
  { min: 0, max: 100 }
);

const minHolders = await askNum(
  "Min token holders",
  p("minHolders", 500),
  { min: 1 }
);

const maxMcap = await askNum(
  "Max token market cap USD",
  p("maxMcap", 10_000_000),
  { min: 100_000 }
);

// ─── Exit ─────────────────────────────────────────────────────────────────────
console.log("\n── Exit Rules ────────────────────────────────");

const takeProfitFeePct = await askNum(
  "Take profit when fees earned >= X% of deployed capital",
  p("takeProfitFeePct", 5),
  { min: 0.1, max: 100 }
);

const outOfRangeWaitMinutes = await askNum(
  "Minutes out-of-range before closing",
  p("outOfRangeWaitMinutes", 30),
  { min: 1 }
);

// ─── Scheduling ───────────────────────────────────────────────────────────────
console.log("\n── Scheduling ────────────────────────────────");

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

// ─── LLM Provider ─────────────────────────────────────────────────────────────
console.log("\n── LLM Provider ──────────────────────────────");

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

const llmApiKeyExisting = e("llmApiKey", process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || "");
const llmApiKeyPrompt   = llmApiKeyExisting ? "*** (already set)" : (provider.keyHint || "");
const llmApiKeyRaw      = await ask("API Key", llmApiKeyExisting ? "*** (already set)" : "");
const llmApiKey         = llmApiKeyRaw.startsWith("***") ? llmApiKeyExisting : llmApiKeyRaw;

const llmModel = await ask(
  "Model name",
  e("llmModel", process.env.LLM_MODEL || provider.modelDefault)
);

console.log("  Fallback model — used when the primary model returns a provider error (502/503/529). Leave blank to keep the built-in default.\n");
const fallbackModelRaw = await ask(
  "Fallback model override (optional)",
  e("fallbackModel", "") || ""
);

const dryRun = await ask(
  "Dry run mode? (true = no real transactions)",
  e("dryRun", "false")
);

rl.close();

// ─── Save ──────────────────────────────────────────────────────────────────────
const userConfig = {
  preset: presetChoice.key,
  rpcUrl,
  ...(walletKey && !walletKey.startsWith("***") ? { walletKey } : {}),
  deployAmountSol,
  maxPositions,
  minSolToOpen,
  maxDeployAmount,
  timeframe,
  maxVolatility,
  maxPriceChangePct,
  minOrganic,
  minHolders,
  maxMcap,
  takeProfitFeePct,
  outOfRangeWaitMinutes,
  managementIntervalMin,
  screeningIntervalMin,
  llmProvider: provider.key,
  llmBaseUrl,
  llmModel,
  ...(llmApiKey ? { llmApiKey } : {}),
  dryRun: dryRun === "true",
};

const normalizedFallbackModel = fallbackModelRaw?.trim() || null;
if (normalizedFallbackModel) {
  userConfig.fallbackModel = normalizedFallbackModel;
} else {
  delete userConfig.fallbackModel;
}

fs.writeFileSync(CONFIG_PATH, JSON.stringify(userConfig, null, 2));

const presetName = preset ? preset.label : "Custom";

console.log(`
╔═══════════════════════════════════════════╗
║           Configuration Saved             ║
╚═══════════════════════════════════════════╝

Preset:       ${presetName}
Timeframe:    ${timeframe}

  Deploy:     ${deployAmountSol} SOL/position  |  Max: ${maxPositions} positions
  Min balance: ${minSolToOpen} SOL to open
  Take profit: fees >= ${takeProfitFeePct}%
  Volatility:  max ${maxVolatility}
  Organic:     min ${minOrganic}
  Holders:     min ${minHolders}
  Max mcap:    $${maxMcap.toLocaleString()}
  OOR close:   after ${outOfRangeWaitMinutes} min
  Mgmt:        every ${managementIntervalMin} min
  Screening:   every ${screeningIntervalMin} min
  Provider:    ${provider.label.split("(")[0].trim()}
  Model:       ${llmModel}
  Base URL:    ${llmBaseUrl}
  Dry run:     ${dryRun}

Run "npm start" to launch the agent.
`);
