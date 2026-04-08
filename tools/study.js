import { getPriceOfBinByBinId } from "@meteora-ag/dlmm";

/**
 * Study top open LPers for a pool and extract behavioural patterns.
 * Used by the /learn command — not called on every cycle.
 */

const AGENT_MERIDIAN_API = "https://api.agentmeridian.xyz/api";
const AGENT_MERIDIAN_PUBLIC_KEY =
  process.env.PUBLIC_API_KEY || "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";

/**
 * Fetch top open LPers for a pool, filter to credible performers,
 * and return condensed behaviour patterns for LLM consumption.
 */
export async function studyTopLPers({ pool_address, limit = 4 }) {
  const headers = { "x-api-key": AGENT_MERIDIAN_PUBLIC_KEY };
  const [poolRes, signalRes] = await Promise.all([
    fetch(`${AGENT_MERIDIAN_API}/pools/${pool_address}`, { headers }),
    fetch(`${AGENT_MERIDIAN_API}/agent/pools/${pool_address}/signal`, { headers }),
  ]);

  if (!poolRes.ok) {
    if (poolRes.status === 429) {
      throw new Error("Rate limit exceeded. Please wait 60 seconds before studying this pool again.");
    }
    throw new Error(`pool study API error: ${poolRes.status}`);
  }

  if (!signalRes.ok) {
    if (signalRes.status === 429) {
      throw new Error("Rate limit exceeded. Please wait 60 seconds before studying this pool again.");
    }
    throw new Error(`pool signal API error: ${signalRes.status}`);
  }

  const poolData = await poolRes.json();
  const signalData = await signalRes.json();
  const rows = Array.isArray(poolData.rows) ? poolData.rows : [];
  const overview = poolData.overview || {};

  if (!rows.length) {
    return {
      pool: pool_address,
      message: "No open LP positions found for this pool.",
      patterns: {},
      lpers: [],
    };
  }

  const { byOwner: ownerSignals, byPosition: signalPositions } = buildSignalMaps(signalData);
  const owners = buildOwnerSnapshots(rows, ownerSignals, signalPositions, overview, pool_address);

  // Prefer larger, profitable, more mature open LPs.
  const credible = owners.filter(
    (owner) =>
      owner.summary.total_balance_usd >= 250 &&
      (owner.summary.avg_age_hours == null || owner.summary.avg_age_hours >= 0.08)
  );

  const ranked = (credible.length ? credible : owners)
    .sort((a, b) => scoreOwner(b) - scoreOwner(a))
    .slice(0, limit);

  if (!ranked.length) {
    return {
      pool: pool_address,
      message: "No credible open LPers found for this pool yet.",
      patterns: {},
      lpers: [],
    };
  }

  const patterns = buildPatterns(ranked, signalData, overview);

  return {
    pool: pool_address,
    pool_name:
      overview.name || `${overview.tokenXSymbol || "TOKEN"}-${overview.tokenYSymbol || "SOL"}`,
    message:
      "Open-position LPer study based on current pool rows and derived signal cohorts.",
    patterns,
    lpers: ranked,
  };
}

