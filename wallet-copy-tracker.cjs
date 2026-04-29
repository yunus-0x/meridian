#!/usr/bin/env node
/**
 * Wallet Copy Tracker
 *
 * Watches one or more source wallets via Helius enhanced transactions.
 * When a new BUY/swap into a token is detected, the script runs lightweight
 * filters and can optionally execute a copy trade.
 *
 * Env vars:
 *   HELIUS_API_KEY=...
 *   SOURCE_WALLETS=wallet1,wallet2
 *   TRACKER_STATE_FILE=/root/meridian/tracker-state.json
 *   POLL_INTERVAL_MS=15000
 *   COPY_ENABLED=false
 *   COPY_MODE=fixed_sol              // fixed_sol | wallet_ratio
 *   COPY_FIXED_SOL=0.1
 *   COPY_RATIO=0.15                  // used when COPY_MODE=wallet_ratio
 *   MAX_TOKEN_AGE_HOURS=72
 *   MIN_VOLUME_USD=1000
 *   MIN_HOLDERS=300
 *   MAX_TOP10_PCT=55
 *   MAX_BOT_HOLDERS_PCT=25
 *   DRY_RUN=true
 *
 * Optional OKX public-mode enrichment:
 *   OKX_BASE_URL=https://www.okx.com
 *
 * Optional execution hook:
 *   COPY_EXECUTOR_CMD="node /root/meridian/copy-executor.js"
 *
 * Notes:
 * - By default this script is safe: DRY_RUN=true and COPY_ENABLED=false.
 * - The execution hook is a separate command so you can wire it into your own
 *   Meridian/DEX flow without editing this watcher.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const fetchJson = async (url, options = {}, timeoutMs = 20000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
};

const CONFIG = {
  heliusApiKey: process.env.HELIUS_API_KEY || '',
  sourceWallets: (process.env.SOURCE_WALLETS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  stateFile: process.env.TRACKER_STATE_FILE || path.join(process.cwd(), 'tracker-state.json'),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 15000),
  copyEnabled: String(process.env.COPY_ENABLED || 'false').toLowerCase() === 'true',
  copyMode: process.env.COPY_MODE || 'fixed_sol',
  copyFixedSol: Number(process.env.COPY_FIXED_SOL || 0.1),
  copyRatio: Number(process.env.COPY_RATIO || 0.15),
  maxTokenAgeHours: Number(process.env.MAX_TOKEN_AGE_HOURS || 72),
  minVolumeUsd: Number(process.env.MIN_VOLUME_USD || 1000),
  minHolders: Number(process.env.MIN_HOLDERS || 300),
  maxTop10Pct: Number(process.env.MAX_TOP10_PCT || 55),
  maxBotHoldersPct: Number(process.env.MAX_BOT_HOLDERS_PCT || 25),
  dryRun: String(process.env.DRY_RUN || 'true').toLowerCase() === 'true',
  okxBaseUrl: process.env.OKX_BASE_URL || 'https://www.okx.com',
  copyExecutorCmd: process.env.COPY_EXECUTOR_CMD || '',
};

if (!CONFIG.heliusApiKey) {
  console.error('Missing HELIUS_API_KEY');
  process.exit(1);
}
if (!CONFIG.sourceWallets.length) {
  console.error('Missing SOURCE_WALLETS');
  process.exit(1);
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function getState() {
  return safeReadJson(CONFIG.stateFile, { seenTxIds: {}, walletCursor: {} });
}

function setState(state) {
  writeJson(CONFIG.stateFile, state);
}

function uniqueKey(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);
}

async function fetchEnhancedTransactions(wallet) {
  const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${CONFIG.heliusApiKey}`;
  return fetchJson(url);
}

function pickLikelyBuy(wallet, tx) {
  const transfers = tx.tokenTransfers || [];
  const nativeChanges = tx.accountData || [];

  const incoming = transfers.filter((t) =>
    (t.toUserAccount === wallet || t.toTokenAccount === wallet || t.toUserAccount === tx.feePayer) &&
    Number(t.tokenAmount || 0) > 0
  );

  if (!incoming.length) return null;

  // Favor non-stable / non-SOL-like mints.
  const stableMints = new Set([
    'So11111111111111111111111111111111111111112',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'Es9vMFrzaCERmJfrF4H2FY4kMWS6h1U16nDpDVuQhR6B',
  ]);

  const candidate = incoming.find((t) => !stableMints.has(t.mint)) || incoming[0];
  if (!candidate?.mint) return null;

  // Rough evidence of spend: negative SOL balance or outgoing stable transfer.
  const spentSol = nativeChanges.some(
    (a) => a.account === wallet && Number(a.nativeBalanceChange || 0) < 0
  );
  const outgoingStable = transfers.some(
    (t) => t.fromUserAccount === wallet && stableMints.has(t.mint) && Number(t.tokenAmount || 0) > 0
  );

  if (!spentSol && !outgoingStable && tx.type !== 'SWAP') return null;

  return {
    wallet,
    txId: tx.signature || uniqueKey(JSON.stringify(tx).slice(0, 1000)),
    mint: candidate.mint,
    symbol: candidate.symbol || 'UNKNOWN',
    tokenAmount: Number(candidate.tokenAmount || 0),
    timestamp: tx.timestamp || Math.floor(Date.now() / 1000),
    description: tx.description || '',
    raw: tx,
  };
}

async function fetchOkxPublicInfo(chain = 'sol', tokenContract = '') {
  if (!tokenContract) return null;

  const headers = { 'Ok-Access-Client-Tag': 'agent-cli' };
  const out = {};

  try {
    out.priceInfo = await fetchJson(
      `${CONFIG.okxBaseUrl}/api/v5/dex/market/price-info?chainId=${encodeURIComponent(chain)}&tokenContractAddress=${encodeURIComponent(tokenContract)}`,
      { headers },
    );
  } catch (err) {
    out.priceInfoError = err.message;
  }

  try {
    out.riskInfo = await fetchJson(
      `${CONFIG.okxBaseUrl}/api/v5/dex/token/risk-info?chainId=${encodeURIComponent(chain)}&tokenContractAddress=${encodeURIComponent(tokenContract)}`,
      { headers },
    );
  } catch (err) {
    out.riskInfoError = err.message;
  }

  try {
    out.advancedInfo = await fetchJson(
      `${CONFIG.okxBaseUrl}/api/v5/dex/token/advanced-info?chainId=${encodeURIComponent(chain)}&tokenContractAddress=${encodeURIComponent(tokenContract)}`,
      { headers },
    );
  } catch (err) {
    out.advancedInfoError = err.message;
  }

  return out;
}

function extractMetrics(okxInfo) {
  const metrics = {
    holders: null,
    volumeUsd24h: null,
    top10Pct: null,
    botHoldersPct: null,
    ageHours: null,
    flags: [],
  };

  const adv = okxInfo?.advancedInfo?.data?.[0] || okxInfo?.advancedInfo?.data || null;
  const risk = okxInfo?.riskInfo?.data?.[0] || okxInfo?.riskInfo?.data || null;
  const price = okxInfo?.priceInfo?.data?.[0] || okxInfo?.priceInfo?.data || null;

  if (adv) {
    metrics.holders = Number(adv.holderCount ?? adv.holders ?? adv.holderNum ?? NaN);
    metrics.volumeUsd24h = Number(adv.volume24h ?? adv.vol24h ?? price?.volume24h ?? NaN);
    metrics.top10Pct = Number(adv.top10HoldingRate ?? adv.top10Pct ?? NaN);
    metrics.botHoldersPct = Number(adv.botHolderRate ?? adv.botHoldersPct ?? NaN);
    const createdAtMs = Number(adv.createdAt ?? adv.launchTime ?? NaN);
    if (Number.isFinite(createdAtMs) && createdAtMs > 0) {
      metrics.ageHours = (Date.now() - createdAtMs) / 1000 / 60 / 60;
    }
  }

  if (risk) {
    const rawFlags = [
      risk.isHoneypot ? 'honeypot' : null,
      risk.isBlacklist ? 'blacklist' : null,
      risk.isMalicious ? 'malicious' : null,
      risk.buyTax && Number(risk.buyTax) > 15 ? `buyTax:${risk.buyTax}` : null,
      risk.sellTax && Number(risk.sellTax) > 15 ? `sellTax:${risk.sellTax}` : null,
    ].filter(Boolean);
    metrics.flags.push(...rawFlags);
  }

  for (const key of ['holders', 'volumeUsd24h', 'top10Pct', 'botHoldersPct', 'ageHours']) {
    if (!Number.isFinite(metrics[key])) metrics[key] = null;
  }

  return metrics;
}

function passesFilter(metrics) {
  const reasons = [];

  if (metrics.flags.length) reasons.push(`riskFlags=${metrics.flags.join('|')}`);
  if (metrics.ageHours != null && metrics.ageHours > CONFIG.maxTokenAgeHours) {
    reasons.push(`ageHours=${metrics.ageHours.toFixed(1)}>${CONFIG.maxTokenAgeHours}`);
  }
  if (metrics.volumeUsd24h != null && metrics.volumeUsd24h < CONFIG.minVolumeUsd) {
    reasons.push(`volume24h=${metrics.volumeUsd24h}<${CONFIG.minVolumeUsd}`);
  }
  if (metrics.holders != null && metrics.holders < CONFIG.minHolders) {
    reasons.push(`holders=${metrics.holders}<${CONFIG.minHolders}`);
  }
  if (metrics.top10Pct != null && metrics.top10Pct > CONFIG.maxTop10Pct) {
    reasons.push(`top10Pct=${metrics.top10Pct}>${CONFIG.maxTop10Pct}`);
  }
  if (metrics.botHoldersPct != null && metrics.botHoldersPct > CONFIG.maxBotHoldersPct) {
    reasons.push(`botHoldersPct=${metrics.botHoldersPct}>${CONFIG.maxBotHoldersPct}`);
  }

  return { ok: reasons.length === 0, reasons };
}

async function executeCopy(signal) {
  const amount = CONFIG.copyMode === 'wallet_ratio'
    ? String(CONFIG.copyRatio)
    : String(CONFIG.copyFixedSol);

  if (!CONFIG.copyExecutorCmd) {
    log('[COPY]', CONFIG.dryRun ? 'DRY_RUN no executor configured' : 'No COPY_EXECUTOR_CMD configured', {
      mint: signal.mint,
      symbol: signal.symbol,
      amount,
    });
    return;
  }

  const parts = CONFIG.copyExecutorCmd.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1).concat([
    '--mint', signal.mint,
    '--symbol', signal.symbol,
    '--amount', amount,
    '--mode', CONFIG.copyMode,
    '--source-wallet', signal.wallet,
    '--txid', signal.txId,
  ]);

  if (CONFIG.dryRun) {
    log('[COPY][DRY_RUN]', cmd, args.join(' '));
    return;
  }

  const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 120000 });
  if (stdout) log('[COPY][stdout]', stdout.trim());
  if (stderr) log('[COPY][stderr]', stderr.trim());
}

async function processWallet(state, wallet) {
  const txs = await fetchEnhancedTransactions(wallet);
  if (!Array.isArray(txs) || txs.length === 0) return;

  // Helius returns newest first. Process oldest to newest for stable state.
  const ordered = [...txs].reverse();

  for (const tx of ordered) {
    const txId = tx.signature || uniqueKey(JSON.stringify(tx).slice(0, 1000));
    if (state.seenTxIds[txId]) continue;

    state.seenTxIds[txId] = Date.now();
    const buy = pickLikelyBuy(wallet, tx);
    if (!buy) continue;

    log('[SIGNAL]', wallet, buy.symbol, buy.mint, `amt=${buy.tokenAmount}`, buy.description || '');

    const okxInfo = await fetchOkxPublicInfo('sol', buy.mint);
    const metrics = extractMetrics(okxInfo);
    const decision = passesFilter(metrics);

    if (!decision.ok) {
      log('[FILTER][REJECT]', buy.symbol, buy.mint, decision.reasons.join(', '));
      continue;
    }

    log('[FILTER][PASS]', buy.symbol, buy.mint, JSON.stringify(metrics));

    if (CONFIG.copyEnabled) {
      await executeCopy(buy);
    } else {
      log('[COPY] copy disabled; pass-only signal emitted', buy.symbol, buy.mint);
    }
  }
}

function pruneState(state) {
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [txId, seenAt] of Object.entries(state.seenTxIds)) {
    if (now - Number(seenAt) > maxAgeMs) delete state.seenTxIds[txId];
  }
}

async function loop() {
  const state = getState();
  try {
    for (const wallet of CONFIG.sourceWallets) {
      await processWallet(state, wallet);
    }
    pruneState(state);
    setState(state);
  } catch (err) {
    log('[ERROR]', err.message);
  }
}

async function main() {
  log('[START]', {
    wallets: CONFIG.sourceWallets.length,
    pollIntervalMs: CONFIG.pollIntervalMs,
    copyEnabled: CONFIG.copyEnabled,
    dryRun: CONFIG.dryRun,
    copyMode: CONFIG.copyMode,
  });

  await loop();
  setInterval(loop, CONFIG.pollIntervalMs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
