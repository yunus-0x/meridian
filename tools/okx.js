/**
 * OKX DEX API helpers — public endpoints (no API key required)
 * Uses Ok-Access-Client-type: agent-cli header for unauthenticated access.
 * Docs: https://web3.okx.com/build/dev-docs/
 */
import crypto from "crypto";
import { config } from "../config.js";

const BASE = "https://web3.okx.com";
const CHAIN_SOLANA = "501";
const PUBLIC_HEADERS = { "Ok-Access-Client-type": "agent-cli" };
const OKX_API_KEY = process.env.OKX_API_KEY || process.env.OK_ACCESS_KEY || "";
const OKX_SECRET_KEY = process.env.OKX_SECRET_KEY || process.env.OK_ACCESS_SECRET || "";
const OKX_PASSPHRASE = process.env.OKX_PASSPHRASE || process.env.OK_ACCESS_PASSPHRASE || "";
const OKX_PROJECT_ID = process.env.OKX_PROJECT_ID || process.env.OK_ACCESS_PROJECT || "";

function hasAuth() {
  return !!(OKX_API_KEY && OKX_SECRET_KEY && OKX_PASSPHRASE && !/enter your passphrase here/i.test(OKX_PASSPHRASE));
}

function buildAuthHeaders(method, path, body = "") {
  const timestamp = new Date().toISOString();
  const prehash = `${timestamp}${method.toUpperCase()}${path}${body}`;
  const sign = crypto
    .createHmac("sha256", OKX_SECRET_KEY)
    .update(prehash)
    .digest("base64");

  const headers = {
    "OK-ACCESS-KEY": OKX_API_KEY,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-PASSPHRASE": OKX_PASSPHRASE,
    "OK-ACCESS-TIMESTAMP": timestamp,
  };

  if (OKX_PROJECT_ID) headers["OK-ACCESS-PROJECT"] = OKX_PROJECT_ID;
  return headers;
}

async function okxRequest(method, path, body = null) {
  const bodyText = body == null ? "" : JSON.stringify(body);
  const headers = hasAuth()
    ? { ...buildAuthHeaders(method, path, bodyText), ...(body != null ? { "Content-Type": "application/json" } : {}) }
    : { ...PUBLIC_HEADERS, ...(body != null ? { "Content-Type": "application/json" } : {}) };

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body != null ? { body: bodyText } : {}),
  });
  if (!res.ok) throw new Error(`OKX API ${res.status}: ${path}`);
  const json = await res.json();
  if (json.code !== "0" && json.code !== 0) throw new Error(`OKX error ${json.code}: ${json.msg || json.message || "unknown"}`);
  return json.data;
}

async function okxGet(path) {
  return okxRequest("GET", path);
}

async function okxPost(path, body) {
  return okxRequest("POST", path, body);
}

const pct = (v) => v != null && v !== "" ? parseFloat(v) : null;
const int = (v) => v != null && v !== "" ? parseInt(v, 10) : null;
const serverEnrichmentCache = new Map();
const SERVER_ENRICHMENT_CACHE_MS = 30_000;

function agentMeridianBaseUrl() {
  return String(config.api?.url || "").replace(/\/+$/, "");
}

function agentMeridianHeaders() {
  const headers = { accept: "application/json" };
  if (config.api?.publicApiKey) {
    headers["x-api-key"] = config.api.publicApiKey;
  }
  return headers;
}

async function fetchServerOkxEnrichment(tokenAddress, chainIndex = CHAIN_SOLANA) {
  const baseUrl = agentMeridianBaseUrl();
  if (!baseUrl) return null;

  const cacheKey = `${chainIndex}:${tokenAddress}`;
  const cached = serverEnrichmentCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SERVER_ENRICHMENT_CACHE_MS) {
    return cached.promise;
  }

  const url = `${baseUrl}/okx/enrich/${encodeURIComponent(tokenAddress)}?chainIndex=${encodeURIComponent(chainIndex)}`;
  const promise = fetch(url, { headers: agentMeridianHeaders() })
    .then(async (res) => {
      const text = await res.text();
      const payload = text ? JSON.parse(text) : null;
      if (!res.ok) {
        throw new Error(payload?.error || `Agent Meridian OKX enrichment ${res.status}`);
      }
      return payload;
    })
    .catch((error) => {
      serverEnrichmentCache.delete(cacheKey);
      throw error;
    });

  serverEnrichmentCache.set(cacheKey, { at: Date.now(), promise });
  return promise;
}

