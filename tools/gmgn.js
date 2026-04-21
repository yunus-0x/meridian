import { randomUUID } from "crypto";
import { setDefaultResultOrder } from "dns";
import { config } from "../config.js";
import { log } from "../logger.js";
import { fetchChartIndicatorsForMint } from "./chart-indicators.js";

// Force IPv4 — GMGN OpenAPI does not support IPv6
setDefaultResultOrder("ipv4first");

const METEORA_DLMM_API = "https://dlmm.datapi.meteora.ag";
const SUPPORTED_INTERVALS = new Set(["1m", "5m", "1h", "6h", "24h"]);
let lastGmgnRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paceGmgnRequest() {
  const delayMs = Math.max(0, Number(config.gmgn?.requestDelayMs ?? 2500));
  if (!delayMs) return;
  const elapsed = Date.now() - lastGmgnRequestAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastGmgnRequestAt = Date.now();
}

function getApiKey() {
  const key = config.gmgn?.apiKey || process.env.GMGN_API_KEY;
  if (!key) throw new Error("GMGN_API_KEY is required when screeningSource=gmgn.");
  return key;
}

function normalizeInterval(value, fallback = "5m") {
  const normalized = String(value || fallback).trim();
  return SUPPORTED_INTERVALS.has(normalized) ? normalized : fallback;
}


function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value.filter((item) => item != null && item !== "")) {
        url.searchParams.append(key, String(entry));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

async function gmgnFetch(pathname, { method = "GET", params = {}, body = null } = {}) {
  const baseUrl = String(config.gmgn?.baseUrl || "https://openapi.gmgn.ai").replace(/\/+$/, "");
  const url = new URL(`${baseUrl}${pathname}`);
  appendParams(url, {
    ...params,
    timestamp: Math.floor(Date.now() / 1000),
    client_id: randomUUID(),
  });

  const maxRetries = Math.max(0, Number(config.gmgn?.maxRetries ?? 2));
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await paceGmgnRequest();
    const res = await fetch(url, {
      method,
      headers: {
        "X-APIKEY": getApiKey(),
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : null,
    });
    const text = await res.text().catch(() => "");
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    const message = payload?.message || payload?.error || payload?.raw || `GMGN ${pathname} ${res.status}`;
    const rateLimited = res.status === 429 || /rate limit|temporarily banned/i.test(String(message));
    if (res.ok) return payload;
    if (rateLimited && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : /temporarily banned/i.test(String(message))
          ? 60000
          : Math.min(30000, 3000 * Math.pow(2, attempt));
      await sleep(backoffMs);
      continue;
    }
    throw new Error(message);
  }
  throw new Error(`GMGN ${pathname} failed`);
}

function unwrapList(payload, keys = ["list", "rank", "data"]) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.data?.[key])) return payload.data[key];
    if (Array.isArray(payload?.data?.data?.[key])) return payload.data.data[key];
  }
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  return [];
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optionalNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolish(value) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true" || String(value).toLowerCase() === "yes";
}

function ratioPct(value) {
  const n = optionalNum(value);
  if (n == null) return null;
  return Number((n * 100).toFixed(2));
}

function hasTag(entry, tag) {
  const tags = []
    .concat(entry?.tags || [])
    .concat(entry?.maker_token_tags || [])
    .map((value) => String(value || "").toLowerCase());
  return tags.includes(tag);
}

function entryName(entry) {
  return String(entry?.name || entry?.twitter_username || entry?.username || entry?.label || entry?.address || entry || "").trim();
}

function entryAmountPct(entry) {
  const raw = entry?.amount_percentage ?? entry?.balance_percentage ?? entry?.amount_cur_percentage;
  const n = optionalNum(raw);
  if (n == null) return 0;
  return n > 1 ? n : n * 100;
}

function isPreferredKol(entry) {
  const preferred = config.gmgn.preferredKolNames
    .map((name) => String(name || "").trim().toLowerCase())
    .filter(Boolean);
  if (!preferred.length) return false;
  const normalized = entryName(entry).toLowerCase();
  return preferred.some((preferredName) => normalized.includes(preferredName));
}

function isDumpKol(entry) {
  const dump = (config.gmgn.dumpKolNames || [])
    .map((name) => String(name || "").trim().toLowerCase())
    .filter(Boolean);
  if (!dump.length) return false;
  const normalized = entryName(entry).toLowerCase();
  return dump.some((dumpName) => normalized.includes(dumpName));
}

