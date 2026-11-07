// tools/pnl.ts — Strict TypeScript DLMM PnL & Deposit History Engine
// Oracle Engineering Standards: Zero any, Zero unsafe assertions, Domain Purity, DRY z.infer schemas.

import { Connection, PublicKey } from "@solana/web3.js";
import type { PositionInfo } from "@meteora-ag/dlmm";
import { config } from "../config.js";
import { log } from "../logger.js";
import {
  getTrackedPosition,
  isPostClaimSettling,
  markOutOfRange,
  markInRange,
  minutesOutOfRange,
} from "../state.js";
import {
  MeteoraPositionsPnlResponseSchema,
  JupiterPriceV3ResponseSchema,
  JupiterAssetSearchResponseSchema,
  type MeteoraPositionPnlItem,
  type PositionPnlReport,
  type PositionsComputeResult,
} from "../src/schemas/api.js";
import { extractStringProperty } from "../src/schemas/solana.js";

// ─── Public-infra PnL Engine Configuration ─────────────────────────────────

const JUP_PRICE_V3 = "https://api.jup.ag/price/v3";
const JUP_SEARCH = "https://datapi.jup.ag/v1/assets/search";
const METEORA_PNL = "https://dlmm.datapi.meteora.ag/positions";

export interface DlmmStatic {
  getAllLbPairPositionsByUser(
    connection: Connection,
    userPubKey: PublicKey
  ): Promise<Map<string, PositionInfo>>;
}

let _DLMM: DlmmStatic | null = null;

function isDlmmClass(val: unknown): val is DlmmStatic {
  return typeof val === "function" && "getAllLbPairPositionsByUser" in val;
}

async function loadDlmmSdk(): Promise<DlmmStatic> {
  if (!_DLMM) {
    const mod: unknown = await import("@meteora-ag/dlmm");
    const candidate =
      mod && typeof mod === "object" && "default" in mod
        ? (mod as { default: unknown }).default
        : mod;
    if (!isDlmmClass(candidate)) {
      throw new Error("Failed to load DLMM SDK: class definition not found");
    }
    _DLMM = candidate;
  }
  return _DLMM;
}

let _pnlConnection: Connection | null = null;
export function getPnlConnection(): Connection {
  if (!_pnlConnection) {
    _pnlConnection = new Connection(config.pnl.rpcUrl, "confirmed");
  }
  return _pnlConnection;
}

// ─── Numeric & Formatting Helpers ──────────────────────────────────────────

function safeNum(value: unknown): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

function maybeNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

function round(value: unknown, decimals = 4): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function unique(arr: (string | null | undefined)[]): string[] {
  const clean = arr.filter((x): x is string => typeof x === "string" && x.length > 0);
  return [...new Set(clean)];
}

function mapEntries(map: unknown): Array<[string, unknown]> {
  if (map instanceof Map) return [...map.entries()];
  if (map && typeof map === "object") return Object.entries(map as Record<string, unknown>);
  return [];
}

// ─── Meteora /pnl Per Pool (Deposit History) ───────────────────────────────

export async function fetchDlmmPnlForPool(
  poolAddress: string,
  walletAddress: string
): Promise<Record<string, MeteoraPositionPnlItem>> {
  const url = `${METEORA_PNL}/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("pnl_api", `HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return {};
    }
    const raw: unknown = await res.json();
    const parsed = MeteoraPositionsPnlResponseSchema.safeParse(raw);
    if (!parsed.success) {
      log("pnl_api", `Schema validation failed for pool ${poolAddress.slice(0, 8)}`);
      return {};
    }
    const positions = parsed.data.positions ?? parsed.data.data ?? [];
    const byAddress: Record<string, MeteoraPositionPnlItem> = {};
    for (const p of positions) {
      const addr = p.positionAddress ?? p.address ?? p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log("pnl_api", `Fetch error for pool ${poolAddress.slice(0, 8)}: ${message}`);
    return {};
  }
}

// ─── Jupiter Prices (Price V3 with Search Fallback) ────────────────────────

