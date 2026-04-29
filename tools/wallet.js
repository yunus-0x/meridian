import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const DATAPI_ASSETS_URL = "https://datapi.jup.ag/v1/assets/search";
let _priceCache = null;      // { prices: {}, mints: Set, at: ms }
const PRICE_CACHE_TTL = 60_000; // reuse prices for 60s across concurrent calls
const _symbolCache = new Map(); // mint → symbol, populated lazily, never evicted
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function getJupiterReferralParams() {
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

/**
 * Get current wallet balances via Solana RPC + Jupiter prices.
 * No dependency on Helius REST API.
 */
export async function getWalletBalances() {
  let walletAddress;
  let walletPubkey;
  try {
    const wallet = getWallet();
    walletPubkey = wallet.publicKey;
    walletAddress = walletPubkey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  try {
    const connection = getConnection();

    // ─── SOL balance ──────────────────────────────────────────
    const lamports = await connection.getBalance(walletPubkey);
    const solBalance = lamports / LAMPORTS_PER_SOL;

    // ─── SPL token balances (Token + Token-2022, parsed JSON) ────
    const [tokenAccounts, token2022Accounts] = await Promise.all([
      connection.getParsedTokenAccountsByOwner(walletPubkey, { programId: TOKEN_PROGRAM_ID }),
      connection.getParsedTokenAccountsByOwner(walletPubkey, { programId: TOKEN_2022_PROGRAM_ID }).catch(() => ({ value: [] })),
    ]);

    const tokenMap = new Map(); // mint → { balance, decimals }
    for (const { account } of [...tokenAccounts.value, ...token2022Accounts.value]) {
      const info = account.data?.parsed?.info;
      if (!info) continue;
      const mint = info.mint;
      const uiAmount = info.tokenAmount?.uiAmount ?? 0;
      const decimals = info.tokenAmount?.decimals ?? 9;
      if (uiAmount === 0) continue;
      if (!tokenMap.has(mint)) tokenMap.set(mint, { balance: 0, decimals });
      tokenMap.get(mint).balance += uiAmount;
    }

    const tokenEntries = [...tokenMap.entries()]
      .map(([mint, { balance, decimals }]) => ({ mint, balance, decimals }))
      .filter(t => t.balance > 0);

    // ─── Resolve symbols for new mints (cached, parallel, non-blocking) ─────
    const unknownMints = tokenEntries.map(t => t.mint).filter(m => !_symbolCache.has(m));
    if (unknownMints.length) {
      await Promise.all(unknownMints.map(async (mint) => {
        try {
          const res = await fetch(`${DATAPI_ASSETS_URL}?query=${mint}`, { signal: AbortSignal.timeout(4000) });
          if (res.ok) {
            const data = await res.json();
            const tokens = Array.isArray(data) ? data : [data];
            const match = tokens.find(t => t.id === mint);
            if (match?.symbol) _symbolCache.set(mint, match.symbol);
          }
        } catch { /* non-critical — fall back to truncated mint */ }
      }));
    }

    // ─── Fetch prices from Jupiter (SOL first, then tokens in batches of 30) ───
    let prices = {};
    const priceMints = [config.tokens.SOL, ...tokenEntries.map(t => t.mint)];
    const BATCH = 30;

    // Use cache if it covers all requested mints and is still fresh
    const cacheHit = _priceCache &&
      (Date.now() - _priceCache.at < PRICE_CACHE_TTL) &&
      priceMints.every(m => _priceCache.mints.has(m));
    if (cacheHit) {
      prices = _priceCache.prices;
    } else {
      try {
        const fetched = {};
        for (let i = 0; i < priceMints.length; i += BATCH) {
          const batch = priceMints.slice(i, i + BATCH).join(",");
          const priceRes = await fetch(`${JUPITER_PRICE_API}?ids=${batch}`, { signal: AbortSignal.timeout(8000) });
          if (priceRes.ok) {
            const priceData = await priceRes.json();
            Object.assign(fetched, priceData || {});
          } else {
            log("wallet_warn", `Jupiter price fetch failed: ${priceRes.status}`);
          }
        }
        if (Object.keys(fetched).length) {
          _priceCache = { prices: fetched, mints: new Set(priceMints), at: Date.now() };
          prices = fetched;
        }
      } catch (e) {
        log("wallet_warn", `Jupiter price fetch error: ${e.message}`);
      }
    }

    const solPrice = Number(prices[config.tokens.SOL]?.usdPrice || 0);
    const solUsd = solBalance * solPrice;

    // ─── Build enriched token list ────────────────────────────
    const USDC_MINT = config.tokens.USDC;
    const enrichedTokens = tokenEntries.map(t => {
      const price = Number(prices[t.mint]?.usdPrice || 0);
      const usd = price > 0 ? Math.round(t.balance * price * 100) / 100 : null;
      return {
        mint: t.mint,
        symbol: _symbolCache.get(t.mint) || t.mint.slice(0, 8),
        balance: t.balance,
        usd,
      };
    });

    const usdcEntry = enrichedTokens.find(t => t.mint === USDC_MINT);
    const totalUsd = solUsd + enrichedTokens.reduce((s, t) => s + (t.usd || 0), 0);

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round((usdcEntry?.balance || 0) * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round(totalUsd * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: error.message };
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
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

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toFixed(0);

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
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
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
