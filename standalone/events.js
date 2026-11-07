import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../config.js';
import { readRpc, fetchJson } from './rpc.js';

export const DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const EVENT_CPI = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);
let coder;
async function getCoder() {
  if (!coder) {
    const { createProgram } = await import('@meteora-ag/dlmm');
    coder = await readRpc('monitor', c => createProgram(c).coder);
  }
  return coder;
}
// Decode only Anchor event CPI instructions emitted by the verified DLMM program.
// Never interpret arbitrary log strings or another program's payload as an LP entry.
export function decodeEvents(tx, eventCoder) {
  if (!tx?.meta || tx.meta.err || tx.blockTime == null) return [];
  const message = tx.transaction.message;
  const keys = message.staticAccountKeys || message.accountKeys;
  const allKeys = [...keys, ...(tx.meta.loadedAddresses?.writable || []), ...(tx.meta.loadedAddresses?.readonly || [])];
  const events = [];
  for (const group of tx.meta.innerInstructions || []) for (const ix of group.instructions) {
    if (String(allKeys[ix.programIdIndex]) !== DLMM_PROGRAM || !ix.data) continue;
    const bytes = typeof ix.data === 'string' ? Buffer.from(bs58.decode(ix.data)) : Buffer.from(ix.data);
    if (bytes.length < 16 || !bytes.subarray(0, 8).equals(EVENT_CPI)) continue;
    const event = eventCoder.decode(bytes.subarray(8).toString('base64'));
    if (event) events.push(event);
  }
  return events;
}
async function account(address, type, minContextSlot) {
  const result = await readRpc('monitor', c => c.getAccountInfoAndContext(new PublicKey(address), { commitment: 'confirmed', minContextSlot }));
  const info = result.value;
  if (!info) return null;
  if (info.owner.toString() !== DLMM_PROGRAM) throw new Error('Unexpected account owner');
  return (await getCoder()).accounts.decode(type, info.data);
}
export async function positionSnapshot(position, wallet, pool, minContextSlot = 0) {
  const [p, pair] = await Promise.all([account(position, 'positionV2', minContextSlot), account(pool, 'lbPair', minContextSlot)]);
  if (!p || !pair || p.owner.toString() !== wallet || p.lbPair.toString() !== pool) return null;
  // Wide positions require dynamic extension decoding. Conservatively exclude them
  // from wallet confirmation rather than misreading their inline liquidity.
  if (p.upperBinId - p.lowerBinId >= 70) return null;
  const shares = p.liquidityShares.reduce((sum, n) => sum + BigInt(n.toString()), 0n);
  return {
    shares: shares.toString(), xMint: pair.tokenXMint.toString(), yMint: pair.tokenYMint.toString(),
    lower: p.lowerBinId, upper: p.upperBinId, active: pair.activeId,
    inRange: p.lowerBinId <= pair.activeId && pair.activeId <= p.upperBinId && shares > 0n,
  };
}
let solPrice;
async function quoteInSol(mint, raw) {
  if (mint === config.tokens.SOL) return Number(raw) / 1e9;
  if (!solPrice || Date.now() - solPrice.at > 30_000) {
    const data = await fetchJson(`https://api.jup.ag/price/v3?ids=${config.tokens.SOL}`, { headers: config.jupiter.apiKey ? { 'x-api-key': config.jupiter.apiKey } : {} });
    const price = data[config.tokens.SOL]?.usdPrice;
    if (!(price > 0)) throw new Error('SOL price unavailable for stablecoin deposit valuation');
    solPrice = { price, at: Date.now() };
  }
  return Number(raw) / 1e6 / solPrice.price;
}
export async function transactionEntries(tx, signature, wallet, options, snapshot = positionSnapshot, eventCoder = null, now = Date.now()) {
  if (!tx?.meta || tx.meta.err || tx.blockTime == null || now - tx.blockTime * 1000 > options.windowSec * 1000 || tx.blockTime * 1000 > now) return [];
  const events = decodeEvents(tx, eventCoder || (await getCoder()).events);
  // Rebalances/withdraw-and-redeposit are not new conviction, including cross-pool moves.
  if (events.some(e => /removeLiquidity|rebalanc/i.test(e.name))) return [];
  const deposits = new Map();
  for (const e of events.filter(e => e.name === 'addLiquidity')) {
    const d = e.data;
    if (d.from.toString() !== wallet) continue;
    const position = d.position.toString(), pool = d.lbPair.toString();
    const key = `${pool}:${position}`;
    const prior = deposits.get(key) || { position, pool, amounts: [0n, 0n] };
    prior.amounts = prior.amounts.map((n, i) => n + BigInt(d.amounts[i].toString()));
    deposits.set(key, prior);
  }
  const out = [];
  const quotes = new Set(Object.values(config.tokens));
  for (const d of deposits.values()) {
    const p = await snapshot(d.position, wallet, d.pool, tx.slot);
    if (!p?.inRange) continue;
    const xQuote = quotes.has(p.xMint), yQuote = quotes.has(p.yMint);
    if (xQuote === yQuote) continue;
    const mint = xQuote ? p.yMint : p.xMint;
    const quote = xQuote ? p.xMint : p.yMint;
    // Require a meaningful quote-side deposit. Token-only inventory selling is excluded.
    const depositSol = await quoteInSol(quote, d.amounts[xQuote ? 0 : 1]);
    if (depositSol < options.minDepositSol) continue;
    out.push({ id: `${signature}:${wallet}:${d.position}`, signature, wallet, position: d.position, pool: d.pool, mint, at: tx.blockTime * 1000, slot: tx.slot, depositSol, shares: p.shares, binsBelow: Math.max(0, p.active - p.lower), binsAbove: Math.max(0, p.upper - p.active) });
  }
  return out;
}
export async function exposureStillPresent(event) {
  const p = await positionSnapshot(event.position, event.wallet, event.pool, event.slot);
  return !!p?.inRange && (p.xMint === event.mint || p.yMint === event.mint) && BigInt(p.shares) * 2n >= BigInt(event.shares);
}
