// standalone/events.ts — DLMM Anchor event decoding, position snapshot, and exposure retention checks
// Oracle System Strict Mode: Zero any, Zero unsafe assertions, Domain Purity, DRY z.infer schemas.

import { PublicKey, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { readRpc, fetchJson } from "./rpc.js";
import type { MonitorEvent } from "../src/schemas/storage.js";
import {
  DlmmAddLiquidityEventDataSchema,
  extractStringProperty,
  type DlmmEvent,
  type PositionSnapshot,
} from "../src/schemas/solana.js";
import { JupiterPriceV3ResponseSchema } from "../src/schemas/api.js";

export const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const EVENT_CPI = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);

// ─── Interfaces for Anchor Coder Abstraction ─────────────────────

export interface EventCoderLike {
  decode(log: string): { name: string; data: unknown } | null;
}

export interface AccountsCoderLike {
  decode(accountName: string, data: Buffer): unknown;
}

export interface DlmmCoder {
  events: EventCoderLike;
  accounts: AccountsCoderLike;
}

export interface TransactionEntriesOptions {
  windowSec: number;
  minDepositSol: number;
}

export type SnapshotFn = (
  position: string,
  wallet: string,
  pool: string,
  minContextSlot?: number
) => Promise<PositionSnapshot | null>;

export interface ExposureCheckTarget {
  position?: string;
  wallet: string;
  pool?: string;
  slot?: number;
  mint: string;
  shares?: string;
}

// ─── Lazy Coder Initialization ────────────────────────────────────

let coder: DlmmCoder | undefined;
let coderPromise: Promise<DlmmCoder> | null = null;

export async function getCoder(): Promise<DlmmCoder> {
  if (coder) return coder;
  if (!coderPromise) {
    coderPromise = (async (): Promise<DlmmCoder> => {
      const { createProgram } = await import("@meteora-ag/dlmm");
      const loaded = await readRpc("monitor", async (c: Connection) => {
        const prog = createProgram(c);
        return prog.coder as DlmmCoder;
      });
      coder = loaded;
      return loaded;
    })().catch((err: unknown) => {
      coderPromise = null;
      throw err;
    });
  }
  return coderPromise;
}

/**
 * Test isolation helper to set or clear cached coder.
 */
export function _setCoderForTests(mockCoder: DlmmCoder | null): void {
  coder = mockCoder ?? undefined;
  coderPromise = mockCoder ? Promise.resolve(mockCoder) : null;
}

// ─── Event Decoding ──────────────────────────────────────────────

/**
 * Decode only Anchor event CPI instructions emitted by the verified DLMM program.
 * Never interpret arbitrary log strings or another program's payload as an LP entry.
 */
export function decodeEvents(
  tx: unknown,
  eventCoder?: EventCoderLike | null
): DlmmEvent[] {
  if (!tx || typeof tx !== "object") return [];

  const candidate = tx as Record<string, unknown>;
  const meta = candidate["meta"] as Record<string, unknown> | undefined;
  if (!meta || meta["err"] != null || candidate["blockTime"] == null) return [];

  const transaction = candidate["transaction"] as Record<string, unknown> | undefined;
  const message = transaction?.["message"] as Record<string, unknown> | undefined;
  if (!message) return [];

  const rawKeys =
    (message["staticAccountKeys"] as unknown[] | undefined) ||
    (message["accountKeys"] as unknown[] | undefined) ||
    [];

  const loadedAddresses = meta["loadedAddresses"] as
    | { writable?: unknown[]; readonly?: unknown[] }
    | undefined;

  const allKeys = [
    ...rawKeys,
    ...(loadedAddresses?.writable || []),
    ...(loadedAddresses?.readonly || []),
  ];

  const innerInstructions = (meta["innerInstructions"] as unknown[] | undefined) || [];
  const events: DlmmEvent[] = [];

  for (const group of innerInstructions) {
    if (!group || typeof group !== "object") continue;
    const instructions = (group as Record<string, unknown>)["instructions"];
    if (!Array.isArray(instructions)) continue;

    for (const ix of instructions) {
      if (!ix || typeof ix !== "object") continue;
      const ixObj = ix as Record<string, unknown>;
      const pIdx = typeof ixObj["programIdIndex"] === "number" ? ixObj["programIdIndex"] : -1;
      const keyObj = allKeys[pIdx];
      const programId = extractStringProperty(keyObj);

      if (programId !== DLMM_PROGRAM || !ixObj["data"]) continue;

      let bytes: Buffer;
      const dataVal = ixObj["data"];
      if (typeof dataVal === "string") {
        bytes = Buffer.from(bs58.decode(dataVal));
      } else if (Buffer.isBuffer(dataVal) || dataVal instanceof Uint8Array) {
        bytes = Buffer.from(dataVal);
      } else {
        continue;
      }

      if (bytes.length < 16 || !bytes.subarray(0, 8).equals(EVENT_CPI)) continue;

      if (!eventCoder) {
        throw new Error("Event coder required for decoding CPI payload");
      }

      const decoded = eventCoder.decode(bytes.subarray(8).toString("base64"));
      if (decoded && typeof decoded === "object" && typeof decoded.name === "string") {
        events.push({
          name: decoded.name,
          data: decoded.data,
        });
      }
    }
  }

  return events;
}