function buildOwnerSnapshots(rows, ownerSignals, signalPositions, overview, poolAddress) {
  const byOwner = new Map();

  for (const row of rows) {
    const owner = row.owner;
    if (!owner) continue;

    if (!byOwner.has(owner)) {
      byOwner.set(owner, {
        owner,
        owner_short: `${owner.slice(0, 8)}...`,
        signal_tags: [],
        summary: {
          total_positions: 0,
          avg_hold_hours: null,
          avg_open_pnl_pct: null,
          avg_fee_per_tvl_24h_pct: null,
          total_pnl_usd: 0,
          total_balance_usd: 0,
          avg_range_width_pct: null,
          avg_distance_to_active_pct: null,
          win_rate: null,
          roi: null,
          fee_pct_of_capital: null,
        },
        positions: [],
      });
    }

    const entry = byOwner.get(owner);
    const signal = ownerSignals.get(owner);
    const signalPosition = signalPositions.get(row.positionAddress);
    if (signal?.tags?.length) {
      entry.signal_tags = Array.from(new Set([...entry.signal_tags, ...signal.tags]));
    }

    const ageHours =
      toHours(row.createdAt) ??
      (isNum(num(signalPosition?.ageSeconds)) ? round(num(signalPosition.ageSeconds) / 3600, 2) : null);
    const pnlUsd = num(row.pnl?.usd);
    const pnlPct = num(row.pnl?.pct);
    const balanceUsd = num(row.balances?.usd);
    const feePerTvl24h = num(row.feePerTvl24h);
    const minPrice = num(row.range?.minPrice);
    const maxPrice = num(row.range?.maxPrice);
    const lowerBinId = row.range?.lowerBinId ?? signalPosition?.lowerBinId ?? null;
    const upperBinId = row.range?.upperBinId ?? signalPosition?.upperBinId ?? null;
    const activeBinId = row.poolActiveBinId ?? poolDataActiveBinIdFallback(signalPosition, signal) ?? null;
    const rangeWidthPct =
      calcRangeWidthPctFromBins(lowerBinId, upperBinId, overview.binStep) ??
      (minPrice > 0 && maxPrice > 0 ? ((maxPrice - minPrice) / minPrice) * 100 : null);
    const distanceToActivePct =
      num(signalPosition?.distanceToActivePct) ??
      num(signal?.distanceToActivePct) ??
      calcDistanceToActivePctFromBins(activeBinId, lowerBinId, upperBinId, overview.binStep) ??
      calcDistanceToActivePct(row.poolActivePrice, minPrice, maxPrice);

    entry.positions.push({
      pool: poolAddress,
      pair:
        overview.name ||
        `${overview.tokenXSymbol || "TOKEN"}-${overview.tokenYSymbol || "SOL"}`,
      hold_hours: ageHours,
      pnl_usd: round(pnlUsd, 2),
      pnl_pct: fmtPct(pnlPct),
      fee_usd: null,
      in_range_pct: null,
      strategy: null,
      closed_reason:
        signalPosition?.cohortTag ||
        signal?.tags?.join(", ") ||
        null,
      balance_usd: round(balanceUsd, 2),
      fee_per_tvl_24h_pct: feePerTvl24h != null ? round(feePerTvl24h * 100, 2) : null,
      range_width_pct: rangeWidthPct != null ? round(rangeWidthPct, 2) : null,
      distance_to_active_pct: distanceToActivePct != null ? round(distanceToActivePct, 2) : null,
      lower_bin_id: lowerBinId,
      upper_bin_id: upperBinId,
    });

    entry.summary.total_positions += 1;
    entry.summary.total_pnl_usd += pnlUsd || 0;
    entry.summary.total_balance_usd += balanceUsd || 0;
  }

  for (const entry of byOwner.values()) {
    const positions = entry.positions;
    const holdHours = positions.map((p) => p.hold_hours).filter(isNum);
    const pnlPcts = positions.map((p) => parsePct(p.pnl_pct)).filter(isNum);
    const fee24s = positions.map((p) => p.fee_per_tvl_24h_pct).filter(isNum);
    const widths = positions.map((p) => p.range_width_pct).filter(isNum);
    const distances = positions.map((p) => p.distance_to_active_pct).filter(isNum);

    entry.summary.avg_hold_hours = avg(holdHours);
    entry.summary.avg_open_pnl_pct = avg(pnlPcts);
    entry.summary.avg_fee_per_tvl_24h_pct = avg(fee24s);
    entry.summary.avg_range_width_pct = avg(widths);
    entry.summary.avg_distance_to_active_pct = avg(distances);
    // Keep legacy-ish fields for prompt compatibility.
    entry.summary.win_rate = positions.length
      ? round(positions.filter((p) => parsePct(p.pnl_pct) > 0).length / positions.length, 2)
      : null;
    entry.summary.roi =
      entry.summary.total_balance_usd > 0
        ? round(entry.summary.total_pnl_usd / entry.summary.total_balance_usd, 4)
        : null;
    entry.summary.fee_pct_of_capital =
      entry.summary.avg_fee_per_tvl_24h_pct != null
        ? round(entry.summary.avg_fee_per_tvl_24h_pct, 2)
        : null;
    entry.summary.total_pnl_usd = round(entry.summary.total_pnl_usd, 2);
    entry.summary.total_balance_usd = round(entry.summary.total_balance_usd, 2);
  }

  return Array.from(byOwner.values());
}