export async function getJupiterPrices(mints: string[]): Promise<Record<string, number>> {
  const list = unique(mints.map((m) => String(m).trim()));
  if (!list.length) return {};
  const out: Record<string, number> = {};
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(config.jupiter.apiKey ? { "x-api-key": config.jupiter.apiKey } : {}),
  };

  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    try {
      const res = await fetch(`${JUP_PRICE_V3}?ids=${chunk.join(",")}`, { headers });
      if (!res.ok) throw new Error(`Jupiter Price V3 ${res.status}`);
      const raw: unknown = await res.json();
      const parsed = JupiterPriceV3ResponseSchema.safeParse(raw);
      if (parsed.success) {
        for (const mint of chunk) {
          const entry = parsed.data[mint];
          const p = maybeNum(entry?.usdPrice ?? entry?.price);
          if (p != null && p > 0) out[mint] = p;
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log("pnl_price", `Jupiter Price V3 fetch failed: ${message}`);
    }
  }

  const missing = list.filter((m) => !(out[m] !== undefined && out[m] > 0));
  if (missing.length > 0) {
    await Promise.all(
      missing.map(async (mint) => {
        try {
          const res = await fetch(`${JUP_SEARCH}?query=${encodeURIComponent(mint)}`, {
            headers: { accept: "application/json" },
          });
          if (!res.ok) throw new Error(`Jupiter search ${res.status}`);
          const raw: unknown = await res.json();
          const parsed = JupiterAssetSearchResponseSchema.safeParse(raw);
          if (parsed.success) {
            const listAssets = parsed.data;
            const match = listAssets.find((a) => a.id === mint) ?? listAssets[0];
            const p = maybeNum(match?.usdPrice ?? match?.price);
            if (p != null && p > 0) out[mint] = p;
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          log("pnl_price", `Jupiter search fallback failed for ${mint.slice(0, 8)}: ${message}`);
        }
      })
    );
  }

  return out;
}

// ─── Deposit-History Cache (Signature Invalidation + TTL) ──────────────────

interface MeteoraCacheEntry {
  at: number;
  byPosition: Record<string, MeteoraPositionPnlItem>;
  sigByPosition: Record<string, string | null>;
}

const _meteoraCache = new Map<string, MeteoraCacheEntry>();
let _pollCount = 0;

async function getLatestSig(conn: Connection, addr: string): Promise<string | null> {
  try {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(addr), { limit: 1 });
    return sigs?.[0]?.signature ?? null;
  } catch {
    return null;
  }
}

interface PositionFlatInfo {
  position: string;
  pool: string;
  baseMint: string | null;
  decX: number;
  decY: number;
  active: number | null;
  lower: number | null;
  upper: number | null;
  xRaw: unknown;
  yRaw: unknown;
  feeXRaw: unknown;
  feeYRaw: unknown;
}

async function getMeteoraData(
  conn: Connection,
  walletAddress: string,
  flat: PositionFlatInfo[]
): Promise<Record<string, MeteoraPositionPnlItem | null>> {
  const ttlMs = Math.max(0, Number(config.pnl.depositCacheTtlSec ?? 300)) * 1000;
  const positionsByPool = new Map<string, string[]>();
  for (const f of flat) {
    if (!positionsByPool.has(f.pool)) positionsByPool.set(f.pool, []);
    positionsByPool.get(f.pool)!.push(f.position);
  }

  const byPosition: Record<string, MeteoraPositionPnlItem | null> = {};
  await Promise.all(
    [...positionsByPool.entries()].map(async ([pool, positionAddrs]) => {
      const cached = _meteoraCache.get(pool);
      const sigByPosition: Record<string, string | null> = {};
      await Promise.all(
        positionAddrs.map(async (addr) => {
          sigByPosition[addr] = await getLatestSig(conn, addr);
        })
      );

      const ageOk = cached && Date.now() - cached.at < ttlMs;
      const sigsMatch =
        cached &&
        positionAddrs.every((a) => cached.sigByPosition[a] === sigByPosition[a]);

      let data: Record<string, MeteoraPositionPnlItem>;
      if (ageOk && sigsMatch) {
        data = cached.byPosition;
      } else {
        data = await fetchDlmmPnlForPool(pool, walletAddress);
        _meteoraCache.set(pool, { at: Date.now(), byPosition: data, sigByPosition });
      }
      for (const addr of positionAddrs) byPosition[addr] = data[addr] ?? null;
    })
  );

  return byPosition;
}

// ─── Build Shaped Position Object ──────────────────────────────────────────

