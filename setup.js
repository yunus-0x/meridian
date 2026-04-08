/**
 * Interactive setup wizard.
 * Runs before the agent starts. Saves settings to user-config.json.
 * Run: npm run setup
 *
 * Goals:
 * - cover the full editable user-config surface
 * - preserve unrelated existing keys instead of overwriting the whole file
 * - make first-time onboarding easy while still supporting advanced tuning
 */

import "dotenv/config";
import readline from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "user-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";

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

function askChoice(question, choices, defaultKey = null) {
  return new Promise(async (resolve) => {
    console.log(`\n${question}`);
    choices.forEach((choice, index) => {
      const marker = defaultKey && choice.key === defaultKey ? " [default]" : "";
      console.log(`  ${index + 1}. ${choice.label}${marker}`);
    });
    while (true) {
      const raw = await ask("Enter number", defaultKey ? String(choices.findIndex((c) => c.key === defaultKey) + 1) : "");
      const idx = parseInt(raw, 10) - 1;
      if (idx >= 0 && idx < choices.length) {
        resolve(choices[idx]);
        return;
      }
      console.log("  ⚠ Invalid choice.");
    }
  });
}

function formatDefaultValue(value, type) {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (type === "boolean") return value ? "true" : "false";
  return String(value);
}

async function askBoolean(question, defaultVal) {
  while (true) {
    const raw = String(await ask(question, formatDefaultValue(defaultVal, "boolean"))).toLowerCase();
    if (raw === "true" || raw === "yes" || raw === "y" || raw === "1") return true;
    if (raw === "false" || raw === "no" || raw === "n" || raw === "0") return false;
    console.log("  ⚠ Please answer true/false.");
  }
}

async function askNumber(question, defaultVal, { min, max, nullable = false } = {}) {
  while (true) {
    const raw = String(await ask(question, formatDefaultValue(defaultVal, "number"))).trim();
    if (nullable && raw.toLowerCase() === "null") return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      console.log(nullable ? "  ⚠ Enter a number or null." : "  ⚠ Please enter a number.");
      continue;
    }
    if (min !== undefined && n < min) {
      console.log(`  ⚠ Minimum is ${min}.`);
      continue;
    }
    if (max !== undefined && n > max) {
      console.log(`  ⚠ Maximum is ${max}.`);
      continue;
    }
    return n;
  }
}

async function askString(question, defaultVal, { allowBlank = true, preserveExistingMasked = false } = {}) {
  const displayDefault =
    preserveExistingMasked && defaultVal ? "*** (already set)" : formatDefaultValue(defaultVal, "string");

  while (true) {
    const raw = await ask(question, displayDefault);
    if (preserveExistingMasked && String(raw).startsWith("***")) return defaultVal || "";
    if (!allowBlank && String(raw).trim() === "") {
      console.log("  ⚠ This field cannot be blank.");
      continue;
    }
    return String(raw);
  }
}

