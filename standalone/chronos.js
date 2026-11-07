// Chronos AI 5-Node Cluster Client + Rolling Relay Manager + Local Quantized Fallback
// Connects Meridian on GCP VPS (1 GB RAM) to the 5-Node InstaBox Cluster Ring
// (Total 20 vCPU / 40 GB RAM: meridian-chronos, coolify-cloud, kev-server, ci-runner, hermes-cloud)
// running:
//   - amazon/chronos-2 (120M Multivariate + 5 Past Covariates)
//   - amazon/chronos-bolt-base (205M Long-Context Patch T5)
// across up to 1,000 OHLCV candles (1m + 5m + 15m).
// Automatically rotates across the 5 nodes and wakes reserve nodes via the InstaBox API
// so no single node's 8-hour limit ever interrupts real Chronos inference.

import { execFile } from "node:child_process";
import { config, MIN_SAFE_BINS_BELOW, scaleBinsForBinStep } from "../config.js";
import { log } from "../logger.js";

const localCache = new Map();
const LOCAL_CACHE_TTL_MS = 40_000;
const inflightRefreshByPool = new Map();
const wakeAttemptByMachine = new Map();
let activeNodeIndex = 0;
let activeNodeStartedAt = Date.now();
let keepaliveTimer = null;

// Rotate primary node proactively every 6 hours (before the 8-hour InstaBox wall)
const PROACTIVE_ROTATE_MS = 6 * 3600_000;

export function getClusterNodes() {
  if (Array.isArray(config.chronos?.nodes) && config.chronos.nodes.length > 0) {
    return config.chronos.nodes;
  }
  const singleUrl = config.chronos?.endpointUrl;
  return singleUrl
    ? [{ name: "meridian-chronos", machineId: config.chronos?.instaboxMachineId, endpointUrl: singleUrl }]
    : [];
}

function pctToBins(pctAbs, binStep = 100) {
  const stepRatio = Math.max(Number(binStep) || 100, 1) / 10_000;
  const frac = Math.max(0.0001, Math.abs(Number(pctAbs) || 0) / 100);
  return Math.ceil(Math.log(1 + frac) / Math.log(1 + stepRatio));
}

function computeRsi14(closes) {
  if (!Array.isArray(closes) || closes.length <= 14) return 50;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= 14; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= 14;
  avgLoss /= 14;
  for (let i = 15; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * 13 + gain) / 14;
    avgLoss = (avgLoss * 13 + loss) / 14;
  }
  if (avgLoss < 1e-12) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

function computeBbPctB(closes, period = 20, mult = 2) {
  if (!Array.isArray(closes) || closes.length < period) return 0.5;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  if (std < 1e-12) return 0.5;
  const upper = mean + mult * std;
  const lower = mean - mult * std;
  return Math.round(((closes[closes.length - 1] - lower) / (upper - lower)) * 1000) / 1000;
}

function computeVolumeProfilePoc(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return { poc_price: 0, price_vs_poc_pct: 0 };
  let minP = Infinity;
  let maxP = -Infinity;
  for (const c of candles) {
    if (c[3] > 0 && c[3] < minP) minP = c[3];
    if (c[2] > maxP) maxP = c[2];
  }
  const cur = candles[candles.length - 1][4];
  if (!(maxP > minP) || !(minP > 0)) return { poc_price: cur, price_vs_poc_pct: 0 };
  const bins = 36;
  const step = (maxP - minP) / bins;
  const hist = new Float64Array(bins);
  for (const c of candles) {
    const typ = (c[2] + c[3] + c[4]) / 3;
    const idx = Math.max(0, Math.min(bins - 1, Math.floor((typ - minP) / step)));
    hist[idx] += Math.max(0, c[5] || 0);
  }
  let bestIdx = 0;
  for (let i = 1; i < bins; i++) {
    if (hist[i] > hist[bestIdx]) bestIdx = i;
  }
  const pocPrice = minP + (bestIdx + 0.5) * step;
  const priceVsPocPct = pocPrice > 0 ? Math.round(((cur - pocPrice) / pocPrice) * 100_000) / 1000 : 0;
  return { poc_price: pocPrice, price_vs_poc_pct: priceVsPocPct };
}

