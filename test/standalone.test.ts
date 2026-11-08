/**
 * test/standalone.test.ts — Unit tests for the standalone wallet-trigger pipeline.
 * Fully migrated to Vitest with 100% Strict Oracle TypeScript compliance.
 * Zero any, zero unsafe casts, hermetic offline execution.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bs58 from "bs58";
import { config, computeDeployAmount } from "../config.js";
import {
  MonitorStore,
  qualifyingEvents,
  acceptEvents,
  finishSignal,
  type MonitorEvent,
  type AcceptEventsOptions,
} from "../standalone/store.js";
import {
  decodeEvents,
  transactionEntries,
  type EventCoderLike,
  type SnapshotFn,
} from "../standalone/events.js";
import { aggregateTokenAccounts } from "../standalone/balances.js";
import { rejectToken, rejectPool } from "../standalone/screening.js";
import { withWalletLock } from "../standalone/transactions.js";
import {
  getDeterministicCloseRule,
  computeBinsBelow,
  type DeterministicPositionMetrics,
  type ManagementConfigInput,
} from "../exit-rules.js";
import { localQuantizedForecast, buildTacticalSignals } from "../standalone/chronos.js";
import { envryptEncrypt, envryptDecrypt } from "../envcrypt.js";
import { _test as adminTest } from "../standalone/telegram-admin.js";
import type {
  JupiterAssetItem,
  MeteoraPoolDiscoveryItem,
  GeckoCandleTuple,
} from "../src/schemas/api.js";
import type { PositionSnapshot } from "../src/schemas/solana.js";

interface Stringifiable {
  toString(): string;
}

const pk = (s: string): Stringifiable => ({ toString: () => s });

const MINT = "Mint111111111111111111111111111111111111111";
const POOL_A = "Po01AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const POOL_B = "Po02BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const W1 = "Wa11eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const W2 = "Wa22eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const W3 = "Wa33eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const options: AcceptEventsOptions = {
  walletThreshold: 2,
  windowSec: 120,
  screeningDeadlineSec: 120,
  minDepositSol: 0.1,
  cooldownSec: 300,
  walletGroups: {},
};

function createEntry(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  const wallet = overrides.wallet ?? W1;
  const position = overrides.position ?? "pos1";
  return {
    id: `sig:${wallet}:${position}`,
    signature: "sig",
    wallet,
    position,
    pool: POOL_A,
    mint: MINT,
    at: Date.now(),
    slot: 100,
    depositSol: 1,
    shares: "1000",
    ...overrides,
  };
}

describe("standalone wallet-trigger pipeline", () => {
  // ─── [1] qualifyingEvents ──────────────────────────────────────────────────
  describe("[1] qualifyingEvents — aggregation, dedup, grouping, dust, expiry", () => {
    it("deduplicates cross-pool entries by the same wallet (keeps latest)", () => {
      const now = Date.now();
      const evts: MonitorEvent[] = [
        createEntry({ wallet: W1, pool: POOL_A, position: "p1", at: now - 90_000 }),
        createEntry({ wallet: W1, pool: POOL_B, position: "p2", at: now - 30_000 }),
        createEntry({ wallet: W2, pool: POOL_A, position: "p3", at: now - 10_000 }),
      ];
      const q = qualifyingEvents(evts, MINT, options, now);
      expect(q).toHaveLength(2);
      const w1Event = q.find((e) => e.wallet === W1);
      expect(w1Event?.position).toBe("p2");
    });

    it("groups wallets sharing an operator group to count only once", () => {
      const now = Date.now();
      const evts: MonitorEvent[] = [
        createEntry({ wallet: W1, at: now - 10_000 }),
        createEntry({ wallet: W2, at: now - 20_000 }),
        createEntry({ wallet: W3, at: now - 5_000 }),
      ];
      const grouped = qualifyingEvents(
        evts,
        MINT,
        { ...options, walletGroups: { [W1]: "op1", [W2]: "op1" } },
        now
      );
      expect(grouped).toHaveLength(2);
      expect(grouped.every((e) => e.wallet !== W2)).toBe(true);
    });

    it("excludes dust deposits below minDepositSol", () => {
      const now = Date.now();
      const q = qualifyingEvents(
        [createEntry({ wallet: W1, depositSol: 0.01 })],
        MINT,
        options,
        now
      );
      expect(q).toHaveLength(0);
    });

    it("excludes events past the window", () => {
      const now = Date.now();
      const q = qualifyingEvents(
        [createEntry({ wallet: W1, at: now - 121_000 })],
        MINT,
        options,
        now
      );
      expect(q).toHaveLength(0);
    });

    it("ignores events for other mints", () => {
      const now = Date.now();
      const q = qualifyingEvents(
        [createEntry({ wallet: W1, mint: "Other111111111111111111111111111111111111111" })],
        MINT,
        options,
        now
      );
      expect(q).toHaveLength(0);
    });
  });

  // ─── [2] acceptEvents / finishSignal ───────────────────────────────────────
  describe("[2] acceptEvents / finishSignal — thresholds, cooldowns, dedup", () => {
    const tempFiles: string[] = [];

    afterEach(() => {
      for (const f of tempFiles) {
        try {
          if (fs.existsSync(f)) fs.rmSync(f, { force: true });
        } catch {}
      }
      tempFiles.length = 0;
    });

    it("manages convergence signals, cooldowns, restart persistence, and pruning", () => {
      const file = path.join(os.tmpdir(), `wm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      tempFiles.push(file);
      const store = new MonitorStore(file);
      const now = Date.now();

      // One wallet does not trigger (threshold = 2)
      const first = acceptEvents(store, [createEntry({ wallet: W1 })], options, now);
      expect(first).toHaveLength(0);

      // Second distinct wallet triggers signal
      const second = acceptEvents(store, [createEntry({ wallet: W2, position: "p3" })], options, now + 1000);
      expect(second).toHaveLength(1);
      const signal = second[0]!;
      expect(signal.mint).toBe(MINT);
      expect(Math.abs(signal.deadline - (now + 1000 + (options.screeningDeadlineSec ?? 120) * 1000))).toBeLessThan(5);

      // No duplicate signal while one is active
      const third = acceptEvents(store, [createEntry({ wallet: W3, position: "p4" })], options, now + 2000);
      expect(third).toHaveLength(0);

      // Duplicate event ids ignored
      const dup = acceptEvents(store, [createEntry({ wallet: W2, position: "p3" })], options, now + 3000);
      expect(dup).toHaveLength(0);
      expect(store.data.events.filter((e) => e.id === `sig:${W2}:p3`)).toHaveLength(1);

      // Finish signal and verify cooldown
      finishSignal(store, signal, "test done", options, now + 4000);
      const stale = acceptEvents(store, [], options, now + 5000);
      expect(stale).toHaveLength(0);
      expect(signal.done).toBe(true);
      expect(signal.cooldownUntil).toBe(now + 4000 + (options.cooldownSec ?? 300) * 1000);

      // Old events cannot re-trigger after cooldown
      const afterCooldown = now + 4000 + (options.cooldownSec ?? 300) * 1000 + 1000;
      const retriggerOld = acceptEvents(
        store,
        [createEntry({ wallet: W3, position: "p5", at: now })],
        options,
        afterCooldown
      );
      expect(retriggerOld).toHaveLength(0);

      // Fresh events re-trigger after cooldown
      const retriggerFresh = acceptEvents(
        store,
        [
          createEntry({ wallet: W3, position: "p6", at: afterCooldown - 1000 }),
          createEntry({ wallet: W1, position: "p7", at: afterCooldown - 500, pool: POOL_B }),
        ],
        options,
        afterCooldown
      );
      expect(retriggerFresh).toHaveLength(1);

      // State persists across restart
      const reopened = new MonitorStore(file);
      expect(reopened.data.events).toHaveLength(store.data.events.length);
      expect(reopened.data.signals[MINT]).toBeDefined();

      // Attempt records pruned after 24h except mid-submit
      reopened.data.attempts[MINT] = { at: Date.now() - 25 * 3600_000, status: "failed", failures: 1, txs: [] };
      reopened.data.attempts["Mint999999999999999999999999999999999999999"] = {
        at: Date.now() - 25 * 3600_000,
        status: "submitting",
        failures: 0,
        txs: [],
      };
      reopened.prune();
      expect(reopened.data.attempts[MINT]).toBeUndefined();
      expect(Object.keys(reopened.data.attempts)).toHaveLength(1);
    });

    it("refuses to discard invalid monitor state file on load", () => {
      const bad = path.join(os.tmpdir(), `wm-bad-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      tempFiles.push(bad);
      fs.writeFileSync(bad, JSON.stringify({ version: 99 }));
      expect(() => new MonitorStore(bad)).toThrow("Invalid monitor state; refusing to discard recovery history");
    });
  });

  // ─── [3] decodeEvents ──────────────────────────────────────────────────────
  describe("[3] decodeEvents — only verified DLMM program, only CPI events", () => {
    const coder: EventCoderLike = {
      decode: (payload: string) => {
        const buf = Buffer.from(payload, "base64");
        const kind = buf.subarray(0, 4).toString("utf8");
        if (kind === "ADD1") {
          return {
            name: "addLiquidity",
            data: {
              from: pk(W1),
              position: pk("pos1"),
              lbPair: pk(POOL_A),
              amounts: [{ toString: () => "100000000" }, { toString: () => "500000000" }],
            },
          };
        }
        if (kind === "ADD2") {
          return {
            name: "addLiquidity",
            data: {
              from: pk(W2),
              position: pk("pos2"),
              lbPair: pk(POOL_A),
              amounts: [{ toString: () => "100000000" }, { toString: () => "500000000" }],
            },
          };
        }
        if (kind === "REMV") return { name: "removeLiquidity", data: {} };
        return null;
      },
    };

    const cpi = (kind: string): Buffer =>
      Buffer.concat([
        Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]),
        Buffer.from(kind),
        Buffer.alloc(8),
      ]);

    const PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
    const OTHER = "Vote111111111111111111111111111111111111111";

    interface MockIx {
      programIdIndex: number;
      data: string;
    }

    const tx = (instructions: MockIx[], { err = null }: { err?: unknown } = {}) => ({
      blockTime: Math.floor(Date.now() / 1000),
      meta: { err, innerInstructions: [{ index: 0, instructions }] },
      transaction: { message: { staticAccountKeys: [pk(PROGRAM), pk(OTHER)] } },
    });

    const ix = (programIdx: number, data: Uint8Array): MockIx => ({
      programIdIndex: programIdx,
      data: bs58.encode(data),
    });

    it("decodes DLMM CPI events only", () => {
      const decoded = decodeEvents(
        tx([ix(0, cpi("ADD1")), ix(1, cpi("ADD2")), ix(0, cpi("REMV"))]),
        coder
      );
      expect(decoded).toHaveLength(2);
      expect(decoded.filter((e) => e.name === "addLiquidity")).toHaveLength(1);
    });

    it("yields nothing on failed transaction", () => {
      const decoded = decodeEvents(tx([ix(0, cpi("ADD1"))], { err: "x" }), coder);
      expect(decoded).toHaveLength(0);
    });

    it("yields nothing on missing blockTime", () => {
      const decoded = decodeEvents({ ...tx([ix(0, cpi("ADD1"))]), blockTime: null }, coder);
      expect(decoded).toHaveLength(0);
    });

    it("ignores non-CPI instruction data", () => {
      const junk = decodeEvents(
        tx([{ programIdIndex: 0, data: bs58.encode(Buffer.alloc(32)) }]),
        coder
      );
      expect(junk).toHaveLength(0);
    });
  });

  // ─── [4] transactionEntries ────────────────────────────────────────────────
  describe("[4] transactionEntries — rebalances, ownership, quote side, dust", () => {
    const now = Date.now();
    const coder: EventCoderLike = {
      decode: (payload: string) => {
        const kind = Buffer.from(payload, "base64").subarray(0, 4).toString("utf8");
        if (kind === "ADD1") {
          return {
            name: "addLiquidity",
            data: {
              from: pk(W1),
              position: pk("pos1"),
              lbPair: pk(POOL_A),
              amounts: [{ toString: () => "100000000" }, { toString: () => "500000000" }],
            },
          };
        }
        if (kind === "DUST") {
          return {
            name: "addLiquidity",
            data: {
              from: pk(W1),
              position: pk("pos1"),
              lbPair: pk(POOL_A),
              amounts: [{ toString: () => "1000000" }, { toString: () => "10000000" }],
            },
          };
        }
        if (kind === "REMV") return { name: "removeLiquidity", data: {} };
        return null;
      },
    };

    const cpi = (kind: string): Buffer =>
      Buffer.concat([
        Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]),
        Buffer.from(kind),
        Buffer.alloc(8),
      ]);

    const inner = (kind: string) => [
      { index: 0, instructions: [{ programIdIndex: 0, data: bs58.encode(cpi(kind)) }] },
    ];

    const snapshot: SnapshotFn = async (_position, wallet, pool): Promise<PositionSnapshot | null> =>
      wallet === W1 && pool === POOL_A
        ? {
            shares: "1000",
            xMint: MINT,
            yMint: config.tokens.SOL,
            lower: 50,
            upper: 90,
            active: 60,
            inRange: true,
          }
        : null;

    const DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
    const tx = (kind = "ADD1", extra = {}) => ({
      meta: { err: null, innerInstructions: inner(kind) },
      transaction: { message: { staticAccountKeys: [pk(DLMM)] } },
      blockTime: Math.floor(now / 1000) - 3,
      slot: 500,
      ...extra,
    });

    it("extracts valid SOL-side deposit and whale bin ranges", async () => {
      const entries = await transactionEntries(tx(), "sig", W1, options, snapshot, coder, now);
      expect(entries).toHaveLength(1);
      const e = entries[0]!;
      expect(e.mint).toBe(MINT);
      expect(Math.abs(e.depositSol - 0.5)).toBeLessThan(1e-9);
      expect(e.binsBelow).toBe(10);
      expect(e.binsAbove).toBe(30);
    });

    it("ignores stale transactions", async () => {
      const entries = await transactionEntries(
        tx("ADD1", { blockTime: Math.floor(now / 1000) - 500 }),
        "sig",
        W1,
        options,
        snapshot,
        coder,
        now
      );
      expect(entries).toHaveLength(0);
    });

    it("ignores other wallet's deposits", async () => {
      const entries = await transactionEntries(tx(), "sig", W2, options, snapshot, coder, now);
      expect(entries).toHaveLength(0);
    });

    it("ignores position snapshot mismatch", async () => {
      const entries = await transactionEntries(tx(), "sig", W1, options, async () => null, coder, now);
      expect(entries).toHaveLength(0);
    });

    it("filters withdraw-and-redeposit sequences", async () => {
      const removeThenAdd = [
        {
          index: 0,
          instructions: [
            { programIdIndex: 0, data: bs58.encode(cpi("REMV")) },
            { programIdIndex: 0, data: bs58.encode(cpi("ADD1")) },
          ],
        },
      ];
      const entries = await transactionEntries(
        { ...tx(), meta: { err: null, innerInstructions: removeThenAdd } },
        "sig",
        W1,
        options,
        snapshot,
        coder,
        now
      );
      expect(entries).toHaveLength(0);
    });

    it("filters dust deposits below threshold", async () => {
      const entries = await transactionEntries(tx("DUST"), "sig", W1, options, snapshot, coder, now);
      expect(entries).toHaveLength(0);
    });

    it("filters token-only non-SOL pairs", async () => {
      const tokenOnly: SnapshotFn = async () => ({
        shares: "1000",
        xMint: MINT,
        yMint: "Othr111111111111111111111111111111111111111",
        lower: 50,
        upper: 90,
        active: 60,
        inRange: true,
      });
      const entries = await transactionEntries(tx(), "sig", W1, options, tokenOnly, coder, now);
      expect(entries).toHaveLength(0);
    });
  });

  // ─── [5] aggregateTokenAccounts ────────────────────────────────────────────
  describe("[5] aggregateTokenAccounts — SPL + Token-2022, no phantom zeros", () => {
    const acct = (mint: string, amount: number, decimals: number) => ({
      account: {
        data: {
          parsed: {
            info: {
              mint,
              tokenAmount: {
                amount: String(amount),
                decimals,
              },
            },
          },
        },
      },
    });

    it("aggregates the same mint across multiple token programs", () => {
      const tokens = aggregateTokenAccounts([
        { value: [acct(MINT, 1000, 6), acct(config.tokens.USDC, 0, 6)] },
        { value: [acct(MINT, 2500, 6)] },
      ]);
      expect(tokens).toHaveLength(1);
      expect(tokens[0]?.mint).toBe(MINT);
      expect(tokens[0]?.balance).toBe(0.0035);
      expect(tokens.some((t) => t.mint === config.tokens.USDC)).toBe(false);
    });

    it("rejects conflicting token decimals for the same mint", () => {
      expect(() =>
        aggregateTokenAccounts([
          { value: [acct(MINT, 1, 6)] },
          { value: [acct(MINT, 1, 9)] },
        ])
      ).toThrow("Conflicting token decimals");
    });
  });

  // ─── [6] rejectToken / rejectPool ──────────────────────────────────────────
  describe("[6] rejectToken / rejectPool — missing data never passes", () => {
    const now = Date.now();
    const base: Partial<JupiterAssetItem> = {
      id: MINT,
      updatedAt: new Date(now - 10_000).toISOString(),
      audit: {
        mintAuthorityDisabled: true,
        freezeAuthorityDisabled: true,
        topHoldersPercentage: 30,
        botHoldersPercentage: 10,
      },
      fees: 50,
      launchpad: null,
      holderCount: 800,
      mcap: 400_000,
      organicScore: 75,
      createdAt: new Date(now - 3 * 3600_000).toISOString(),
    };

    it("evaluates token screening conditions", () => {
      expect(rejectToken(base, MINT, config.screening, now)).toBeNull();
      expect(rejectToken(base, POOL_A, config.screening, now)).not.toBeNull();
      expect(
        rejectToken({ ...base, updatedAt: new Date(now - 300_000).toISOString() }, MINT, config.screening, now)
      ).not.toBeNull();
      expect(rejectToken({ ...base, audit: undefined }, MINT, config.screening, now)).not.toBeNull();
      expect(
        rejectToken(
          { ...base, audit: { ...base.audit!, mintAuthorityDisabled: false } },
          MINT,
          config.screening,
          now
        )
      ).not.toBeNull();
      expect(
        rejectToken(
          { ...base, audit: { ...base.audit!, topHoldersPercentage: null } },
          MINT,
          config.screening,
          now
        )
      ).not.toBeNull();
    });

    const pool: Partial<MeteoraPoolDiscoveryItem> = {
      pool_type: "dlmm",
      is_blacklisted: false,
      token_x: { address: MINT, warnings: [], symbol: "MINT", organic_score: 75 },
      token_y: { address: config.tokens.SOL, warnings: [], organic_score: 75, symbol: "SOL" },
      tvl: 50_000,
      active_tvl: 40_000,
      volume: 5_000,
      fee_active_tvl_ratio: 0.1,
      dlmm_params: { bin_step: 100 },
      volatility: 3.2,
      pool_price: 1.5,
    };

    it("evaluates pool screening conditions", () => {
      expect(rejectPool(pool, MINT, config.screening)).toBeNull();
      expect(rejectPool({ ...pool, pool_type: "clmm" }, MINT, config.screening)).not.toBeNull();
      expect(
        rejectPool(
          { ...pool, token_y: { ...pool.token_y!, address: "USDTMint11111111111111111111111111111111111" } },
          MINT,
          config.screening
        )
      ).not.toBeNull();
      expect(
        rejectPool(
          { ...pool, token_x: { ...pool.token_x!, warnings: [{ severity: "danger" }] } },
          MINT,
          config.screening
        )
      ).not.toBeNull();
      expect(rejectPool({ ...pool, tvl: null }, MINT, config.screening)).not.toBeNull();
      expect(rejectPool({ ...pool, tvl: 10_000_000 }, MINT, config.screening)).not.toBeNull();
    });
  });

  // ─── [7] withWalletLock ────────────────────────────────────────────────────
  describe("[7] withWalletLock — exits jump the queue, never concurrent", () => {
    it("serializes execution and prioritizes exits ahead of writes", async () => {
      const order: string[] = [];
      const job = (label: string, ms: number) => async () => {
        order.push(`start:${label}`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`end:${label}`);
      };

      const first = withWalletLock(job("deploy", 40), 0);
      const second = withWalletLock(job("close", 1), 10);
      const third = withWalletLock(job("claim", 1), 5);

      await Promise.all([first, second, third]);

      expect(order[0]).toBe("start:deploy");
      expect(order[1]).toBe("end:deploy");
      expect(order[2]).toBe("start:close");
      expect(order[4]).toBe("start:claim");
    });
  });

  // ─── [8] deterministic rules ──────────────────────────────────────────────
  describe("[8] deterministic rules", () => {
    const pos = (base: Partial<DeterministicPositionMetrics>): DeterministicPositionMetrics => ({
      position: "Pos111111111111111111111111111111111111111",
      pair: "T/SOL",
      pnl_pct: 0,
      active_bin: 100,
      lower_bin: 50,
      upper_bin: 100,
      minutes_out_of_range: 0,
      age_minutes: 90,
      fee_per_tvl_24h: 10,
      ...base,
    });

    const mgmt: ManagementConfigInput = {
      ...config.management,
      takeProfitPct: 8,
      outOfRangeBinsToClose: 25,
      outOfRangeAboveWaitMinutes: 60,
      outOfRangeBelowWaitMinutes: 240,
    };

    it("triggers stop loss and take profit deterministic close rules", () => {
      expect(getDeterministicCloseRule(pos({ pnl_pct: -60 }), mgmt)?.rule).toBe(1);
      expect(getDeterministicCloseRule(pos({ pnl_pct: 10 }), mgmt)?.rule).toBe(2);
      expect(getDeterministicCloseRule(pos({ active_bin: 130 }), mgmt)?.rule).toBe(3);
    });

    it("evaluates out-of-range above and below duration thresholds", () => {
      expect(getDeterministicCloseRule(pos({ active_bin: 105, minutes_out_of_range: 65 }), mgmt)?.rule).toBe(4);
      expect(getDeterministicCloseRule(pos({ active_bin: 40, minutes_out_of_range: 65 }), mgmt)).toBeNull();
      expect(getDeterministicCloseRule(pos({ active_bin: 40, minutes_out_of_range: 245 }), mgmt)?.rule).toBe(4);
    });

    it("ignores suspect PnL readings", () => {
      expect(getDeterministicCloseRule(pos({ pnl_pct: -95, pnl_pct_suspicious: true }), mgmt)).toBeNull();
    });

    it("scales bins_below with volatility and clamps within range", () => {
      const lo = config.strategy.minBinsBelow;
      const hi = config.strategy.maxBinsBelow;
      const tiny = computeBinsBelow(0.01);
      const mid = computeBinsBelow(2.5);
      const huge = computeBinsBelow(50);

      expect(tiny).toBe(lo);
      expect(mid).toBeGreaterThan(lo);
      expect(mid).toBeLessThan(hi);
      expect(huge).toBe(hi);
      expect(() => computeBinsBelow(null)).toThrow();
    });

    const synthCandles: GeckoCandleTuple[] = Array.from({ length: 60 }, (_, i) => {
      const p = 1.0 + Math.sin(i / 4) * 0.04 + i * 0.001;
      return [1700000000 + i * 300, p * 0.995, p * 1.01, p * 0.99, p, 1000 + i * 25];
    });

    it("produces ordered quantiles and safe bin recommendations from Chronos forecast", () => {
      const lo = config.strategy.minBinsBelow;
      const cf = localQuantizedForecast(synthCandles, { poolAddress: POOL_A, binStep: 100 });
      expect(cf).not.toBeNull();
      expect(cf!.summary.p10_pct).toBeLessThanOrEqual(cf!.summary.p50_pct);
      expect(cf!.summary.p50_pct).toBeLessThanOrEqual(cf!.summary.p90_pct);
      expect(cf!.recommended_bins.bins_below).toBeGreaterThanOrEqual(lo);
      expect(cf!.recommended_bins.bins_above).toBeGreaterThanOrEqual(0);
      expect(cf!.recommended_bins.bins_below + cf!.recommended_bins.bins_above).toBeLessThanOrEqual(69);
      expect(Array.isArray(config.chronos.nodes)).toBe(true);
      expect(config.chronos.nodes).toHaveLength(5);
    });

    it("builds tactical signals for dump, bull, and conviction sizing", () => {
      const dumpSignals = buildTacticalSignals({
        p10Pct: -32,
        p50Pct: -5.5,
        p90Pct: 5,
        rsi14: 75,
        bbPctB: 0.93,
        microRsi14: 26,
        microBbPctB: 0.04,
        microP50Pct: 1.5,
        modelAgreement: 0.3,
      });
      expect(dumpSignals.x_ratio_mult).toBe(0.35);
      expect(dumpSignals.conviction_mult).toBe(0.8);
      expect(dumpSignals.sniper_lock).toBe(true);
      expect(dumpSignals.micro_oversold_bounce).toBe(true);

      const bullSignals = buildTacticalSignals({
        p10Pct: -5,
        p50Pct: 3.2,
        p90Pct: 18,
        rsi14: 58,
        bbPctB: 0.65,
        modelAgreement: 0.82,
      });
      expect(bullSignals.x_ratio_mult).toBe(0.85);
      expect(bullSignals.conviction_mult).toBe(1.15);
      expect(bullSignals.let_winners_run).toBe(true);
      expect(computeDeployAmount(2.0, 1.15)).toBeGreaterThan(computeDeployAmount(2.0, 0.8));
    });

    it("handles Touchpoint 3 OOR-below Chronos Defense correctly", () => {
      expect(
        getDeterministicCloseRule(pos({ active_bin: 40, minutes_out_of_range: 95 }), mgmt, {
          oor_below_outlook: "WEAK_STRUCTURAL_BREAKDOWN",
        })?.rule
      ).toBe(4);

      expect(
        getDeterministicCloseRule(pos({ active_bin: 40, minutes_out_of_range: 260, pnl_pct: -12 }), mgmt, {
          oor_below_outlook: "STRONG_REBOUND_PROBABILITY",
        })
      ).toBeNull();
    });

    it("verifies audit bug fixes", () => {
      const highByteKey = "k\u00ff\u00fe99";
      const secretVal = "sec_key_12345_!@#_\u00e9";
      expect(envryptDecrypt(envryptEncrypt(secretVal, highByteKey), highByteKey)).toBe(secretVal);

      expect(getDeterministicCloseRule(pos({ pnl_pct: -92, total_value_usd: 0.02 }), mgmt)?.rule).toBe(1);

      expect(
        getDeterministicCloseRule(pos({ fee_per_tvl_24h: 1, age_minutes: 75 }), {
          ...mgmt,
          minAgeBeforeYieldCheck: 90,
          minFeePerTvl24h: 5,
        })
      ).toBeNull();

      expect(
        getDeterministicCloseRule(pos({ fee_per_tvl_24h: 1, age_minutes: 95 }), {
          ...mgmt,
          minAgeBeforeYieldCheck: 90,
          minFeePerTvl24h: 5,
        })?.rule
      ).toBe(5);

      expect(adminTest.rootText("Cancelled.")).toContain("Cancelled.");
    });

    it("evaluates Full-Power Chronos Phase 2 features", () => {
      const curveSignals = buildTacticalSignals({
        p10Pct: -5.0,
        p50Pct: 0.4,
        p90Pct: 6.5,
        rsi14: 51,
        bbPctB: 0.48,
        priceVsPocPct: 3.2,
        binStep: 100,
        modelAgreement: 0.85,
      });
      expect(curveSignals.recommended_strategy).toBe("curve");

      const step200Signals = buildTacticalSignals({
        p10Pct: -10.8,
        p50Pct: -0.9,
        p90Pct: 11.3,
        rsi14: 52,
        bbPctB: 0.38,
        microP50Pct: -1.2,
        priceVsPocPct: 39.5,
        binStep: 200,
        modelAgreement: 0.22,
      });
      expect(step200Signals.recommended_strategy).toBe("curve");

      const mtfBullSignals = buildTacticalSignals({
        p10Pct: -4.0,
        p50Pct: 3.5,
        p90Pct: 16.0,
        rsi14: 58,
        bbPctB: 0.62,
        microP50Pct: 1.4,
        macro15mP50Pct: 2.8,
        priceVsPocPct: 4.5,
        binStep: 100,
        modelAgreement: 0.88,
      });
      expect(mtfBullSignals.conviction_mult).toBe(1.25);
      expect(mtfBullSignals.micro_breakout_hold).toBe(true);
      expect(mtfBullSignals.recommended_strategy).toBe("bid_ask");

      const knifeSignals = buildTacticalSignals({
        p10Pct: -22.0,
        p50Pct: -6.5,
        p90Pct: -1.0,
        rsi14: 34,
        bbPctB: 0.12,
        macro15mP50Pct: -8.2,
        chronos2P50Pct: -5.8,
        modelAgreement: 0.8,
      });
      expect(knifeSignals.knife_rescue_trigger).toBe(true);
      expect(knifeSignals.volume_decay_warning).toBe(true);
      expect(knifeSignals.claim_threshold_mult).toBe(0.4);

      expect(
        getDeterministicCloseRule(
          pos({ pnl_pct: -16 }),
          { ...mgmt, stopLossPct: -35, knifeRescueStopLossPct: -15 },
          knifeSignals
        )?.rule
      ).toBe(1);

      expect(
        getDeterministicCloseRule(
          pos({
            pnl_pct: 0.33,
            age_minutes: 77,
            fee_per_tvl_24h: 4.56,
            total_value_true_usd: 18.03,
            collected_fees_true_usd: 0,
            unclaimed_fees_true_usd: 0.0442,
          }),
          { ...mgmt, minFeePerTvl24h: 3, minPositionFeeVelocityPctPerHr: 0.45, minAgeBeforeYieldCheck: 60 }
        )?.rule
      ).toBe(5);

      const cf200 = localQuantizedForecast(synthCandles, { poolAddress: POOL_A, binStep: 200 });
      expect(cf200).not.toBeNull();
      expect(cf200!.recommended_bins.bins_below).toBeGreaterThanOrEqual(22);
      expect(cf200!.recommended_bins.bins_below).toBeLessThanOrEqual(36);
    });
  });
});