// ─── Account Decoding & Position Snapshot ─────────────────────────

async function account(
  address: string,
  type: string,
  minContextSlot?: number
): Promise<unknown | null> {
  const result = await readRpc("monitor", async (c: Connection) => {
    return c.getAccountInfoAndContext(new PublicKey(address), {
      commitment: "confirmed",
      minContextSlot,
    });
  });

  const info = result.value;
  if (!info) return null;
  if (info.owner.toString() !== DLMM_PROGRAM) {
    throw new Error("Unexpected account owner");
  }

  const dlmmCoder = await getCoder();
  return dlmmCoder.accounts.decode(type, info.data);
}

export async function positionSnapshot(
  position: string,
  wallet: string,
  pool: string,
  minContextSlot = 0
): Promise<PositionSnapshot | null> {
  const [pRaw, pairRaw] = await Promise.all([
    account(position, "positionV2", minContextSlot),
    account(pool, "lbPair", minContextSlot),
  ]);

  if (!pRaw || !pairRaw || typeof pRaw !== "object" || typeof pairRaw !== "object") {
    return null;
  }

  const p = pRaw as Record<string, unknown>;
  const pair = pairRaw as Record<string, unknown>;

  const pOwner = extractStringProperty(p["owner"]);
  const pLbPair = extractStringProperty(p["lbPair"]);
  if (!pOwner || !pLbPair || pOwner !== wallet || pLbPair !== pool) return null;

  const upperBinId = typeof p["upperBinId"] === "number" ? p["upperBinId"] : null;
  const lowerBinId = typeof p["lowerBinId"] === "number" ? p["lowerBinId"] : null;
  const activeId = typeof pair["activeId"] === "number" ? pair["activeId"] : null;

  if (upperBinId === null || lowerBinId === null || activeId === null) return null;

  // Wide positions require dynamic extension decoding. Conservatively exclude them
  // from wallet confirmation rather than misreading their inline liquidity.
  if (upperBinId - lowerBinId >= 70) return null;

  const sharesArr = Array.isArray(p["liquidityShares"]) ? p["liquidityShares"] : [];
  let sharesSum = 0n;
  for (const n of sharesArr) {
    const s = extractStringProperty(n);
    if (s && /^-?\d+$/.test(s)) {
      sharesSum += BigInt(s);
    }
  }

  const tokenXMint = extractStringProperty(pair["tokenXMint"]);
  const tokenYMint = extractStringProperty(pair["tokenYMint"]);
  if (!tokenXMint || !tokenYMint) return null;

  return {
    shares: sharesSum.toString(),
    xMint: tokenXMint,
    yMint: tokenYMint,
    lower: lowerBinId,
    upper: upperBinId,
    active: activeId,
    inRange: lowerBinId <= activeId && activeId <= upperBinId && sharesSum > 0n,
  };
}

// ─── SOL Price Valuation ──────────────────────────────────────────

let solPrice: { price: number; at: number } | null = null;

async function quoteInSol(mint: string, raw: bigint | number | string): Promise<number> {
  const rawNum = Number(raw);
  if (mint === config.tokens.SOL) return rawNum / 1e9;

  if (!solPrice || Date.now() - solPrice.at > 30_000) {
    const headers: Record<string, string> = {};
    if (config.jupiter.apiKey) {
      headers["x-api-key"] = config.jupiter.apiKey;
    }

    const rawData = await fetchJson(
      `https://api.jup.ag/price/v3?ids=${config.tokens.SOL}`,
      { headers }
    );

    const parsed = JupiterPriceV3ResponseSchema.safeParse(rawData);
    let price: number | undefined;
    if (parsed.success) {
      const entry = parsed.data[config.tokens.SOL];
      price = entry?.usdPrice;
    }

    if (typeof price !== "number" || !(price > 0)) {
      throw new Error("SOL price unavailable for stablecoin deposit valuation");
    }
    solPrice = { price, at: Date.now() };
  }

  return rawNum / 1e6 / solPrice.price;
}

