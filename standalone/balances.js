import { PublicKey } from '@solana/web3.js';
import { config } from '../config.js';
import { fetchJson, readRpc } from './rpc.js';

export const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const prices = new Map();
const balances = new Map();
export function aggregateTokenAccounts(responses) {
  const byMint = new Map();
  for (const response of responses) for (const account of response.value) {
    const info = account.account.data.parsed.info;
    const amount = BigInt(info.tokenAmount.amount);
    if (amount === 0n) continue;
    const prior = byMint.get(info.mint);
    if (prior && prior.decimals !== info.tokenAmount.decimals) throw new Error('Conflicting token decimals');
    byMint.set(info.mint, { mint: info.mint, decimals: info.tokenAmount.decimals, raw: (prior?.raw ?? 0n) + amount });
  }
  return [...byMint.values()].map(t => ({ mint: t.mint, raw_balance: t.raw.toString(), decimals: t.decimals, balance: Number(t.raw) / 10 ** t.decimals }));
}
export async function rpcBalances(address, { force = false, nativeOnly = false, rpc = readRpc, now = Date.now() } = {}) {
  const owner = new PublicKey(address);
  if (nativeOnly) return { wallet: address, sol: await rpc('balance', c => c.getBalance(owner, 'confirmed')) / 1e9 };
  const cached = balances.get(address);
  if (!force && cached && now - cached.at < 10_000) return cached.value;
  const [lamports, ...accounts] = await Promise.all([
    rpc('balance', c => c.getBalance(owner, 'confirmed')),
    ...TOKEN_PROGRAMS.map(p => rpc('balance', c => c.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(p) }, 'confirmed'))),
  ]);
  const value = { wallet: address, sol: lamports / 1e9, tokens: aggregateTokenAccounts(accounts) };
  balances.set(address, { at: now, value });
  return value;
}
export function invalidateBalances() { balances.clear(); }
export async function priceBalances(raw, { force = false } = {}) {
  const mints = [...new Set([config.tokens.SOL, ...raw.tokens.map(t => t.mint)])];
  const missing = mints.filter(m => force || !prices.has(m) || Date.now() - prices.get(m).at > 30_000);
  for (let i = 0; i < missing.length; i += 50) {
    try {
      const data = await fetchJson(`https://api.jup.ag/price/v3?ids=${missing.slice(i, i + 50).join(',')}`, {
        headers: config.jupiter.apiKey ? { 'x-api-key': config.jupiter.apiKey } : {},
      });
      for (const mint of missing.slice(i, i + 50)) {
        const n = data[mint]?.usdPrice;
        if (typeof n === 'number' && Number.isFinite(n) && n > 0) prices.set(mint, { price: n, at: Date.now() });
      }
    } catch { /* Pricing is optional; unknown prices never become zero-valued assets. */ }
  }
  const price = mint => {
    const entry = prices.get(mint);
    return entry && Date.now() - entry.at <= 30_000 ? entry.price : null;
  };
  const solPrice = price(config.tokens.SOL);
  const tokens = raw.tokens.map(t => ({ ...t, symbol: t.mint === config.tokens.SOL ? 'wSOL' : t.mint === config.tokens.USDC ? 'USDC' : t.mint.slice(0, 8), usd: price(t.mint) == null ? null : t.balance * price(t.mint) }));
  const solUsd = solPrice == null ? null : raw.sol * solPrice;
  const complete = solUsd != null && tokens.every(t => t.usd != null);
  return { ...raw, tokens, sol_price: solPrice, sol_usd: solUsd, usdc: tokens.find(t => t.mint === config.tokens.USDC)?.balance ?? 0, total_usd: complete ? solUsd + tokens.reduce((sum, t) => sum + t.usd, 0) : null, prices_complete: complete };
}
