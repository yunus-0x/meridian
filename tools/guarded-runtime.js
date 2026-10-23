import { createGuardedExecutor } from "./guarded-executor.js";
import { strictNumber } from "../risk/entry-policy.js";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const TIMEFRAME_MINUTES = { "5m": 5, "30m": 30, "1h": 60, "2h": 120, "4h": 240, "12h": 720, "24h": 1440 };
const MIN_VOLATILITY_TIMEFRAME = "30m";
const MAX_DATA_AGE_MS = 120_000;

/** Build the entry policy snapshot from the live screening config. */
export function buildPolicy(s = {}) {
  return {
    minTvl: s.minTvl, maxTvl: s.maxTvl,
    minVolume: s.minVolume,
    minHolders: s.minHolders,
    minMcap: s.minMcap, maxMcap: s.maxMcap,
    minBinStep: s.minBinStep, maxBinStep: s.maxBinStep,
    minFeeActiveTvlRatio: s.minFeeActiveTvlRatio,
    minOrganic: s.minOrganic,
    minTokenAgeHours: s.minTokenAgeHours,
    maxTokenAgeHours: s.maxTokenAgeHours,
    maxDataAgeMs: MAX_DATA_AGE_MS,
  };
}

/**
 * Fresh pool detail fetcher. For screening timeframes shorter than 30m the volatility
 * is taken from the 30m window, mirroring the executor's own volatility check.
 */
export function createPoolDetailFetcher(fetchFn, getTimeframe) {
  async function getDetail(pool, timeframe) {
    const filter = encodeURIComponent(`pool_address=${pool}`);
    const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodeURIComponent(timeframe)}`;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`Pool Discovery API error: ${res.status}`);
    const data = await res.json();
    return (data?.data || [])[0] ?? null;
  }
  return async function fetchPoolDetail(pool) {
    const tf = getTimeframe() || "5m";
    const detail = await getDetail(pool, tf);
    if (!detail) return null;
    if ((TIMEFRAME_MINUTES[tf] ?? 5) < TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME]) {
      const long = await getDetail(pool, MIN_VOLATILITY_TIMEFRAME);
      if (long && strictNumber(long.volatility) !== null) detail.volatility = long.volatility;
    }
    return detail;
  };
}

let guarded = null;

/** Drop-in replacement for executeTool for LLM-originated calls (see agent.js). */
export async function executeToolGuarded(name, args, ctx) {
  if (!guarded) {
    const [{ executeTool }, { config }, { log }] = await Promise.all([
      import("./executor.js"),
      import("../config.js"),
      import("../logger.js"),
    ]);
    guarded = createGuardedExecutor({
      executeTool,
      fetchPoolDetail: createPoolDetailFetcher(fetch, () => config.screening.timeframe),
      getPolicy: () => buildPolicy(config.screening),
      log,
    });
  }
  return guarded(name, args, ctx);
}
