import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
const CACHE_PATH = path.join(__dirname, "hivemind-cache.json");
const PACKAGE_JSON_PATH = path.join(__dirname, "package.json");
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

let _heartbeatTimer = null;

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function sanitizeText(text, maxLen = 400) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function getVersion() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")).version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

const AGENT_VERSION = getVersion();

function readUserConfig() {
  return readJson(USER_CONFIG_PATH, {});
}

function writeUserConfig(nextConfig) {
  writeJson(USER_CONFIG_PATH, nextConfig);
}

function readCache() {
  return readJson(CACHE_PATH, {
    sharedLessons: [],
    presets: [],
    pulledAt: null,
  });
}

function writeCache(nextCache) {
  writeJson(CACHE_PATH, nextCache);
}

function getBaseUrl() {
  return sanitizeText(config.hiveMind?.url || "", 500) || "";
}

function getApiKey() {
  return sanitizeText(config.hiveMind?.apiKey || "", 300) || "";
}

function getPullMode() {
  const mode = sanitizeText(config.hiveMind?.pullMode || "auto", 20) || "auto";
  return mode === "manual" ? "manual" : "auto";
}

export function getHiveMindPullMode() {
  return getPullMode();
}

export function isHiveMindEnabled() {
  return !!(getBaseUrl() && getApiKey());
}

export function ensureAgentId() {
  const userConfig = readUserConfig();
  if (userConfig.agentId) {
    config.hiveMind.agentId = userConfig.agentId;
    return userConfig.agentId;
  }

  const agentId = `agt_${crypto.randomBytes(12).toString("hex")}`;
  userConfig.agentId = agentId;
  writeUserConfig(userConfig);
  config.hiveMind.agentId = agentId;
  log("hivemind", `Generated agentId ${agentId}`);
  return agentId;
}

function getAgentId() {
  return config.hiveMind?.agentId || ensureAgentId();
}

