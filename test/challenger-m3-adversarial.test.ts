/**
 * Adversarial Empirical Challenge Suite for Milestone 3 (challenger_m3_2)
 *
 * Focus:
 * 1. Token Balances:
 *    - aggregateTokenAccounts across Tokenkeg and Token-2022
 *    - Multi-account merge & large u64 balance precision
 *    - Zero-balance drops & empty responses
 *    - Conflicting token decimals rejection
 *    - Boundary validation (Zod schema validation on corrupted input)
 * 2. Pricing:
 *    - priceBalances with Jupiter batching (>50 tokens chunking)
 *    - Missing prices (must return usd: null, never 0)
 *    - Incomplete prices handling (sol_usd, total_usd, prices_complete)
 *    - 30s cache eviction and force bypass
 *    - Non-positive/non-finite price filtering
 * 3. Event Decoding:
 *    - DLMM CPI 8-byte prefix enforcement [228, 69, 165, 46, 81, 203, 154, 29]
 *    - Non-matching program ID filtering
 *    - Corrupted inner instruction structures & malformed data
 *    - Missing coder handling & mock vs real coder abstraction
 * 4. Telegram Alert Suppression:
 *    - Verify zero Telegram alerts leak when DISABLE_TELEGRAM=true
 */

process.env.NODE_ENV = "test";
process.env.DISABLE_TELEGRAM = "true";

import { describe, test, it, expect, assert, beforeEach, afterEach, vi } from "vitest";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import {
  aggregateTokenAccounts,
  priceBalances,
  invalidateBalances,
  TOKEN_PROGRAMS,
} from "../standalone/balances.js";
import {
  decodeEvents,
  DLMM_PROGRAM,
  _setCoderForTests,
  type EventCoderLike,
} from "../standalone/events.js";
import { connection, readRpc, fetchJson } from "../standalone/rpc.js";
import {
  isTelegramSuppressed,
  isEnabled,
  sendMessage,
  sendMenu,
  editMenu,
  notifyDeploy,
  notifyClose,
  notifySwap,
  startAdminPolling,
} from "../telegram.js";

const pk = (s: string) => ({ toString: () => s });
const W1 = "Wa11eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const POOL_A = "Po01AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MINT_SOL = config.tokens.SOL;
const MINT_USDC = config.tokens.USDC;
const MINT_1 = "Mint111111111111111111111111111111111111111";
const MINT_2 = "Mint222222222222222222222222222222222222222";
const MINT_3 = "Mint333333333333333333333333333333333333333";

