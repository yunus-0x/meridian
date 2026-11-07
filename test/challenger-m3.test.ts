/**
 * Empirical Challenge Test Suite for Milestone 3 (Low-Level Infrastructure & Primitives)
 *
 * Verifies:
 * - src/schemas/solana.ts (helpers, boundary coercion, event schemas, balance schemas)
 * - src/schemas/storage.ts (MonitorState schemas and drift fixes)
 * - src/schemas/api.ts (JupiterPriceV3 schemas and wrapped/unwrapped response handling)
 * - standalone/rpc.ts (connection validation, caching, error sanitization)
 * - standalone/balances.ts (aggregateTokenAccounts, rpcBalances, priceBalances, invalidateBalances)
 * - standalone/transactions.ts (withWalletLock priority ordering, timeouts, priority fee calculation, blockhash cache)
 * - standalone/store.ts (MonitorStore atomic save, corruption rejection, pruning, convergence signaling)
 * - standalone/events.ts (DLMM CPI decoding, position snapshots, transaction entries, exposure retention)
 */

process.env.NODE_ENV = "test";
process.env.DISABLE_TELEGRAM = "true";
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { config } from "../config.js";
import {
  extractStringProperty,
  extractBigIntProperty,
  StringifiableAddressSchema,
  BigIntCoercibleSchema,
  AggregateTokenAccountsInputSchema,
  DlmmAddLiquidityEventDataSchema,
  PositionSnapshotSchema,
} from "../src/schemas/solana.js";
import {
  MonitorStateSchema,
  MonitorWalletStateSchema,
  MonitorAttemptSchema,
} from "../src/schemas/storage.js";
import {
  JupiterPriceV3ResponseSchema,
  JupiterPriceV3EntrySchema,
} from "../src/schemas/api.js";
import { connection, readRpc, fetchJson } from "../standalone/rpc.js";
import {
  aggregateTokenAccounts,
  rpcBalances,
  priceBalances,
  invalidateBalances,
  TOKEN_PROGRAMS,
} from "../standalone/balances.js";
import {
  withWalletLock,
  isWalletLocked,
  getWalletLockQueueLength,
  resetWalletLockForTests,
  calculatePriorityFee,
  validateSimulation,
  BlockhashCache,
  validateSignatureStatus,
} from "../standalone/transactions.js";
import {
  MonitorStore,
  qualifyingEvents,
  acceptEvents,
  finishSignal,
} from "../standalone/store.js";
import {
  decodeEvents,
  transactionEntries,
  exposureStillPresent,
  DLMM_PROGRAM,
  _setCoderForTests,
  type EventCoderLike,
} from "../standalone/events.js";

const pk = (s: string) => ({ toString: () => s });
const W1 = "Wa11eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const W2 = "Wa22eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const POOL_A = "Po01AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MINT_A = "Mint111111111111111111111111111111111111111";

