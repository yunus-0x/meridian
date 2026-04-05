/**
 * Agent learning system.
 *
 * After each position closes, performance is analyzed and lessons are
 * derived. These lessons are injected into the system prompt so the
 * agent avoids repeating mistakes and doubles down on what works.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const LESSONS_FILE = "./lessons.json";
const MIN_EVOLVE_POSITIONS = 5;   // don't evolve until we have real data
const MAX_CHANGE_PER_STEP  = 0.20; // never shift a threshold more than 20% at once
const MAX_MANUAL_LESSON_LENGTH = 400;

function sanitizeLessonText(text, maxLen = MAX_MANUAL_LESSON_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function save(data) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
}

// ─── Lesson Management Helpers ───────────────────────────────

function volatilityBucket(vol) {
  if (vol == null || !Number.isFinite(vol)) return null;
  if (vol < 2) return [0, 2];
  if (vol < 4) return [2, 4];
  if (vol < 6) return [4, 6];
  return [6, Infinity];
}

function extractPattern(perf) {
  return {
    volatility_range: volatilityBucket(perf.volatility),
    bin_step: perf.bin_step ?? null,
    strategy: perf.strategy ?? null,
    outcome: perf.pnl_pct >= 5 ? "good" : perf.pnl_pct <= -5 ? "bad" : null,
    sample_size: 1,
    pools: perf.pool_name ? [perf.pool_name] : [],
  };
}

function patternsMatch(a, b) {
  if (!a || !b) return false;
  if (a.outcome !== b.outcome) return false;
  if (a.bin_step !== b.bin_step) return false;
  if (a.strategy !== b.strategy) return false;
  if (!a.volatility_range || !b.volatility_range) return false;
  return a.volatility_range[0] === b.volatility_range[0] &&
         a.volatility_range[1] === b.volatility_range[1];
}

function patternsContradict(a, b) {
  if (!a || !b) return false;
  if (a.bin_step !== b.bin_step) return false;
  if (a.strategy !== b.strategy) return false;
  if (!a.volatility_range || !b.volatility_range) return false;
  const sameRange = a.volatility_range[0] === b.volatility_range[0] &&
                    a.volatility_range[1] === b.volatility_range[1];
  if (!sameRange) return false;
  return (a.outcome === "good" && b.outcome === "bad") ||
         (a.outcome === "bad" && b.outcome === "good");
}

function computeScore(lesson) {
  const now = Date.now();
  const created = new Date(lesson.created_at).getTime();
  const expires = new Date(lesson.expires_at).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(expires)) return 0;
  const totalLifespan = expires - created;
  const elapsed = now - created;
  const recencyWeight = totalLifespan > 0
    ? Math.max(0.1, 1 - (elapsed / totalLifespan) * 0.9)
    : 0.1;
  const sampleSize = lesson.pattern?.sample_size ?? 1;
  const typeMultiplier = lesson.type === "pattern" ? 1.5
    : lesson.type === "evolved" ? 1.2
    : 1.0;
  return sampleSize * recencyWeight * typeMultiplier;
}

function computeExpiresAt(type, lessonsConfig) {
  const days = type === "pattern" ? lessonsConfig.patternTtlDays
    : type === "evolved" ? lessonsConfig.evolvedTtlDays
    : lessonsConfig.specificTtlDays;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function load() {
  if (!fs.existsSync(LESSONS_FILE)) {
    return { lessons: [], performance: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
    // Backfill legacy lessons missing lifecycle fields
    let migrated = false;
    for (const lesson of data.lessons || []) {
      if (!lesson.type) {
        lesson.type = lesson.tags?.includes("evolution") ? "evolved" : "specific";
        migrated = true;
      }
      if (!lesson.expires_at && !lesson.pinned) {
        const ttlDays = lesson.type === "pattern" ? 30
          : lesson.type === "evolved" ? 14 : 7;
        lesson.expires_at = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
        migrated = true;
      }
      if (lesson.score == null) {
        lesson.score = 1.0;
        migrated = true;
      }
      if (!lesson.pattern && lesson.type === "specific") {
        lesson.pattern = {
          volatility_range: volatilityBucket(lesson.volatility ?? null),
          bin_step: null,
          strategy: null,
          outcome: lesson.outcome === "good" ? "good" : lesson.outcome === "bad" ? "bad" : null,
          sample_size: 1,
          pools: [],
        };
        migrated = true;
      }
    }
    if (migrated) {
      fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
      log("lessons", `Migrated ${data.lessons.length} legacy lessons to new format`);
    }
    return data;
  } catch {
    return { lessons: [], performance: [] };
  }
}

/**
 * Prune lessons: expire, merge duplicates, resolve contradictions, evict if over cap.
 */