async function askList(question, defaultVal) {
  const raw = await ask(question, formatDefaultValue(defaultVal, "list"));
  const trimmed = String(raw).trim();
  if (!trimmed) return [];
  return trimmed
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const PRESETS = {
  degen: {
    label: "🔥 Degen",
    description: "Fast cycles, looser filters, quicker exits, higher risk/reward.",
    defaults: {
      timeframe: "30m",
      category: "top",
      deployAmountSol: 0.35,
      maxPositions: 3,
      minSolToOpen: 0.45,
      minOrganic: 60,
      minQuoteOrganic: 60,
      minHolders: 250,
      minMcap: 100000,
      maxMcap: 5000000,
      minVolume: 1000,
      minTvl: 5000,
      maxTvl: 150000,
      minFeePerTvl24h: 5,
      stopLossPct: -35,
      takeProfitPct: 8,
      trailingTriggerPct: 2.5,
      trailingDropPct: 1.25,
      outOfRangeWaitMinutes: 15,
      maxBotHoldersPct: 35,
      maxTop10Pct: 65,
      managementIntervalMin: 5,
      screeningIntervalMin: 15,
    },
  },
  moderate: {
    label: "⚖️ Moderate",
    description: "Balanced default for most users.",
    defaults: {
      timeframe: "30m",
      category: "top",
      deployAmountSol: 0.5,
      maxPositions: 3,
      minSolToOpen: 0.55,
      minOrganic: 65,
      minQuoteOrganic: 65,
      minHolders: 500,
      minMcap: 150000,
      maxMcap: 10000000,
      minVolume: 500,
      minTvl: 10000,
      maxTvl: 150000,
      minFeePerTvl24h: 7,
      stopLossPct: -40,
      takeProfitPct: 5,
      trailingTriggerPct: 3,
      trailingDropPct: 1.5,
      outOfRangeWaitMinutes: 30,
      managementIntervalMin: 10,
      screeningIntervalMin: 30,
    },
  },
  safe: {
    label: "🛡️ Safe",
    description: "Stricter filters, smaller concurrency, slower cycles.",
    defaults: {
      timeframe: "4h",
      category: "top",
      deployAmountSol: 0.4,
      maxPositions: 2,
      minSolToOpen: 0.65,
      minOrganic: 75,
      minQuoteOrganic: 75,
      minHolders: 1000,
      minMcap: 250000,
      maxMcap: 10000000,
      minVolume: 1000,
      minTvl: 15000,
      maxTvl: 150000,
      minFeePerTvl24h: 9,
      stopLossPct: -30,
      takeProfitPct: 3,
      trailingTriggerPct: 3,
      trailingDropPct: 1,
      outOfRangeWaitMinutes: 60,
      maxBotHoldersPct: 25,
      maxTop10Pct: 55,
      managementIntervalMin: 15,
      screeningIntervalMin: 60,
    },
  },
};

const EXAMPLE_DEFAULTS = JSON.parse(fs.readFileSync(path.join(__dirname, "user-config.example.json"), "utf8"));
const existing = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
  : {};

function defaultFor(key, presetDefaults = {}) {
  if (existing[key] !== undefined) return existing[key];
  if (key === "hiveMindUrl") return DEFAULT_HIVEMIND_URL;
  if (presetDefaults[key] !== undefined) return presetDefaults[key];
  return EXAMPLE_DEFAULTS[key];
}

const FIELD_SECTIONS = [
  {
    title: "Wallet & RPC",
    fields: [
      { key: "rpcUrl", label: "RPC URL", type: "string" },
      { key: "walletKey", label: "Wallet private key (base58)", type: "string", preserveExistingMasked: true },
      { key: "dryRun", label: "Dry run mode? (true/false)", type: "boolean" },
    ],
  },
  {
    title: "Deployment",
    fields: [
      { key: "deployAmountSol", label: "SOL to deploy per position", type: "number", min: 0.01 },
      { key: "maxPositions", label: "Max concurrent positions", type: "number", min: 1 },
      { key: "minSolToOpen", label: "Min SOL balance to open", type: "number", min: 0.01 },
      { key: "maxDeployAmount", label: "Max SOL per position", type: "number", min: 0.01 },
      { key: "gasReserve", label: "Gas reserve (SOL)", type: "number", min: 0 },
      { key: "positionSizePct", label: "Dynamic position size % of deployable balance", type: "number", min: 0, max: 1 },
    ],
  },
  {
    title: "Strategy Defaults",
    fields: [
      { key: "strategy", label: "Default LP strategy", type: "choice", choices: [
        { key: "bid_ask", label: "bid_ask" },
        { key: "spot", label: "spot" },
        { key: "curve", label: "curve" },
      ]},
      { key: "binsBelow", label: "Bins below active price", type: "number", min: 1 },
    ],
  },
  {
    title: "Screening Filters",
    fields: [
      { key: "timeframe", label: "Discovery timeframe", type: "choice", choices: ["30m", "1h", "4h", "12h", "24h"].map((key) => ({ key, label: key })) },
      { key: "category", label: "Discovery category", type: "string" },
      { key: "excludeHighSupplyConcentration", label: "Exclude high supply concentration? (true/false)", type: "boolean" },
      { key: "minTvl", label: "Min TVL", type: "number", min: 0 },
      { key: "maxTvl", label: "Max TVL", type: "number", min: 0 },
      { key: "minVolume", label: "Min volume", type: "number", min: 0 },
      { key: "minOrganic", label: "Min base organic score", type: "number", min: 0, max: 100 },
      { key: "minQuoteOrganic", label: "Min quote organic score", type: "number", min: 0, max: 100 },
      { key: "minHolders", label: "Min holders", type: "number", min: 0 },
      { key: "minMcap", label: "Min market cap", type: "number", min: 0 },
      { key: "maxMcap", label: "Max market cap", type: "number", min: 0 },
      { key: "minBinStep", label: "Min bin step", type: "number", min: 1 },
      { key: "maxBinStep", label: "Max bin step", type: "number", min: 1 },
      { key: "minFeeActiveTvlRatio", label: "Min fee/active TVL ratio", type: "number", min: 0 },
      { key: "minTokenFeesSol", label: "Min token fees paid (SOL)", type: "number", min: 0 },
      { key: "useDiscordSignals", label: "Use Discord listener signals in screening? (true/false)", type: "boolean" },
      { key: "discordSignalMode", label: "Discord signal mode", type: "choice", choices: [
        { key: "merge", label: "merge — add Discord-signaled pools as another screening source" },
        { key: "only", label: "only — screen only from signaled pools" },
      ]},
      { key: "avoidPvpSymbols", label: "Avoid PvP symbols? (true/false)", type: "boolean" },
      { key: "blockPvpSymbols", label: "Hard block PvP symbols? (true/false)", type: "boolean" },
      { key: "maxBundlePct", label: "Max bundle %", type: "number", min: 0, max: 100 },
      { key: "maxBotHoldersPct", label: "Max bot holders %", type: "number", min: 0, max: 100 },
      { key: "maxTop10Pct", label: "Max top10 holder %", type: "number", min: 0, max: 100 },
      { key: "allowedLaunchpads", label: "Allowed launchpads (comma separated, blank = none)", type: "list" },
      { key: "blockedLaunchpads", label: "Blocked launchpads (comma separated, blank = none)", type: "list" },
      { key: "minTokenAgeHours", label: "Min token age hours (or null)", type: "number", min: 0, nullable: true },
      { key: "maxTokenAgeHours", label: "Max token age hours (or null)", type: "number", min: 0, nullable: true },
      { key: "athFilterPct", label: "ATH filter pct (or null)", type: "number", nullable: true },
    ],
  },
  {
    title: "Management Rules",
    fields: [
      { key: "minClaimAmount", label: "Min claim amount", type: "number", min: 0 },
      { key: "autoSwapAfterClaim", label: "Auto swap after claim? (true/false)", type: "boolean" },
      { key: "outOfRangeBinsToClose", label: "Bins above range to force close", type: "number", min: 0 },
      { key: "outOfRangeWaitMinutes", label: "Minutes OOR before close", type: "number", min: 1 },
      { key: "oorCooldownTriggerCount", label: "OOR cooldown trigger count", type: "number", min: 1 },
      { key: "oorCooldownHours", label: "OOR cooldown hours", type: "number", min: 1 },
      { key: "minVolumeToRebalance", label: "Min volume to rebalance", type: "number", min: 0 },
      { key: "stopLossPct", label: "Stop loss %", type: "number" },
      { key: "emergencyPriceDropPct", label: "Legacy emergency price drop %", type: "number" },
      { key: "takeProfitPct", label: "Take profit %", type: "number", min: 0 },
      { key: "minFeePerTvl24h", label: "Min fee per TVL 24h", type: "number", min: 0 },
      { key: "minAgeBeforeYieldCheck", label: "Min age before yield check (minutes)", type: "number", min: 0 },
      { key: "trailingTakeProfit", label: "Trailing take profit? (true/false)", type: "boolean" },
      { key: "trailingTriggerPct", label: "Trailing trigger %", type: "number" },
      { key: "trailingDropPct", label: "Trailing drop %", type: "number", min: 0 },
      { key: "pnlSanityMaxDiffPct", label: "Max open-PnL sanity diff %", type: "number", min: 0 },
      { key: "solMode", label: "SOL mode? (true/false)", type: "boolean" },
    ],
  },
  {
    title: "Scheduling",
    fields: [
      { key: "managementIntervalMin", label: "Management interval (minutes)", type: "number", min: 1 },
      { key: "screeningIntervalMin", label: "Screening interval (minutes)", type: "number", min: 1 },
      { key: "healthCheckIntervalMin", label: "Health check interval (minutes)", type: "number", min: 1 },
    ],
  },
  {
    title: "LLM",
    fields: [
      { key: "llmBaseUrl", label: "LLM base URL", type: "string" },
      { key: "llmApiKey", label: "LLM API key", type: "string", preserveExistingMasked: true },
      { key: "llmModel", label: "Default/fallback LLM model", type: "string" },
      { key: "managementModel", label: "Management model", type: "string" },
      { key: "screeningModel", label: "Screening model", type: "string" },
      { key: "generalModel", label: "General model", type: "string" },
      { key: "temperature", label: "Temperature", type: "number", min: 0, max: 2 },
      { key: "maxTokens", label: "Max tokens", type: "number", min: 256 },
      { key: "maxSteps", label: "Max agent steps", type: "number", min: 1 },
    ],
  },
  {
    title: "Darwin",
    fields: [
      { key: "darwinEnabled", label: "Enable Darwin weighting? (true/false)", type: "boolean" },
      { key: "darwinWindowDays", label: "Darwin window days", type: "number", min: 1 },
      { key: "darwinRecalcEvery", label: "Darwin recalc every N closes", type: "number", min: 1 },
      { key: "darwinBoost", label: "Darwin boost factor", type: "number", min: 0 },
      { key: "darwinDecay", label: "Darwin decay factor", type: "number", min: 0 },
      { key: "darwinFloor", label: "Darwin weight floor", type: "number", min: 0 },
      { key: "darwinCeiling", label: "Darwin weight ceiling", type: "number", min: 0 },
      { key: "darwinMinSamples", label: "Darwin min samples", type: "number", min: 1 },
    ],
  },
  {
    title: "Integrations",
    fields: [
      { key: "agentId", label: "Agent ID (leave blank to auto-generate on startup)", type: "string" },
      { key: "telegramChatId", label: "Telegram chat ID", type: "string" },
      { key: "hiveMindApiKey", label: "HiveMind API key", type: "string", preserveExistingMasked: true },
      { key: "hiveMindPullMode", label: "HiveMind pull mode", type: "choice", choices: [
        { key: "auto", label: "auto — pull shared lessons/presets automatically" },
        { key: "manual", label: "manual — only pull when explicitly requested" },
      ]},
    ],
  },
];

async function askField(field, presetDefaults) {
  const defaultValue = defaultFor(field.key, presetDefaults);

  switch (field.type) {
    case "boolean":
      return askBoolean(field.label, defaultValue);
    case "number":
      return askNumber(field.label, defaultValue, field);
    case "choice":
      return (await askChoice(field.label, field.choices, defaultValue)).key;
    case "list":
      return askList(field.label, defaultValue);
    case "string":
    default:
      return askString(field.label, defaultValue, field);
  }
}

console.log(`
╔═══════════════════════════════════════════╗
║       DLMM LP Agent — Setup Wizard        ║
╚═══════════════════════════════════════════╝
`);

const presetChoice = await askChoice(
  "Select a starting preset:",
  [
    { key: "degen", label: `${PRESETS.degen.label} — ${PRESETS.degen.description}` },
    { key: "moderate", label: `${PRESETS.moderate.label} — ${PRESETS.moderate.description}` },
    { key: "safe", label: `${PRESETS.safe.label} — ${PRESETS.safe.description}` },
    { key: "custom", label: "Custom — no preset bias, edit everything manually" },
  ],
  existing.preset || "moderate",
);

const presetDefaults = presetChoice.key === "custom" ? {} : PRESETS[presetChoice.key].defaults;

console.log(
  presetChoice.key === "custom"
    ? `\nCustom mode — all prompts will use your existing values or example defaults.\n`
    : `\nUsing ${PRESETS[presetChoice.key].label} as the starting default layer. Existing values still win unless you change them.\n`,
);

const updates = {
  ...existing,
  preset: presetChoice.key,
  hiveMindUrl: DEFAULT_HIVEMIND_URL,
};

for (const section of FIELD_SECTIONS) {
  console.log(`\n── ${section.title} ────────────────────────────────`);
  for (const field of section.fields) {
    updates[field.key] = await askField(field, presetDefaults);
  }
}

rl.close();

// Preserve generated agentId and any unknown future keys automatically by merge.
// Drop masked placeholders if the user kept them unchanged.
if (!updates.walletKey && existing.walletKey) updates.walletKey = existing.walletKey;
if (!updates.llmApiKey && existing.llmApiKey) updates.llmApiKey = existing.llmApiKey;
if (!updates.hiveMindApiKey && existing.hiveMindApiKey) updates.hiveMindApiKey = existing.hiveMindApiKey;
if (existing.agentId && !updates.agentId) updates.agentId = existing.agentId;
updates.hiveMindUrl = DEFAULT_HIVEMIND_URL;

fs.writeFileSync(CONFIG_PATH, JSON.stringify(updates, null, 2));

console.log(`
╔═══════════════════════════════════════════╗
║           Configuration Saved             ║
╚═══════════════════════════════════════════╝

Setup updated your existing user-config.json by merge, so unrelated keys were preserved.

Highlights:
  Preset:      ${updates.preset}
  Deploy:      ${updates.deployAmountSol} SOL
  Max pos:     ${updates.maxPositions}
  Timeframe:   ${updates.timeframe}
  Mgmt:        every ${updates.managementIntervalMin} min
  Screening:   every ${updates.screeningIntervalMin} min
  Dry run:     ${updates.dryRun}
  Agent ID:    ${updates.agentId || "(auto-generate on startup)"}
  HiveMind:    ${DEFAULT_HIVEMIND_URL}${updates.hiveMindApiKey ? " (API key configured)" : " (API key not set)"}
  Pull mode:   ${updates.hiveMindPullMode}

Run "npm start" to launch the agent.
`);
