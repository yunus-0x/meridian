// tools/wallet.ts — Strict TypeScript Wallet & Jupiter Swap Engine
// Oracle Engineering Standards: Zero any, Zero unsafe assertions, Domain Purity, DRY z.infer schemas.

import {
  Connection,
  PublicKey,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";
import {
  rpcBalances,
  priceBalances,
  type RpcBalancesOptions,
} from "../standalone/balances.js";
import type {
  NativeBalanceResult,
  PricedBalancesResult,
} from "../src/schemas/solana.js";
import {
  JupiterSwapOrderResponseSchema,
  JupiterSwapExecuteResponseSchema,
  type JupiterSwapOrderResponse,
  type JupiterSwapExecuteResponse,
} from "../src/schemas/api.js";
import { log } from "../logger.js";
import { config } from "../config.js";

// ─── Module Singleton State ────────────────────────────────────────────────

let _connection: Connection | null = null;
let _connectionUrl: string | null = null;
let _wallet: Keypair | null = null;
let _walletSecret: string | null = null;

export function resetWalletCache(): void {
  _wallet = null;
  _walletSecret = null;
  _connection = null;
  _connectionUrl = null;
}

export function getConnection(): Connection {
  const url = process.env.RPC_URL;
  if (!url) {
    throw new Error("RPC_URL environment variable is not configured");
  }
  if (!_connection || _connectionUrl !== url) {
    _connection = new Connection(url, "confirmed");
    _connectionUrl = url;
  }
  return _connection;
}

const KeypairByteArraySchema = z.array(z.number().int().min(0).max(255));

export function getWallet(): Keypair {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) {
    throw new Error("WALLET_PRIVATE_KEY not set");
  }
  if (!_wallet || _walletSecret !== raw) {
    const text = String(raw).trim();
    let bytes: Uint8Array;
    if (text.startsWith("[")) {
      const parsedBytes = KeypairByteArraySchema.parse(JSON.parse(text));
      bytes = Uint8Array.from(parsedBytes);
    } else {
      bytes = bs58.decode(text);
    }
    _wallet = Keypair.fromSecretKey(bytes);
    _walletSecret = raw;
  }
  return _wallet;
}

// ─── Jupiter Swap V2 Constants & Configuration ────────────────────────────

const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function getJupiterApiKey(): string {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

export interface JupiterReferralParams {
  referralAccount: string;
  referralFee: number;
}

function getJupiterReferralParams(): JupiterReferralParams | null {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

// ─── Wallet Balances Query ─────────────────────────────────────────────────

export interface WalletBalanceErrorResult {
  wallet: null;
  sol: null;
  sol_price: null;
  sol_usd: null;
  usdc: null;
  tokens: never[];
  total_usd: null;
  error: string;
}

export type WalletBalancesResult =
  | NativeBalanceResult
  | PricedBalancesResult
  | WalletBalanceErrorResult;

export async function getWalletBalances(
  options: RpcBalancesOptions & { nativeOnly: true }
): Promise<NativeBalanceResult | WalletBalanceErrorResult>;
export async function getWalletBalances(
  options?: RpcBalancesOptions & { nativeOnly?: false }
): Promise<PricedBalancesResult | WalletBalanceErrorResult>;
export async function getWalletBalances(
  options?: RpcBalancesOptions
): Promise<WalletBalancesResult>;
export async function getWalletBalances(
  options: RpcBalancesOptions = {}
): Promise<WalletBalancesResult> {
  try {
    const walletAddress = config.standalone.walletAddress || getWallet().publicKey.toString();
    if (options.nativeOnly) {
      return await rpcBalances(walletAddress, { ...options, nativeOnly: true });
    }
    const raw = await rpcBalances(walletAddress, { ...options, nativeOnly: false });
    return await priceBalances(raw, options);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      wallet: null,
      sol: null,
      sol_price: null,
      sol_usd: null,
      usdc: null,
      tokens: [],
      total_usd: null,
      error: message,
    };
  }
}

// ─── Mint Normalization ────────────────────────────────────────────────────

const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Normalize any SOL-like address or symbol to the canonical wrapped SOL mint.
 */
export function normalizeMint(mint: string | null | undefined): string | null | undefined {
  if (!mint) return mint;
  if (
    mint === "SOL" ||
    mint === "native" ||
    /^So1+$/.test(mint) ||
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

// ─── Jupiter Token Swap ────────────────────────────────────────────────────

export interface SwapTokenParams {
  input_mint: string;
  output_mint: string;
  amount: number;
}

export interface SwapSuccessResult {
  success: true;
  tx: string;
  input_mint: string;
  output_mint: string;
  amount_in: string | number | null;
  amount_out: string | number | null;
  referral_account: string | null;
  referral_fee_bps_requested: number;
  fee_bps_applied: number | null;
  fee_mint: string | null;
}

export interface SwapDryRunResult {
  dry_run: true;
  would_swap: {
    input_mint: string;
    output_mint: string;
    amount: number;
  };
  message: string;
}

export interface SwapErrorResult {
  success: false;
  error: string;
}

export type SwapTokenResult = SwapSuccessResult | SwapDryRunResult | SwapErrorResult;

const MintDataDecimalsSchema = z.object({
  parsed: z.object({
    info: z.object({
      decimals: z.number().int().nonnegative(),
    }),
  }),
});

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}: SwapTokenParams): Promise<SwapTokenResult> {
  const normInput = normalizeMint(input_mint) ?? input_mint;
  const normOutput = normalizeMint(output_mint) ?? output_mint;

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint: normInput, output_mint: normOutput, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} ${normInput} → ${normOutput}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Resolve smallest unit (decimals) ──────────────────────────
    let decimals = 9; // SOL default
    if (normInput !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(normInput));
      const parsedMint = MintDataDecimalsSchema.safeParse(mintInfo.value?.data);
      if (parsedMint.success) {
        decimals = parsedMint.data.parsed.info.decimals;
      }
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ─────────────
    const search = new URLSearchParams({
      inputMint: normInput,
      outputMint: normOutput,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text().catch(() => "");
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const rawOrder: unknown = await orderRes.json();
    const order: JupiterSwapOrderResponse = JupiterSwapOrderResponseSchema.parse(rawOrder);
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign VersionedTransaction ───────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute Swap ────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      const body = await execRes.text().catch(() => "");
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${body}`);
    }

    const rawExec: unknown = await execRes.json();
    const result: JupiterSwapExecuteResponse = JupiterSwapExecuteResponseSchema.parse(rawExec);
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${String(result.code)}`);
    }

    if (!result.signature) {
      throw new Error("Swap succeeded but no signature was returned from Jupiter API");
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint: normInput,
      output_mint: normOutput,
      amount_in: result.inputAmountResult ?? null,
      amount_out: result.outputAmountResult ?? null,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log("swap_error", message);
    return { success: false, error: message };
  }
}