function passBasicRankFilter(token) {
  const g = config.gmgn;
  const reasons = [];
  const tokenAgeHours = num(token.creation_timestamp) > 0
    ? (Date.now() / 1000 - num(token.creation_timestamp)) / 3600
    : null;
  if (num(token.market_cap) < g.minMcap) reasons.push(`mcap ${num(token.market_cap)} < ${g.minMcap}`);
  if (g.maxMcap != null && num(token.market_cap) > g.maxMcap) reasons.push(`mcap ${num(token.market_cap)} > ${g.maxMcap}`);
  if (num(token.bundler_rate) > g.maxBundlerRate) reasons.push(`bundler ${(num(token.bundler_rate) * 100).toFixed(1)}% > ${(g.maxBundlerRate * 100).toFixed(1)}%`);
  if (g.minTokenAgeHours != null && tokenAgeHours != null && tokenAgeHours < g.minTokenAgeHours) {
    reasons.push(`age ${tokenAgeHours.toFixed(2)}h < ${g.minTokenAgeHours}h`);
  }
  if (g.maxTokenAgeHours != null && tokenAgeHours != null && tokenAgeHours > g.maxTokenAgeHours) {
    reasons.push(`age ${tokenAgeHours.toFixed(2)}h > ${g.maxTokenAgeHours}h`);
  }
  if (num(token.volume) < g.minVolume) reasons.push(`volume ${num(token.volume)} < ${g.minVolume}`);
  return { pass: reasons.length === 0, reasons };
}

function analyzeSecurity(security = {}) {
  const g = config.gmgn;
  const reasons = [];
  if (security.renounced_mint != null && !boolish(security.renounced_mint)) reasons.push("mint not renounced");
  if (security.renounced_freeze_account != null && !boolish(security.renounced_freeze_account)) reasons.push("freeze not renounced");
  if (String(security.is_honeypot || "").toLowerCase() === "yes") reasons.push("honeypot");
  if (boolish(security.is_wash_trading)) reasons.push("wash trading");
  if (String(security.creator_token_status || "").toLowerCase() === "creator_hold") reasons.push("creator still holding");
  if (num(security.rug_ratio) > g.maxRugRatio) reasons.push(`rug ratio ${ratioPct(security.rug_ratio)}%`);
  if (num(security.top_10_holder_rate) > g.maxTop10HolderRate) reasons.push(`top10 ${ratioPct(security.top_10_holder_rate)}%`);
  if (num(security.bundler_trader_amount_rate) > g.maxBundlerRate) reasons.push(`bundler ${ratioPct(security.bundler_trader_amount_rate)}%`);
  if (num(security.rat_trader_amount_rate) > g.maxRatTraderRate) reasons.push(`insider ${ratioPct(security.rat_trader_amount_rate)}%`);
  if (num(security.sniper_count) > g.maxSniperCount) reasons.push(`snipers ${num(security.sniper_count)}`);
  return { passed: reasons.length === 0, reasons };
}

function analyzeTokenInfo(info = {}) {
  const g = config.gmgn;
  const stat = info.stat || {};
  const tags = info.wallet_tags_stat || {};
  const reasons = [];
  const smartWallets = num(tags.smart_wallets);
  const kolWallets = num(tags.renowned_wallets);
  const tradeFeeSol = num(info.trade_fee);
  const price = num(info.price);
  const athPrice = num(info.ath_price);
  const priceVsAthPct = athPrice > 0 && price > 0 ? (price / athPrice) * 100 : null;
  const athFilter = g.athFilterPct;
  if (athFilter != null && priceVsAthPct != null) {
    const threshold = 100 + Number(athFilter);
    if (priceVsAthPct > threshold) reasons.push(`price ${priceVsAthPct.toFixed(1)}% of ATH > ${threshold}%`);
  }
  const totalFeeSol = num(info.total_fee);
  if (num(info.holder_count) < g.minHolders) reasons.push(`holders ${num(info.holder_count)} < ${g.minHolders}`);
  if (totalFeeSol < g.minTotalFeeSol) reasons.push(`total fee ${totalFeeSol} SOL < ${g.minTotalFeeSol} SOL`);
  if (num(stat.top_10_holder_rate) > g.maxTop10HolderRate) reasons.push(`top10 ${ratioPct(stat.top_10_holder_rate)}%`);
  if (g.maxDevTeamHoldRate != null && num(stat.dev_team_hold_rate) > g.maxDevTeamHoldRate) reasons.push(`dev team ${ratioPct(stat.dev_team_hold_rate)}%`);
  if (num(stat.bot_degen_rate) > g.maxBotDegenRate) reasons.push(`bot degen ${ratioPct(stat.bot_degen_rate)}%`);
  if (g.maxFreshWalletRate != null && num(stat.fresh_wallet_rate) > g.maxFreshWalletRate) reasons.push(`fresh wallets ${ratioPct(stat.fresh_wallet_rate)}%`);
  if (num(stat.top_bundler_trader_percentage) > g.maxBundlerRate) reasons.push(`bundler ${ratioPct(stat.top_bundler_trader_percentage)}%`);
  if (num(stat.top_rat_trader_percentage) > g.maxRatTraderRate) reasons.push(`insider ${ratioPct(stat.top_rat_trader_percentage)}%`);
  return {
    passed: reasons.length === 0,
    reasons,
    smartWallets,
    kolWallets,
    priceVsAthPct,
    tradeFeeSol,
    totalFeeSol,
    top10HolderPct: ratioPct(stat.top_10_holder_rate),
    devTeamHoldPct: ratioPct(stat.dev_team_hold_rate),
    botDegenCount: num(stat.bot_degen_count),
    botDegenPct: ratioPct(stat.bot_degen_rate),
    freshWalletPct: ratioPct(stat.fresh_wallet_rate),
    bundlerPct: ratioPct(stat.top_bundler_trader_percentage),
    insiderPct: ratioPct(stat.top_rat_trader_percentage),
    sniperWallets: num(tags.sniper_wallets),
    bundlerWallets: num(tags.bundler_wallets),
    whaleWallets: num(tags.whale_wallets),
    freshWallets: num(tags.fresh_wallets),
  };
}