export function buildTacticalSignals({
  p10Pct,
  p50Pct,
  p90Pct,
  rsi14,
  bbPctB,
  microRsi14 = rsi14,
  microBbPctB = bbPctB,
  microP50Pct = p50Pct,
  macro15mP50Pct = p50Pct,
  macro15mP90Pct = p90Pct,
  chronos2P50Pct = p50Pct,
  priceVsPocPct = 0,
  binStep = 100,
  modelAgreement = 0.7,
}) {
  const xRatioMult = p50Pct <= -4.0
    ? 0.35
    : (p50Pct >= 2.0 && modelAgreement >= 0.60)
      ? 0.85
      : 0.65;

  const sniperLock = Boolean(
    (bbPctB >= 0.90 && rsi14 >= 72.0 && p50Pct < 0.0) ||
    (microBbPctB >= 0.92 && microRsi14 >= 75.0 && microP50Pct < -0.5),
  );
  const letWinnersRun = Boolean(p50Pct >= 2.5 && p90Pct >= 12.0 && !sniperLock);
  const microOversoldBounce = Boolean(microBbPctB < 0.08 && microRsi14 < 32.0 && microP50Pct > 1.0);
  const microBreakoutHold = Boolean(
    !sniperLock && p50Pct >= 2.5 && p90Pct >= 10.0 && microP50Pct >= 0.8 && microRsi14 < 78.0,
  );
  const spreadPct = Math.round((p90Pct - p10Pct) * 1000) / 1000;
  const stepNum = Number(binStep) || 100;

  // Upgrade #3: Dynamic Strategy Shape (curve vs spot vs bid_ask)
  // - curve: tight spread near POC (mean-reverting consolidation) OR high bin_step (>=150) where
  //   bid_ask would starve the active bin.
  // - bid_ask: compact bin_step (<=125) with wide volatility spread, deep wick-hunt (p10<=-9%),
  //   or explosive upside breakout (p90>=14%, p50>=2.5%).
  // - spot: moderate trend or divergent model agreement (<0.45).
  let recommendedStrategy = "spot";
  if (
    !sniperLock &&
    ((spreadPct < 18.0 && modelAgreement >= 0.65 && Math.abs(priceVsPocPct) <= 12.0 && Math.abs(p50Pct) <= 2.5) ||
      (stepNum >= 150 && spreadPct <= 24.0 && Math.abs(microP50Pct) <= 2.0))
  ) {
    recommendedStrategy = "curve";
  } else if (
    stepNum <= 125 &&
    modelAgreement >= 0.45 &&
    (spreadPct >= 22.0 ||
      (p10Pct <= -9.0 && p50Pct >= -0.5) ||
      (!sniperLock && p90Pct >= 14.0 && p50Pct >= 2.5))
  ) {
    recommendedStrategy = "bid_ask";
  }

  // Upgrade #4: Multi-Timeframe (1m + 5m + 15m + POC) Calibrated Conviction Multiplier
  const fullMtfBull = Boolean(
    microP50Pct > 0.5 &&
    p50Pct >= 2.5 &&
    macro15mP50Pct > 0.5 &&
    modelAgreement >= 0.75 &&
    priceVsPocPct > 0.5 &&
    priceVsPocPct <= 20.0,
  );
  const convictionMult = fullMtfBull
    ? 1.25
    : (p50Pct >= 1.5 && macro15mP50Pct >= -2.0 && modelAgreement >= 0.65 && p10Pct > -20.0)
      ? 1.15
      : (p10Pct <= -30.0 && modelAgreement < 0.35)
        ? 0.80
        : (p50Pct <= -1.8 || macro15mP50Pct <= -3.5 || (modelAgreement < 0.35 && chronos2P50Pct <= -2.0))
          ? 0.75
          : 1.00;

  const volumeDecayWarning = Boolean(
    chronos2P50Pct <= -2.0 && (p50Pct < 0 || modelAgreement < 0.35),
  );
  const knifeRescueTrigger = Boolean(
    p50Pct <= -5.0 && macro15mP50Pct <= -6.0 && modelAgreement >= 0.70,
  );
  const claimThresholdMult = (sniperLock || p50Pct <= -2.0 || chronos2P50Pct <= -2.5)
    ? 0.40
    : letWinnersRun
      ? 1.25
      : 1.00;
  const takeProfitMult = (letWinnersRun || macro15mP90Pct >= 16.0) ? 1.35 : 1.00;

  return {
    recommended_strategy: recommendedStrategy,
    x_ratio_mult: xRatioMult,
    conviction_mult: convictionMult,
    sniper_lock: sniperLock,
    let_winners_run: letWinnersRun,
    micro_oversold_bounce: microOversoldBounce,
    micro_breakout_hold: microBreakoutHold,
    volume_decay_warning: volumeDecayWarning,
    knife_rescue_trigger: knifeRescueTrigger,
    claim_threshold_mult: claimThresholdMult,
    take_profit_mult: takeProfitMult,
    spread_pct: spreadPct,
  };
}

