import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config, getHeader } from "../config.js";

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

async function fetchJupiterPrices(mints) {
  const uniqueMints = [...new Set(mints.filter(Boolean))];
  if (!uniqueMints.length) return {};
  try {
    const res = await fetch(`https://datapi.jup.ag/v1/assets/search?query=${uniqueMints.join(",")}`, {
      headers: getHeader(),
    });
    if (!res.ok) return {};
    const assets = await res.json();
    const prices = {};
    for (const a of assets) {
      if (a.id && a.usdPrice != null) {
        prices[a.id] = parseFloat(a.usdPrice);
      }
    }
    return prices;
  } catch (e) {
    log("wallet_error", `Jupiter price lookup failed: ${e.message}`);
    return {};
  }
}

/**
 * Get single token balance using Shyft Wallet API (GET /sol/v1/wallet/token_balance).
 */
export async function getShyftTokenBalance(walletAddress, tokenMint) {
  const SHYFT_KEY = process.env.SHYFT_API_KEY;
  if (!SHYFT_KEY) {
    throw new Error("SHYFT_API_KEY not set in .env");
  }
  const url = `https://api.shyft.to/sol/v1/wallet/token_balance?network=mainnet-beta&wallet=${walletAddress}&token=${tokenMint}`;
  const res = await fetch(url, {
    headers: {
      "x-api-key": SHYFT_KEY,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Shyft token_balance API error: ${res.status} ${errText}`);
  }
  const data = await res.json();
  return data.result;
}

/**
 * Fetch wallet balances using Shyft Wallet API (GET /sol/v1/wallet/balance & GET /sol/v1/wallet/all_tokens).
 */
async function getWalletBalancesFromShyft(walletAddress) {
  const SHYFT_KEY = process.env.SHYFT_API_KEY;
  if (!SHYFT_KEY) {
    log("wallet_error", "SHYFT_API_KEY not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Shyft API key missing" };
  }

  const headers = {
    "x-api-key": SHYFT_KEY,
    "Content-Type": "application/json",
  };

  try {
    const [solRes, tokensRes] = await Promise.all([
      fetch(`https://api.shyft.to/sol/v1/wallet/balance?network=mainnet-beta&wallet=${walletAddress}`, { headers }),
      fetch(`https://api.shyft.to/sol/v1/wallet/all_tokens?network=mainnet-beta&wallet=${walletAddress}`, { headers }),
    ]);

    if (!solRes.ok) {
      const errText = await solRes.text().catch(() => "");
      throw new Error(`Shyft balance API error: ${solRes.status} ${errText}`);
    }
    if (!tokensRes.ok) {
      const errText = await tokensRes.text().catch(() => "");
      throw new Error(`Shyft all_tokens API error: ${tokensRes.status} ${errText}`);
    }

    const solData = await solRes.json();
    const tokensData = await tokensRes.json();

    const solBalance = solData.result?.balance || 0;
    const rawTokens = tokensData.result || [];

    const mintsToPrice = [config.tokens.SOL, ...rawTokens.map(t => t.address)];
    const prices = await fetchJupiterPrices(mintsToPrice);

    const solPrice = prices[config.tokens.SOL] || 0;
    const solUsd = solBalance * solPrice;

    let usdcBalance = 0;
    let tokensUsdSum = 0;

    const enrichedTokens = rawTokens.map(t => {
      const mint = t.address;
      const symbol = t.info?.symbol || mint.slice(0, 8);
      const balance = t.balance || 0;
      const price = prices[mint] || 0;
      const usd = (balance > 0 && price > 0) ? Math.round(balance * price * 100) / 100 : null;

      if (mint === config.tokens.USDC || symbol === "USDC") {
        usdcBalance = balance;
      }
      if (usd != null) {
        tokensUsdSum += usd;
      }

      return {
        mint,
        symbol,
        balance,
        usd,
      };
    });

    const totalUsd = solUsd + tokensUsdSum;

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round(totalUsd * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
}

/**
 * Fetch wallet balances using Helius Wallet API.
 */
async function getWalletBalancesFromHelius(walletAddress) {
  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_error", "HELIUS_API_KEY not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Helius API key missing" };
  }

  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
}

/**
 * Fetch wallet balances using native Solana web3 RPC (connection.getBalance / getParsedTokenAccountsByOwner).
 */
async function getWalletBalancesFromSolana(walletAddress) {
  try {
    const connection = getConnection();
    const pubKey = new PublicKey(walletAddress);

    const [solLamports, tokenAccountsResult] = await Promise.all([
      connection.getBalance(pubKey),
      connection.getParsedTokenAccountsByOwner(pubKey, {
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      }),
    ]);

    const solBalance = solLamports / LAMPORTS_PER_SOL;

    const rawTokens = [];
    if (tokenAccountsResult?.value) {
      for (const item of tokenAccountsResult.value) {
        const parsedInfo = item.account?.data?.parsed?.info;
        if (!parsedInfo) continue;
        const mint = parsedInfo.mint;
        const balance = parsedInfo.tokenAmount?.uiAmount || 0;
        if (balance > 0) {
          rawTokens.push({ mint, balance });
        }
      }
    }

    const mintsToPrice = [config.tokens.SOL, ...rawTokens.map(t => t.mint)];
    const prices = await fetchJupiterPrices(mintsToPrice);

    const solPrice = prices[config.tokens.SOL] || 0;
    const solUsd = solBalance * solPrice;

    let usdcBalance = 0;
    let tokensUsdSum = 0;

    const enrichedTokens = rawTokens.map(t => {
      const mint = t.mint;
      const balance = t.balance;
      const price = prices[mint] || 0;
      const usd = (balance > 0 && price > 0) ? Math.round(balance * price * 100) / 100 : null;

      if (mint === config.tokens.USDC) {
        usdcBalance = balance;
      }
      if (usd != null) {
        tokensUsdSum += usd;
      }

      return {
        mint,
        symbol: mint.slice(0, 8),
        balance,
        usd,
      };
    });

    const totalUsd = solUsd + tokensUsdSum;

    return {
      wallet: walletAddress,
      provider: "solana",
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round(totalUsd * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using configured API provider (Helius, Shyft, or Solana RPC).
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const provider = (config.walletApi || process.env.WALLET_API || "helius").toLowerCase();
  if (provider === "shyft") {
    return getWalletBalancesFromShyft(walletAddress);
  }
  if (provider === "solana" || provider === "rpc" || provider === "web3") {
    return getWalletBalancesFromSolana(walletAddress);
  }
  return getWalletBalancesFromHelius(walletAddress);
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
  input_mint = normalizeMint(input_mint);
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
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

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