function analyzeHoldersAndTraders(holders = [], traders = []) {
  const g = config.gmgn;
  const combined = [...holders, ...traders];
  const kolHolders = holders.filter((entry) => hasTag(entry, "kol") && !entry.end_holding_at);
  const kolHolding = kolHolders.length;
  const smartHolding = holders.filter((entry) => hasTag(entry, "smart_degen") && !entry.end_holding_at).length;
  const kolTraders = traders.filter((entry) => hasTag(entry, "kol"));
  const smartTraders = traders.filter((entry) => hasTag(entry, "smart_degen"));
  const smartAccumulating = smartTraders.filter((entry) => num(entry.buy_volume_cur) > num(entry.sell_volume_cur)).length;
  const smartExiting = smartTraders.filter((entry) => num(entry.sell_volume_cur) > num(entry.buy_volume_cur)).length;
  const mostlyExited = combined.filter((entry) =>
    (hasTag(entry, "kol") || hasTag(entry, "smart_degen")) &&
    num(entry.sell_amount_percentage) >= 0.8
  ).length;
  const preferredKolHolders = kolHolders.filter((entry) =>
    isPreferredKol(entry) && entryAmountPct(entry) >= g.preferredKolMinHoldPct
  );
  const dumpKolThreshold = g.dumpKolMinHoldPct ?? 0.5;
  const dumpKolHoldersAll = [...kolHolders, ...kolTraders.filter((e) => !e.end_holding_at)].filter(isDumpKol);
  const dumpKolSignificant = dumpKolHoldersAll.filter((e) => entryAmountPct(e) >= dumpKolThreshold);
  const dumpKolMinor = dumpKolHoldersAll.filter((e) => entryAmountPct(e) < dumpKolThreshold);
  const bundlerTopHolders = holders.filter((entry) => hasTag(entry, "bundler"));
  const sniperTopHolders = holders.filter((entry) => hasTag(entry, "sniper"));
  const sniperHoldRate = holders.length > 0 ? sniperTopHolders.length / holders.length : 0;
  const reasons = [];
  if (sniperHoldRate > g.maxSniperHoldRate) reasons.push(`sniper top-holder rate ${(sniperHoldRate * 100).toFixed(1)}%`);
  return {
    passed: reasons.length === 0,
    reasons,
    kolHolding,
    kolHolderNames: kolHolders.map((entry) => entryName(entry)).filter(Boolean).slice(0, 12),
    kolProfitNames: kolTraders
      .sort((a, b) => num(b.profit) - num(a.profit))
      .map((entry) => entryName(entry))
      .filter(Boolean)
      .slice(0, 12),
    preferredKolHolding: preferredKolHolders.length,
    preferredKolHolders: preferredKolHolders.map((entry) => ({
      name: entryName(entry),
      amountPct: Number(entryAmountPct(entry).toFixed(2)),
    })),
    dumpKolSignificantCount: dumpKolSignificant.length,
    dumpKolMinorCount: dumpKolMinor.length,
    dumpKolHolders: dumpKolSignificant.map((entry) => ({
      name: entryName(entry),
      amountPct: Number(entryAmountPct(entry).toFixed(2)),
    })),
    smartHolding,
    smartAccumulating,
    smartExiting,
    mostlyExited,
    bundlerTopHolderCount: bundlerTopHolders.length,
    sniperTopHolderCount: sniperTopHolders.length,
    sniperHoldRate,
  };
}