/**
 * Deterministic Mean-Scaled Quantized Trajectory Forecaster (Local Fallback)
 */
export function localQuantizedForecast(candles, {
  poolAddress = "local",
  binStep = 100,
  defaultBinsAbove = config.strategy?.defaultBinsAbove ?? 7,
  defaultBinsBelow = config.strategy?.defaultBinsBelow ?? 55,
  minBinsBelow = MIN_SAFE_BINS_BELOW,
  horizon = 12,
  candles1m = null,
} = {}) {
  const valid = (Array.isArray(candles) ? candles : []).filter(c => Array.isArray(c) && Number(c[4]) > 0);
  if (valid.length < 16) {
    return null;
  }
  const closes = valid.map(c => Number(c[4]));
  const currentPrice = closes[closes.length - 1];
  const rsi14 = computeRsi14(closes);
  const bbPctB = computeBbPctB(closes, 20, 2);
  const vp = computeVolumeProfilePoc(valid);

  const valid1m = (Array.isArray(candles1m) ? candles1m : []).filter(c => Array.isArray(c) && Number(c[4]) > 0);
  const closes1m = valid1m.length >= 20 ? valid1m.map(c => Number(c[4])) : null;
  const microRsi14 = closes1m ? computeRsi14(closes1m) : rsi14;
  const microBbPctB = closes1m ? computeBbPctB(closes1m, 20, 2) : bbPctB;

  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    const r = (closes[i] - closes[i - 1]) / closes[i - 1];
    if (Number.isFinite(r)) returns.push(r);
  }
  const n = returns.length;
  const pathEnds = [];
  const pathMin = [];
  const pathMax = [];
  const blockLen = 3;
  const numPaths = 240;
  for (let p = 0; p < numPaths; p++) {
    let price = currentPrice;
    let lowest = currentPrice;
    let highest = currentPrice;
    for (let h = 0; h < horizon; h += blockLen) {
      const seed = Math.sin((p + 1) * 12.9898 + (h + 1) * 78.233 + n) * 43758.5453;
      const u = seed - Math.floor(seed);
      const biasedU = Math.pow(u, 0.65);
      const startIdx = Math.max(0, Math.min(n - blockLen, Math.floor(biasedU * (n - blockLen + 1))));
      for (let b = 0; b < blockLen && h + b < horizon; b++) {
        const stepRet = returns[startIdx + b] ?? 0;
        price *= Math.max(0.2, Math.min(3.0, 1 + stepRet));
        if (price < lowest) lowest = price;
        if (price > highest) highest = price;
      }
    }
    pathEnds.push(price);
    pathMin.push(lowest);
    pathMax.push(highest);
  }

  pathEnds.sort((a, b) => a - b);
  pathMin.sort((a, b) => a - b);
  pathMax.sort((a, b) => a - b);

  const qIndex = (arr, q) => arr[Math.max(0, Math.min(arr.length - 1, Math.floor(q * (arr.length - 1))))];
  const p10Price = qIndex(pathMin, 0.15);
  const p50Price = qIndex(pathEnds, 0.50);
  const p75Price = qIndex(pathEnds, 0.75);
  const p90Price = qIndex(pathMax, 0.85);

  const p10Pct = Math.round(((p10Price - currentPrice) / currentPrice) * 100_000) / 1000;
  const p50Pct = Math.round(((p50Price - currentPrice) / currentPrice) * 100_000) / 1000;
  const p75Pct = Math.round(((p75Price - currentPrice) / currentPrice) * 100_000) / 1000;
  const p90Pct = Math.round(((p90Price - currentPrice) / currentPrice) * 100_000) / 1000;

  let gateAction = "PASS";
  let gateReason = "trajectory healthy (local quantized)";
  if (bbPctB > 0.92 && rsi14 > 74 && p50Pct < 0) {
    gateAction = "DEFER";
    gateReason = `climax top detected (RSI=${rsi14}, BB%B=${bbPctB}, P50=${p50Pct}%) — waiting for pullback`;
  } else if (p50Pct <= -6.0 && p90Pct <= 0.5) {
    gateAction = "DEFER";
    gateReason = `freefall knife detected (P50=${p50Pct}%, P90=${p90Pct}%)`;
  } else if (vp.price_vs_poc_pct > 28.0 && rsi14 >= 68.0 && p50Pct < 0.5) {
    gateAction = "DEFER";
    gateReason = `overextended above POC (+${vp.price_vs_poc_pct}% vs POC, RSI=${rsi14}, P50=${p50Pct}%)`;
  }

  const stepNum = Number(binStep) || 100;
  const scaledMinBelow = scaleBinsForBinStep(minBinsBelow, stepNum, 22);
  const scaledDefaultBelow = scaleBinsForBinStep(defaultBinsBelow, stepNum, 26);
  const skewRatio = Math.abs(p90Pct) / Math.max(1.0, Math.abs(p10Pct));
  const rawBinsAbove = pctToBins(Math.max(1.5, p90Pct * 0.75), stepNum);
  const maxBinsAbove = (p50Pct >= 2.5 && p90Pct >= 12.0 && skewRatio >= 1.3) ? 15 : 11;
  const recommendedBinsAbove = p50Pct > 1.5
    ? Math.max(5, Math.min(maxBinsAbove, rawBinsAbove))
    : p50Pct < -1.5
      ? Math.max(4, Math.min(7, defaultBinsAbove))
      : Math.max(5, Math.min(9, defaultBinsAbove));

  const p10BinsNeeded = pctToBins(Math.abs(p10Pct) * 1.15, stepNum);
  const pocBinsNeeded = (vp.price_vs_poc_pct > 0 && vp.price_vs_poc_pct <= 35.0)
    ? pctToBins(vp.price_vs_poc_pct * 1.08, stepNum)
    : 0;
  const maxAllowedBelow = Math.min(
    scaleBinsForBinStep(69, stepNum, 36),
    69 - recommendedBinsAbove,
  );
  const recommendedBinsBelow = Math.max(
    scaledMinBelow,
    Math.min(maxAllowedBelow, Math.max(scaledDefaultBelow, p10BinsNeeded, pocBinsNeeded)),
  );

  const oorBelowOutlook = (p50Pct < -4.0 && p90Pct < 1.0)
    ? "WEAK_STRUCTURAL_BREAKDOWN"
    : (p50Pct > 0.5 || p75Pct > 3.0)
      ? "STRONG_REBOUND_PROBABILITY"
      : "HOLD_FOR_REBOUND";

  const tacticalSignals = buildTacticalSignals({
    p10Pct,
    p50Pct,
    p90Pct,
    rsi14,
    bbPctB,
    microRsi14,
    microBbPctB,
    microP50Pct: p50Pct,
    macro15mP50Pct: p50Pct,
    macro15mP90Pct: p90Pct,
    chronos2P50Pct: p50Pct,
    priceVsPocPct: vp.price_vs_poc_pct,
    binStep: stepNum,
    modelAgreement: 0.7,
  });

  return {
    pool_address: poolAddress,
    engine: "local-quantized-bootstrap-fallback",
    node: "gcp-local",
    latency_ms: 2,
    cached: false,
    gate: { action: gateAction, reason: gateReason },
    recommended_bins: {
      bins_above: recommendedBinsAbove,
      bins_below: recommendedBinsBelow,
      bin_step: binStep,
    },
    tactical_signals: tacticalSignals,
    oor_below_outlook: oorBelowOutlook,
    summary: {
      p10_pct: p10Pct,
      p50_pct: p50Pct,
      p90_pct: p90Pct,
      macro_15m_p50_pct: p50Pct,
      macro_15m_p90_pct: p90Pct,
      micro_1m_p50_pct: p50Pct,
      micro_1m_rsi_14: microRsi14,
      micro_1m_bb_pct_b: microBbPctB,
      rsi_14: rsi14,
      bb_pct_b: bbPctB,
      poc_price: vp.poc_price,
      price_vs_poc_pct: vp.price_vs_poc_pct,
      model_agreement: 0.7,
    },
  };
}