function buildPosition(
  f: PositionFlatInfo,
  prices: Record<string, number>,
  solUsd: number | null,
  meteora: MeteoraPositionPnlItem | null | undefined,
  solMode: boolean
): PositionPnlReport {
  const priceX = f.baseMint ? (prices[f.baseMint] ?? 0) : 0;

  const xHuman = safeNum(f.xRaw) / 10 ** f.decX;
  const yHuman = safeNum(f.yRaw) / 10 ** f.decY;
  const balancesUsd = xHuman * priceX + yHuman * (solUsd ?? 0);
  const balancesSol = solUsd ? balancesUsd / solUsd : yHuman;

  const feeXHuman = safeNum(f.feeXRaw) / 10 ** f.decX;
  const feeYHuman = safeNum(f.feeYRaw) / 10 ** f.decY;
  const claimableUsd = feeXHuman * priceX + feeYHuman * (solUsd ?? 0);
  const claimableSol = solUsd ? claimableUsd / solUsd : feeYHuman;

  const depositsUsd = safeNum(meteora?.allTimeDeposits?.total?.usd);
  const depositsSol = safeNum(meteora?.allTimeDeposits?.total?.sol);
  const withdrawUsd = safeNum(meteora?.allTimeWithdrawals?.total?.usd);
  const withdrawSol = safeNum(meteora?.allTimeWithdrawals?.total?.sol);
  const claimedUsd = safeNum(meteora?.allTimeFees?.total?.usd);
  const claimedSol = safeNum(meteora?.allTimeFees?.total?.sol);

  const pnlUsd = balancesUsd + withdrawUsd + claimableUsd + claimedUsd - depositsUsd;
  const pnlSol = balancesSol + withdrawSol + claimableSol + claimedSol - depositsSol;
  const pctUsd = depositsUsd > 0 ? (pnlUsd / depositsUsd) * 100 : 0;
  const pctSol = depositsSol > 0 ? (pnlSol / depositsSol) * 100 : 0;

  const ourPct = solMode ? pctSol : pctUsd;

  const reportedPct = solMode ? maybeNum(meteora?.pnlSolPctChange) : maybeNum(meteora?.pnlPctChange);
  const pnlPctDiff = reportedPct != null ? Math.abs(ourPct - reportedPct) : null;

  const tracked = getTrackedPosition(f.position);
  const postClaimSettling = isPostClaimSettling(tracked);
  const holdsTokenX = xHuman > 0 || feeXHuman > 0;
  const priceMissing = !(solUsd != null && solUsd > 0) || (holdsTokenX && Boolean(f.baseMint) && !(priceX > 0));
  const depositsMissing = (solMode ? depositsSol : depositsUsd) <= 0;
  const pnlPctSuspicious = priceMissing || depositsMissing || postClaimSettling;

  if (postClaimSettling) {
    log(
      "pnl_warn",
      `${f.position.slice(0, 8)} post-claim settlement window active (last_claim_at=${tracked?.last_claim_at}) — pausing PnL exit/peak rules for 60s`
    );
  } else if (pnlPctSuspicious) {
    log(
      "pnl_warn",
      `${f.position.slice(0, 8)} suspicious tick — priceMissing=${priceMissing} depositsMissing=${depositsMissing} (solUsd=${solUsd}, priceX=${priceX})`
    );
  }

  const inRange =
    f.active != null && f.lower != null && f.upper != null
      ? f.active >= f.lower && f.active <= f.upper
      : meteora
        ? !meteora.isOutOfRange
        : true;

  if (inRange) markInRange(f.position);
  else markOutOfRange(f.position);

  const ageFromState = tracked?.deployed_at
    ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
    : null;
  const ageMinutes = meteora?.createdAt
    ? Math.floor((Date.now() - meteora.createdAt * 1000) / 60000)
    : ageFromState;

  return {
    position: f.position,
    pool: f.pool,
    pair: tracked?.pool_name || (meteora ? `${meteora.tokenX ?? "?"}/${meteora.tokenY ?? "SOL"}` : "?/SOL"),
    base_mint: f.baseMint,
    lower_bin: f.lower ?? tracked?.bin_range?.min ?? null,
    upper_bin: f.upper ?? tracked?.bin_range?.max ?? null,
    active_bin: f.active ?? tracked?.bin_range?.active ?? null,
    in_range: inRange,
    unclaimed_fees_usd: round(solMode ? claimableSol : claimableUsd),
    unclaimed_fees_true_usd: round(claimableUsd),
    total_value_usd: round(solMode ? balancesSol : balancesUsd),
    total_value_true_usd: round(balancesUsd),
    collected_fees_usd: round(solMode ? claimedSol : claimedUsd),
    collected_fees_true_usd: round(claimedUsd),
    pnl_usd: round(solMode ? pnlSol : pnlUsd),
    pnl_true_usd: round(pnlUsd),
    pnl_pct: round(ourPct, 2),
    pnl_pct_derived: round(ourPct, 2),
    pnl_pct_diff: pnlPctDiff != null ? round(pnlPctDiff, 2) : null,
    pnl_pct_suspicious: Boolean(pnlPctSuspicious),
    fee_per_tvl_24h: meteora?.feePerTvl24h != null ? Math.round(safeNum(meteora.feePerTvl24h) * 100) / 100 : null,
    age_minutes: ageMinutes,
    minutes_out_of_range: minutesOutOfRange(f.position),
    instruction: tracked?.instruction ?? null,
  };
}