function pruneLessons(lessonsConfig) {
  const data = load();
  const now = Date.now();
  const before = data.lessons.length;

  // Step 1: Remove expired (skip pinned and lessons without expires_at)
  data.lessons = data.lessons.filter(l =>
    l.pinned || !l.expires_at || new Date(l.expires_at).getTime() > now
  );

  // Step 2: Merge specifics into patterns
  const specifics = data.lessons.filter(l => l.type === "specific" && l.pattern?.outcome);
  const groups = new Map();
  for (const lesson of specifics) {
    const key = `${lesson.pattern.outcome}|${lesson.pattern.bin_step}|${lesson.pattern.strategy}|${(lesson.pattern.volatility_range || []).join(",")}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(lesson);
  }

  for (const [key, members] of groups) {
    if (members.length < lessonsConfig.mergeThreshold) continue;

    const totalSampleSize = members.reduce((s, l) => s + (l.pattern?.sample_size ?? 1), 0);
    const allPools = [...new Set(members.flatMap(l => l.pattern?.pools ?? []))];
    const repr = members[0];
    const volLabel = repr.pattern.volatility_range
      ? `volatility ${repr.pattern.volatility_range[0]}-${repr.pattern.volatility_range[1] === Infinity ? "+" : repr.pattern.volatility_range[1]}`
      : "unknown volatility";
    const outcomeLabel = repr.pattern.outcome === "good" ? "PATTERN-PREFER" : "PATTERN-AVOID";

    const merged = {
      id: Date.now(),
      rule: `${outcomeLabel}: pools with ${volLabel}, bin_step ${repr.pattern.bin_step}, strategy ${repr.pattern.strategy} — ${totalSampleSize} positions (${allPools.join(", ")})`,
      type: "pattern",
      tags: [...new Set(members.flatMap(l => l.tags || []))],
      outcome: repr.pattern.outcome === "good" ? "good" : "bad",
      pattern: {
        ...repr.pattern,
        sample_size: totalSampleSize,
        pools: allPools,
      },
      score: 1.0,
      expires_at: computeExpiresAt("pattern", lessonsConfig),
      created_at: new Date().toISOString(),
    };

    const memberIds = new Set(members.map(l => l.id));
    data.lessons = data.lessons.filter(l => !memberIds.has(l.id));
    data.lessons.push(merged);
  }

  // Step 3: Resolve contradictions (higher sample_size wins)
  const withPatterns = data.lessons.filter(l => l.pattern?.outcome);
  const toRemove = new Set();
  for (let i = 0; i < withPatterns.length; i++) {
    for (let j = i + 1; j < withPatterns.length; j++) {
      if (patternsContradict(withPatterns[i].pattern, withPatterns[j].pattern)) {
        const sizeI = withPatterns[i].pattern.sample_size ?? 1;
        const sizeJ = withPatterns[j].pattern.sample_size ?? 1;
        const loser = sizeI >= sizeJ ? withPatterns[j] : withPatterns[i];
        toRemove.add(loser.id);
      }
    }
  }
  if (toRemove.size > 0) {
    data.lessons = data.lessons.filter(l => !toRemove.has(l.id));
    log("lessons", `Removed ${toRemove.size} contradicted lesson(s)`);
  }

  // Step 4: Evict lowest-scoring if over cap
  const maxLessons = lessonsConfig.maxLessons;
  if (data.lessons.length > maxLessons) {
    const pinned = data.lessons.filter(l => l.pinned);
    const unpinned = data.lessons.filter(l => !l.pinned);
    unpinned.sort((a, b) => computeScore(b) - computeScore(a));
    const keepCount = Math.max(0, maxLessons - pinned.length);
    data.lessons = [...pinned, ...unpinned.slice(0, keepCount)];
    log("lessons", `Evicted ${unpinned.length - keepCount} low-scoring lesson(s) (cap: ${maxLessons})`);
  }

  if (data.lessons.length !== before) {
    save(data);
    log("lessons", `Pruned: ${before} → ${data.lessons.length} lessons`);
  }
}

// ─── Record Position Performance ──────────────────────────────

/**
 * Call this when a position closes. Captures performance data and
 * derives a lesson if the outcome was notably good or bad.
 *
 * @param {Object} perf
 * @param {string} perf.position       - Position address
 * @param {string} perf.pool           - Pool address
 * @param {string} perf.pool_name      - Pool name (e.g. "Mustard-SOL")
 * @param {string} perf.strategy       - "spot" | "curve" | "bid_ask"
 * @param {number} perf.bin_range      - Bin range used
 * @param {number} perf.bin_step       - Pool bin step
 * @param {number} perf.volatility     - Pool volatility at deploy time
 * @param {number} perf.fee_tvl_ratio  - fee/TVL ratio at deploy time
 * @param {number} perf.organic_score  - Token organic score at deploy time
 * @param {number} perf.amount_sol     - Amount deployed
 * @param {number} perf.fees_earned_usd - Total fees earned
 * @param {number} perf.final_value_usd - Value when closed
 * @param {number} perf.initial_value_usd - Value when opened
 * @param {number} perf.minutes_in_range  - Total minutes position was in range
 * @param {number} perf.minutes_held      - Total minutes position was held
 * @param {string} perf.close_reason   - Why it was closed
 */
export async function recordPerformance(perf) {
  const data = load();

  // Guard against unit-mixed records where a SOL-sized final value is
  // accidentally written into a USD field (e.g. final_value_usd = 2 for a 2 SOL close).
  const suspiciousUnitMix =
    Number.isFinite(perf.initial_value_usd) &&
    Number.isFinite(perf.final_value_usd) &&
    Number.isFinite(perf.amount_sol) &&
    perf.initial_value_usd >= 20 &&
    perf.amount_sol >= 0.25 &&
    perf.final_value_usd > 0 &&
    perf.final_value_usd <= perf.amount_sol * 2;

  if (suspiciousUnitMix) {
    log("lessons_warn", `Skipped suspicious performance record for ${perf.pool_name || perf.pool}: initial=${perf.initial_value_usd}, final=${perf.final_value_usd}, amount_sol=${perf.amount_sol}`);
    return;
  }

  const pnl_usd = (perf.final_value_usd + perf.fees_earned_usd) - perf.initial_value_usd;
  const pnl_pct = perf.initial_value_usd > 0
    ? (pnl_usd / perf.initial_value_usd) * 100
    : 0;
  const range_efficiency = perf.minutes_held > 0
    ? (perf.minutes_in_range / perf.minutes_held) * 100
    : 0;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const suspiciousAbsurdClosedPnl =
    Number.isFinite(pnl_pct) &&
    perf.initial_value_usd >= 20 &&
    pnl_pct <= -90 &&
    !closeReasonText.includes("stop loss");

  if (suspiciousAbsurdClosedPnl) {
    log("lessons_warn", `Skipped absurd closed PnL record for ${perf.pool_name || perf.pool}: pnl_pct=${pnl_pct.toFixed(2)} reason=${perf.close_reason}`);
    return;
  }

  const entry = {
    ...perf,
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    recorded_at: new Date().toISOString(),
  };

  data.performance.push(entry);

  // Derive and store a lesson
  const lesson = await derivLesson(entry);
  if (lesson) {
    data.lessons.push(lesson);
    log("lessons", `New lesson: ${lesson.rule}`);
  }

  save(data);

  // Prune lessons
  const { config: cfg } = await import("./config.js");
  pruneLessons(cfg.lessons);

  // Update pool-level memory
  if (perf.pool) {
    const { recordPoolDeploy } = await import("./pool-memory.js");
    recordPoolDeploy(perf.pool, {
      pool_name: perf.pool_name,
      base_mint: perf.base_mint,
      deployed_at: perf.deployed_at,
      closed_at: entry.recorded_at,
      pnl_pct: entry.pnl_pct,
      pnl_usd: entry.pnl_usd,
      range_efficiency: entry.range_efficiency,
      minutes_held: perf.minutes_held,
      close_reason: perf.close_reason,
      strategy: perf.strategy,
      volatility: perf.volatility,
    });
  }

  // Evolve thresholds every 5 closed positions
  if (data.performance.length % MIN_EVOLVE_POSITIONS === 0) {
    const { config, reloadScreeningThresholds } = await import("./config.js");
    const result = evolveThresholds(data.performance, config);
    if (result?.changes && Object.keys(result.changes).length > 0) {
      reloadScreeningThresholds();
      log("evolve", `Auto-evolved thresholds: ${JSON.stringify(result.changes)}`);
    }

    // Darwinian signal weight recalculation
    if (config.darwin?.enabled) {
      const { recalculateWeights } = await import("./signal-weights.js");
      const wResult = recalculateWeights(data.performance, config);
      if (wResult.changes.length > 0) {
        log("evolve", `Darwin: adjusted ${wResult.changes.length} signal weight(s)`);
      }
    }
  }

  // Fire-and-forget sync to hive mind (if enabled)
  import("./hive-mind.js").then(m => m.syncToHive()).catch(() => {});
}

/**
 * Derive a lesson from a closed position's performance.
 * Only generates a lesson if the outcome was clearly good or bad.
 */
async function derivLesson(perf) {
  const tags = [];

  // Categorize outcome
  const outcome = perf.pnl_pct >= 5 ? "good"
    : perf.pnl_pct >= 0 ? "neutral"
    : perf.pnl_pct >= -5 ? "poor"
    : "bad";

  if (outcome === "neutral") return null; // nothing interesting to learn

  // Build context description
  const context = [
    `${perf.pool_name}`,
    `strategy=${perf.strategy}`,
    `bin_step=${perf.bin_step}`,
    `volatility=${perf.volatility}`,
    `fee_tvl_ratio=${perf.fee_tvl_ratio}`,
    `organic=${perf.organic_score}`,
    `bin_range=${typeof perf.bin_range === 'object' ? JSON.stringify(perf.bin_range) : perf.bin_range}`,
  ].join(", ");

  let rule = "";

  if (outcome === "good" || outcome === "bad") {
    if (perf.range_efficiency < 30 && outcome === "bad") {
      rule = `AVOID: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — went OOR ${100 - perf.range_efficiency}% of the time. Consider wider bin_range or bid_ask strategy.`;
      tags.push("oor", perf.strategy, `volatility_${Math.round(perf.volatility)}`);
    } else if (perf.range_efficiency > 80 && outcome === "good") {
      rule = `PREFER: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — ${perf.range_efficiency}% in-range efficiency, PnL +${perf.pnl_pct}%.`;
      tags.push("efficient", perf.strategy);
    } else if (outcome === "bad" && perf.close_reason?.includes("volume")) {
      rule = `AVOID: Pools with fee_tvl_ratio=${perf.fee_tvl_ratio} that showed volume collapse — fees evaporated quickly. Minimum sustained volume check needed before deploying.`;
      tags.push("volume_collapse");
    } else if (outcome === "good") {
      rule = `WORKED: ${context} → PnL +${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%.`;
      tags.push("worked");
    } else {
      rule = `FAILED: ${context} → PnL ${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%. Reason: ${perf.close_reason}.`;
      tags.push("failed");
    }
  }

  if (!rule) return null;

  const { config } = await import("./config.js");

  return {
    id: Date.now(),
    rule,
    type: "specific",
    tags,
    outcome,
    context,
    pnl_pct: perf.pnl_pct,
    range_efficiency: perf.range_efficiency,
    pool: perf.pool,
    pattern: extractPattern(perf),
    score: 1.0,
    expires_at: computeExpiresAt("specific", config.lessons),
    created_at: new Date().toISOString(),
  };
}

// ─── Adaptive Threshold Evolution ──────────────────────────────

/**
 * Analyze closed position performance and evolve screening thresholds.
 * Writes changes to user-config.json and returns a summary.
 *
 * @param {Array}  perfData - Array of performance records (from lessons.json)
 * @param {Object} config   - Live config object (mutated in place)
 * @returns {{ changes: Object, rationale: Object } | null}
 */
export function evolveThresholds(perfData, config) {
  if (!perfData || perfData.length < MIN_EVOLVE_POSITIONS) return null;

  // Rolling window — only learn from recent data
  const windowMs = (config.darwin?.windowDays ?? 60) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const recentData = perfData.filter(p => {
    const ts = new Date(p.recorded_at).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });
  if (recentData.length < MIN_EVOLVE_POSITIONS) return null;

  const winners = recentData.filter((p) => p.pnl_pct > 0);
  const losers  = recentData.filter((p) => p.pnl_pct < -5);

  // Need at least some signal in both directions before adjusting
  const hasSignal = winners.length >= 2 || losers.length >= 2;
  if (!hasSignal) return null;

  const changes   = {};
  const rationale = {};

  // ── 1. maxVolatility ─────────────────────────────────────────
  // If losers tend to cluster at higher volatility → tighten the ceiling.
  // If winners span higher volatility safely → we can loosen a bit.
  {
    const winnerVols = winners.map((p) => p.volatility).filter(isFiniteNum);
    const loserVols  = losers.map((p) => p.volatility).filter(isFiniteNum);
    const current    = config.screening.maxVolatility;

    if (loserVols.length >= 2) {
      // 25th percentile of loser volatilities — this is where things start going wrong
      const loserP25 = percentile(loserVols, 25);
      if (loserP25 < current) {
        // Tighten: new ceiling = loserP25 + a small buffer
        const target  = loserP25 * 1.15;
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 1.0, 20.0);
        const rounded = Number(newVal.toFixed(1));
        if (rounded < current) {
          changes.maxVolatility = rounded;
          rationale.maxVolatility = `Losers clustered at volatility ~${loserP25.toFixed(1)} — tightened from ${current} → ${rounded}`;
        }
      }
    } else if (winnerVols.length >= 3 && losers.length === 0) {
      // All winners so far — loosen conservatively so we don't miss good pools
      const winnerP75 = percentile(winnerVols, 75);
      if (winnerP75 > current * 1.1) {
        const target  = winnerP75 * 1.1;
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 1.0, 20.0);
        const rounded = Number(newVal.toFixed(1));
        if (rounded > current) {
          changes.maxVolatility = rounded;
          rationale.maxVolatility = `All ${winners.length} positions profitable — loosened from ${current} → ${rounded}`;
        }
      }
    }
  }

  // ── 2. minFeeTvlRatio ─────────────────────────────────────────
  // Raise the floor if low-fee pools consistently underperform.
  {
    const winnerFees = winners.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const loserFees  = losers.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const current    = config.screening.minFeeActiveTvlRatio;

    if (winnerFees.length >= 2) {
      // Minimum fee/TVL among winners — we know pools below this don't work for us
      const minWinnerFee = Math.min(...winnerFees);
      if (minWinnerFee > current * 1.2) {
        const target  = minWinnerFee * 0.85; // stay slightly below min winner
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
        const rounded = Number(newVal.toFixed(2));
        if (rounded > current) {
          changes.minFeeActiveTvlRatio = rounded;
          rationale.minFeeActiveTvlRatio = `Lowest winner fee_tvl=${minWinnerFee.toFixed(2)} — raised floor from ${current} → ${rounded}`;
        }
      }
    }

    if (loserFees.length >= 2) {
      // If losers all had high fee/TVL, that's noise (pumps then crash) — don't raise min
      // But if losers had low fee/TVL, raise min
      const maxLoserFee = Math.max(...loserFees);
      if (maxLoserFee < current * 1.5 && winnerFees.length > 0) {
        const minWinnerFee = Math.min(...winnerFees);
        if (minWinnerFee > maxLoserFee) {
          const target  = maxLoserFee * 1.2;
          const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
          const rounded = Number(newVal.toFixed(2));
          if (rounded > current && !changes.minFeeActiveTvlRatio) {
            changes.minFeeActiveTvlRatio = rounded;
            rationale.minFeeActiveTvlRatio = `Losers had fee_tvl<=${maxLoserFee.toFixed(2)}, winners higher — raised floor from ${current} → ${rounded}`;
          }
        }
      }
    }
  }

  // ── 3. minOrganic ─────────────────────────────────────────────
  // Raise organic floor if low-organic tokens consistently failed.
  {
    const loserOrganics  = losers.map((p) => p.organic_score).filter(isFiniteNum);
    const winnerOrganics = winners.map((p) => p.organic_score).filter(isFiniteNum);
    const current        = config.screening.minOrganic;

    if (loserOrganics.length >= 2 && winnerOrganics.length >= 1) {
      const avgLoserOrganic  = avg(loserOrganics);
      const avgWinnerOrganic = avg(winnerOrganics);
      // Only raise if there's a clear gap (winners consistently more organic)
      if (avgWinnerOrganic - avgLoserOrganic >= 10) {
        // Set floor just below worst winner
        const minWinnerOrganic = Math.min(...winnerOrganics);
        const target = Math.max(minWinnerOrganic - 3, current);
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 60, 90);
        if (newVal > current) {
          changes.minOrganic = newVal;
          rationale.minOrganic = `Winner avg organic ${avgWinnerOrganic.toFixed(0)} vs loser avg ${avgLoserOrganic.toFixed(0)} — raised from ${current} → ${newVal}`;
        }
      }
    }
  }

  // ── 4. minHolders ─────────────────────────────────────────────
  // Raise holder floor if low-holder tokens consistently lost.
  {
    const loserHolders  = losers.map((p) => p.holder_count ?? p.holders).filter(isFiniteNum);
    const winnerHolders = winners.map((p) => p.holder_count ?? p.holders).filter(isFiniteNum);
    const current       = config.screening.minHolders;

    if (winnerHolders.length >= 2 && loserHolders.length >= 1) {
      const avgWinnerHolders = avg(winnerHolders);
      const avgLoserHolders  = avg(loserHolders);
      if (avgWinnerHolders - avgLoserHolders >= 100) {
        const minWinnerHolder = Math.min(...winnerHolders);
        const target = Math.max(minWinnerHolder - 50, current);
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 100, 2000);
        if (newVal > current) {
          changes.minHolders = newVal;
          rationale.minHolders = `Winner avg holders ${Math.round(avgWinnerHolders)} vs loser avg ${Math.round(avgLoserHolders)} — raised from ${current} → ${newVal}`;
        }
      }
    }
  }

  // ── 5. minVolume ──────────────────────────────────────────────
  // Raise volume floor if low-volume pools consistently lost.
  {
    const winnerVols = winners.map((p) => p.volume ?? p.volume_window).filter(isFiniteNum);
    const loserVols  = losers.map((p) => p.volume ?? p.volume_window).filter(isFiniteNum);
    const current    = config.screening.minVolume;

    if (winnerVols.length >= 2) {
      const minWinnerVol = Math.min(...winnerVols);
      if (minWinnerVol > current * 1.2) {
        const target  = minWinnerVol * 0.85;
        const newVal  = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 100, 50000);
        if (newVal > current) {
          changes.minVolume = newVal;
          rationale.minVolume = `Lowest winner volume=${Math.round(minWinnerVol)} — raised floor from ${current} → ${newVal}`;
        }
      }
    }
  }

  // ── 6. outOfRangeWaitMinutes ──────────────────────────────────
  // If OOR positions that waited longer eventually profited, loosen.
  // If OOR positions always lost, tighten.
  {
    const oorPositions = recentData.filter(p => (p.minutes_held ?? 0) - (p.minutes_in_range ?? 0) > 5);
    const oorWinners = oorPositions.filter(p => p.pnl_pct > 0);
    const oorLosers  = oorPositions.filter(p => p.pnl_pct < -5);
    const current    = config.management.outOfRangeWaitMinutes;

    if (oorPositions.length >= 3) {
      if (oorWinners.length >= 2) {
        const oorWinnerHolds = oorWinners.map(p => p.minutes_held).filter(isFiniteNum);
        if (oorWinnerHolds.length >= 2) {
          const medianHold = percentile(oorWinnerHolds, 50);
          const target = Math.min(medianHold * 0.8, 60);
          const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 10, 60);
          if (newVal > current) {
            changes.outOfRangeWaitMinutes = newVal;
            rationale.outOfRangeWaitMinutes = `${oorWinners.length} good OOR recoveries — relaxed from ${current} → ${newVal}m`;
          }
        }
      } else if (oorLosers.length >= 3 && oorWinners.length === 0) {
        const target = current * 0.8;
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 10, 60);
        if (newVal < current) {
          changes.outOfRangeWaitMinutes = newVal;
          rationale.outOfRangeWaitMinutes = `All ${oorLosers.length} OOR positions lost — tightened from ${current} → ${newVal}m`;
        }
      }
    }
  }

  if (Object.keys(changes).length === 0) return { changes: {}, rationale: {} };

  // ── Persist changes to user-config.json ───────────────────────
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  }

  Object.assign(userConfig, changes);
  // Migrate old key if present
  if (userConfig.minFeeTvlRatio != null) {
    if (userConfig.minFeeActiveTvlRatio == null) userConfig.minFeeActiveTvlRatio = userConfig.minFeeTvlRatio;
    delete userConfig.minFeeTvlRatio;
  }
  userConfig._lastEvolved = new Date().toISOString();
  userConfig._positionsAtEvolution = recentData.length;

  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

  // Apply to live config object immediately
  const s = config.screening;
  if (changes.maxVolatility         != null) s.maxVolatility         = changes.maxVolatility;
  if (changes.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = changes.minFeeActiveTvlRatio;
  if (changes.minOrganic            != null) s.minOrganic            = changes.minOrganic;
  if (changes.minHolders            != null) s.minHolders            = changes.minHolders;
  if (changes.minVolume             != null) s.minVolume             = changes.minVolume;
  if (changes.outOfRangeWaitMinutes != null) config.management.outOfRangeWaitMinutes = changes.outOfRangeWaitMinutes;

  // Log a lesson summarizing the evolution
  const data = load();
  const windowLabel = config.darwin?.windowDays ?? 60;
  data.lessons.push({
    id: Date.now(),
    rule: `[AUTO-EVOLVED @ ${recentData.length} positions (${windowLabel}d window)] ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ")} — ${Object.values(rationale).join("; ")}`,
    type: "evolved",
    tags: ["evolution", "config_change"],
    outcome: "manual",
    pattern: null,
    score: 1.0,
    expires_at: computeExpiresAt("evolved", config.lessons),
    created_at: new Date().toISOString(),
  });
  save(data);

  return { changes, rationale };
}

// ─── Helpers ───────────────────────────────────────────────────

function isFiniteNum(n) {
  return typeof n === "number" && isFinite(n);
}

function avg(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/** Move current toward target by at most maxChange fraction. */
function nudge(current, target, maxChange) {
  const delta = target - current;
  const maxDelta = current * maxChange;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

// ─── Manual Lessons ────────────────────────────────────────────

/**
 * Add a manual lesson (e.g. from operator observation).
 *
 * @param {string}   rule
 * @param {string[]} tags
 * @param {Object}   opts
 * @param {boolean}  opts.pinned - Always inject regardless of cap
 * @param {string}   opts.role   - "SCREENER" | "MANAGER" | "GENERAL" | null (all roles)
 */
export async function addLesson(rule, tags = [], { pinned = false, role = null } = {}) {
  const safeRule = sanitizeLessonText(rule);
  if (!safeRule) return;
  const { config } = await import("./config.js");
  const data = load();
  data.lessons.push({
    id: Date.now(),
    rule: safeRule,
    type: "specific",
    tags,
    outcome: "manual",
    pinned: !!pinned,
    role: role || null,
    pattern: null,
    score: 1.0,
    expires_at: pinned ? null : computeExpiresAt("specific", config.lessons),
    created_at: new Date().toISOString(),
  });
  save(data);
  pruneLessons(config.lessons);
  log("lessons", `Manual lesson added${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${safeRule}`);
}

/**
 * Pin a lesson by ID — pinned lessons are always injected regardless of cap.
 */
export function pinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = true;
  save(data);
  log("lessons", `Pinned lesson ${id}: ${lesson.rule.slice(0, 60)}`);
  return { found: true, pinned: true, id, rule: lesson.rule };
}

/**
 * Unpin a lesson by ID.
 */
export function unpinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = false;
  save(data);
  return { found: true, pinned: false, id, rule: lesson.rule };
}

/**
 * List lessons with optional filters — for agent browsing via Telegram.
 */
export function listLessons({ role = null, pinned = null, tag = null, limit = 30 } = {}) {
  const data = load();
  let lessons = [...data.lessons];

  if (pinned !== null) lessons = lessons.filter((l) => !!l.pinned === pinned);
  if (role)            lessons = lessons.filter((l) => !l.role || l.role === role);
  if (tag)             lessons = lessons.filter((l) => l.tags?.includes(tag));

  return {
    total: lessons.length,
    lessons: lessons.slice(-limit).map((l) => ({
      id: l.id,
      rule: l.rule.slice(0, 120),
      tags: l.tags,
      outcome: l.outcome,
      pinned: !!l.pinned,
      role: l.role || "all",
      created_at: l.created_at?.slice(0, 10),
    })),
  };
}

/**
 * Remove a lesson by ID.
 */
export function removeLesson(id) {
  const data = load();
  const before = data.lessons.length;
  data.lessons = data.lessons.filter((l) => l.id !== id);
  save(data);
  return before - data.lessons.length;
}

/**
 * Remove lessons matching a keyword in their rule text (case-insensitive).
 */
export function removeLessonsByKeyword(keyword) {
  const data = load();
  const before = data.lessons.length;
  const kw = keyword.toLowerCase();
  data.lessons = data.lessons.filter((l) => !l.rule.toLowerCase().includes(kw));
  save(data);
  return before - data.lessons.length;
}

/**
 * Clear ALL lessons (keeps performance data).
 */
export function clearAllLessons() {
  const data = load();
  const count = data.lessons.length;
  data.lessons = [];
  save(data);
  return count;
}

/**
 * Clear ALL performance records.
 */
export function clearPerformance() {
  const data = load();
  const count = data.performance.length;
  data.performance = [];
  save(data);
  return count;
}

// ─── Lesson Retrieval ──────────────────────────────────────────

// Tags that map to each agent role — used for role-aware lesson injection
const ROLE_TAGS = {
  SCREENER: ["screening", "narrative", "strategy", "deployment", "token", "volume", "entry", "bundler", "holders", "organic"],
  MANAGER:  ["management", "risk", "oor", "fees", "position", "hold", "close", "pnl", "rebalance", "claim"],
  GENERAL:  [], // all lessons
};

/**
 * Get lessons formatted for injection into the system prompt.
 * Structured injection with three tiers:
 *   1. Pinned        — always injected, up to PINNED_CAP
 *   2. Role-matched  — lessons tagged for this agentType, up to ROLE_CAP
 *   3. Recent        — fill remaining slots up to RECENT_CAP
 *
 * @param {Object} opts
 * @param {string} [opts.agentType]  - "SCREENER" | "MANAGER" | "GENERAL"
 * @param {number} [opts.maxLessons] - Override total cap (default 35)
 */
export function getLessonsForPrompt(opts = {}) {
  // Support legacy call signature: getLessonsForPrompt(20)
  if (typeof opts === "number") opts = { maxLessons: opts };

  const { agentType = "GENERAL", maxLessons } = opts;

  const data = load();
  const now = Date.now();
  const activeLessons = data.lessons.filter(l =>
    l.pinned || !l.expires_at || new Date(l.expires_at).getTime() > now
  );
  if (activeLessons.length === 0) return null;

  // Smaller caps for automated cycles — they don't need the full lesson history
  const isAutoCycle = agentType === "SCREENER" || agentType === "MANAGER";
  const PINNED_CAP  = isAutoCycle ? 5  : 10;
  const ROLE_CAP    = isAutoCycle ? 6  : 15;
  const RECENT_CAP  = maxLessons ?? (isAutoCycle ? 10 : 35);

  const byScore = (a, b) => computeScore(b) - computeScore(a);

  // ── Tier 1: Pinned ──────────────────────────────────────────────
  // Respect role even for pinned lessons — a pinned SCREENER lesson shouldn't pollute MANAGER
  const pinned = activeLessons
    .filter((l) => l.pinned && (!l.role || l.role === agentType || agentType === "GENERAL"))
    .sort(byScore)
    .slice(0, PINNED_CAP);

  const usedIds = new Set(pinned.map((l) => l.id));

  // ── Tier 2: Role-matched ────────────────────────────────────────
  const roleTags = ROLE_TAGS[agentType] || [];
  const roleMatched = activeLessons
    .filter((l) => {
      if (usedIds.has(l.id)) return false;
      // Include if: lesson has no role restriction OR matches this role
      const roleOk = !l.role || l.role === agentType || agentType === "GENERAL";
      // Include if: lesson has role-relevant tags OR no tags (general)
      const tagOk  = roleTags.length === 0 || !l.tags?.length || l.tags.some((t) => roleTags.includes(t));
      return roleOk && tagOk;
    })
    .sort(byScore)
    .slice(0, ROLE_CAP);

  roleMatched.forEach((l) => usedIds.add(l.id));

  // ── Tier 3: Recent fill ─────────────────────────────────────────
  const remainingBudget = RECENT_CAP - pinned.length - roleMatched.length;
  const recent = remainingBudget > 0
    ? activeLessons
        .filter((l) => !usedIds.has(l.id))
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
        .slice(0, remainingBudget)
    : [];

  const selected = [...pinned, ...roleMatched, ...recent];
  if (selected.length === 0) return null;

  const sections = [];
  if (pinned.length)      sections.push(`── PINNED (${pinned.length}) ──\n` + fmt(pinned));
  if (roleMatched.length) sections.push(`── ${agentType} (${roleMatched.length}) ──\n` + fmt(roleMatched));
  if (recent.length)      sections.push(`── RECENT (${recent.length}) ──\n` + fmt(recent));

  return sections.join("\n\n");
}

function fmt(lessons) {
  return lessons.map((l) => {
    const date = l.created_at ? l.created_at.slice(0, 16).replace("T", " ") : "unknown";
    const pin  = l.pinned ? "📌 " : "";
    return `${pin}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
  }).join("\n");
}

/**
 * Get individual performance records filtered by time window.
 * Tool handler: get_performance_history
 *
 * @param {Object} opts
 * @param {number} [opts.hours=24]   - How many hours back to look
 * @param {number} [opts.limit=50]   - Max records to return
 */
export function getPerformanceHistory({ hours = 24, limit = 50 } = {}) {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return { positions: [], count: 0, hours };

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const filtered = p
    .filter((r) => r.recorded_at >= cutoff)
    .slice(-limit)
    .map((r) => ({
      pool_name: r.pool_name,
      pool: r.pool,
      strategy: r.strategy,
      pnl_usd: r.pnl_usd,
      pnl_pct: r.pnl_pct,
      fees_earned_usd: r.fees_earned_usd,
      range_efficiency: r.range_efficiency,
      minutes_held: r.minutes_held,
      close_reason: r.close_reason,
      closed_at: r.recorded_at,
    }));

  const totalPnl = filtered.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = filtered.filter((r) => r.pnl_usd > 0).length;

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    positions: filtered,
  };
}

/**
 * Get performance stats summary.
 */
export function getPerformanceSummary() {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return null;

  const totalPnl = p.reduce((s, x) => s + x.pnl_usd, 0);
  const avgPnlPct = p.reduce((s, x) => s + x.pnl_pct, 0) / p.length;
  const avgRangeEfficiency = p.reduce((s, x) => s + x.range_efficiency, 0) / p.length;
  const wins = p.filter((x) => x.pnl_usd > 0).length;

  return {
    total_positions_closed: p.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    avg_pnl_pct: Math.round(avgPnlPct * 100) / 100,
    avg_range_efficiency_pct: Math.round(avgRangeEfficiency * 10) / 10,
    win_rate_pct: Math.round((wins / p.length) * 100),
    total_lessons: data.lessons.length,
  };
}