/**
 * Wake a specific InstaBox machine by ID (or the current primary node if omitted).
 */
export async function wakeInstaBoxIfNeeded(targetMachineId = null) {
  const apiKey = config.chronos?.instaboxApiKey;
  const nodes = getClusterNodes();
  const machineId = targetMachineId || nodes[activeNodeIndex]?.machineId || config.chronos?.instaboxMachineId;
  if (!apiKey || !machineId) return false;
  const lastAt = wakeAttemptByMachine.get(machineId) ?? 0;
  if (Date.now() - lastAt < 60_000) return false;
  wakeAttemptByMachine.set(machineId, Date.now());
  try {
    const res = await fetch(`https://api.instabox.sh/v1/machines/${machineId}/resume`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `meridian-wake-${machineId}-${Date.now()}`,
        "User-Agent": "meridian-standalone",
      },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 200 || res.status === 202) {
      log("chronos", `InstaBox node (${machineId}) resume triggered (HTTP ${res.status})`);
      return true;
    }
  } catch {
    // Ignore transient network errors
  }
  return false;
}

/**
 * Suspend an InstaBox machine so its 8-hour continuous runtime timer rests and resets.
 */
export async function suspendInstaBoxMachine(machineId) {
  const apiKey = config.chronos?.instaboxApiKey;
  if (!apiKey || !machineId) return false;
  try {
    const res = await fetch(`https://api.instabox.sh/v1/machines/${machineId}/suspend`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `meridian-suspend-${machineId}-${Date.now()}`,
        "User-Agent": "meridian-standalone",
      },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 200 || res.status === 202) {
      log("chronos", `InstaBox node (${machineId}) proactively suspended for cooldown reset`);
      return true;
    }
  } catch {
    // Ignore transient network errors
  }
  return false;
}