function buildUrl(pathname, query = {}) {
  const url = new URL(pathname, getBaseUrl());
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function requestJson(pathname, { method = "GET", body = null, query = {} } = {}) {
  if (!isHiveMindEnabled()) return null;
  const response = await fetch(buildUrl(pathname, query), {
    method,
    headers: {
      accept: "application/json",
      "x-api-key": getApiKey(),
      ...(body != null ? { "content-type": "application/json" } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `HiveMind ${response.status}`);
  }
  return payload;
}

function normalizeSharedLesson(lesson) {
  const rule = sanitizeText(lesson?.rule, 400);
  if (!rule) return null;
  return {
    id: lesson.id || lesson.lessonId || `shared_${Date.now()}`,
    rule,
    tags: Array.isArray(lesson.tags) ? lesson.tags.map((tag) => sanitizeText(tag, 48)).filter(Boolean) : [],
    role: sanitizeText(lesson.role || "", 20) || null,
    outcome: sanitizeText(lesson.outcome || "shared", 20) || "shared",
    sourceType: sanitizeText(lesson.sourceType || lesson.source || "shared", 24) || "shared",
    score: Number.isFinite(Number(lesson.score)) ? Number(lesson.score) : null,
    created_at: lesson.created_at || lesson.createdAt || new Date().toISOString(),
  };
}

export function getSharedLessonsForPrompt({ agentType = "GENERAL", maxLessons = 6 } = {}) {
  const role = String(agentType || "GENERAL").toUpperCase();
  // Suppress Hivemind lessons that recommend bid_ask — our pinned lessons explicitly
  // require spot to avoid IL compounding on dumps (AINI -22%, WIZ -10%).
  const BID_ASK_PATTERN = /\bbid[_-]ask\b/i;
  const shared = (readCache().sharedLessons || [])
    .map(normalizeSharedLesson)
    .filter(Boolean)
    .filter((lesson) => !lesson.role || lesson.role === role || role === "GENERAL")
    .filter((lesson) => !BID_ASK_PATTERN.test(lesson.rule) || /\bWARNING\b|\bCAUTION\b|\bAVOID\b/i.test(lesson.rule))
    .sort((left, right) => (Number(right.score) || 0) - (Number(left.score) || 0))
    .slice(0, maxLessons);

  if (!shared.length) return null;
  return shared
    .map((lesson) => `[HIVEMIND${lesson.score != null ? ` score=${lesson.score}` : ""}] ${lesson.rule}`)
    .join("\n");
}

export async function registerHiveMindAgent({ reason = "heartbeat" } = {}) {
  if (!isHiveMindEnabled()) return null;
  try {
    return await requestJson("/api/hivemind/agents/register", {
      method: "POST",
      body: {
        agentId: getAgentId(),
        version: AGENT_VERSION,
        timestamp: new Date().toISOString(),
        reason,
        capabilities: {
          telegram: !!process.env.TELEGRAM_BOT_TOKEN,
          lpagent: !!process.env.LPAGENT_API_KEY,
          dryRun: process.env.DRY_RUN === "true",
        },
      },
    });
  } catch (error) {
    log("hivemind_warn", `Agent register failed: ${error.message}`);
    return null;
  }
}

export async function pullHiveMindLessons(limit = 12) {
  if (!isHiveMindEnabled()) return null;
  try {
    const payload = await requestJson("/api/hivemind/lessons/pull", {
      query: { agentId: getAgentId(), limit },
    });
    const cache = readCache();
    cache.sharedLessons = Array.isArray(payload?.lessons)
      ? payload.lessons.map(normalizeSharedLesson).filter(Boolean)
      : [];
    cache.pulledAt = new Date().toISOString();
    writeCache(cache);
    return cache.sharedLessons;
  } catch (error) {
    log("hivemind_warn", `Lesson pull failed: ${error.message}`);
    return null;
  }
}

export async function pullHiveMindPresets() {
  if (!isHiveMindEnabled()) return null;
  try {
    const payload = await requestJson("/api/hivemind/presets/pull", {
      query: { agentId: getAgentId() },
    });
    const cache = readCache();
    cache.presets = Array.isArray(payload?.presets) ? payload.presets : [];
    cache.pulledAt = new Date().toISOString();
    writeCache(cache);
    return cache.presets;
  } catch (error) {
    log("hivemind_warn", `Preset pull failed: ${error.message}`);
    return null;
  }
}

export async function bootstrapHiveMind() {
  if (!isHiveMindEnabled()) return null;
  ensureAgentId();
  const tasks = [registerHiveMindAgent({ reason: "startup" })];
  if (getPullMode() === "auto") {
    tasks.push(pullHiveMindLessons(), pullHiveMindPresets());
  }
  await Promise.allSettled(tasks);
  return { enabled: true, agentId: getAgentId(), pullMode: getPullMode() };
}

export function startHiveMindBackgroundSync() {
  if (!isHiveMindEnabled() || _heartbeatTimer) return null;
  _heartbeatTimer = setInterval(() => {
    const tasks = [registerHiveMindAgent({ reason: "heartbeat" })];
    if (getPullMode() === "auto") {
      tasks.push(pullHiveMindLessons(), pullHiveMindPresets());
    }
    Promise.allSettled(tasks).catch(() => null);
  }, HEARTBEAT_INTERVAL_MS);
  return _heartbeatTimer;
}

function buildLessonEvent(lesson) {
  const rule = sanitizeText(lesson?.rule, 400);
  if (!rule) return null;
  const sourceType = sanitizeText(lesson.sourceType || inferLessonSourceType(lesson), 24) || "manual";
  return {
    eventId: `lesson:${getAgentId()}:${lesson.id || crypto.randomUUID()}`,
    agentId: getAgentId(),
    version: AGENT_VERSION,
    timestamp: lesson.created_at || new Date().toISOString(),
    lesson: {
      id: lesson.id || null,
      rule,
      tags: Array.isArray(lesson.tags) ? lesson.tags.map((tag) => sanitizeText(tag, 48)).filter(Boolean) : [],
      role: sanitizeText(lesson.role || "", 20) || null,
      outcome: sanitizeText(lesson.outcome || "manual", 20) || "manual",
      sourceType,
      confidence: Number.isFinite(Number(lesson.confidence)) ? Number(lesson.confidence) : null,
      pool: sanitizeText(lesson.pool || "", 64) || null,
      pinned: !!lesson.pinned,
      metrics: {
        pnlPct: Number.isFinite(Number(lesson.pnl_pct)) ? Number(lesson.pnl_pct) : null,
        feesUsd: Number.isFinite(Number(lesson.fees_earned_usd)) ? Number(lesson.fees_earned_usd) : null,
        initialValueUsd: Number.isFinite(Number(lesson.initial_value_usd)) ? Number(lesson.initial_value_usd) : null,
        rangeEfficiency: Number.isFinite(Number(lesson.range_efficiency)) ? Number(lesson.range_efficiency) : null,
        closeReason: sanitizeText(lesson.close_reason || "", 160) || null,
      },
    },
  };
}

function inferLessonSourceType(lesson) {
  const tags = Array.isArray(lesson?.tags) ? lesson.tags.map((tag) => String(tag).toLowerCase()) : [];
  const rule = String(lesson?.rule || "").toLowerCase();
  if (tags.includes("self_tune") || tags.includes("config_change") || rule.startsWith("[self-tuned]")) {
    return "config_change";
  }
  if (lesson?.outcome === "manual") {
    return "manual";
  }
  return "performance";
}

export async function pushHiveLesson(lesson) {
  if (!isHiveMindEnabled()) return null;
  const body = buildLessonEvent(lesson);
  if (!body) return null;
  try {
    return await requestJson("/api/hivemind/lessons/push", {
      method: "POST",
      body,
    });
  } catch (error) {
    log("hivemind_warn", `Lesson push failed: ${error.message}`);
    return null;
  }
}

export function shouldCountInAdjustedWinRate(closeReason) {
  const text = String(closeReason || "").toLowerCase();
  return !(
    text.includes("out of range") ||
    text.includes("pumped far above range") ||
    text === "oor" ||
    text.includes("oor")
  );
}

export async function pushHivePerformanceEvent(perf) {
  if (!isHiveMindEnabled()) return null;
  try {
    return await requestJson("/api/hivemind/performance/push", {
      method: "POST",
      body: {
        eventId: sanitizeText(perf.eventId, 200) || `close:${getAgentId()}:${perf.position || perf.pool}:${perf.recorded_at || Date.now()}`,
        agentId: getAgentId(),
        version: AGENT_VERSION,
        timestamp: perf.recorded_at || new Date().toISOString(),
        event: {
          pool: sanitizeText(perf.pool, 64) || null,
          poolName: sanitizeText(perf.pool_name, 80) || null,
          baseMint: sanitizeText(perf.base_mint, 64) || null,
          strategy: sanitizeText(perf.strategy, 32) || null,
          closeReason: sanitizeText(perf.close_reason, 200) || "unknown",
          pnlUsd: Number(perf.pnl_usd || 0),
          pnlPct: Number(perf.pnl_pct || 0),
          feesUsd: Number(perf.fees_earned_usd || 0),
          feesSol: Number(perf.fees_earned_sol || 0),
          minutesHeld: Number(perf.minutes_held || 0),
          countInAdjustedWinRate: shouldCountInAdjustedWinRate(perf.close_reason),
        },
      },
    });
  } catch (error) {
    log("hivemind_warn", `Performance push failed: ${error.message}`);
    return null;
  }
}
