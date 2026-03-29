/**
 * OKX DEX API helpers
 * Docs: https://web3.okx.com/build/dev-docs/
 */

import crypto from "crypto";

const BASE = "https://web3.okx.com";
const CHAIN_SOLANA = "501";

function sign(timestamp, method, path, body = "") {
  const pre = timestamp + method.toUpperCase() + path + body;
  return crypto.createHmac("sha256", process.env.OKX_SECRET_KEY).update(pre).digest("base64");
}

function authHeaders(method, path, body = "") {
  const ts = new Date().toISOString();
  return {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY":        process.env.OKX_API_KEY,
    "OK-ACCESS-SIGN":       sign(ts, method, path, body),
    "OK-ACCESS-TIMESTAMP":  ts,
    "OK-ACCESS-PASSPHRASE": process.env.OKX_PASSPHRASE,
  };
}

async function okxGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders("GET", path) });
  if (!res.ok) throw new Error(`OKX API ${res.status}: ${path}`);
  const json = await res.json();
  if (json.code !== "0" && json.code !== 0) throw new Error(`OKX error ${json.code}: ${json.msg}`);
  return json.data;
}

async function okxPost(path, body) {
  const bodyStr = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: authHeaders("POST", path, bodyStr),
    body: bodyStr,
  });
  if (!res.ok) throw new Error(`OKX API ${res.status}: ${path}`);
  const json = await res.json();
  if (json.code !== "0" && json.code !== 0) throw new Error(`OKX error ${json.code}: ${json.msg}`);
  return json.data;
}

const pct = (v) => v != null && v !== "" ? parseFloat(v) : null;
const int = (v) => v != null && v !== "" ? parseInt(v, 10) : null;

/**
 * Advanced token info — risk level, bundle/sniper/suspicious %, dev rug history, token tags.
 * Single call replaces the old cluster-overview endpoint.
 */
export async function getAdvancedInfo(tokenAddress, chainIndex = CHAIN_SOLANA) {
  const path = `/api/v6/dex/market/token/advanced-info?chainIndex=${chainIndex}&tokenContractAddress=${tokenAddress}`;
  const data = await okxGet(path);
  const d = Array.isArray(data) ? data[0] : data;
  if (!d) return null;

  const tags = d.tokenTags || [];
  return {
    risk_level:       int(d.riskControlLevel),  // 1=low 2=med 3=med-high 4=high 5=high(manual)
    bundle_pct:       pct(d.bundleHoldingPercent),
    sniper_pct:       pct(d.sniperHoldingPercent),
    suspicious_pct:   pct(d.suspiciousHoldingPercent),
    new_wallet_pct:   pct(d.holderNewAddressPercent),
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
    dev_sold_all:         tags.includes("devHoldingStatusSellAll"),   // BULLISH — dev has no bag left to dump
    dev_buying_more:      tags.includes("devHoldingStatusBuy"),       // dev accumulating
    low_liquidity:        tags.includes("lowLiquidity"),
    dex_boost:            tags.includes("dexBoost"),                  // paid boost on DEX (promotional)
    dex_screener_paid:    tags.includes("dexScreenerPaid"),           // paid trending on DexScreener
  };
}

/**
 * Top 100 holder clusters — trend direction, holding period, KOL presence, PnL.
 * Condenses to top N clusters for LLM consumption.
 */
export async function getClusterList(tokenAddress, chainIndex = CHAIN_SOLANA, limit = 5) {
  const path = `/api/v6/dex/market/token/cluster/list?chainIndex=${chainIndex}&tokenContractAddress=${tokenAddress}`;
  const data = await okxGet(path);
  const raw = Array.isArray(data) ? data[0]?.clustList ?? data : (data?.clustList ?? []);
  if (!raw.length) return [];

  return raw.slice(0, limit).map((c) => {
    const hasKol = (c.clusterAddressList || []).some((a) => a.isKol);
    return {
      holding_pct:      pct(c.holdingPercent),
      trend:            c.trendType?.trendType || null,   // buy | sell | neutral | transfer
      avg_hold_days:    c.averageHoldingPeriod ? Math.round(parseFloat(c.averageHoldingPeriod)) : null,
      pnl_pct:          pct(c.pnlPercent),
      buy_vol_usd:      pct(c.buyVolume),
      sell_vol_usd:     pct(c.sellVolume),
      avg_buy_price:    pct(c.averageBuyPriceUsd),
      has_kol:          hasKol,
      address_count:    (c.clusterAddressList || []).length,
    };
  });
}

/**
 * Price info — current price, ATH (maxPrice), ATL, 24h volume + price change.
 */
export async function getPriceInfo(tokenAddress, chainIndex = CHAIN_SOLANA) {
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
    volume_24h:       parseFloat(d.volume24H || 0),
    price_change_24h: parseFloat(d.priceChange24H || 0),
  };
}

/**
 * Fetch all three in parallel — use this during screening enrichment.
 */
export async function getFullTokenAnalysis(tokenAddress, chainIndex = CHAIN_SOLANA) {
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