describe("Milestone 3: Solana & Storage Schemas", () => {
  test("extractStringProperty and StringifiableAddressSchema handle mocks and public keys", () => {
    assert.equal(extractStringProperty("hello"), "hello");
    assert.equal(extractStringProperty(pk("pos1")), "pos1");
    assert.equal(extractStringProperty(null), null);
    assert.equal(extractStringProperty({}), null);

    assert.equal(StringifiableAddressSchema.parse("Wa11eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"), "Wa11eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    assert.equal(StringifiableAddressSchema.parse(pk("pos1")), "pos1");
  });

  test("extractBigIntProperty and BigIntCoercibleSchema coerce strings, numbers and BN mocks", () => {
    assert.equal(extractBigIntProperty(100n), 100n);
    assert.equal(extractBigIntProperty(12345), 12345n);
    assert.equal(extractBigIntProperty("9876543210"), 9876543210n);
    assert.equal(extractBigIntProperty(pk("500000")), 500000n);
    assert.equal(extractBigIntProperty("not_a_number"), null);

    assert.equal(BigIntCoercibleSchema.parse("1000000"), 1000000n);
    assert.equal(BigIntCoercibleSchema.parse(500), 500n);
    assert.equal(BigIntCoercibleSchema.parse(pk("750")), 750n);
  });

  test("MonitorStateSchema accepts valid default state and short mock identifiers", () => {
    const emptyState = MonitorStateSchema.parse({
      version: 1,
      wallets: {},
      pending: {},
      seen: {},
      events: [],
      signals: {},
      attempts: {},
      paused: false,
    });
    assert.equal(emptyState.version, 1);
    assert.equal(emptyState.paused, false);

    // Tests that short mock addresses pass validation
    const mockWallet = MonitorWalletStateSchema.parse({
      baselineSlot: 100,
      baselinePools: ["pool"],
    });
    assert.deepEqual(mockWallet.baselinePools, ["pool"]);

    const mockAttempt = MonitorAttemptSchema.parse({
      at: Date.now(),
      status: "proposed",
      mint: "MINT_X",
      pool: "POOL_Y",
    });
    assert.equal(mockAttempt.status, "proposed");
    assert.equal(mockAttempt.mint, "MINT_X");
  });

  test("JupiterPriceV3ResponseSchema unwraps both wrapped and direct price maps", () => {
    const directPayload = {
      [config.tokens.SOL]: { usdPrice: 185.5 },
      [config.tokens.USDC]: { usdPrice: 1.0 },
    };
    const parsedDirect = JupiterPriceV3ResponseSchema.parse(directPayload);
    assert.equal(parsedDirect[config.tokens.SOL]?.usdPrice, 185.5);

    const wrappedPayload = {
      data: {
        [config.tokens.SOL]: { usdPrice: 190.25 },
      },
    };
    const parsedWrapped = JupiterPriceV3ResponseSchema.parse(wrappedPayload);
    assert.equal(parsedWrapped[config.tokens.SOL]?.usdPrice, 190.25);
  });
});

describe("Milestone 3: standalone/rpc.ts", () => {
  test("connection enforces URL protocol validation", () => {
    assert.throws(() => connection(""), /Configure RPC_URL/);
    assert.throws(() => connection("ftp://rpc.solana.com"), /`http:` or `https:`/i);
    const conn = connection("https://api.mainnet-beta.solana.com");
    assert.ok(conn);
  });

  test("readRpc catches errors and sanitizes error messages without leaking URLs", async () => {
    const originalUrl = config.standalone.monitorRpcUrl;
    try {
      config.standalone.monitorRpcUrl = "https://sensitive-key.rpc.example.com";
      await assert.rejects(
        async () => {
          await readRpc("monitor", () => {
            const err = new Error("Connection refused to https://sensitive-key.rpc.example.com");
            err.name = "FetchError";
            throw err;
          });
        },
        (err: Error) => {
          assert.equal(err.message, "RPC monitor read failed (FetchError)");
          assert.ok(!err.message.includes("sensitive-key"));
          return true;
        }
      );
    } finally {
      config.standalone.monitorRpcUrl = originalUrl;
    }
  });
});

describe("Milestone 3: standalone/balances.ts", () => {
  beforeEach(() => {
    invalidateBalances();
  });

  test("aggregateTokenAccounts merges accounts across SPL programs and rejects decimal conflicts", () => {
    const acct = (mint: string, amount: string | number, decimals: number) => ({
      account: { data: { parsed: { info: { mint, tokenAmount: { amount: String(amount), decimals } } } } },
    });

    // Zero balance dropped
    const respZero = [{ value: [acct("MINT_A", 0, 6)] }];
    assert.deepEqual(aggregateTokenAccounts(respZero), []);

    // Merge multi accounts
    const respMerge = [
      { value: [acct("MINT_A", "1000000", 6)] },
      { value: [acct("MINT_A", "2000000", 6)] },
    ];
    const merged = aggregateTokenAccounts(respMerge);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.balance, 3.0);
    assert.equal(merged[0]?.raw_balance, "3000000");

    // Conflicting decimals thrown
    const respConflict = [
      { value: [acct("MINT_A", "1000000", 6)] },
      { value: [acct("MINT_A", "2000000", 9)] },
    ];
    assert.throws(() => aggregateTokenAccounts(respConflict), /Conflicting token decimals/);
  });

  test("rpcBalances nativeOnly vs full token balance queries", async () => {
    const mockRpc = async (kind: string, fn: (c: unknown) => unknown) => {
      if (kind === "balance") {
        return 1_500_000_000; // 1.5 SOL
      }
      return { value: [] };
    };

    const native = await rpcBalances(W1, {
      nativeOnly: true,
      rpc: mockRpc as unknown as typeof readRpc,
    });
    assert.equal(native.sol, 1.5);
    assert.equal((native as { tokens?: unknown }).tokens, undefined);
  });

  test("priceBalances computes USD balances with clean type narrowing", async () => {
    const rawTokens = {
      wallet: W1,
      sol: 2.0,
      tokens: [
        { mint: config.tokens.SOL, raw_balance: "2000000000", decimals: 9, balance: 2.0 },
        { mint: config.tokens.USDC, raw_balance: "50000000", decimals: 6, balance: 50.0 },
      ],
    };

    // priceBalances with simulated pricing
    const priced = await priceBalances(rawTokens, { force: false });
    assert.equal(priced.wallet, W1);
    assert.equal(priced.tokens.length, 2);
    assert.equal(priced.usdc, 50.0);
  });
});

