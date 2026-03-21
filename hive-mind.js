/**
 * Hive Mind — opt-in collective intelligence for meridian agents.
 *
 * When enabled, agents share anonymized performance data (lessons, deploy
 * outcomes, screening thresholds) with a central server. In return, they
 * receive consensus wisdom from other agents — weighted by credibility
 * and freshness — to inform screening and management decisions.
 *
 * Setup:
 *   1. Run: node -e "import('./hive-mind.js').then(m => m.register('https://your-hive-url'))"
 *   2. Save the API key shown — it won't be shown again.
 *   3. Agent auto-syncs on each position close and queries during screening.
 *
 * Disable: clear hiveMindUrl and hiveMindApiKey in user-config.json.
 *
 * Privacy: NO wallet addresses or private keys are ever sent.
 *          Only pool addresses (public on-chain data), performance stats,
 *          and lessons are shared. Agent IDs are anonymous UUIDs.
 *
 * Zero dependencies — uses only Node.js stdlib + native fetch().
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
const LESSONS_FILE = path.join(__dirname, "lessons.json");
const POOL_MEMORY_FILE = path.join(__dirname, "pool-memory.json");

const SYNC_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
const GET_TIMEOUT_MS = 5_000;
const POST_TIMEOUT_MS = 10_000;
const MIN_AGENTS_FOR_CONSENSUS = 3;
const MAX_CONSENSUS_CHARS = 500;

let _lastSyncTime = 0;

// ─── Helpers ────────────────────────────────────────────────────

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const current = readConfig();
  const merged = { ...current, ...patch };
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(merged, null, 2));
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = GET_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Check whether Hive Mind is configured and enabled.
 * @returns {boolean}
 */
export function isEnabled() {
  const cfg = readConfig();
  return Boolean(cfg.hiveMindUrl && cfg.hiveMindApiKey);
}

/**
 * One-time registration with a Hive Mind server.
 * Stores hiveMindUrl and hiveMindApiKey in user-config.json.
 * @param {string} url - Base URL of the hive server (e.g. "https://hive.example.com")
 * @returns {Promise<string>} The raw API key (shown once, save it!)
 */
export async function register(url) {
  const baseUrl = url.replace(/\/+$/, "");
  const cfg = readConfig();
  const displayName = cfg.displayName || `agent-${Date.now().toString(36)}`;

  console.log("[hive]", `Registering with ${baseUrl} as "${displayName}"...`);

  const res = await fetchWithTimeout(
    `${baseUrl}/api/register`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: displayName }),
    },
    POST_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Registration failed (${res.status}): ${text}`);
  }

  const { agent_id, api_key } = await res.json();
  writeConfig({ hiveMindUrl: baseUrl, hiveMindApiKey: api_key, hiveMindAgentId: agent_id });
  console.log("[hive]", `Registered! agent_id=${agent_id}`);
  console.log("[hive]", `API key: ${api_key}`);
  console.log("[hive]", `Save this key — it will NOT be shown again.`);

  return api_key;
}

/**
 * Batch-upload local data to the hive mind server.
 * Debounced (5 min), fire-and-forget, never throws.
 */
export async function syncToHive() {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return;

    // Debounce
    const now = Date.now();
    if (now - _lastSyncTime < SYNC_DEBOUNCE_MS) return;
    _lastSyncTime = now;

    // ── Collect local data ──────────────────────────

    // Lessons
    const lessonsData = readJsonFile(LESSONS_FILE) || { lessons: [], performance: [] };
    const lessons = lessonsData.lessons || [];

    // Pool deploys — flatten all pools' deploy arrays
    const poolMemory = readJsonFile(POOL_MEMORY_FILE) || {};
    const deploys = [];
    for (const poolAddr of Object.keys(poolMemory)) {
      const pool = poolMemory[poolAddr];
      if (Array.isArray(pool.deploys)) {
        for (const d of pool.deploys) {
          deploys.push({ pool_address: poolAddr, pool_name: pool.name, ...d });
        }
      }
    }

    // Screening thresholds from config
    const thresholds = {
      minFeeActiveTvlRatio: cfg.minFeeActiveTvlRatio,
      minTvl: cfg.minTvl,
      maxTvl: cfg.maxTvl,
      minOrganic: cfg.minOrganic,
      minHolders: cfg.minHolders,
      minBinStep: cfg.minBinStep,
      maxBinStep: cfg.maxBinStep,
      minVolume: cfg.minVolume,
      minMcap: cfg.minMcap,
      stopLossPct: cfg.stopLossPct ?? cfg.emergencyPriceDropPct,
      takeProfitFeePct: cfg.takeProfitFeePct,
    };

    // Agent stats via dynamic import (avoids circular deps)
    let agentStats = null;
    try {
      const { getPerformanceSummary } = await import("./lessons.js");
      agentStats = getPerformanceSummary();
    } catch (e) {
      console.log("[hive]", `Could not load agent stats: ${e.message}`);
    }

    // ── POST to /api/sync ───────────────────────────

    const payload = { lessons, deploys, thresholds, agentStats };

    console.log("[hive]", `Syncing ${lessons.length} lessons, ${deploys.length} deploys...`);

    const res = await fetchWithTimeout(
      `${cfg.hiveMindUrl}/api/sync`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.hiveMindApiKey}`,
        },
        body: JSON.stringify(payload),
      },
      POST_TIMEOUT_MS,
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.log("[hive]", `Sync failed (${res.status}): ${text}`);
      return;
    }

    const result = await res.json();
    console.log("[hive]", `Sync complete — ${result.lessons_upserted} lessons, ${result.deploys_upserted} deploys`);
  } catch (e) {
    console.log("[hive]", `Sync error: ${e.message}`);
  }
}