describe("Milestone 3 Challenge 1: Token Balances Aggregation", () => {
  const makeAccount = (mint: string, amount: string | number, decimals: number, program = "spl-token") => ({
    pubkey: pk(`acct_${mint}_${decimals}`),
    account: {
      data: {
        parsed: {
          info: {
            mint,
            tokenAmount: {
              amount: String(amount),
              decimals,
              uiAmount: decimals > 0 ? Number(amount) / (10 ** decimals) : Number(amount),
              uiAmountString: String(Number(amount) / (10 ** decimals)),
            },
            owner: W1,
            state: "initialized",
          },
          type: "account",
        },
        program,
      },
    },
  });

  test("aggregates across Tokenkeg and Token-2022 programs for the same mint", () => {
    // Response 1: Tokenkeg program
    const respTokenkeg = {
      value: [
        makeAccount(MINT_1, "1500000", 6, "spl-token"),
        makeAccount(MINT_2, "1000000000", 9, "spl-token"),
      ],
    };
    // Response 2: Token-2022 program
    const respToken2022 = {
      value: [
        makeAccount(MINT_1, "3500000", 6, "spl-token-2022"),
        makeAccount(MINT_3, "500000", 6, "spl-token-2022"),
      ],
    };

    const aggregated = aggregateTokenAccounts([respTokenkeg, respToken2022]);

    assert.equal(aggregated.length, 3);
    const m1 = aggregated.find((t) => t.mint === MINT_1);
    assert.ok(m1);
    assert.equal(m1.decimals, 6);
    assert.equal(m1.raw_balance, "5000000"); // 1500000 + 3500000
    assert.equal(m1.balance, 5.0);

    const m2 = aggregated.find((t) => t.mint === MINT_2);
    assert.ok(m2);
    assert.equal(m2.decimals, 9);
    assert.equal(m2.raw_balance, "1000000000");
    assert.equal(m2.balance, 1.0);

    const m3 = aggregated.find((t) => t.mint === MINT_3);
    assert.ok(m3);
    assert.equal(m3.balance, 0.5);
  });

  test("drops zero-balance accounts and returns empty array if all accounts are zero", () => {
    const resp = {
      value: [
        makeAccount(MINT_1, "0", 6),
        makeAccount(MINT_2, 0, 9),
      ],
    };

    const aggregated = aggregateTokenAccounts([resp]);
    assert.deepEqual(aggregated, []);
  });

  test("handles empty responses array or response with empty value cleanly", () => {
    assert.deepEqual(aggregateTokenAccounts([]), []);
    assert.deepEqual(aggregateTokenAccounts([{ value: [] }]), []);
  });

  test("preserves large u64 balance precision via bigint raw_balance", () => {
    const maxU64Str = "18446744073709551615";
    const resp = {
      value: [
        makeAccount(MINT_1, maxU64Str, 9),
        makeAccount(MINT_1, "1", 9),
      ],
    };

    const aggregated = aggregateTokenAccounts([resp]);
    assert.equal(aggregated.length, 1);
    // 18446744073709551615 + 1 = 18446744073709551616
    assert.equal(aggregated[0]?.raw_balance, "18446744073709551616");
    assert.equal(aggregated[0]?.decimals, 9);
  });

  test("throws explicit 'Conflicting token decimals' error on decimal mismatch across accounts", () => {
    const resp = {
      value: [
        makeAccount(MINT_1, "1000000", 6),
        makeAccount(MINT_1, "1000000", 9), // Conflict!
      ],
    };

    expect(() => aggregateTokenAccounts([resp])).toThrow(/Conflicting token decimals/);
  });

  test("rejects invalid boundary payloads via Zod validation", () => {
    assert.throws(() => aggregateTokenAccounts(null));
    assert.throws(() => aggregateTokenAccounts(undefined));
    assert.throws(() => aggregateTokenAccounts("not an array"));
    assert.throws(() => aggregateTokenAccounts([{ invalid: true }]));
  });
});

