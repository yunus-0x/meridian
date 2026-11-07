import { PublicKey, type Connection } from "@solana/web3.js";
import { config } from "../config.js";
import { fetchJson, readRpc, type RpcKind } from "./rpc.js";
import {
  AggregateTokenAccountsInputSchema,
  type AggregatedTokenBalance,
  type NativeBalanceResult,
  type TokenBalanceResult,
  type PricedTokenBalance,
  type PricedBalancesResult,
} from "../src/schemas/solana.js";
import { JupiterPriceV3ResponseSchema } from "../src/schemas/api.js";

export const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
] as const;

interface PriceEntry {
  price: number;
  at: number;
}

interface BalanceEntry {
  at: number;
  value: TokenBalanceResult;
}

const prices = new Map<string, PriceEntry>();
const balances = new Map<string, BalanceEntry>();

interface MintAccumulator {
  mint: string;
  decimals: number;
  raw: bigint;
}

export function aggregateTokenAccounts(responses: unknown): AggregatedTokenBalance[] {
  const parsedResponses = AggregateTokenAccountsInputSchema.parse(responses);
  const byMint = new Map<string, MintAccumulator>();

  for (const response of parsedResponses) {
    for (const account of response.value) {
      const info = account.account.data.parsed.info;
      const amount = BigInt(info.tokenAmount.amount);
      if (amount === 0n) continue;

      const prior = byMint.get(info.mint);
      if (prior && prior.decimals !== info.tokenAmount.decimals) {
        throw new Error("Conflicting token decimals");
      }

      const priorRaw = prior?.raw ?? 0n;
      byMint.set(info.mint, {
        mint: info.mint,
        decimals: info.tokenAmount.decimals,
        raw: priorRaw + amount,
      });
    }
  }

  return [...byMint.values()].map((t): AggregatedTokenBalance => ({
    mint: t.mint,
    raw_balance: t.raw.toString(),
    decimals: t.decimals,
    balance: Number(t.raw) / (10 ** t.decimals),
  }));
}

export interface RpcBalancesOptions {
  force?: boolean;
  nativeOnly?: boolean;
  rpc?: <T>(kind: RpcKind, fn: (connection: Connection) => Promise<T>) => Promise<T>;
  now?: number;
}

export async function rpcBalances(
  address: string,
  options: RpcBalancesOptions & { nativeOnly: true }
): Promise<NativeBalanceResult>;
export async function rpcBalances(
  address: string,
  options?: RpcBalancesOptions & { nativeOnly?: false }
): Promise<TokenBalanceResult>;
export async function rpcBalances(
  address: string,
  options?: RpcBalancesOptions
): Promise<NativeBalanceResult | TokenBalanceResult>;
export async function rpcBalances(
  address: string,
  options: RpcBalancesOptions = {}
): Promise<NativeBalanceResult | TokenBalanceResult> {
  const { force = false, nativeOnly = false, rpc = readRpc, now = Date.now() } = options;
  const owner = new PublicKey(address);

  if (nativeOnly) {
    const lamports = await rpc("balance", (c: Connection) => c.getBalance(owner, "confirmed"));
    return { wallet: address, sol: lamports / 1e9 };
  }

  const cached = balances.get(address);
  if (!force && cached && now - cached.at < 10_000) {
    return cached.value;
  }

  const [lamports, ...accounts] = await Promise.all([
    rpc("balance", (c: Connection) => c.getBalance(owner, "confirmed")),
    ...TOKEN_PROGRAMS.map((p) =>
      rpc("balance", (c: Connection) =>
        c.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(p) }, "confirmed")
      )
    ),
  ]);

  const value: TokenBalanceResult = {
    wallet: address,
    sol: lamports / 1e9,
    tokens: aggregateTokenAccounts(accounts),
  };
  balances.set(address, { at: now, value });
  return value;
}

export function invalidateBalances(): void {
  balances.clear();
}

export interface PriceBalancesOptions {
  force?: boolean;
}

export async function priceBalances(
  raw: TokenBalanceResult,
  { force = false }: PriceBalancesOptions = {}
): Promise<PricedBalancesResult> {
  const mints = [...new Set([config.tokens.SOL, ...raw.tokens.map((t) => t.mint)])];
  const missing = mints.filter(
    (m) => force || !prices.has(m) || Date.now() - (prices.get(m)?.at ?? 0) > 30_000
  );

  for (let i = 0; i < missing.length; i += 50) {
    try {
      const batch = missing.slice(i, i + 50);
      const headers: Record<string, string> = {};
      if (config.jupiter.apiKey) {
        headers["x-api-key"] = config.jupiter.apiKey;
      }
      const rawData = await fetchJson(`https://api.jup.ag/price/v3?ids=${batch.join(",")}`, { headers });
      const parsed = JupiterPriceV3ResponseSchema.safeParse(rawData);
      if (parsed.success) {
        for (const mint of batch) {
          const entry = parsed.data[mint];
          const n = entry?.usdPrice;
          if (typeof n === "number" && Number.isFinite(n) && n > 0) {
            prices.set(mint, { price: n, at: Date.now() });
          }
        }
      }
    } catch {
      /* Pricing is optional; unknown prices never become zero-valued assets. */
    }
  }

  const getPrice = (mint: string): number | null => {
    const entry = prices.get(mint);
    return entry && Date.now() - entry.at <= 30_000 ? entry.price : null;
  };

  const solPrice = getPrice(config.tokens.SOL);
  const tokens: PricedTokenBalance[] = raw.tokens.map((t) => {
    const price = getPrice(t.mint);
    const usd = price !== null ? t.balance * price : null;
    return {
      ...t,
      symbol:
        t.mint === config.tokens.SOL
          ? "wSOL"
          : t.mint === config.tokens.USDC
            ? "USDC"
            : t.mint.slice(0, 8),
      usd,
    };
  });

  const solUsd = solPrice !== null ? raw.sol * solPrice : null;
  const complete = solUsd !== null && tokens.every((t) => t.usd !== null);
  const usdcToken = tokens.find((t) => t.mint === config.tokens.USDC);
  const usdc = usdcToken ? usdcToken.balance : 0;
  const totalUsd = complete
    ? solUsd + tokens.reduce((sum, t) => sum + (t.usd ?? 0), 0)
    : null;

  return {
    ...raw,
    tokens,
    sol_price: solPrice,
    sol_usd: solUsd,
    usdc,
    total_usd: totalUsd,
    prices_complete: complete,
  };
}