async function getServerOkxEnrichmentOrNull(tokenAddress, chainIndex = CHAIN_SOLANA) {
  if (hasAuth()) return null;
  try {
    return await fetchServerOkxEnrichment(tokenAddress, chainIndex);
  } catch {
    return null;
  }
}

function isAffirmative(label) {
  return typeof label === "string" && label.trim().toLowerCase() === "yes";
}

function collectRiskEntries(section) {
  if (!section || typeof section !== "object") return [];
  return [
    ...(Array.isArray(section.highRiskList) ? section.highRiskList : []),
    ...(Array.isArray(section.middleRiskList) ? section.middleRiskList : []),
    ...(Array.isArray(section.lowRiskList) ? section.lowRiskList : []),
  ];
}

/**
 * Token risk flags from OKX's nested risk check endpoint.
 * Rugpull is informational only; wash trading is used as a hard filter upstream.
 */
export async function getRiskFlags(tokenAddress, chainId = CHAIN_SOLANA) {
  const serverPayload = await getServerOkxEnrichmentOrNull(tokenAddress, chainId);
  if (serverPayload?.risk) return serverPayload.risk;

  const ts = Date.now();
  const path = `/priapi/v1/dx/market/v2/risk/new/check?chainId=${chainId}&tokenContractAddress=${tokenAddress}&t=${ts}`;
  const data = await okxGet(path);

  const entries = [
    ...collectRiskEntries(data?.allAnalysis),
    ...collectRiskEntries(data?.swapAnalysis),
    ...collectRiskEntries(data?.contractAnalysis),
    ...collectRiskEntries(data?.extraAnalysis),
  ];

  const hasRisk = (riskKey) =>
    entries.some((entry) => entry?.riskKey === riskKey && isAffirmative(entry?.newRiskLabel));

  return {
    is_rugpull: hasRisk("isLiquidityRemoval"),
    is_wash: hasRisk("isWash"),
    risk_level: int(data?.riskLevel ?? data?.riskControlLevel),
    source: "okx-risk-check",
  };
}

/**
 * Advanced token info — risk level, bundle/sniper/suspicious %, dev rug history, token tags.
 */
export async function getAdvancedInfo(tokenAddress, chainIndex = CHAIN_SOLANA) {
  const serverPayload = await getServerOkxEnrichmentOrNull(tokenAddress, chainIndex);
  if (serverPayload?.advanced) return serverPayload.advanced;

  const path = `/api/v6/dex/market/token/advanced-info?chainIndex=${chainIndex}&tokenContractAddress=${tokenAddress}`;
  const data = await okxGet(path);
  const d = Array.isArray(data) ? data[0] : data;
  if (!d) return null;

  const tags = d.tokenTags || [];
  return {
    risk_level:       int(d.riskControlLevel),
    bundle_pct:       pct(d.bundleHoldingPercent),
    sniper_pct:       pct(d.sniperHoldingPercent),
    suspicious_pct:   pct(d.suspiciousHoldingPercent),
    dev_holding_pct:  pct(d.devHoldingPercent),
    top10_pct:        pct(d.top10HoldPercent),
    lp_burned_pct:    pct(d.lpBurnedPercent),
    total_fee_sol:    pct(d.totalFee),
    dev_rug_count:    int(d.devRugPullTokenCount),
    dev_token_count:  int(d.devCreateTokenCount),
    creator:          d.creatorAddress || null,
    tags,
    is_honeypot:          tags.includes("honeypot"),
    smart_money_buy:      tags.includes("smartMoneyBuy"),
    dev_sold_all:         tags.includes("devHoldingStatusSellAll"),
    dev_buying_more:      tags.includes("devHoldingStatusBuy"),
    low_liquidity:        tags.includes("lowLiquidity"),
    dex_boost:            tags.includes("dexBoost"),
    dex_screener_paid:    tags.includes("dexScreenerPaid") || tags.includes("dsPaid"),
  };
}