async function fetchTopMeteoraDlmmPoolsForMint(mint, minTvl = 0, limit = 2) {
  const filterBy = minTvl > 0 ? `&filter_by=${encodeURIComponent(`tvl>${minTvl}`)}` : "";
  const url = `${METEORA_DLMM_API}/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}${filterBy}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Meteora pool search ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools
    .filter((pool) => {
      // pool_type and dlmm_params are always undefined on this endpoint — DLMM is
      // inferred from the presence of pool_config.bin_step
      const baseMatches = pool?.token_x?.address === mint || pool?.token_x_mint === mint;
      const quoteIsSol =
        pool?.token_y?.address === config.tokens.SOL ||
        pool?.token_y_mint === config.tokens.SOL ||
        pool?.token_y?.symbol === "SOL";
      return baseMatches && quoteIsSol;
    })
    .slice(0, limit);
}

async function fetchPoolDetailDirect(poolAddress) {
  // Always use Meteora's public Pool Discovery API — the server-side endpoint
  // (api.agentmeridian.xyz) returns stale/fee=0 data for some pools.
  const discoveryBase = "https://pool-discovery-api.datapi.meteora.ag";
  const url = `${discoveryBase}/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=5m`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

async function pickBestPool(pools) {
  const details = await Promise.all(
    pools.map((pool) =>
      fetchPoolDetailDirect(pool.address || pool.pool_address).catch(() => null)
    )
  );
  if (pools.length <= 1) return { pool: pools[0] ?? null, detail: details[0] ?? null };
  const scored = pools.map((pool, i) => {
    const d = details[i];
    const activeTvl = num(d?.active_tvl ?? pool.active_tvl ?? pool.tvl ?? pool.liquidity);
    // Use the API-provided fee_active_tvl_ratio directly (already a percentage, e.g. 7.95 = 7.95%)
    const feeActiveTvlRatio = Number(d?.fee_active_tvl_ratio) > 0
      ? Number(d.fee_active_tvl_ratio)
      : (activeTvl > 0 ? (num(d?.fee) / activeTvl) * 100 : 0);
    return { pool, detail: d, feeActiveTvlRatio, activeTvl };
  });
  scored.sort((a, b) => b.feeActiveTvlRatio - a.feeActiveTvlRatio || b.activeTvl - a.activeTvl);
  return { pool: scored[0].pool, detail: scored[0].detail };
}

function condenseGmgnCandidate({ token, pool, poolDetail, security, info, infoAnalysis, holdersAnalysis, indicatorSignal }) {
  const poolAddress = pool.address || pool.pool_address;
  // Stage 5 Pool Discovery provides active_tvl and fee_active_tvl_ratio
  // Stage 3 Meteora search provides tvl and bin_step/base_fee_pct via pool_config
  const activeTvl = num(poolDetail?.active_tvl ?? pool.tvl ?? pool.liquidity);
  // Use API-provided ratio directly; fee_active_tvl_ratio from Pool Discovery is already computed
  const feeActiveTvlRatio = Number(poolDetail?.fee_active_tvl_ratio) > 0
    ? Number(Number(poolDetail.fee_active_tvl_ratio).toFixed(4))
    : 0;
  const kolCount = holdersAnalysis.kolHolding || num(token.renowned_count) || num(info?.wallet_tags_stat?.renowned_wallets);
  const smartCount = holdersAnalysis.smartHolding + holdersAnalysis.smartAccumulating || num(token.smart_degen_count) || num(info?.wallet_tags_stat?.smart_wallets);
  const gmgnScore =
    num(token.volume) / 100 +
    num(token.smart_degen_count) * 50 +
    kolCount * 35 +
    num(holdersAnalysis?.preferredKolHolding) * 75 -
    num(holdersAnalysis?.dumpKolSignificantCount) * 100 -
    num(holdersAnalysis?.dumpKolMinorCount) * 20 +
    feeActiveTvlRatio * 1000 +
    Math.max(0, 100 - num(security?.rug_ratio) * 100) * 5;

  return {
    pool: poolAddress,
    name: pool.name || `${token.symbol || info.symbol || "?"}-SOL`,
    base: {
      symbol: token.symbol || info.symbol || pool.token_x?.symbol,
      mint: token.address || info.address || pool.token_x?.address,
      organic: null,
      warnings: 0,
    },
    quote: {
      symbol: pool.token_y?.symbol || "SOL",
      mint: pool.token_y?.address || config.tokens.SOL,
    },
    pool_type: "dlmm",
    // Stage 3 Meteora search: pool_config.bin_step / base_fee_pct
    bin_step: pool.pool_config?.bin_step ?? poolDetail?.dlmm_params?.bin_step ?? null,
    fee_pct: pool.pool_config?.base_fee_pct ?? poolDetail?.fee_pct ?? null,
    // Stage 5 Pool Discovery: active_tvl, fee_active_tvl_ratio, volatility
    active_tvl: round(activeTvl),
    fee_active_tvl_ratio: feeActiveTvlRatio,
    volatility: poolDetail?.volatility != null ? Number(Number(poolDetail.volatility).toFixed(2)) : null,
    // Stage 1 GMGN rank: token-level metrics
    holders: num(token.holder_count || info.holder_count),
    mcap: round(num(token.market_cap || (num(info.price) * num(info.circulating_supply)))),
    token_age_hours: token.open_timestamp ? Math.floor((Date.now() / 1000 - num(token.open_timestamp)) / 3600) : null,
    dev: info.dev?.creator_address || null,
    price: num(info.price || token.price),
    price_change_pct: num(token.price_change_percent5m ?? token.price_change_percent),
    volume: num(token.volume ?? 0),
    swap_count: token.swaps ?? null,
    gmgn: true,
    gmgn_score: Number(gmgnScore.toFixed(2)),
    gmgn_total_fee_sol: num(infoAnalysis?.totalFeeSol ?? info.total_fee),
    gmgn_trade_fee_sol: num(infoAnalysis?.tradeFeeSol ?? info.trade_fee),
    gmgn_smart_wallets: smartCount,
    gmgn_kol_wallets: kolCount,
    gmgn_kol_names: holdersAnalysis?.kolHolderNames || [],
    gmgn_kol_profit_names: holdersAnalysis?.kolProfitNames || [],
    gmgn_preferred_kol_matches: num(holdersAnalysis?.preferredKolHolding),
    gmgn_preferred_kol_holders: holdersAnalysis?.preferredKolHolders || [],
    gmgn_dump_kol_significant: num(holdersAnalysis?.dumpKolSignificantCount),
    gmgn_dump_kol_minor: num(holdersAnalysis?.dumpKolMinorCount),
    gmgn_dump_kol_holders: holdersAnalysis?.dumpKolHolders || [],
    gmgn_top10_holder_pct: ratioPct(security?.top_10_holder_rate ?? token.top_10_holder_rate),
    gmgn_bundler_pct: ratioPct(security?.bundler_trader_amount_rate ?? token.bundler_rate),
    gmgn_insider_pct: ratioPct(security?.rat_trader_amount_rate ?? token.rat_trader_amount_rate),
    gmgn_bot_degen_pct: ratioPct(info?.stat?.bot_degen_rate ?? token.bot_degen_rate),
    gmgn_token_info_top10_pct: infoAnalysis?.top10HolderPct ?? null,
    gmgn_dev_team_hold_pct: infoAnalysis?.devTeamHoldPct ?? null,
    gmgn_fresh_wallet_pct: infoAnalysis?.freshWalletPct ?? null,
    gmgn_bot_degen_count: infoAnalysis?.botDegenCount ?? null,
    gmgn_token_info_bundler_pct: infoAnalysis?.bundlerPct ?? null,
    gmgn_token_info_insider_pct: infoAnalysis?.insiderPct ?? null,
    gmgn_sniper_wallets: infoAnalysis?.sniperWallets ?? null,
    gmgn_bundler_wallets: infoAnalysis?.bundlerWallets ?? null,
    gmgn_whale_wallets: infoAnalysis?.whaleWallets ?? null,
    gmgn_fresh_wallets: infoAnalysis?.freshWallets ?? null,
    gmgn_sniper_count: num(security?.sniper_count ?? token.sniper_count),
    gmgn_kol_holding: holdersAnalysis.kolHolding,
    gmgn_smart_holding: holdersAnalysis.smartHolding,
    gmgn_smart_accumulating: holdersAnalysis.smartAccumulating,
    gmgn_smart_exiting: holdersAnalysis.smartExiting,
    gmgn_mostly_exited: holdersAnalysis.mostlyExited,
    price_vs_ath_pct: infoAnalysis?.priceVsAthPct != null ? Number(infoAnalysis.priceVsAthPct.toFixed(2)) : null,
    ath: info.ath_price || null,
    launchpad: token.launchpad_platform || info.launchpad_platform || info.launchpad || null,
    indicators: indicatorSignal ?? null,
  };
}

// SOL deployed in bins BELOW current price.
// Token dumps down through bins (fees collected) then bounces back up (more fees).
// Need: (1) token not already at bottom — needs room to dump into range,
//        (2) overall bullish trend — guarantees the bounce back.
async function checkBounceSetup(mint) {
  const interval = String(config.gmgn.indicatorInterval || "15_MINUTE").trim().toUpperCase();
  const payload = await fetchChartIndicatorsForMint(mint, { interval });
  const latest = payload?.latest || {};
  const st = latest?.supertrend || {};
  const stValue = Number(st.value) || 0;
  const stDirection = String(st.direction || "").toLowerCase();
  const stBreakUp = !!latest?.states?.supertrendBreakUp;
  const close = Number(latest?.candle?.close) || 0;
  const rsiValue = Number(latest?.rsi?.value);
  const bb = latest?.bollinger || {};
  const upperBand = Number(bb.upper) || 0;
  const lowerBand = Number(bb.lower) || 0;
  const oversold = Number(config.indicators?.rsiOversold ?? 35);

  const isBullish = stDirection === "bullish" || stBreakUp;
  const alreadyAtBottom =
    Number.isFinite(rsiValue) && rsiValue < oversold &&
    close > 0 && lowerBand > 0 && close < lowerBand;
  const priceAboveSupertrend = close > 0 && stValue > 0 && close >= stValue;

  let bbPosition = "inside";
  if (close > 0 && upperBand > 0 && close > upperBand) bbPosition = "above";
  else if (close > 0 && lowerBand > 0 && close < lowerBand) bbPosition = "below";

  let rsiLabel = null;
  if (Number.isFinite(rsiValue)) {
    if (rsiValue < 35) rsiLabel = "oversold";
    else if (rsiValue > 65) rsiLabel = "overbought";
    else rsiLabel = "neutral";
  }

  const rules = config.gmgn.indicatorRules || {};
  const reasons = [];

  if (rules.requireBullishSupertrend !== false && !isBullish)
    reasons.push(`no bounce support: ${stDirection} supertrend`);

  if (rules.rejectAlreadyAtBottom !== false && alreadyAtBottom)
    reasons.push(`already at bottom: RSI ${rsiValue.toFixed(1)}, price below lower BB — dump done`);

  if (rules.requireAboveSupertrend && !priceAboveSupertrend)
    reasons.push(`price below supertrend (${stValue})`);

  if (rules.minRsi != null && Number.isFinite(rsiValue) && rsiValue < rules.minRsi)
    reasons.push(`RSI ${rsiValue.toFixed(1)} < min ${rules.minRsi}`);

  if (rules.maxRsi != null && Number.isFinite(rsiValue) && rsiValue > rules.maxRsi)
    reasons.push(`RSI ${rsiValue.toFixed(1)} > max ${rules.maxRsi}`);

  if (rules.requireBbPosition != null && bbPosition !== rules.requireBbPosition)
    reasons.push(`BB position ${bbPosition} ≠ required ${rules.requireBbPosition}`);

  return {
    passed: reasons.length === 0,
    reasons,
    signal: {
      interval,
      rsi: Number.isFinite(rsiValue) ? Number(rsiValue.toFixed(1)) : null,
      rsiLabel,
      bbPosition,
      supertrendDirection: stDirection || null,
      supertrendBreakUp: stBreakUp,
      aboveSupertrend: close > 0 && stValue > 0 ? close >= stValue : null,
    },
  };
}

export async function discoverGmgnPools({ limit = 10 } = {}) {
  const g = config.gmgn;
  const filtered = [];
  const stageCounts = {};

  // ── Stage 1: rank filter ──────────────────────────────────────────────────
  const rankPayload = await gmgnFetch("/v1/market/rank", {
    params: {
      chain: "sol",
      interval: normalizeInterval(g.interval),
      order_by: g.orderBy || "volume",
      direction: g.direction || "desc",
      limit: Math.min(100, Math.max(1, Number(g.limit || 100))),
      filters: g.filters || [],
      platforms: g.platforms || [],
    },
  });
  const ranked = unwrapList(rankPayload, ["rank", "list", "data"]);
  const s1 = ranked.filter((token) => {
    const check = passBasicRankFilter(token);
    if (!check.pass) {
      filtered.push({ stage: 1, name: token.symbol || token.address, reason: check.reasons.join(", ") });
      return false;
    }
    return true;
  }).sort((a, b) => num(b.volume) - num(a.volume))
    .slice(0, Math.max(limit, Number(g.enrichLimit || 20)));
  stageCounts.s1 = s1.length;
  log("gmgn", `Stage1 rank: ${ranked.length} → ${s1.length} pass`);

  // ── Stage 2: token info filter ────────────────────────────────────────────
  const s2 = [];
  for (const token of s1) {
    const mint = token.address;
    try {
      const infoPayload = await gmgnFetch("/v1/token/info", { params: { chain: "sol", address: mint } });
      const info = infoPayload?.data?.data || infoPayload?.data || infoPayload;
      const infoCheck = analyzeTokenInfo(info);
      if (!infoCheck.passed) {
        filtered.push({ stage: 2, name: token.symbol || mint, reason: infoCheck.reasons.join(", ") });
        continue;
      }
      s2.push({ token, info, infoCheck });
    } catch (error) {
      log("gmgn", `Stage2 skip ${token.symbol || mint}: ${error.message}`);
      filtered.push({ stage: 2, name: token.symbol || mint, reason: error.message });
    }
  }
  stageCounts.s2 = s2.length;
  log("gmgn", `Stage2 info: ${s1.length} → ${s2.length} pass`);

  // ── Stage 3: holders/traders enrichment (no hard filter) + Meteora pool ──
  const s3 = [];
  const minTvl = num(g.minTvl ?? config.screening.minTvl ?? 0);
  for (const { token, info, infoCheck } of s2) {
    const mint = token.address;
    try {
      const [holdersPayload, tradersPayload] = await Promise.all([
        gmgnFetch("/v1/market/token_top_holders", {
          params: { chain: "sol", address: mint, limit: g.holdersLimit || 100, order_by: "amount_percentage", direction: "desc" },
        }),
        gmgnFetch("/v1/market/token_top_traders", {
          params: { chain: "sol", address: mint, limit: g.holdersLimit || 100, order_by: "profit", direction: "desc" },
        }),
      ]);
      const holders = unwrapList(holdersPayload, ["list", "holders", "data"]);
      const traders = unwrapList(tradersPayload, ["list", "traders", "data"]);
      const holdersCheck = analyzeHoldersAndTraders(holders, traders);

      const topPools = await fetchTopMeteoraDlmmPoolsForMint(mint, minTvl, 2);
      if (topPools.length === 0) {
        filtered.push({ stage: 3, name: token.symbol || mint, reason: `no SOL DLMM pool above tvl>${minTvl}` });
        continue;
      }
      s3.push({ token, info, infoCheck, holdersCheck, topPools });
    } catch (error) {
      log("gmgn", `Stage3 skip ${token.symbol || mint}: ${error.message}`);
      filtered.push({ stage: 3, name: token.symbol || mint, reason: error.message });
    }
  }
  stageCounts.s3 = s3.length;
  log("gmgn", `Stage3 pool: ${s2.length} → ${s3.length} pass`);

  // ── Stage 4: Meridian chart indicators ────────────────────────────────────
  const s4 = [];
  if (g.indicatorFilter !== false) {
    for (const entry of s3) {
      const mint = entry.token.address;
      let indicatorCheck;
      try {
        indicatorCheck = await checkBounceSetup(mint);
      } catch (error) {
        log("gmgn", `Stage4 indicator unavailable for ${entry.token.symbol || mint}: ${error.message} — skip filter`);
        indicatorCheck = { passed: true, reasons: [] };
      }
      if (!indicatorCheck.passed) {
        filtered.push({ stage: 4, name: entry.token.symbol || mint, reason: indicatorCheck.reasons.join(", ") });
        continue;
      }
      s4.push({ ...entry, indicatorSignal: indicatorCheck.signal });
    }
  } else {
    s4.push(...s3);
  }
  stageCounts.s4 = s4.length;
  log("gmgn", `Stage4 indicators: ${s3.length} → ${s4.length} pass`);

  // ── Stage 5: pick best pool ───────────────────────────────────────────────
  const pools = [];
  for (const { token, info, infoCheck, holdersCheck, topPools, indicatorSignal } of s4) {
    if (pools.length >= limit) break;
    const mint = token.address;
    try {
      const { pool, detail: poolDetail } = await pickBestPool(topPools);
      if (!pool) {
        filtered.push({ stage: 5, name: token.symbol || mint, reason: "pool selection failed" });
        continue;
      }
      const security = {};
      const candidate = condenseGmgnCandidate({ token, pool, poolDetail, security, info, infoAnalysis: infoCheck, holdersAnalysis: holdersCheck, indicatorSignal });
      if (!candidate.pool || !candidate.base?.mint) {
        filtered.push({ stage: 5, name: token.symbol || mint, reason: "incomplete pool mapping" });
        continue;
      }
      pools.push(candidate);
    } catch (error) {
      log("gmgn", `Stage5 skip ${token.symbol || mint}: ${error.message}`);
      filtered.push({ stage: 5, name: token.symbol || mint, reason: error.message });
    }
  }
  stageCounts.s5 = pools.length;
  log("gmgn", `Stage5 final: ${s4.length} → ${pools.length} candidates`);

  return {
    total: ranked.length,
    stage_counts: stageCounts,
    pools,
    filtered_examples: filtered,
  };
}

export function formatGmgnCandidateForPrompt(p) {
  const sym = p.name || p.base?.symbol || "?";
  const launchpad = p.launchpad || "unknown";
  const age = p.token_age_hours != null ? `age=${p.token_age_hours}h` : "";
  const mcap = p.mcap != null ? `mcap=$${(p.mcap / 1000).toFixed(0)}k` : "";
  const binStep = p.bin_step != null ? `bin_step=${p.bin_step}` : "";

  const tvl = p.active_tvl != null ? `tvl=$${(p.active_tvl / 1000).toFixed(1)}k` : "";
  const feeTvl = p.fee_active_tvl_ratio != null ? `fee/tvl=${p.fee_active_tvl_ratio}%` : "";
  const vol = p.volume_window != null ? `vol=$${(p.volume_window / 1000).toFixed(1)}k` : "";
  const ath = p.price_vs_ath_pct != null ? `price_vs_ath=${p.price_vs_ath_pct.toFixed(0)}%` : "";

  const top10 = p.gmgn_token_info_top10_pct != null ? `top10=${p.gmgn_token_info_top10_pct}%` : (p.gmgn_top10_holder_pct != null ? `top10=${p.gmgn_top10_holder_pct}%` : "");
  const dev = p.gmgn_dev_team_hold_pct != null ? `dev=${p.gmgn_dev_team_hold_pct}%` : "";
  const bot = p.gmgn_bot_degen_pct != null ? `bot=${p.gmgn_bot_degen_pct}%` : "";
  const fresh = p.gmgn_fresh_wallet_pct != null ? `fresh=${p.gmgn_fresh_wallet_pct}%` : "";
  const bundler = p.gmgn_token_info_bundler_pct != null ? `bundler=${p.gmgn_token_info_bundler_pct}%` : (p.gmgn_bundler_pct != null ? `bundler=${p.gmgn_bundler_pct}%` : "");

  const holders = p.holders != null ? `holders=${p.holders.toLocaleString()}` : "";
  const fees = p.gmgn_total_fee_sol != null ? `fees=${p.gmgn_total_fee_sol.toFixed(0)}SOL` : "";
  const smart = p.gmgn_smart_wallets != null ? `smart=${p.gmgn_smart_wallets}` : "";
  const kol = p.gmgn_kol_wallets != null ? `kol=${p.gmgn_kol_wallets}` : "";

  let kolLine = "";
  if (p.gmgn_preferred_kol_holders?.length) {
    const pref = p.gmgn_preferred_kol_holders.map((k) => `${k.name} holding ${k.amountPct}%`).join(" | ");
    const prof = p.gmgn_kol_profit_names?.length ? ` | profit leaders: ${p.gmgn_kol_profit_names.slice(0, 3).join(", ")}` : "";
    kolLine = `\n  KOL: ${pref}${prof}`;
  } else if (p.gmgn_kol_names?.length) {
    const names = p.gmgn_kol_names.slice(0, 3).join(", ");
    const prof = p.gmgn_kol_profit_names?.length ? ` | profit leaders: ${p.gmgn_kol_profit_names.slice(0, 3).join(", ")}` : "";
    kolLine = `\n  KOL: ${names}${prof}`;
  }

  let dumpKolLine = "";
  if (p.gmgn_dump_kol_holders?.length) {
    const sig = p.gmgn_dump_kol_holders.map((k) => `${k.name} ${k.amountPct}%`).join(" | ");
    dumpKolLine = `\n  ⚠ DUMP KOL (significant): ${sig}`;
  } else if (p.gmgn_dump_kol_minor > 0) {
    dumpKolLine = `\n  ⚠ DUMP KOL (minor, <${config.gmgn.dumpKolMinHoldPct}%): ${p.gmgn_dump_kol_minor} wallet(s)`;
  }

  let indLine = "";
  if (p.indicators) {
    const ind = p.indicators;
    const interval = ind.interval ? `[${ind.interval}]` : "";
    const st = ind.supertrendDirection ? `supertrend=${ind.supertrendDirection}${ind.supertrendBreakUp ? " (breakup)" : ""}` : "";
    const rsi = ind.rsi != null ? `rsi=${ind.rsi} ${ind.rsiLabel || ""}`.trim() : "";
    const bb = ind.bbPosition ? `bb=${ind.bbPosition}` : "";
    const parts = [st, rsi, bb].filter(Boolean).join(" | ");
    if (parts) indLine = `\n  Indicators ${interval}: ${parts}`;
  }

  const header = [sym, launchpad, age, mcap, binStep].filter(Boolean).join(" | ");
  const pool = [tvl, feeTvl, vol, ath].filter(Boolean).join(" | ");
  const risk = [top10, dev, bot, fresh, bundler].filter(Boolean).join(" | ");
  const traction = [holders, fees, smart, kol].filter(Boolean).join(" | ");

  return [
    `[${header}]`,
    pool ? `  Pool: ${pool}` : null,
    risk ? `  Risk: ${risk}` : null,
    traction ? `  Traction: ${traction}` : null,
    kolLine || null,
    dumpKolLine || null,
    indLine || null,
  ].filter(Boolean).join("\n");
}

function round(n) {
  return n != null ? Math.round(n) : null;
}