/**
 * Query pool consensus from the hive.
 * @param {string} poolAddress
 * @returns {Promise<object|null>}
 */
export async function queryPoolConsensus(poolAddress) {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const res = await fetchWithTimeout(
      `${cfg.hiveMindUrl}/api/consensus/pool/${encodeURIComponent(poolAddress)}`,
      { headers: { Authorization: `Bearer ${cfg.hiveMindApiKey}` } },
    );

    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Query lesson consensus by tags.
 * @param {string[]} [tags]
 * @returns {Promise<Array|null>}
 */
export async function queryLessonConsensus(tags) {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const qs = Array.isArray(tags) && tags.length > 0
      ? `?tags=${encodeURIComponent(tags.join(","))}`
      : "";
    const res = await fetchWithTimeout(
      `${cfg.hiveMindUrl}/api/consensus/lessons${qs}`,
      { headers: { Authorization: `Bearer ${cfg.hiveMindApiKey}` } },
    );

    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Query pattern consensus for a given volatility level.
 * @param {number} [volatility]
 * @returns {Promise<Array|null>}
 */
export async function queryPatternConsensus(volatility) {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const qs = volatility != null ? `?volatility=${encodeURIComponent(volatility)}` : "";
    const res = await fetchWithTimeout(
      `${cfg.hiveMindUrl}/api/consensus/patterns${qs}`,
      { headers: { Authorization: `Bearer ${cfg.hiveMindApiKey}` } },
    );

    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Query median threshold consensus across all agents.
 * @returns {Promise<object|null>}
 */
export async function queryThresholdConsensus() {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const res = await fetchWithTimeout(
      `${cfg.hiveMindUrl}/api/consensus/thresholds`,
      { headers: { Authorization: `Bearer ${cfg.hiveMindApiKey}` } },
    );

    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Get global hive pulse stats.
 * @returns {Promise<object|null>}
 */
export async function getHivePulse() {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const res = await fetchWithTimeout(
      `${cfg.hiveMindUrl}/api/pulse`,
      { headers: { Authorization: `Bearer ${cfg.hiveMindApiKey}` } },
    );

    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Query multiple pools in parallel and format for LLM prompt injection.
 * Only shows pools with >= 3 agents reporting (filters noise).
 * @param {string[]} poolAddresses
 * @returns {Promise<string>} Formatted consensus block or empty string
 */
export async function formatPoolConsensusForPrompt(poolAddresses) {
  if (!isEnabled() || !Array.isArray(poolAddresses) || poolAddresses.length === 0) {
    return "";
  }

  try {
    const results = await Promise.all(
      poolAddresses.map(async (addr) => {
        const data = await queryPoolConsensus(addr);
        return { addr, data };
      }),
    );

    const lines = [];
    let poolsWithData = 0;

    for (const { addr, data } of results) {
      if (data && data.unique_agents >= MIN_AGENTS_FOR_CONSENSUS) {
        poolsWithData++;
        const name = data.pool_name || addr.slice(0, 8);
        const winPct = data.weighted_win_rate ?? 0;
        const avgPnl = data.weighted_avg_pnl != null
          ? (data.weighted_avg_pnl >= 0 ? "+" : "") + data.weighted_avg_pnl.toFixed(1) + "%"
          : "N/A";
        lines.push(`[HIVE] ${name}: ${data.unique_agents} agents, ${winPct}% win, ${avgPnl} avg PnL`);
      }
    }

    if (lines.length === 0) return "";

    const header = `HIVE MIND CONSENSUS (supplementary — your own analysis takes priority):`;
    let output = [header, ...lines].join("\n");

    if (output.length > MAX_CONSENSUS_CHARS) {
      output = output.slice(0, MAX_CONSENSUS_CHARS - 3) + "...";
    }

    return output;
  } catch (e) {
    console.log("[hive]", `formatPoolConsensusForPrompt error: ${e.message}`);
    return "";
  }
}