/**
 * Keep the active InstaBox Chronos node warm and perform 6-hour rolling relay
 * rotation across the 5-node ring so no node ever hits the 8-hour hard wall.
 */
export function startChronosKeepalive() {
  if (keepaliveTimer || !config.chronos?.enabled) return;
  const sshToken = config.chronos?.instaboxSshToken;
  const nodes = getClusterNodes();
  if (nodes.length === 0) return;

  const maintainCluster = async () => {
    // Proactive 6-hour relay shift before the 8-hour InstaBox limit (only when API key is configured)
    if (config.chronos?.instaboxApiKey && nodes.length > 1 && Date.now() - activeNodeStartedAt >= PROACTIVE_ROTATE_MS) {
      const prevNode = nodes[activeNodeIndex];
      const nextIdx = (activeNodeIndex + 1) % nodes.length;
      const nextNode = nodes[nextIdx];
      const standbyIdx = (nextIdx + 1) % nodes.length;
      const standbyNode = nodes[standbyIdx];

      await wakeInstaBoxIfNeeded(nextNode.machineId);
      await wakeInstaBoxIfNeeded(standbyNode.machineId);
      // Verify nextNode is reachable before shifting activeNodeIndex
      let nextReady = false;
      try {
        const check = await fetch(`${nextNode.endpointUrl.replace(/\/$/, "")}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        nextReady = check.ok;
      } catch {
        nextReady = false;
      }
      if (nextReady) {
        log("chronos", `Proactive 6h relay shift: ${prevNode.name} → ${nextNode.name} (standby: ${standbyNode.name})`);
        activeNodeIndex = nextIdx;
        activeNodeStartedAt = Date.now();
        // Rest the previous node unless it is coolify-cloud (which runs Sync ERP)
        if (prevNode.name !== "coolify-cloud") {
          void suspendInstaBoxMachine(prevNode.machineId);
        }
        return;
      }
    }

    // Always keep primary meridian-chronos warm via SSH token if it is active or if no API key is configured
    const curNode = nodes[activeNodeIndex];
    if ((curNode?.name === "meridian-chronos" || !config.chronos?.instaboxApiKey) && sshToken) {
      execFile(
        "ssh",
        [
          "-p", "2222",
          "-o", "StrictHostKeyChecking=accept-new",
          "-o", "BatchMode=yes",
          "-o", "ConnectTimeout=15",
          `${sshToken}@ssh.instabox.sh`,
          "curl -sf http://127.0.0.1:8090/health >/dev/null || sudo systemctl restart chronos-api.service",
        ],
        { timeout: 20_000 },
        err => {
          if (err && curNode) void wakeInstaBoxIfNeeded(curNode.machineId);
        },
      );
    } else if (curNode?.endpointUrl) {
      try {
        const res = await fetch(`${curNode.endpointUrl.replace(/\/$/, "")}/health`, {
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) void wakeInstaBoxIfNeeded(curNode.machineId);
      } catch {
        void wakeInstaBoxIfNeeded(curNode.machineId);
      }
    }
  };

  void maintainCluster();
  keepaliveTimer = setInterval(() => { void maintainCluster(); }, 10 * 60_000);
  if (typeof keepaliveTimer.unref === "function") keepaliveTimer.unref();
}

export function stopChronosKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

async function fetchGeckoCandles(poolAddress, aggregate, limit = 1000) {
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=${aggregate}&limit=${limit}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(4500),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const list = body?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list) || list.length < 16) return null;
    return list.slice().reverse();
  } catch {
    return null;
  }
}

export function getCachedChronosAnalysis(poolAddress) {
  const cached = localCache.get(poolAddress);
  if (cached && Date.now() - cached.at < LOCAL_CACHE_TTL_MS * 6) {
    return cached.data;
  }
  return null;
}

export function getChronosCacheAgeMs(poolAddress) {
  const cached = localCache.get(poolAddress);
  return cached ? Math.max(0, Date.now() - cached.at) : Infinity;
}

export function refreshChronosInBackground(poolAddress, opts = {}) {
  if (!poolAddress || !config.chronos?.enabled) return false;
  if (inflightRefreshByPool.has(poolAddress)) return false;
  const p = analyzePoolWithChronos(poolAddress, { ...opts, maxCacheAgeMs: 0 })
    .catch(() => null)
    .finally(() => {
      inflightRefreshByPool.delete(poolAddress);
    });
  inflightRefreshByPool.set(poolAddress, p);
  return true;
}

function enrichClusterResponse(data, {
  binStep = 100,
  defaultBinsAbove = config.strategy?.defaultBinsAbove ?? 7,
  defaultBinsBelow = config.strategy?.defaultBinsBelow ?? 55,
  minBinsBelow = MIN_SAFE_BINS_BELOW,
  computedMicroRsi14,
  computedMicroBbPctB,
} = {}) {
  if (!data || !data.summary) return data;
  const s = data.summary;
  const stepNum = Number(binStep) || Number(data.recommended_bins?.bin_step) || 100;
  const p10Pct = Number(s.p10_pct ?? 0);
  const p50Pct = Number(s.p50_pct ?? 0);
  const p90Pct = Number(s.p90_pct ?? 0);
  const rsi14 = Number(s.rsi_14 ?? 50);
  const bbPctB = Number(s.bb_pct_b ?? 0.5);
  const macro15mP50Pct = Number(s.macro_15m_p50_pct ?? data.timeframes?.["15m"]?.p50_pct ?? p50Pct);
  const macro15mP90Pct = Number(s.macro_15m_p90_pct ?? data.timeframes?.["15m"]?.p90_pct ?? p90Pct);
  const microP50Pct = Number(s.micro_1m_p50_pct ?? data.timeframes?.["1m"]?.p50_pct ?? p50Pct);
  const microRsi14 = Number(s.micro_1m_rsi_14 ?? data.timeframes?.["1m"]?.rsi_14 ?? computedMicroRsi14 ?? rsi14);
  const microBbPctB = Number(s.micro_1m_bb_pct_b ?? data.timeframes?.["1m"]?.bb_pct_b ?? computedMicroBbPctB ?? bbPctB);
  const priceVsPocPct = Number(s.price_vs_poc_pct ?? data.timeframes?.["5m"]?.volume_profile?.price_vs_poc_pct ?? 0);
  const modelAgreement = Number(s.model_agreement ?? 0.7);
  const chronos2P50Pct = Number(
    s.chronos2_p50_pct ?? data.timeframes?.["5m"]?.chronos2_p50_pct ?? p50Pct,
  );

  s.chronos2_p50_pct = chronos2P50Pct;
  s.macro_15m_p50_pct = macro15mP50Pct;
  s.macro_15m_p90_pct = macro15mP90Pct;
  s.price_vs_poc_pct = priceVsPocPct;

  data.tactical_signals = {
    ...(data.tactical_signals || {}),
    ...buildTacticalSignals({
      p10Pct,
      p50Pct,
      p90Pct,
      rsi14,
      bbPctB,
      microRsi14,
      microBbPctB,
      microP50Pct,
      macro15mP50Pct,
      macro15mP90Pct,
      chronos2P50Pct,
      priceVsPocPct,
      binStep: stepNum,
      modelAgreement,
    }),
  };

  // Upgrade #2 & #4: POC Overextended Gate & Macro 15m Structural Downtrend Gate
  if (!data.gate || data.gate.action === "PASS") {
    if (priceVsPocPct > 28.0 && rsi14 >= 68.0 && p50Pct < 0.5) {
      data.gate = {
        action: "DEFER",
        reason: `overextended above POC (+${priceVsPocPct.toFixed(1)}% vs POC, RSI=${rsi14}, P50=${p50Pct}%)`,
      };
    } else if (macro15mP50Pct <= -7.5 && p50Pct < 1.0) {
      data.gate = {
        action: "DEFER",
        reason: `macro 15m structural downtrend (15m P50=${macro15mP50Pct}%, 5m P50=${p50Pct}%)`,
      };
    }
  }

  // Upgrade #2: POC-Anchored & Bin-Step-Scaled Range
  const scaledMinBelow = scaleBinsForBinStep(minBinsBelow, stepNum, 22);
  const scaledDefaultBelow = scaleBinsForBinStep(defaultBinsBelow, stepNum, 26);
  const skewRatio = Math.abs(p90Pct) / Math.max(1.0, Math.abs(p10Pct));
  const rawBinsAbove = pctToBins(Math.max(1.5, p90Pct * 0.75), stepNum);
  const maxBinsAbove = (p50Pct >= 2.5 && p90Pct >= 12.0 && skewRatio >= 1.3) ? 15 : 11;
  const recommendedBinsAbove = p50Pct > 1.5
    ? Math.max(5, Math.min(maxBinsAbove, rawBinsAbove))
    : p50Pct < -1.5
      ? Math.max(4, Math.min(7, defaultBinsAbove))
      : Math.max(5, Math.min(9, defaultBinsAbove));

  const p10BinsNeeded = pctToBins(Math.abs(p10Pct) * 1.15, stepNum);
  const pocBinsNeeded = (priceVsPocPct > 0 && priceVsPocPct <= 35.0)
    ? pctToBins(priceVsPocPct * 1.08, stepNum)
    : 0;
  const maxAllowedBelow = Math.min(
    scaleBinsForBinStep(69, stepNum, 36),
    69 - recommendedBinsAbove,
  );
  const recommendedBinsBelow = Math.max(
    scaledMinBelow,
    Math.min(maxAllowedBelow, Math.max(scaledDefaultBelow, p10BinsNeeded, pocBinsNeeded)),
  );

  data.recommended_bins = {
    bins_above: recommendedBinsAbove,
    bins_below: recommendedBinsBelow,
    bin_step: stepNum,
  };

  return data;
}

/**
 * Analyze a DLMM pool across the 5-Node InstaBox Cluster Ring
 * (`amazon/chronos-2` Multivariate + `amazon/chronos-bolt-base` 205M across 1,000 candles).
 * If the primary node fails/cools down, immediately fails over around the 5-node ring
 * and wakes the next reserve node in the background.
 */
export async function analyzePoolWithChronos(poolAddress, {
  binStep = 100,
  activePrice = null,
  defaultBinsAbove = config.strategy?.defaultBinsAbove ?? 7,
  defaultBinsBelow = config.strategy?.defaultBinsBelow ?? 55,
  minBinsBelow = MIN_SAFE_BINS_BELOW,
  candles5m = null,
  maxCacheAgeMs = LOCAL_CACHE_TTL_MS,
} = {}) {
  if (!config.chronos?.enabled) return null;

  const cached = localCache.get(poolAddress);
  if (cached && maxCacheAgeMs > 0 && Date.now() - cached.at < maxCacheAgeMs && !candles5m) {
    return { ...cached.data, cached: true };
  }

  let c1m = null;
  let c5m = candles5m;
  let c15m = null;

  if (!c5m) {
    [c1m, c5m, c15m] = await Promise.all([
      fetchGeckoCandles(poolAddress, 1, 512),
      fetchGeckoCandles(poolAddress, 5, 1000),
      fetchGeckoCandles(poolAddress, 15, 350),
    ]);
  }

  const valid1m = (Array.isArray(c1m) ? c1m : []).filter(c => Array.isArray(c) && Number(c[4]) > 0);
  const closes1m = valid1m.length >= 20 ? valid1m.map(c => Number(c[4])) : null;
  const computedMicroRsi14 = closes1m ? computeRsi14(closes1m) : undefined;
  const computedMicroBbPctB = closes1m ? computeBbPctB(closes1m, 20, 2) : undefined;

  const nodes = getClusterNodes();
  if (nodes.length > 0 && (c5m || c1m) && !candles5m) {
    const payload = JSON.stringify({
      pool_address: poolAddress,
      bin_step: Number(binStep) || 100,
      active_price: Number(activePrice) || null,
      default_bins_above: defaultBinsAbove,
      default_bins_below: defaultBinsBelow,
      min_bins_below: minBinsBelow,
      candles_1m: c1m,
      candles_5m: c5m,
      candles_15m: c15m,
    });

    for (let offset = 0; offset < nodes.length; offset++) {
      const idx = (activeNodeIndex + offset) % nodes.length;
      const node = nodes[idx];
      if (!node?.endpointUrl) continue;
      try {
        const res = await fetch(`${node.endpointUrl.replace(/\/$/, "")}/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          signal: AbortSignal.timeout(config.chronos?.timeoutMs ?? 6500),
        });
        if (res.ok) {
          const data = enrichClusterResponse(await res.json(), {
            binStep,
            defaultBinsAbove,
            defaultBinsBelow,
            minBinsBelow,
            computedMicroRsi14,
            computedMicroBbPctB,
          });
          data.cluster_node = node.name;
          if (idx !== activeNodeIndex) {
            log("chronos", `Cluster failover succeeded: switched active node to ${node.name} (#${idx + 1}/${nodes.length})`);
            activeNodeIndex = idx;
            activeNodeStartedAt = Date.now();
            // Wake the next reserve node in the ring so hot-standby is always ready
            const nextReserve = nodes[(idx + 1) % nodes.length];
            if (nextReserve?.machineId) void wakeInstaBoxIfNeeded(nextReserve.machineId);
          }
          localCache.set(poolAddress, { at: Date.now(), data });
          return data;
        }
        // Node returned 502/503/504 -> wake it or next reserve and immediately try next node in ring
        void wakeInstaBoxIfNeeded(node.machineId);
        const nextReserve = nodes[(idx + 1) % nodes.length];
        if (nextReserve?.machineId) void wakeInstaBoxIfNeeded(nextReserve.machineId);
      } catch {
        void wakeInstaBoxIfNeeded(node.machineId);
      }
    }
  }

  // Fallback: run local quantized engine on the fetched 5m (or 1m) candles
  const rawCandles = c5m || c1m;
  if (Array.isArray(rawCandles) && rawCandles.length >= 16) {
    const fallback = localQuantizedForecast(rawCandles, {
      poolAddress,
      binStep,
      defaultBinsAbove,
      defaultBinsBelow,
      minBinsBelow,
      candles1m: c1m,
    });
    if (fallback) {
      localCache.set(poolAddress, { at: Date.now(), data: fallback });
      return fallback;
    }
  }
  return null;
}
