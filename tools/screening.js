import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";



/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = 50,
} = {}) {
  const s = config.screening;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    `tvl<=${s.maxTvl}`,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    "quote_token_organic_score>=60",
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
    s.maxVolatility    != null ? `volatility<=${s.maxVolatility}` : null,
  ].filter(Boolean).join("&&");

  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${s.timeframe}` +
    `&category=${s.category}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  const condensed = (data.data || []).map(condensePool);

  // Hard-filter blacklisted tokens and blocked deployers (what pool discovery already gave us)
  let pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens/devs`);

  // If pool discovery didn't supply dev field, batch-fetch from Jupiter for any pools
  // where dev is null — but only if the dev blocklist is non-empty (avoid useless calls)
  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await Promise.allSettled(
        missingDev.map((p) =>
          fetch(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              const t = Array.isArray(d) ? d[0] : d;
              return { pool: p.pool, dev: t?.dev || null };
            })
            .catch(() => ({ pool: p.pool, dev: null }))
        )
      );
      const devMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") devMap[r.value.pool] = r.value.dev;
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        if (dev) p.dev = dev; // enrich in-place
        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          return false;
        }
        return true;
      });
    }
  }

  return {
    total: data.total,
    pools,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  const { pools } = await discoverPools({ page_size: 50 });
  const filteredOut = [];

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));

  const eligible = pools
    .filter((p) => {
      if (occupiedPools.has(p.pool)) {
        pushFilteredReason(filteredOut, p, "already have an open position in this pool");
        return false;
      }
      if (occupiedMints.has(p.base?.mint)) {
        pushFilteredReason(filteredOut, p, "already holding this base token in another pool");
        return false;
      }
      if (isPoolOnCooldown(p.pool)) {
        log("screening", `Filtered cooldown pool ${p.name} (${p.pool.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "pool cooldown active");
        return false;
      }
      if (isBaseMintOnCooldown(p.base?.mint)) {
        log("screening", `Filtered cooldown token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "token cooldown active");
        return false;
      }
      return true;
    })
    .slice(0, limit);

  if (config.screening.avoidPvpSymbols && eligible.length > 0) {
    await enrichPvpRisk(eligible);
    if (config.screening.blockPvpSymbols) {
      const before = eligible.length;
      const pvpRemoved = eligible.filter((p) => p.is_pvp);
      pvpRemoved.forEach((p) => pushFilteredReason(filteredOut, p, "PVP hard filter"));
      eligible.splice(0, eligible.length, ...eligible.filter((p) => !p.is_pvp));
      if (eligible.length < before) {
        log("screening", `PVP hard filter removed ${before - eligible.length} pool(s)`);
      }
    }
  }
  // Enrich with OKX data — advanced info (risk/bundle/sniper) + ATH price (no API key required)
  if (eligible.length > 0) {
    const { getAdvancedInfo, getPriceInfo, getClusterList, getRiskFlags } = await import("./okx.js");
    const okxResults = await Promise.allSettled(
      eligible.map(async (p) => {
        if (!p.base?.mint) return { adv: null, price: null, clusters: [], risk: null };
        const [adv, price, clusters, risk] = await Promise.allSettled([
          getAdvancedInfo(p.base.mint),
          getPriceInfo(p.base.mint),
          getClusterList(p.base.mint),
          getRiskFlags(p.base.mint),
        ]);

        const mintShort = p.base.mint.slice(0, 8);
        if (adv.status !== "fulfilled")      log("okx", `advanced-info unavailable for ${p.name} (${mintShort})`);
        if (price.status !== "fulfilled")    log("okx", `price-info unavailable for ${p.name} (${mintShort})`);
        if (clusters.status !== "fulfilled") log("okx", `cluster-list unavailable for ${p.name} (${mintShort})`);
        if (risk.status !== "fulfilled")     log("okx", `risk-check unavailable for ${p.name} (${mintShort})`);

        return {
          adv: adv.status === "fulfilled" ? adv.value : null,
          price: price.status === "fulfilled" ? price.value : null,
          clusters: clusters.status === "fulfilled" ? clusters.value : [],
          risk: risk.status === "fulfilled" ? risk.value : null,
        };
      })
    );
    for (let i = 0; i < eligible.length; i++) {
      const r = okxResults[i];
      if (r.status !== "fulfilled") continue;
      const { adv, price, clusters, risk } = r.value;
      if (adv) {
        eligible[i].risk_level      = adv.risk_level;
        eligible[i].bundle_pct      = adv.bundle_pct;
        eligible[i].sniper_pct      = adv.sniper_pct;
        eligible[i].suspicious_pct  = adv.suspicious_pct;
        eligible[i].smart_money_buy = adv.smart_money_buy;
        eligible[i].dev_sold_all    = adv.dev_sold_all;
        eligible[i].dex_boost       = adv.dex_boost;
        eligible[i].dex_screener_paid = adv.dex_screener_paid;
        if (adv.creator && !eligible[i].dev) eligible[i].dev = adv.creator;
      }
      if (risk) {
        eligible[i].is_rugpull = risk.is_rugpull;
        eligible[i].is_wash    = risk.is_wash;
      }
      if (price) {
        eligible[i].price_vs_ath_pct = price.price_vs_ath_pct;
        eligible[i].ath              = price.ath;
      }
      if (clusters?.length) {
        // Surface KOL presence and top cluster trend for LLM
        eligible[i].kol_in_clusters      = clusters.some((c) => c.has_kol);
        eligible[i].top_cluster_trend    = clusters[0]?.trend ?? null;      // buy|sell|neutral
        eligible[i].top_cluster_hold_pct = clusters[0]?.holding_pct ?? null;
      }
    }
    // Wash trading hard filter — fake volume = misleading fee yield
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      if (p.is_wash) {
        log("screening", `Risk filter: dropped ${p.name} — wash trading flagged`);
        pushFilteredReason(filteredOut, p, "wash trading flagged");
        return false;
      }
      return true;
    }));

    // ── Pool age window filter ────────────────────────────────────────
    // Very new tokens (<4h): metrics inflated — first LPs capture all fees, volume unsustained.
    // Very old tokens (>7d): established but possibly saturated with LPs.
    {
      const minAge = config.screening.minPoolAgeHours;
      const maxAge = config.screening.maxPoolAgeHours;
      if (minAge != null || maxAge != null) {
        const before = eligible.length;
        eligible.splice(0, eligible.length, ...eligible.filter((p) => {
          const age = p.token_age_hours;
          if (age == null) return true; // no data → don't filter
          if (minAge != null && age < minAge) {
            log("screening", `Age filter: dropped ${p.name} — token only ${age.toFixed(1)}h old (min ${minAge}h)`);
            pushFilteredReason(filteredOut, p, `token age ${age.toFixed(1)}h < min ${minAge}h`);
            return false;
          }
          if (maxAge != null && age > maxAge) {
            log("screening", `Age filter: dropped ${p.name} — token ${age.toFixed(1)}h old (max ${maxAge}h)`);
            pushFilteredReason(filteredOut, p, `token age ${age.toFixed(1)}h > max ${maxAge}h`);
            return false;
          }
          return true;
        }));
        if (eligible.length < before) log("screening", `Age filter removed ${before - eligible.length} pool(s)`);
      }
    }

    // ── Volume acceleration filter ────────────────────────────────────
    // Skip pools where volume is already collapsing — fees will dry up fast.
    {
      const minAccel = config.screening.minVolumeAccelPct;
      if (minAccel != null) {
        const before = eligible.length;
        eligible.splice(0, eligible.length, ...eligible.filter((p) => {
          const accel = p.volume_change_pct;
          if (accel == null) return true;
          if (accel < minAccel) {
            log("screening", `Volume accel filter: dropped ${p.name} — volume ${accel}% (min ${minAccel}%)`);
            pushFilteredReason(filteredOut, p, `volume change ${accel}% < min ${minAccel}%`);
            return false;
          }
          return true;
        }));
        if (eligible.length < before) log("screening", `Volume accel filter removed ${before - eligible.length} pool(s)`);
      }
    }

    // ── Time-of-day bias ─────────────────────────────────────────────
    // During off-peak hours (low global volume), require higher minimum thresholds.
    // Peak: US hours 14:00-22:00 UTC + Asian partial 01:00-08:00 UTC
    if (config.screening.timeOfDayBias) {
      const hour = new Date().getUTCHours();
      const isPeak = (hour >= 14 && hour < 22) || (hour >= 1 && hour < 8);
      if (!isPeak) {
        const mult = config.screening.offPeakMultiplier ?? 1.3;
        const effectiveMinVolume = (config.screening.minVolume ?? 500) * mult;
        const effectiveMinFeeRatio = (config.screening.minFeeActiveTvlRatio ?? 0.05) * mult;
        const before = eligible.length;
        eligible.splice(0, eligible.length, ...eligible.filter((p) => {
          if (p.volume_window != null && p.volume_window < effectiveMinVolume) {
            log("screening", `Off-peak filter: dropped ${p.name} — vol $${p.volume_window} < $${effectiveMinVolume.toFixed(0)} (off-peak)`);
            pushFilteredReason(filteredOut, p, `off-peak volume $${p.volume_window} < $${effectiveMinVolume.toFixed(0)}`);
            return false;
          }
          if (p.fee_active_tvl_ratio != null && p.fee_active_tvl_ratio < effectiveMinFeeRatio) {
            log("screening", `Off-peak filter: dropped ${p.name} — fee/tvl ${p.fee_active_tvl_ratio} < ${effectiveMinFeeRatio.toFixed(3)} (off-peak)`);
            pushFilteredReason(filteredOut, p, `off-peak fee/tvl ${p.fee_active_tvl_ratio} < ${effectiveMinFeeRatio.toFixed(3)}`);
            return false;
          }
          return true;
        }));
        if (eligible.length < before) log("screening", `Off-peak filter removed ${before - eligible.length} pool(s) [UTC hour: ${hour}]`);
      }
    }

    // Price momentum guard — skip pools where price just pumped hard in the timeframe window.
    // Deploying into a post-pump pool = you LP at/near the top, then price dumps below your range.
    // Token with strong downtrend (price_change_pct very negative) is also risky — already in freefall.
    const maxPump = config.screening.maxEntry5mPricePct;
    const maxDump = config.screening.minEntry5mPricePct;
    if (maxPump != null || maxDump != null) {
      const before = eligible.length;
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        const chg = p.price_change_pct;
        if (chg == null) return true; // no data → don't filter
        if (maxPump != null && chg > maxPump) {
          log("screening", `Momentum filter: dropped ${p.name} — price +${chg}% (limit +${maxPump}%)`);
          pushFilteredReason(filteredOut, p, `price +${chg}% exceeds pump limit +${maxPump}%`);
          return false;
        }
        if (maxDump != null && chg < maxDump) {
          log("screening", `Momentum filter: dropped ${p.name} — price ${chg}% (limit ${maxDump}%)`);
          pushFilteredReason(filteredOut, p, `price ${chg}% below dump limit ${maxDump}%`);
          return false;
        }
        return true;
      }));
      if (eligible.length < before) log("screening", `Momentum filter removed ${before - eligible.length} pool(s)`);
    }

    // ATH filter — drop pools where price is too close to ATH
    const athFilter = config.screening.athFilterPct;
    if (athFilter != null) {
      const threshold = 100 + athFilter; // e.g. -20 → threshold = 80 (price must be <= 80% of ATH)
      const before = eligible.length;
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        if (p.price_vs_ath_pct == null) return true; // no data → don't filter
        if (p.price_vs_ath_pct > threshold) {
          log("screening", `ATH filter: dropped ${p.name} — ${p.price_vs_ath_pct}% of ATH (limit: ${threshold}%)`);
          pushFilteredReason(filteredOut, p, `${p.price_vs_ath_pct}% of ATH > ${threshold}% limit`);
          return false;
        }
        return true;
      }));
      if (eligible.length < before) log("screening", `ATH filter removed ${before - eligible.length} pool(s)`);
    }

    // ── Composite quality scoring ────────────────────────────────────
    // Score each pool on a 0-100 scale before the LLM sees them.
    // Higher score = better risk-adjusted yield expectation.
    // The LLM still makes the final decision, but ranked order means
    // the best pool always appears first when limit is applied.
    for (const p of eligible) {
      let score = 0;

      // ── Yield signals (highest weight) ───────────────────────────
      // daily_yield_pct_est: projected % return per day at current rate
      if (p.daily_yield_pct_est != null) {
        // 15%/day = excellent (20pts), 5%/day = decent (7pts), <1% = marginal
        score += Math.min(20, p.daily_yield_pct_est * 1.35);
      }
      // fee_per_position_est: your share of fees vs. other LPs
      // High = few LPs sharing → your slice is big
      if (p.fee_per_position_est != null) {
        // $10+ per position = great (15pts), $1 = 1.5pts
        score += Math.min(15, p.fee_per_position_est * 1.5);
      }
      // fee_active_tvl_ratio: fundamental fee/TVL efficiency
      if (p.fee_active_tvl_ratio != null) {
        score += Math.min(15, p.fee_active_tvl_ratio * 10);
      }

      // ── Token quality signals ─────────────────────────────────────
      // organic_score: 60–100 range, rescale to 0–20
      if (p.organic_score != null) {
        score += Math.max(0, (p.organic_score - 60) / 2); // 60→0, 100→20
      }

      // ── Smart money signals (bonuses) ─────────────────────────────
      if (p.smart_money_buy)   score += 12;
      if (p.kol_in_clusters)   score += 8;
      if (p.dev_sold_all)      score += 5;
      if (p.dex_boost)         score += 3;

      // ── Volume acceleration bonus/penalty ─────────────────────────
      // volume_change_pct: how much volume changed in the timeframe window
      // Accelerating volume = more fees incoming; collapsing volume = fees dying
      if (p.volume_change_pct != null) {
        if (p.volume_change_pct > 50)       score += 10; // volume surging
        else if (p.volume_change_pct > 20)  score += 5;  // volume growing
        else if (p.volume_change_pct < -30) score -= 8;  // volume declining
        else if (p.volume_change_pct < -50) score -= 15; // volume collapsing
      }

      // ── Risk penalties ────────────────────────────────────────────
      if (p.is_rugpull)        score -= 40;
      if (p.bundle_pct  != null) score -= p.bundle_pct * 0.4;
      if (p.suspicious_pct != null) score -= p.suspicious_pct * 0.3;
      if (p.sniper_pct  != null) score -= p.sniper_pct * 0.2;

      p.quality_score = Math.round(Math.max(0, Math.min(100, score)));

      // ── Strategy recommendation ───────────────────────────────────
      // bid_ask: optimal for volatile/meme tokens — single-sided SOL, earn from price swings
      // spot: better for established/stable tokens — both-sided, lower IL risk
      const age   = p.token_age_hours;
      const mcap  = p.mcap;
      const vol   = p.volatility;
      const org   = p.organic_score;
      if (vol >= 2.5 && (mcap == null || mcap < 3_000_000) && (age == null || age < 72)) {
        p.recommended_strategy = "bid_ask";
      } else if (org >= 75 && mcap != null && mcap >= 2_000_000) {
        p.recommended_strategy = "spot";
      } else {
        p.recommended_strategy = "bid_ask"; // safe default
      }
    }

    // Sort descending by quality score before returning to LLM
    eligible.sort((a, b) => (b.quality_score ?? 0) - (a.quality_score ?? 0));
    log("screening", `Pool scores: ${eligible.slice(0, 5).map(p => `${p.name}=${p.quality_score}`).join(", ")}`);

    // Drop any pools whose creator is on the dev blocklist (caught via advanced-info)
    const before = eligible.length;
    const filtered = eligible.filter((p) => {
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer (okx) ${p.dev.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...filtered);
    if (eligible.length < before) log("dev_blocklist", `Filtered ${before - eligible.length} pool(s) via OKX creator check`);
  }

  return {
    candidates: eligible,
    total_screened: pools.length,
    filtered_examples: filteredOut.slice(0, 3),
    top_score: eligible[0]?.quality_score ?? null,
  };
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${pool_address}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const pool = (data.data || [])[0];

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    // API sometimes returns 0 for fee_active_tvl_ratio on short timeframes — compute from raw values as fallback
    fee_active_tvl_ratio: p.fee_active_tvl_ratio > 0
      ? fix(p.fee_active_tvl_ratio, 4)
      : (p.active_tvl > 0 ? fix((p.fee / p.active_tvl) * 100, 4) : 0),
    volatility: fix(p.volatility, 2),


    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,

    // ── Fee dilution signal ──────────────────────────────────────────
    // fee_per_position_est: estimated fee earned per LP position in this timeframe window.
    // Low = pool is overcrowded → your share is tiny even if total fees look high.
    // High = few LPs sharing fees → you capture a large slice.
    // Formula: fee_window / active_positions (raw $, not normalised by position size)
    fee_per_position_est: (p.active_positions > 0 && p.fee != null)
      ? fix(p.fee / p.active_positions, 2)
      : null,

    // ── Daily yield projection ────────────────────────────────────────
    // Annualised fee yield based on the active timeframe window.
    // daily_yield_pct = fee_active_tvl_ratio * (minutes_in_24h / timeframe_minutes)
    // Tells the screener: "if this rate holds, 1 SOL deployed earns X% today."
    // Use 5m=288 periods, 15m=96, 1h=24, 4h=6, 24h=1 multiplier.
    daily_yield_pct_est: (() => {
      const tfMinutes = { "5m": 5, "15m": 15, "1h": 60, "2h": 120, "4h": 240, "24h": 1440 };
      const tf = tfMinutes[p.timeframe] || 5;
      const ratio = p.fee_active_tvl_ratio > 0
        ? p.fee_active_tvl_ratio
        : (p.active_tvl > 0 ? (p.fee / p.active_tvl) * 100 : 0);
      return ratio > 0 ? fix(ratio * (1440 / tf), 2) : null;
    })(),

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  return n != null ? Number(n.toFixed(decimals)) : null;
}

function pushFilteredReason(list, pool, reason) {
  if (!list || !pool) return;
  list.push({
    name: pool.name || `${pool.base?.symbol || "?"}-${pool.quote?.symbol || "?"}`,
    reason,
  });
}