/**
 * Top holder clusters — trend direction, holding period, KOL presence, PnL.
 * Condenses to top N clusters for LLM consumption.
 */
export async function getClusterList(tokenAddress, chainIndex = CHAIN_SOLANA, limit = 5) {
  const serverPayload = await getServerOkxEnrichmentOrNull(tokenAddress, chainIndex);
  if (Array.isArray(serverPayload?.clusters)) return serverPayload.clusters.slice(0, limit);

  const path = `/api/v6/dex/market/token/cluster/list?chainIndex=${chainIndex}&tokenContractAddress=${tokenAddress}`;
  const data = await okxGet(path);
  // Public endpoint returns data.clusterList (not data[0].clustList)
  const raw = data?.clusterList ?? (Array.isArray(data) ? data[0]?.clustList ?? [] : []);
  if (!raw.length) return [];

  return raw.slice(0, limit).map((c) => {
    const hasKol = (c.clusterAddressList || []).some((a) => a.isKol);
    return {
      holding_pct:   pct(c.holdingPercent),
      trend:         c.trendType?.trendType || c.trendType || null,
      avg_hold_days: c.averageHoldingPeriod ? Math.round(parseFloat(c.averageHoldingPeriod) / 86400) : null,
      pnl_pct:       pct(c.pnlPercent),
      buy_vol_usd:   pct(c.buyVolume),
      sell_vol_usd:  pct(c.sellVolume),
      avg_buy_price: pct(c.averageBuyPriceUsd),
      has_kol:       hasKol,
      address_count: (c.clusterAddressList || []).length,
    };
  });
}

/**
 * Price info — current price, ATH (maxPrice), ATL, multi-timeframe volume + price change.
 * Also returns holders, marketCap, liquidity from this endpoint.
 */
export async function getPriceInfo(tokenAddress, chainIndex = CHAIN_SOLANA) {
  const serverPayload = await getServerOkxEnrichmentOrNull(tokenAddress, chainIndex);
  if (serverPayload?.price) return serverPayload.price;

  const data = await okxPost("/api/v6/dex/market/price-info", [
    { chainIndex, tokenContractAddress: tokenAddress },
  ]);
  const d = Array.isArray(data) ? data[0] : data;
  if (!d) return null;
  const price    = parseFloat(d.price    || 0);
  const maxPrice = parseFloat(d.maxPrice || 0);
  return {
    price,
    ath:              maxPrice,
    atl:              parseFloat(d.minPrice || 0),
    price_vs_ath_pct: maxPrice > 0 ? parseFloat(((price / maxPrice) * 100).toFixed(1)) : null,
    price_change_5m:  pct(d.priceChange5M),
    price_change_1h:  pct(d.priceChange1H),
    volume_5m:        pct(d.volume5M),
    volume_1h:        pct(d.volume1H),
    holders:          int(d.holders),
    market_cap:       pct(d.marketCap),
    liquidity:        pct(d.liquidity),
  };
}

/**
 * Fetch all three in parallel — use this during screening enrichment.
 */
export async function getFullTokenAnalysis(tokenAddress, chainIndex = CHAIN_SOLANA) {
  const serverPayload = await getServerOkxEnrichmentOrNull(tokenAddress, chainIndex);
  if (serverPayload) {
    return {
      advanced: serverPayload.advanced || null,
      clusters: Array.isArray(serverPayload.clusters) ? serverPayload.clusters : [],
      price: serverPayload.price || null,
    };
  }

  const [advanced, clusters, price] = await Promise.allSettled([
    getAdvancedInfo(tokenAddress, chainIndex),
    getClusterList(tokenAddress, chainIndex),
    getPriceInfo(tokenAddress, chainIndex),
  ]);
  return {
    advanced: advanced.status === "fulfilled" ? advanced.value : null,
    clusters: clusters.status === "fulfilled" ? clusters.value : [],
    price:    price.status    === "fulfilled" ? price.value    : null,
  };
}
