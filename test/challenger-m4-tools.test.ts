/**
 * test/challenger-m4-tools.test.ts — Adversarial Empirical Challenge Suite for Milestone 4
 *
 * Focus:
 * 1. tools/wallet.ts:
 *    - Keypair decoding (JSON byte array vs Base58 string, corrupted/malformed arrays, non-base58 inputs, missing env).
 *    - Mint normalization edge cases (exact SOL, native, regex /^So1+$/, length 32-44 starting with So1, USDC/other mints, null/undefined).
 *    - DRY_RUN behavior in swapToken (zero on-chain transactions, mock bypassed).
 *    - Jupiter Swap order response validation & error handling (HTTP 500, errorCode/errorMessage, invalid JSON, execute HTTP 502, on-chain Failed, missing signature, success).
 *
 * 2. tools/pnl.ts:
 *    - Fallback pricing via Jupiter Price V3 with chunking (>50 mints) and Jupiter asset search fallback.
 *    - Meteora PnL pool deposit history API fetch & schema validation.
 *    - PnL calculations, suspicious PnL flagging (priceMissing, depositsMissing, postClaimSettling window).
 *    - In-range vs out-of-range detection and state tracking.
 *
 * 3. tools/executor.ts:
 *    - Mutex lock priorities (close = 10 > swap/claim = 5 > deploy = 0).
 *    - Priority pre-emption: higher priority queued items jump ahead of lower priority items.
 *    - Tool input schema rejection of invalid arguments across all 4 WRITE_TOOLS.
 *
 * 4. tools/dlmm.ts:
 *    - Dynamic SDK loader safety (validates structural type guards without eager ESM crashes).
 *    - DRY_RUN mode safety for deploy_position, claim_fees, and close_position.
 *    - Parameter boundary guards (invalid bins, below minimum bins, missing before_submit).
 */

process.env.NODE_ENV = "test";
process.env.DISABLE_TELEGRAM = "true";

import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  Transaction,
} from "@solana/web3.js";
import {
  getWallet,
  resetWalletCache,
  getConnection,
  normalizeMint,
  swapToken,
} from "../tools/wallet.js";
import {
  fetchDlmmPnlForPool,
  getJupiterPrices,
  computePositions,
} from "../tools/pnl.js";
import { executeTool } from "../tools/executor.js";
import {
  deployPosition,
  claimFees,
  closePosition,
  resetDlmmWalletCache,
} from "../tools/dlmm.js";
import {
  withWalletLock,
  resetWalletLockForTests,
} from "../standalone/transactions.js";
import {
  isPostClaimSettling,
} from "../state.js";

const VALID_SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface DlmmStatics {
  create: (connection: unknown, poolPubkey: unknown) => Promise<unknown>;
  getAllLbPairPositionsByUser: (connection: unknown, userPubkey: unknown) => Promise<unknown>;
  getBinIdFromPrice?: unknown;
}

function isDlmmStatics(val: unknown): val is DlmmStatics {
  return typeof val === "function" && "create" in val && "getAllLbPairPositionsByUser" in val;
}

async function loadDlmmStatics(): Promise<DlmmStatics> {
  const mod: unknown = await import("@meteora-ag/dlmm");
  const candidate =
    typeof mod === "object" && mod !== null && "default" in mod
      ? (mod as { default: unknown }).default
      : mod;
  if (!isDlmmStatics(candidate)) {
    throw new Error("Expected @meteora-ag/dlmm to export static class constructor");
  }
  return candidate;
}