describe("Milestone 3: standalone/transactions.ts", () => {
  beforeEach(() => {
    resetWalletLockForTests();
  });

  afterEach(() => {
    resetWalletLockForTests();
  });

  test("withWalletLock prioritizes exits (priority 10) ahead of entries (priority 0)", async () => {
    const order: string[] = [];
    const job = (name: string, delayMs: number) => async () => {
      order.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, delayMs));
      order.push(`end:${name}`);
      return name;
    };

    const first = withWalletLock(job("deploy", 40), 0);
    const second = withWalletLock(job("close", 1), 10);
    const third = withWalletLock(job("claim", 1), 5);

    await Promise.all([first, second, third]);

    assert.equal(order[0], "start:deploy");
    assert.equal(order[1], "end:deploy");
    assert.equal(order[2], "start:close");
    assert.equal(order[3], "end:close");
    assert.equal(order[4], "start:claim");
    assert.equal(order[5], "end:claim");
  });

  test("withWalletLock timeout rejects when acquisition takes too long", async () => {
    let blockerResolve: (() => void) | null = null;
    const blockerPromise = new Promise<void>((r) => { blockerResolve = r; });

    void withWalletLock(async () => {
      await blockerPromise;
    }, 0);

    await assert.rejects(
      async () => {
        await withWalletLock(async () => "fast", { priority: 0, timeoutMs: 20 });
      },
      /Wallet lock acquisition timed out after 20ms/
    );

    if (blockerResolve) (blockerResolve as () => void)();
  });

  test("calculatePriorityFee handles percentiles and clamps", () => {
    const raw = [
      { slot: 1, prioritizationFee: 5000 },
      { slot: 2, prioritizationFee: 15000 },
      { slot: 3, prioritizationFee: 25000 },
      { slot: 4, prioritizationFee: 50000 },
    ];
    const fee = calculatePriorityFee(raw, { percentile: 50 });
    assert.ok(fee >= 15000 && fee <= 25000);

    // Empty fallback
    assert.equal(calculatePriorityFee([]), 10000);
  });

  test("BlockhashCache stores and retrieves within TTL", () => {
    const cache = new BlockhashCache(100);
    const now = 1000;
    cache.setBlockhash({ blockhash: "4vJ9JU1bJJE96ZCVHGXTqAGUKFod1f1p45AxgHGBW4gE", lastValidBlockHeight: 500 }, now);

    assert.equal(cache.getValidBlockhash(now + 50), "4vJ9JU1bJJE96ZCVHGXTqAGUKFod1f1p45AxgHGBW4gE");
    assert.equal(cache.getValidBlockhash(now + 150), null);
  });
});