// ─── Main Entrypoint: Compute Positions From Public Infra ──────────────────

export async function computePositions(walletAddress: string): Promise<PositionsComputeResult> {
  const solMode = Boolean(config.management?.solMode);
  const SOL_MINT = config.tokens.SOL;
  const conn = getPnlConnection();
  const DLMM = await loadDlmmSdk();

  const map = await DLMM.getAllLbPairPositionsByUser(conn, new PublicKey(walletAddress));
  _pollCount++;
  if (_pollCount % 20 === 1) {
    const totalCount = [...mapEntries(map)].reduce((sum, [, item]) => {
      const positionsData = (item as { lbPairPositionsData?: unknown[] })?.lbPairPositionsData;
      return sum + (Array.isArray(positionsData) ? positionsData.length : 0);
    }, 0);
    log("pnl_tick", `poller alive — ${totalCount} position(s) tracked (tick #${_pollCount})`);
  }

  const flat: PositionFlatInfo[] = [];
  for (const [lbPairKey, item] of mapEntries(map)) {
    const info = item as {
      tokenX?: { mint?: { decimals?: number; address?: { toString?: () => string } } };
      tokenY?: { mint?: { decimals?: number } };
      lbPair?: { activeId?: number };
      lbPairPositionsData?: Array<{
        publicKey: { toString: () => string };
        positionData?: {
          lowerBinId?: number;
          upperBinId?: number;
          totalXAmount?: unknown;
          totalYAmount?: unknown;
          feeX?: unknown;
          feeY?: unknown;
        };
      }>;
    };

    const decX = info?.tokenX?.mint?.decimals ?? 9;
    const decY = info?.tokenY?.mint?.decimals ?? 9;
    const baseMint = info?.tokenX?.mint?.address?.toString?.() ?? null;
    const active = info?.lbPair?.activeId ?? null;
    for (const p of info?.lbPairPositionsData || []) {
      const d = p.positionData;
      flat.push({
        position: p.publicKey.toString(),
        pool: lbPairKey,
        baseMint,
        decX,
        decY,
        active,
        lower: d?.lowerBinId ?? null,
        upper: d?.upperBinId ?? null,
        xRaw: d?.totalXAmount,
        yRaw: d?.totalYAmount,
        feeXRaw: extractStringProperty(d?.feeX) ?? String(d?.feeX ?? 0),
        feeYRaw: extractStringProperty(d?.feeY) ?? String(d?.feeY ?? 0),
      });
    }
  }

  if (flat.length === 0) {
    return { wallet: walletAddress, total_positions: 0, positions: [], source: "rpc" };
  }

  const [prices, meteoraByPosition] = await Promise.all([
    getJupiterPrices([
      SOL_MINT,
      ...flat.map((f) => f.baseMint).filter((m): m is string => Boolean(m)),
    ]),
    getMeteoraData(conn, walletAddress, flat),
  ]);
  const solUsd = prices[SOL_MINT] ?? null;

  const positions = flat.map((f) =>
    buildPosition(f, prices, solUsd, meteoraByPosition[f.position], solMode)
  );

  return { wallet: walletAddress, total_positions: positions.length, positions, source: "rpc" };
}