function buildPatterns(ranked, signalData, overview) {
  const avgHold = avg(ranked.map((o) => o.summary.avg_hold_hours).filter(isNum));
  const avgOpenPnlPct = avg(ranked.map((o) => o.summary.avg_open_pnl_pct).filter(isNum));
  const avgFeePerTvl = avg(ranked.map((o) => o.summary.avg_fee_per_tvl_24h_pct).filter(isNum));
  const avgWidth = avg(ranked.map((o) => o.summary.avg_range_width_pct).filter(isNum));
  const avgDistance = avg(ranked.map((o) => o.summary.avg_distance_to_active_pct).filter(isNum));

  return {
    top_lper_count: ranked.length,
    study_mode: "open_positions",
    pool_name:
      overview.name || `${overview.tokenXSymbol || "TOKEN"}-${overview.tokenYSymbol || "SOL"}`,
    active_position_count: signalData.activePositionCount ?? null,
    owner_count: signalData.ownerCount ?? null,
    avg_hold_hours: avgHold,
    avg_open_pnl_pct: avgOpenPnlPct,
    avg_fee_per_tvl_24h_pct: avgFeePerTvl,
    avg_range_width_pct: avgWidth,
    avg_distance_to_active_pct: avgDistance,
    best_open_pnl_pct: maxOf(ranked.map((o) => o.summary.avg_open_pnl_pct)) != null
      ? `${round(maxOf(ranked.map((o) => o.summary.avg_open_pnl_pct)), 2)}%`
      : null,
    scalper_count: ranked.filter((o) => o.summary.avg_hold_hours < 1).length,
    holder_count: ranked.filter((o) => o.summary.avg_hold_hours >= 4).length,
    mature_winner_count: (signalData.matureWinners?.positions || []).length,
    support_anchor_count: (signalData.supportAnchors?.positions || []).length,
    recent_entrant_count: (signalData.recentEntrants?.positions || []).length,
    suggested_range: signalData.suggestedRange || null,
  };
}

function buildSignalMaps(signalData) {
  const byOwner = new Map();
  const byPosition = new Map();

  const add = (owner, tag, position) => {
    if (!owner) return;
    if (!byOwner.has(owner)) {
      byOwner.set(owner, { tags: [], distanceToActivePct: null, samples: [] });
    }
    const current = byOwner.get(owner);
    current.tags = Array.from(new Set([...current.tags, tag]));
    if (current.distanceToActivePct == null && isNum(num(position?.distanceToActivePct))) {
      current.distanceToActivePct = num(position.distanceToActivePct);
    }
    if (position) current.samples.push(position);
    if (position?.positionAddress && !byPosition.has(position.positionAddress)) {
      byPosition.set(position.positionAddress, {
        ...position,
        cohortTag: tag,
      });
    }
  };

  for (const key of [
    "topWinnersByUsd",
    "topWinnersByPct",
    "topLosersByUsd",
    "topLosersByPct",
  ]) {
    for (const position of signalData[key] || []) {
      add(position.owner, key, position);
    }
  }

  for (const [key, tag] of [
    ["recentEntrants", "recent_entrant"],
    ["matureWinners", "mature_winner"],
    ["recentLosersAboveActive", "recent_loser_above_active"],
    ["supportAnchors", "support_anchor"],
  ]) {
    for (const position of signalData[key]?.positions || []) {
      add(position.owner, tag, position);
    }
  }

  return { byOwner, byPosition };
}