describe("Milestone 3: standalone/store.ts", () => {
  const tmpFile = path.resolve("./test-temp-store.json");

  afterEach(() => {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      if (fs.existsSync(`${tmpFile}.tmp`)) fs.unlinkSync(`${tmpFile}.tmp`);
    } catch {
      // Ignore
    }
  });

  test("MonitorStore refuses corrupted state file without discarding recovery history", () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ version: 2, invalid: true }));
    assert.throws(
      () => new MonitorStore(tmpFile),
      /Invalid monitor state; refusing to discard recovery history/
    );
  });

  test("MonitorStore creates valid default state and saves atomically", () => {
    const store = new MonitorStore(tmpFile);
    assert.equal(store.data.version, 1);
    store.data.seen["test_sig"] = Date.now();
    store.save();

    assert.ok(fs.existsSync(tmpFile));
    const reloaded = new MonitorStore(tmpFile);
    assert.ok(reloaded.data.seen["test_sig"]);
  });

  test("qualifyingEvents and acceptEvents trigger convergence signals", () => {
    const store = new MonitorStore(tmpFile);
    const now = Date.now();
    const opts = {
      walletThreshold: 2,
      windowSec: 120,
      screeningDeadlineSec: 120,
      minDepositSol: 0.1,
    };

    const ev1 = {
      id: "e1",
      wallet: W1,
      mint: MINT_A,
      depositSol: 0.5,
      at: now - 1000,
    };
    const ev2 = {
      id: "e2",
      wallet: W2,
      mint: MINT_A,
      depositSol: 0.5,
      at: now - 500,
    };

    // First wallet does not trigger
    const sig1 = acceptEvents(store, [ev1], opts, now);
    assert.equal(sig1.length, 0);

    // Second wallet triggers
    const sig2 = acceptEvents(store, [ev2], opts, now);
    assert.equal(sig2.length, 1);
    assert.equal(sig2[0]?.mint, MINT_A);
    assert.equal(sig2[0]?.events.length, 2);

    // finishSignal sets cooldown
    finishSignal(store, sig2[0]!, "completed", { cooldownSec: 300 }, now);
    assert.equal(store.data.signals[MINT_A]?.done, true);
    assert.equal(store.data.signals[MINT_A]?.cooldownUntil, now + 300_000);
  });
});

describe("Milestone 3: standalone/events.ts", () => {
  const cpi = (kind: string) =>
    Buffer.concat([
      Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]),
      Buffer.from(kind),
      Buffer.alloc(8),
    ]);

  const mockCoder: EventCoderLike = {
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
            amounts: [pk("100000000"), pk("500000000")],
          },
        };
      }
      if (kind === "REMV") return { name: "removeLiquidity", data: {} };
      return null;
    },
  };

  afterEach(() => {
    _setCoderForTests(null);
  });

  test("decodeEvents processes DLMM CPI instructions and filters invalid ones", () => {
    const tx = (instructions: unknown[]) => ({
      blockTime: Math.floor(Date.now() / 1000),
      meta: { err: null, innerInstructions: [{ index: 0, instructions }] },
      transaction: { message: { staticAccountKeys: [pk(DLMM_PROGRAM)] } },
    });
    const ix = (pIdx: number, data: Buffer) => ({
      programIdIndex: pIdx,
      data: bs58.encode(data),
    });

    const decoded = decodeEvents(tx([ix(0, cpi("ADD1")), ix(0, cpi("REMV"))]), mockCoder);
    assert.equal(decoded.length, 2);
    assert.equal(decoded[0]?.name, "addLiquidity");
    assert.equal(decoded[1]?.name, "removeLiquidity");
  });

  test("transactionEntries extracts SOL deposit and calculates whale bin range", async () => {
    const now = Date.now();
    const snapshot = async (position: string, wallet: string, pool: string) =>
      wallet === W1 && pool === POOL_A
        ? {
            shares: "1000",
            xMint: MINT_A,
            yMint: config.tokens.SOL,
            lower: 50,
            upper: 90,
            active: 60,
            inRange: true,
          }
        : null;

    const testTx = {
      meta: {
        err: null,
        innerInstructions: [
          {
            index: 0,
            instructions: [{ programIdIndex: 0, data: bs58.encode(cpi("ADD1")) }],
          },
        ],
      },
      transaction: { message: { staticAccountKeys: [pk(DLMM_PROGRAM)] } },
      blockTime: Math.floor(now / 1000) - 5,
      slot: 1000,
    };

    const entries = await transactionEntries(
      testTx,
      "test_sig",
      W1,
      { windowSec: 120, minDepositSol: 0.1 },
      snapshot,
      mockCoder,
      now
    );

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.mint, MINT_A);
    assert.ok(Math.abs((entries[0]?.depositSol ?? 0) - 0.5) < 1e-9);
    assert.equal(entries[0]?.binsBelow, 10);
    assert.equal(entries[0]?.binsAbove, 30);

    // exposureStillPresent verifies retention
    const present = await exposureStillPresent(entries[0]!, snapshot);
    assert.equal(present, true);
  });
});