// ─── Transaction Entries Extraction ───────────────────────────────

export async function transactionEntries(
  tx: unknown,
  signature: string,
  wallet: string,
  options: TransactionEntriesOptions,
  snapshot: SnapshotFn = positionSnapshot,
  eventCoder: EventCoderLike | null = null,
  now = Date.now()
): Promise<MonitorEvent[]> {
  if (!tx || typeof tx !== "object") return [];
  const candidate = tx as Record<string, unknown>;
  const meta = candidate["meta"] as Record<string, unknown> | undefined;

  if (
    !meta ||
    meta["err"] != null ||
    candidate["blockTime"] == null ||
    typeof candidate["blockTime"] !== "number" ||
    now - candidate["blockTime"] * 1000 > options.windowSec * 1000 ||
    candidate["blockTime"] * 1000 > now
  ) {
    return [];
  }

  const activeCoder = eventCoder || (await getCoder()).events;
  const events = decodeEvents(tx, activeCoder);

  // Rebalances/withdraw-and-redeposit are not new conviction, including cross-pool moves.
  if (events.some((e) => /removeLiquidity|rebalanc/i.test(e.name))) return [];

  interface AggregatedDeposit {
    position: string;
    pool: string;
    amounts: [bigint, bigint];
  }

  const deposits = new Map<string, AggregatedDeposit>();

  for (const e of events.filter((e) => e.name === "addLiquidity")) {
    const parsed = DlmmAddLiquidityEventDataSchema.safeParse(e.data);
    if (!parsed.success) continue;

    const d = parsed.data;
    if (d.from !== wallet) continue;

    const position = d.position;
    const pool = d.lbPair;
    const key = `${pool}:${position}`;

    const prior = deposits.get(key) || {
      position,
      pool,
      amounts: [0n, 0n],
    };

    prior.amounts = [
      prior.amounts[0] + (d.amounts[0] ?? 0n),
      prior.amounts[1] + (d.amounts[1] ?? 0n),
    ];
    deposits.set(key, prior);
  }

  const out: MonitorEvent[] = [];
  const quotes = new Set<string>(Object.values(config.tokens));
  const txSlot = typeof candidate["slot"] === "number" ? candidate["slot"] : 0;
  const txBlockTime = typeof candidate["blockTime"] === "number" ? candidate["blockTime"] : 0;

  for (const d of deposits.values()) {
    const p = await snapshot(d.position, wallet, d.pool, txSlot);
    if (!p?.inRange) continue;

    const xQuote = quotes.has(p.xMint);
    const yQuote = quotes.has(p.yMint);
    if (xQuote === yQuote) continue;

    const mint = xQuote ? p.yMint : p.xMint;
    const quote = xQuote ? p.xMint : p.yMint;

    // Require a meaningful quote-side deposit. Token-only inventory selling is excluded.
    const depositSol = await quoteInSol(quote, d.amounts[xQuote ? 0 : 1] ?? 0n);
    if (depositSol < options.minDepositSol) continue;

    out.push({
      id: `${signature}:${wallet}:${d.position}`,
      signature,
      wallet,
      position: d.position,
      pool: d.pool,
      mint,
      at: txBlockTime * 1000,
      slot: txSlot,
      depositSol,
      shares: p.shares,
      binsBelow: Math.max(0, p.active - p.lower),
      binsAbove: Math.max(0, p.upper - p.active),
    });
  }

  return out;
}

// ─── Exposure Retention Check ─────────────────────────────────────

export async function exposureStillPresent(
  event: ExposureCheckTarget,
  snapshot: SnapshotFn = positionSnapshot
): Promise<boolean> {
  if (!event.position || !event.pool || !event.shares) return false;
  const p = await snapshot(event.position, event.wallet, event.pool, event.slot);
  return (
    !!p?.inRange &&
    (p.xMint === event.mint || p.yMint === event.mint) &&
    BigInt(p.shares) * 2n >= BigInt(event.shares)
  );
}