describe("Challenger M4 Suite 1: tools/wallet.ts", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetWalletCache();
    process.env = {
      ...originalEnv,
      DISABLE_TELEGRAM: "true",
      RPC_URL: "https://api.mainnet-beta.solana.com",
    };
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    resetWalletCache();
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  test("Keypair decoding: valid Base58 string decodes to correct public key", () => {
    const sample = Keypair.generate();
    process.env.WALLET_PRIVATE_KEY = bs58.encode(sample.secretKey);

    const wallet = getWallet();
    assert.equal(wallet.publicKey.toBase58(), sample.publicKey.toBase58());
  });

  test("Keypair decoding: valid JSON byte array decodes to correct public key", () => {
    const sample = Keypair.generate();
    process.env.WALLET_PRIVATE_KEY = JSON.stringify(Array.from(sample.secretKey));

    const wallet = getWallet();
    assert.equal(wallet.publicKey.toBase58(), sample.publicKey.toBase58());
  });

  test("Keypair decoding: throws descriptive error on missing WALLET_PRIVATE_KEY", () => {
    delete process.env.WALLET_PRIVATE_KEY;
    assert.throws(
      () => getWallet(),
      /WALLET_PRIVATE_KEY not set/
    );
  });

  test("Keypair decoding: throws on malformed JSON byte array (out of range / invalid types)", () => {
    process.env.WALLET_PRIVATE_KEY = JSON.stringify([999, 10, 20]);
    assert.throws(() => getWallet());

    resetWalletCache();
    process.env.WALLET_PRIVATE_KEY = JSON.stringify([-5, 10, 20]);
    assert.throws(() => getWallet());

    resetWalletCache();
    process.env.WALLET_PRIVATE_KEY = JSON.stringify({ key: "invalid" });
    assert.throws(() => getWallet());
  });

  test("Keypair decoding: throws on invalid Base58 string", () => {
    process.env.WALLET_PRIVATE_KEY = "0OIl_not_valid_base58_string!";
    assert.throws(() => getWallet());
  });

  test("Keypair decoding: resetWalletCache resets cached keypair on secret update", () => {
    const sample1 = Keypair.generate();
    const sample2 = Keypair.generate();

    process.env.WALLET_PRIVATE_KEY = bs58.encode(sample1.secretKey);
    const wallet1 = getWallet();
    assert.equal(wallet1.publicKey.toBase58(), sample1.publicKey.toBase58());

    process.env.WALLET_PRIVATE_KEY = bs58.encode(sample2.secretKey);
    resetWalletCache();
    const wallet2 = getWallet();
    assert.equal(wallet2.publicKey.toBase58(), sample2.publicKey.toBase58());
  });

  test("getConnection: throws when RPC_URL is missing", () => {
    delete process.env.RPC_URL;
    assert.throws(() => getConnection(), /RPC_URL environment variable is not configured/);
  });

  test("Mint normalization: normalizes all SOL variants to canonical wrapped SOL mint", () => {
    assert.equal(normalizeMint("SOL"), VALID_SOL_MINT);
    assert.equal(normalizeMint("native"), VALID_SOL_MINT);
    assert.equal(normalizeMint("So11111111111111111111111111111111111111111"), VALID_SOL_MINT);
    assert.equal(normalizeMint("So11111111111111111111111111111111111111112"), VALID_SOL_MINT);
    assert.equal(normalizeMint("So11111111111111111111111111111111111111113"), VALID_SOL_MINT);
    assert.equal(normalizeMint("So1111"), VALID_SOL_MINT);
  });

  test("Mint normalization: preserves non-SOL mints and passes through null/undefined", () => {
    assert.equal(normalizeMint(USDC_MINT), USDC_MINT);
    assert.equal(normalizeMint("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"), "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN");
    assert.equal(normalizeMint(null), null);
    assert.equal(normalizeMint(undefined), undefined);
    assert.equal(normalizeMint(""), "");
  });

  test("DRY_RUN mode: swapToken immediately returns dry_run payload without network calls", async () => {
    process.env.DRY_RUN = "true";
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called in DRY_RUN");
    };

    const res = await swapToken({
      input_mint: "SOL",
      output_mint: USDC_MINT,
      amount: 0.5,
    });

    assert.equal(fetchCalled, false);
    assert.equal("dry_run" in res && res.dry_run, true);
    if ("would_swap" in res) {
      assert.equal(res.would_swap.input_mint, VALID_SOL_MINT);
      assert.equal(res.would_swap.output_mint, USDC_MINT);
      assert.equal(res.would_swap.amount, 0.5);
    }
  });

  test("Jupiter Swap: order HTTP error returns failure object gracefully", async () => {
    process.env.DRY_RUN = "false";
    const sample = Keypair.generate();
    process.env.WALLET_PRIVATE_KEY = bs58.encode(sample.secretKey);
    process.env.RPC_URL = "https://api.mainnet-beta.solana.com";

    globalThis.fetch = async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/order")) {
        return new Response("Internal Server Error", { status: 500, statusText: "Internal Error" });
      }
      return new Response("{}", { status: 200 });
    };

    const res = await swapToken({
      input_mint: "SOL",
      output_mint: USDC_MINT,
      amount: 0.1,
    });

    assert.equal("success" in res && res.success, false);
    if ("error" in res) {
      assert.match(res.error, /Swap V2 order failed: 500/);
    }
  });

  test("Jupiter Swap: order API error response (errorCode / errorMessage) is rejected", async () => {
    process.env.DRY_RUN = "false";
    const sample = Keypair.generate();
    process.env.WALLET_PRIVATE_KEY = bs58.encode(sample.secretKey);
    process.env.RPC_URL = "https://api.mainnet-beta.solana.com";

    const dummyMsg = new TransactionMessage({
      payerKey: sample.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [],
    }).compileToV0Message();
    const vTx = new VersionedTransaction(dummyMsg);
    const mockTxBase64 = Buffer.from(vTx.serialize()).toString("base64");

    globalThis.fetch = async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/order")) {
        return new Response(
          JSON.stringify({
            transaction: mockTxBase64,
            requestId: "req_test_with_error",
            errorCode: "ROUTE_NOT_FOUND",
            errorMessage: "No route available for swap",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    };

    const res = await swapToken({
      input_mint: "SOL",
      output_mint: USDC_MINT,
      amount: 0.1,
    });

    assert.equal("success" in res && res.success, false);
    if ("error" in res) {
      assert.match(res.error, /Swap V2 order error: No route available for swap/);
    }
  });

  test("Jupiter Swap: malformed order schema is caught by Zod boundary validation", async () => {
    process.env.DRY_RUN = "false";
    const sample = Keypair.generate();
    process.env.WALLET_PRIVATE_KEY = bs58.encode(sample.secretKey);
    process.env.RPC_URL = "https://api.mainnet-beta.solana.com";

    globalThis.fetch = async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/order")) {
        return new Response(JSON.stringify({ someBogusField: 123 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    };

    const res = await swapToken({
      input_mint: "SOL",
      output_mint: USDC_MINT,
      amount: 0.1,
    });

    assert.equal("success" in res && res.success, false);
    if ("error" in res) {
      assert.ok(res.error.length > 0);
    }
  });

  test("Jupiter Swap: execute endpoint on-chain Failed status produces explicit error", async () => {
    process.env.DRY_RUN = "false";
    const sample = Keypair.generate();
    process.env.WALLET_PRIVATE_KEY = bs58.encode(sample.secretKey);
    process.env.RPC_URL = "https://api.mainnet-beta.solana.com";

    const dummyMsg = new TransactionMessage({
      payerKey: sample.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [],
    }).compileToV0Message();
    const vTx = new VersionedTransaction(dummyMsg);
    const mockTxBase64 = Buffer.from(vTx.serialize()).toString("base64");

    globalThis.fetch = async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/order")) {
        return new Response(
          JSON.stringify({
            transaction: mockTxBase64,
            requestId: "req_test_123",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (urlStr.includes("/execute")) {
        return new Response(
          JSON.stringify({
            status: "Failed",
            code: 6005,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    };

    const res = await swapToken({
      input_mint: "SOL",
      output_mint: USDC_MINT,
      amount: 0.1,
    });

    assert.equal("success" in res && res.success, false);
    if ("error" in res) {
      assert.match(res.error, /Swap failed on-chain: code=6005/);
    }
  });

  test("Jupiter Swap: execute endpoint missing signature produces explicit error", async () => {
    process.env.DRY_RUN = "false";
    const sample = Keypair.generate();
    process.env.WALLET_PRIVATE_KEY = bs58.encode(sample.secretKey);
    process.env.RPC_URL = "https://api.mainnet-beta.solana.com";

    const dummyMsg = new TransactionMessage({
      payerKey: sample.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [],
    }).compileToV0Message();
    const vTx = new VersionedTransaction(dummyMsg);
    const mockTxBase64 = Buffer.from(vTx.serialize()).toString("base64");

    globalThis.fetch = async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/order")) {
        return new Response(
          JSON.stringify({
            transaction: mockTxBase64,
            requestId: "req_test_123",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (urlStr.includes("/execute")) {
        return new Response(
          JSON.stringify({
            status: "Success",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    };

    const res = await swapToken({
      input_mint: "SOL",
      output_mint: USDC_MINT,
      amount: 0.1,
    });

    assert.equal("success" in res && res.success, false);
    if ("error" in res) {
      assert.match(res.error, /Swap succeeded but no signature was returned/);
    }
  });

  test("Jupiter Swap: successful order and execution returns success payload with signature", async () => {
    process.env.DRY_RUN = "false";
    const sample = Keypair.generate();
    process.env.WALLET_PRIVATE_KEY = bs58.encode(sample.secretKey);
    process.env.RPC_URL = "https://api.mainnet-beta.solana.com";

    const dummyMsg = new TransactionMessage({
      payerKey: sample.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [],
    }).compileToV0Message();
    const vTx = new VersionedTransaction(dummyMsg);
    const mockTxBase64 = Buffer.from(vTx.serialize()).toString("base64");

    globalThis.fetch = async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/order")) {
        return new Response(
          JSON.stringify({
            transaction: mockTxBase64,
            requestId: "req_test_success",
            feeBps: 50,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (urlStr.includes("/execute")) {
        return new Response(
          JSON.stringify({
            status: "Success",
            signature: "5VERIFY_MOCK_SIGNATURE_SUCCESS_111111111111111111111",
            inputAmountResult: "100000000",
            outputAmountResult: "15500000",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    };

    const res = await swapToken({
      input_mint: "SOL",
      output_mint: USDC_MINT,
      amount: 0.1,
    });

    assert.equal("success" in res && res.success, true);
    if ("tx" in res) {
      assert.equal(res.tx, "5VERIFY_MOCK_SIGNATURE_SUCCESS_111111111111111111111");
      assert.equal(res.input_mint, VALID_SOL_MINT);
      assert.equal(res.output_mint, USDC_MINT);
      assert.equal(res.amount_in, "100000000");
      assert.equal(res.amount_out, "15500000");
    }
  });
});

describe("Challenger M4 Suite 2: tools/pnl.ts", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("Jupiter pricing: chunks requests for >50 mints and extracts valid prices", async () => {
    const requestedBatches: string[] = [];
    const mints: string[] = [];
    for (let i = 0; i < 75; i++) {
      mints.push(Keypair.generate().publicKey.toBase58());
    }

    globalThis.fetch = async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("api.jup.ag/price/v3")) {
        requestedBatches.push(urlStr);
        const data: Record<string, { usdPrice: number }> = {};
        for (const m of mints) {
          if (urlStr.includes(m)) {
            data[m] = { usdPrice: 1.25 };
          }
        }
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    };

    const prices = await getJupiterPrices(mints);

    assert.equal(requestedBatches.length, 2);
    assert.equal(Object.keys(prices).length, 75);
    const m0 = mints[0];
    const m74 = mints[74];
    assert.ok(m0 && m74);
    assert.equal(prices[m0], 1.25);
    assert.equal(prices[m74], 1.25);
  });

  test("Jupiter pricing: fallback search queries datapi for mints missing from Price V3", async () => {
    const mintFound = Keypair.generate().publicKey.toBase58();
    const mintMissing = Keypair.generate().publicKey.toBase58();

    let searchCalledWith = "";
    globalThis.fetch = async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("api.jup.ag/price/v3")) {
        return new Response(
          JSON.stringify({
            data: {
              [mintFound]: { usdPrice: 50.0 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (urlStr.includes("datapi.jup.ag/v1/assets/search")) {
        searchCalledWith = urlStr;
        return new Response(
          JSON.stringify([
            {
              id: mintMissing,
              usdPrice: 3.14,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    };

    const prices = await getJupiterPrices([mintFound, mintMissing]);

    assert.ok(searchCalledWith.includes(encodeURIComponent(mintMissing)));
    assert.equal(prices[mintFound], 50.0);
    assert.equal(prices[mintMissing], 3.14);
  });

  test("fetchDlmmPnlForPool: parses Meteora PnL API and handles errors safely", async () => {
    const samplePool = Keypair.generate().publicKey.toBase58();
    const sampleWallet = Keypair.generate().publicKey.toBase58();
    const posAddr = Keypair.generate().publicKey.toBase58();

    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          positions: [
            {
              positionAddress: posAddr,
              pnlPctChange: 5.5,
              pnlUsd: 12.34,
              allTimeDeposits: { total: { usd: 100 } },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const result = await fetchDlmmPnlForPool(samplePool, sampleWallet);
    const entry = result[posAddr];
    assert.ok(entry);
    assert.equal(entry.positionAddress, posAddr);
    assert.equal(entry.pnlUsd, 12.34);

    // Test HTTP 404 returns empty object
    globalThis.fetch = async () => new Response("Not Found", { status: 404 });
    const emptyResult = await fetchDlmmPnlForPool(samplePool, sampleWallet);
    assert.deepEqual(emptyResult, {});

    // Test malformed payload returns empty object
    globalThis.fetch = async () => new Response(JSON.stringify({ invalid: true }), { status: 200 });
    const invalidResult = await fetchDlmmPnlForPool(samplePool, sampleWallet);
    assert.deepEqual(invalidResult, {});
  });

  test("isPostClaimSettling: active when last_claim_at is within 60s, inactive when older", () => {
    const now = Date.now();
    const recent = { last_claim_at: new Date(now - 30_000).toISOString() };
    assert.equal(isPostClaimSettling(recent, now), true);

    const old = { last_claim_at: new Date(now - 90_000).toISOString() };
    assert.equal(isPostClaimSettling(old, now), false);

    assert.equal(isPostClaimSettling({}, now), false);
    assert.equal(isPostClaimSettling({ last_claim_at: null }, now), false);
  });

  test("computePositions: calculates PnL correctly and flags suspicious states", async () => {
    const poolKey = Keypair.generate().publicKey.toBase58();
    const posKey = Keypair.generate().publicKey.toBase58();
    const baseMint = Keypair.generate().publicKey.toBase58();
    const walletAddress = Keypair.generate().publicKey.toBase58();

    const dlmmStatics = await loadDlmmStatics();
    const originalPositionsMethod = dlmmStatics.getAllLbPairPositionsByUser;

    try {
      dlmmStatics.getAllLbPairPositionsByUser = async () => {
        const map = new Map();
        map.set(poolKey, {
          tokenX: {
            mint: {
              decimals: 6,
              address: { toString: () => baseMint },
            },
          },
          tokenY: { mint: { decimals: 9 } },
          lbPair: { activeId: 100 },
          lbPairPositionsData: [
            {
              publicKey: { toString: () => posKey },
              positionData: {
                lowerBinId: 90,
                upperBinId: 110,
                totalXAmount: 100 * 1e6,
                totalYAmount: 1 * 1e9,
                feeX: "500000",
                feeY: "10000000",
              },
            },
          ],
        });
        return map;
      };

      // Scenario A: Healthy prices & deposits -> pnl_pct_suspicious = false
      globalThis.fetch = async (url: unknown) => {
        const urlStr = String(url);
        if (urlStr.includes("api.jup.ag/price/v3")) {
          return new Response(
            JSON.stringify({
              data: {
                [VALID_SOL_MINT]: { usdPrice: 150 },
                [baseMint]: { usdPrice: 2.0 },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (urlStr.includes("dlmm.datapi.meteora.ag/positions")) {
          return new Response(
            JSON.stringify({
              positions: [
                {
                  positionAddress: posKey,
                  allTimeDeposits: { total: { usd: 300, sol: 2 } },
                  allTimeWithdrawals: { total: { usd: 0, sol: 0 } },
                  allTimeFees: { total: { usd: 10, sol: 0.06 } },
                  pnlPctChange: 15.0,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("{}", { status: 200 });
      };

      const healthyRes = await computePositions(walletAddress);
      assert.equal(healthyRes.total_positions, 1);
      const pos = healthyRes.positions[0];
      assert.ok(pos);
      assert.equal(pos.position, posKey);
      assert.equal(pos.in_range, true);
      assert.equal(pos.pnl_pct_suspicious, false);
      assert.ok(pos.pnl_true_usd != null && pos.pnl_true_usd > 50);

      // Scenario B: Missing token X price -> priceMissing triggers pnl_pct_suspicious = true
      globalThis.fetch = async (url: unknown) => {
        const urlStr = String(url);
        if (urlStr.includes("api.jup.ag/price/v3")) {
          return new Response(
            JSON.stringify({
              data: {
                [VALID_SOL_MINT]: { usdPrice: 150 },
                [baseMint]: { usdPrice: 0 },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (urlStr.includes("datapi.jup.ag/v1/assets/search")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (urlStr.includes("dlmm.datapi.meteora.ag/positions")) {
          return new Response(
            JSON.stringify({
              positions: [
                {
                  positionAddress: posKey,
                  pnlPctChange: 0,
                  allTimeDeposits: { total: { usd: 300, sol: 2 } },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("{}", { status: 200 });
      };

      const priceMissingRes = await computePositions(walletAddress);
      const posMissing = priceMissingRes.positions[0];
      assert.ok(posMissing);
      assert.equal(posMissing.pnl_pct_suspicious, true);
    } finally {
      dlmmStatics.getAllLbPairPositionsByUser = originalPositionsMethod;
    }
  });
});

describe("Challenger M4 Suite 3: tools/executor.ts", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetWalletLockForTests();
    process.env = { ...originalEnv, DISABLE_TELEGRAM: "true" };
  });

  afterEach(() => {
    resetWalletLockForTests();
    process.env = { ...originalEnv };
  });

  test("Tool input schema validation: rejects invalid or missing required parameters", async () => {
    // 1. deploy_position with invalid pool address
    const invalidDeploy = await executeTool("deploy_position", {
      pool_address: "invalid_not_sol_address",
      amount_y: 0.5,
    });
    assert.ok("error" in invalidDeploy || ("blocked" in invalidDeploy && invalidDeploy.blocked));

    // 2. deploy_position with invalid strategy enum
    const validPool = Keypair.generate().publicKey.toBase58();
    const invalidStrat = await executeTool("deploy_position", {
      pool_address: validPool,
      strategy: "invalid_unsupported_strat",
      amount_y: 0.5,
    });
    assert.ok("error" in invalidStrat || ("blocked" in invalidStrat && invalidStrat.blocked));

    // 3. claim_fees without position_address
    const invalidClaim = await executeTool("claim_fees", {});
    assert.ok("error" in invalidClaim || ("blocked" in invalidClaim && invalidClaim.blocked));

    // 4. close_position without position_address
    const invalidClose = await executeTool("close_position", {});
    assert.ok("error" in invalidClose || ("blocked" in invalidClose && invalidClose.blocked));

    // 5. swap_token with empty string input_mint or negative amount
    const invalidSwap1 = await executeTool("swap_token", {
      input_mint: "",
      output_mint: "SOL",
      amount: 1,
    });
    assert.ok("error" in invalidSwap1);

    const invalidSwap2 = await executeTool("swap_token", {
      input_mint: "SOL",
      output_mint: USDC_MINT,
      amount: -10,
    });
    assert.ok("error" in invalidSwap2);

    // 6. Unknown tool name returns explicit error
    const unknownTool = await executeTool("nonexistent_tool_action", {});
    assert.deepEqual(unknownTool, { error: "Unknown tool: nonexistent_tool_action" });
  });

  test("Mutex lock priorities: close_position (10) jumps ahead of swap_token (5) and deploy_position (0)", async () => {
    process.env.DRY_RUN = "true";
    const executionOrder: string[] = [];

    let releaseHolder: () => void = () => {};
    const holderPromise = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const lockAcquired = new Promise<void>((resolve) => {
      void withWalletLock(async () => {
        resolve();
        await holderPromise;
      }, 0);
    });

    await lockAcquired;

    const deployPromise = withWalletLock(async () => {
      executionOrder.push("deploy_position");
    }, 0);

    const swapPromise = withWalletLock(async () => {
      executionOrder.push("swap_token");
    }, 5);

    const closePromise = withWalletLock(async () => {
      executionOrder.push("close_position");
    }, 10);

    releaseHolder();

    await Promise.all([deployPromise, swapPromise, closePromise]);

    assert.deepEqual(executionOrder, [
      "close_position",
      "swap_token",
      "deploy_position",
    ]);
  });
});

describe("Challenger M4 Suite 4: tools/dlmm.ts", () => {
  const originalEnv = { ...process.env };
  let originalDlmmCreate: ((connection: unknown, poolPubkey: unknown) => Promise<unknown>) | null = null;
  let dlmmStaticsRef: DlmmStatics | null = null;

  beforeEach(async () => {
    resetDlmmWalletCache();
    process.env = {
      ...originalEnv,
      DISABLE_TELEGRAM: "true",
      RPC_URL: "https://api.mainnet-beta.solana.com",
      WALLET_PRIVATE_KEY: bs58.encode(Keypair.generate().secretKey),
    };

    dlmmStaticsRef = await loadDlmmStatics();
    originalDlmmCreate = dlmmStaticsRef.create;

    dlmmStaticsRef.create = async () => ({
      lbPair: {
        publicKey: Keypair.generate().publicKey,
        tokenXMint: Keypair.generate().publicKey,
        tokenYMint: new PublicKey(VALID_SOL_MINT),
        binStep: 100,
      },
      getActiveBin: async () => ({ binId: 100, price: 1.0 }),
      fromPricePerLamport: (p: number) => p,
      getPosition: async () => null,
      claimSwapFee: async () => new Transaction(),
      removeLiquidity: async () => new Transaction(),
      closePosition: async () => new Transaction(),
      createExtendedEmptyPosition: async () => new Transaction(),
      addLiquidityByStrategyChunkable: async () => new Transaction(),
      initializePositionAndAddLiquidityByStrategy: async () => new Transaction(),
    });
  });

  afterEach(() => {
    resetDlmmWalletCache();
    process.env = { ...originalEnv };
    if (dlmmStaticsRef && originalDlmmCreate) {
      dlmmStaticsRef.create = originalDlmmCreate;
    }
  });

  test("Dynamic SDK loading safety: @meteora-ag/dlmm loads cleanly without ESM runtime crashes", async () => {
    const statics = await loadDlmmStatics();
    assert.equal(typeof statics, "function");
    assert.equal(typeof statics.create, "function");
    assert.equal(typeof statics.getAllLbPairPositionsByUser, "function");
  });

  test("deployPosition: enforces before_submit recheck function", async () => {
    process.env.DRY_RUN = "true";
    const samplePool = Keypair.generate().publicKey.toBase58();

    await assert.rejects(
      async () => {
        await deployPosition({
          pool_address: samplePool,
          amount_y: 0.5,
        });
      },
      /Deploy requires a wallet-signal recheck \(before_submit\)/
    );
  });

  test("deployPosition: DRY_RUN mode validates parameters and returns dry_run payload safely", async () => {
    process.env.DRY_RUN = "true";
    const samplePool = Keypair.generate().publicKey.toBase58();

    const res = await deployPosition({
      pool_address: samplePool,
      amount_y: 0.5,
      bins_below: 35,
      bins_above: 10,
      bin_step: 100,
      strategy: "spot",
      before_submit: async () => {},
    });

    assert.equal("dry_run" in res && res.dry_run, true);
    if ("would_deploy" in res) {
      assert.equal(res.would_deploy.pool_address, samplePool);
      assert.equal(res.would_deploy.amount_y, 0.5);
      assert.equal(res.would_deploy.bins_below, 35);
      assert.equal(res.would_deploy.bins_above, 10);
      assert.equal(res.would_deploy.strategy, "spot");
    }
  });

  test("deployPosition: rejects invalid bin ranges (negative, fractional, or below safe threshold)", async () => {
    process.env.DRY_RUN = "true";
    const samplePool = Keypair.generate().publicKey.toBase58();

    // Non-integer bins
    await assert.rejects(
      async () => {
        await deployPosition({
          pool_address: samplePool,
          amount_y: 0.5,
          bins_below: 35.5,
          bins_above: 10,
          bin_step: 100,
          before_submit: async () => {},
        });
      },
      /bins_below and bins_above must be whole-bin integers/
    );

    // Negative bins
    await assert.rejects(
      async () => {
        await deployPosition({
          pool_address: samplePool,
          amount_y: 0.5,
          bins_below: -5,
          bins_above: 10,
          bin_step: 100,
          before_submit: async () => {},
        });
      },
      /bins_below and bins_above cannot be negative/
    );

    // Tiny range below minimum
    await assert.rejects(
      async () => {
        await deployPosition({
          pool_address: samplePool,
          amount_y: 0.5,
          bins_below: 1,
          bins_above: 1,
          bin_step: 100,
          before_submit: async () => {},
        });
      },
      /below minimum/
    );
  });

  test("claimFees & closePosition: DRY_RUN mode safely returns dry_run payload without on-chain execution", async () => {
    process.env.DRY_RUN = "true";
    const samplePos = Keypair.generate().publicKey.toBase58();

    const claimRes = await claimFees({ position_address: samplePos });
    assert.equal("dry_run" in claimRes && claimRes.dry_run, true);
    if ("would_claim" in claimRes) {
      assert.equal(claimRes.would_claim, samplePos);
    }

    const closeRes = await closePosition({ position_address: samplePos, reason: "Adversarial test close" });
    assert.equal("dry_run" in closeRes && closeRes.dry_run, true);
    if ("would_close" in closeRes) {
      assert.equal(closeRes.would_close, samplePos);
    }
  });
});