function scoreOwner(owner) {
  const s = owner.summary;
  const tags = owner.signal_tags || [];
  let score = 0;
  score += (s.avg_open_pnl_pct || 0) * 3;
  score += (s.avg_fee_per_tvl_24h_pct || 0) * 0.8;
  score += Math.min(s.total_balance_usd || 0, 5000) / 500;
  score += tags.includes("mature_winner") ? 6 : 0;
  score += tags.includes("support_anchor") ? 4 : 0;
  score += tags.includes("topWinnersByUsd") ? 3 : 0;
  score += tags.includes("topWinnersByPct") ? 2 : 0;
  score -= tags.includes("topLosersByUsd") ? 4 : 0;
  score -= tags.includes("topLosersByPct") ? 2 : 0;
  return score;
}

function calcDistanceToActivePct(activePrice, minPrice, maxPrice) {
  const active = num(activePrice);
  if (!isNum(active) || (!isNum(minPrice) && !isNum(maxPrice))) return null;
  if (isNum(minPrice) && active < minPrice) return ((minPrice - active) / minPrice) * 100;
  if (isNum(maxPrice) && active > maxPrice) return ((active - maxPrice) / maxPrice) * 100;
  if (isNum(minPrice) && isNum(maxPrice)) {
    const mid = (minPrice + maxPrice) / 2;
    return mid > 0 ? (Math.abs(active - mid) / mid) * 100 : 0;
  }
  return null;
}

function calcRangeWidthPctFromBins(lowerBinId, upperBinId, binStep) {
  if (!isNum(num(lowerBinId)) || !isNum(num(upperBinId)) || !isNum(num(binStep))) return null;
  const low = Number(getPriceOfBinByBinId(Number(lowerBinId), Number(binStep)).toString());
  const high = Number(getPriceOfBinByBinId(Number(upperBinId), Number(binStep)).toString());
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= 0) return null;
  return ((high - low) / low) * 100;
}

function calcDistanceToActivePctFromBins(activeBinId, lowerBinId, upperBinId, binStep) {
  if (
    !isNum(num(activeBinId)) ||
    !isNum(num(lowerBinId)) ||
    !isNum(num(upperBinId)) ||
    !isNum(num(binStep))
  ) return null;

  const active = Number(getPriceOfBinByBinId(Number(activeBinId), Number(binStep)).toString());
  const low = Number(getPriceOfBinByBinId(Number(lowerBinId), Number(binStep)).toString());
  const high = Number(getPriceOfBinByBinId(Number(upperBinId), Number(binStep)).toString());
  if (!Number.isFinite(active) || !Number.isFinite(low) || !Number.isFinite(high)) return null;

  return calcDistanceToActivePct(active, low, high);
}

function poolDataActiveBinIdFallback(signalPosition, signal) {
  return signalPosition?.activeBinId ?? signal?.samples?.[0]?.activeBinId ?? null;
}

function toHours(iso) {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return round((Date.now() - ts) / 3600000, 2);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtPct(value) {
  return isNum(value) ? `${round(value, 2)}%` : null;
}

function parsePct(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  return num(value.replace("%", ""));
}

function avg(arr) {
  if (!arr.length) return null;
  return round(arr.reduce((s, x) => s + x, 0) / arr.length, 2);
}

function maxOf(arr) {
  const nums = arr.filter(isNum);
  if (!nums.length) return null;
  return Math.max(...nums);
}

function round(n, digits = 2) {
  if (!isNum(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function isNum(n) {
  return typeof n === "number" && Number.isFinite(n);
}