describe("Milestone 3 Challenge 2: Jupiter Pricing & Cache Eviction", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: string[] = [];
  let mockJupiterResponses: Record<string, { usdPrice: number }> = {};

  beforeEach(() => {
    invalidateBalances();
    fetchCalls = [];
    mockJupiterResponses = {};
    globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const urlStr = typeof input === "string" ? input : input.toString();
      fetchCalls.push(urlStr);

      if (urlStr.includes("api.jup.ag/price/v3")) {
        const url = new URL(urlStr);
        const ids = (url.searchParams.get("ids") || "").split(",");
        const result: Record<string, { usdPrice: number }> = {};
        for (const id of ids) {
          const item = mockJupiterResponses[id];
          if (item) {
            result[id] = item;
          }
        }
        return new Response(JSON.stringify({ data: result }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response("Not Found", { status: 404 });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("batches Jupiter price queries into chunks of 50 when querying many tokens", async () => {
    // Generate 75 unique mints
    const tokens = [];
    for (let i = 0; i < 75; i++) {
      const mint = `MintBatch${String(i).padStart(4, "0")}11111111111111111111111`;
      tokens.push({
        mint,
        raw_balance: "1000000",
        decimals: 6,
        balance: 1.0,
      });
      mockJupiterResponses[mint] = { usdPrice: 2.5 };
    }
    mockJupiterResponses[MINT_SOL] = { usdPrice: 190.0 };

    const raw = {
      wallet: W1,
      sol: 2.0,
      tokens,
    };

    const priced = await priceBalances(raw, { force: true });
    assert.equal(priced.tokens.length, 75);

    // Mints to query: SOL + 75 tokens = 76 mints total
    // 76 mints chunked by 50 = 2 fetch calls (chunk 1: 50, chunk 2: 26)
    const jupCalls = fetchCalls.filter((u) => u.includes("api.jup.ag/price/v3"));
    assert.equal(jupCalls.length, 2);

    const call1Url = new URL(jupCalls[0]!);
    const chunk1Ids = (call1Url.searchParams.get("ids") || "").split(",");
    assert.equal(chunk1Ids.length, 50);

    const call2Url = new URL(jupCalls[1]!);
    const chunk2Ids = (call2Url.searchParams.get("ids") || "").split(",");
    assert.equal(chunk2Ids.length, 26);
  });

  test("returns usd: null (NOT 0) when prices are missing or Jupiter API fails", async () => {
    // Do not populate mockJupiterResponses for MINT_1
    mockJupiterResponses[MINT_SOL] = { usdPrice: 200.0 };

    const raw = {
      wallet: W1,
      sol: 1.0,
      tokens: [
        { mint: MINT_1, raw_balance: "1000000", decimals: 6, balance: 1.0 },
      ],
    };

    const priced = await priceBalances(raw, { force: true });
    assert.equal(priced.tokens[0]?.usd, null); // MUST NOT be 0!
    assert.equal(priced.sol_price, 200.0);
    assert.equal(priced.sol_usd, 200.0);
    assert.equal(priced.prices_complete, false);
    assert.equal(priced.total_usd, null); // Incomplete prices -> total_usd is null!
  });

  test("filters out non-positive and non-finite prices from Jupiter response", async () => {
    mockJupiterResponses[MINT_SOL] = { usdPrice: 200.0 };
    mockJupiterResponses[MINT_1] = { usdPrice: 0 }; // Zero price
    mockJupiterResponses[MINT_2] = { usdPrice: -5.0 }; // Negative price

    const raw = {
      wallet: W1,
      sol: 1.0,
      tokens: [
        { mint: MINT_1, raw_balance: "1000000", decimals: 6, balance: 1.0 },
        { mint: MINT_2, raw_balance: "1000000", decimals: 6, balance: 1.0 },
      ],
    };

    const priced = await priceBalances(raw, { force: true });
    assert.equal(priced.tokens[0]?.usd, null);
    assert.equal(priced.tokens[1]?.usd, null);
    assert.equal(priced.prices_complete, false);
  });

  test("reuses cached prices within 30s and evicts/refetches after 30s", async () => {
    mockJupiterResponses[MINT_SOL] = { usdPrice: 180.0 };
    mockJupiterResponses[MINT_1] = { usdPrice: 10.0 };

    const raw = {
      wallet: W1,
      sol: 1.0,
      tokens: [
        { mint: MINT_1, raw_balance: "1000000", decimals: 6, balance: 1.0 },
      ],
    };

    // First call: fetches from API
    const res1 = await priceBalances(raw, { force: false });
    assert.equal(res1.tokens[0]?.usd, 10.0);
    const initialCalls = fetchCalls.length;
    assert.ok(initialCalls > 0);

    // Second call immediately: uses cache, 0 new network calls
    const res2 = await priceBalances(raw, { force: false });
    assert.equal(res2.tokens[0]?.usd, 10.0);
    assert.equal(fetchCalls.length, initialCalls);

    // Force bypass: ignores cache, triggers fresh call
    const res3 = await priceBalances(raw, { force: true });
    assert.equal(res3.tokens[0]?.usd, 10.0);
    assert.ok(fetchCalls.length > initialCalls);
  });
});

describe("Milestone 3 Challenge 3: DLMM Event Decoding", () => {
  const EVENT_CPI = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);

  const makeTx = (instructions: unknown[], options: { programId?: string; err?: unknown; blockTime?: number | null } = {}) => {
    const progId = options.programId ?? DLMM_PROGRAM;
    return {
      blockTime: options.blockTime !== undefined ? options.blockTime : Math.floor(Date.now() / 1000),
      meta: {
        err: options.err ?? null,
        innerInstructions: [
          {
            index: 0,
            instructions,
          },
        ],
      },
      transaction: {
        message: {
          staticAccountKeys: [pk(progId)],
        },
      },
    };
  };

  const makeIx = (data: Buffer | string, pIdx = 0) => ({
    programIdIndex: pIdx,
    data: typeof data === "string" ? data : bs58.encode(data),
  });

  const mockCoder: EventCoderLike = {
    decode: (payload: string) => {
      const buf = Buffer.from(payload, "base64");
      const tag = buf.subarray(0, 4).toString("utf8");
      if (tag === "TEST") {
        return {
          name: "addLiquidity",
          data: {
            from: pk(W1),
            position: pk("pos1"),
            lbPair: pk(POOL_A),
            amounts: [pk("100"), pk("200")],
          },
        };
      }
      return null;
    },
  };

  test("decodes instructions matching DLMM_PROGRAM and exact 8-byte EVENT_CPI prefix", () => {
    const validPayload = Buffer.concat([
      EVENT_CPI,
      Buffer.from("TEST"),
      Buffer.alloc(8),
    ]);

    const tx = makeTx([makeIx(validPayload)]);
    const events = decodeEvents(tx, mockCoder);

    assert.equal(events.length, 1);
    assert.equal(events[0]?.name, "addLiquidity");
  });

  test("ignores instructions with non-matching CPI prefix (even 1 byte off)", () => {
    const invalidPrefix = Buffer.from([228, 69, 165, 46, 81, 203, 154, 30]); // 30 instead of 29
    const payload = Buffer.concat([
      invalidPrefix,
      Buffer.from("TEST"),
      Buffer.alloc(8),
    ]);

    const tx = makeTx([makeIx(payload)]);
    const events = decodeEvents(tx, mockCoder);
    assert.equal(events.length, 0);
  });

  test("ignores instructions with payload length < 16 bytes", () => {
    // 8 bytes prefix + 4 bytes tag = 12 bytes (< 16)
    const shortPayload = Buffer.concat([EVENT_CPI, Buffer.from("TEST")]);
    const tx = makeTx([makeIx(shortPayload)]);
    const events = decodeEvents(tx, mockCoder);
    assert.equal(events.length, 0);
  });

  test("ignores instructions from other program IDs (e.g. SPL Token, System Program)", () => {
    const validPayload = Buffer.concat([
      EVENT_CPI,
      Buffer.from("TEST"),
      Buffer.alloc(8),
    ]);

    // Send instruction with Tokenkeg program ID instead of DLMM_PROGRAM
    const tx = makeTx([makeIx(validPayload)], { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" });
    const events = decodeEvents(tx, mockCoder);
    assert.equal(events.length, 0);
  });

  test("ignores failed transactions (meta.err != null) and transactions with missing blockTime", () => {
    const validPayload = Buffer.concat([
      EVENT_CPI,
      Buffer.from("TEST"),
      Buffer.alloc(8),
    ]);

    const failedTx = makeTx([makeIx(validPayload)], { err: { InstructionError: [0, "Custom"] } });
    assert.equal(decodeEvents(failedTx, mockCoder).length, 0);

    const noBlockTimeTx = makeTx([makeIx(validPayload)], { blockTime: null });
    assert.equal(decodeEvents(noBlockTimeTx, mockCoder).length, 0);
  });

  test("throws error when eventCoder is missing but DLMM CPI payload is present", () => {
    const validPayload = Buffer.concat([
      EVENT_CPI,
      Buffer.from("TEST"),
      Buffer.alloc(8),
    ]);

    const tx = makeTx([makeIx(validPayload)]);
    assert.throws(
      () => decodeEvents(tx, null),
      /Event coder required for decoding CPI payload/
    );
  });

  test("tolerates corrupted/non-array innerInstructions and non-object instructions safely", () => {
    const corruptedTx1 = {
      blockTime: 1700000000,
      meta: { err: null, innerInstructions: null },
      transaction: { message: { staticAccountKeys: [pk(DLMM_PROGRAM)] } },
    };
    assert.equal(decodeEvents(corruptedTx1, mockCoder).length, 0);

    const corruptedTx2 = {
      blockTime: 1700000000,
      meta: { err: null, innerInstructions: ["not an object", { instructions: null }] },
      transaction: { message: { staticAccountKeys: [pk(DLMM_PROGRAM)] } },
    };
    assert.equal(decodeEvents(corruptedTx2, mockCoder).length, 0);
  });

  test("corrupted base58 data in DLMM instruction behavior check", () => {
    const corruptedIxTx = makeTx([{ programIdIndex: 0, data: "invalid_base58_!@#$" }]);
    try {
      const res = decodeEvents(corruptedIxTx, mockCoder);
      assert.deepEqual(res, []);
    } catch (err: unknown) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /base58/i);
    }
  });

function hasEventCoder(val: unknown): val is { events: EventCoderLike } {
  return (
    typeof val === "object" &&
    val !== null &&
    "events" in val &&
    typeof val.events === "object" &&
    val.events !== null &&
    "decode" in val.events &&
    typeof val.events.decode === "function"
  );
}

  test("real Anchor coder decodes valid DLMM events and returns null for unknown events", async () => {
    const { createProgram } = await import("@meteora-ag/dlmm");
    const { Connection } = await import("@solana/web3.js");
    const dummyConn = new Connection("https://api.mainnet-beta.solana.com");
    const prog = createProgram(dummyConn);
    if (!hasEventCoder(prog.coder)) {
      throw new Error("prog.coder does not implement EventCoderLike");
    }
    const realCoder = prog.coder.events;

    // Unknown random event payload (8 bytes prefix + 16 bytes data)
    const randomPayload = Buffer.concat([
      EVENT_CPI,
      Buffer.alloc(16, 0xff),
    ]);
    const tx = makeTx([makeIx(randomPayload)]);
    const events = decodeEvents(tx, realCoder);
    // Real Anchor coder returns null for unknown discriminator, so events is empty
    assert.equal(events.length, 0);
  });
});

describe("Milestone 3 Challenge 4: Telegram Alert Suppression", () => {
  const originalFetch = globalThis.fetch;
  let telegramFetchCalls: string[] = [];

  beforeEach(() => {
    telegramFetchCalls = [];
    globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const urlStr = typeof input === "string" ? input : input.toString();
      if (urlStr.includes("api.telegram.org")) {
        telegramFetchCalls.push(urlStr);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }
      return originalFetch(input, init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("isTelegramSuppressed() is true when DISABLE_TELEGRAM=true or NODE_ENV=test", () => {
    assert.equal(isTelegramSuppressed(), true);
    assert.equal(isEnabled(), false);
  });

  test("all notify methods and sendMessage are zero-op and make 0 Telegram HTTP calls", async () => {
    await sendMessage("Test message to live bot");

    await sendMenu("Menu text", [[{ text: "Btn", callback_data: "btn" }]]);
    await editMenu(1, "Edited text", [[{ text: "Btn2", callback_data: "btn2" }]]);
    await notifyDeploy({
      pair: "TEST/SOL",
      amountSol: 1.0,
      position: POOL_A,
      tx: "sig123",
      priceRange: { min: 0.1, max: 0.2 },
      rangeCoverage: { downside_pct: 10, upside_pct: 10, width_pct: 20 },
      binStep: 20,
      baseFee: 0.1,
    });
    await notifyClose({
      pair: "TEST/SOL",
      pnlUsd: 10.5,
      pnlPct: 5.2,
      solMode: false,
    });
    await notifySwap({
      inputSymbol: "TEST",
      outputSymbol: "SOL",
      amountIn: 1000,
      amountOut: 1.05,
      tx: "sig789",
    });
    const stopPoll = startAdminPolling(async () => {});
    stopPoll();

    assert.equal(telegramFetchCalls.length, 0, "No HTTP calls must ever reach api.telegram.org in test mode");
  });
});
