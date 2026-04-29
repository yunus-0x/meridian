const express = require('express');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '2mb' }));

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLE_MINTS = new Set([
  SOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FY4kMWS6h1U16nDpDVuQhR6B', // USDT
]);

const TRACKED_WALLETS = new Set(
  (process.env.SOURCE_WALLETS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const QUEUE_FILE = '/root/meridian/priority-mints.json';
const ACTIVE_FILE = '/root/meridian/active-priority-mint.json';
const DEDUPE_MS = 6 * 60 * 60 * 1000;

function toArray(body) {
  return Array.isArray(body) ? body : [body];
}

function readQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

function cleanupQueue(queue) {
  const now = Date.now();
  return queue.filter((item) => now - item.detectedAt < DEDUPE_MS);
}

function addToQueue(signal) {
  let queue = readQueue();
  queue = cleanupQueue(queue);

  const exists = queue.find(
    (q) => q.mint === signal.mint && q.wallet === signal.wallet
  );

  if (exists) {
    console.log(`[QUEUE][SKIP] already queued ${signal.mint}`);
    return;
  }

  queue.unshift({
    mint: signal.mint,
    symbol: signal.symbol || 'UNKNOWN',
    wallet: signal.wallet,
    source: signal.source || 'UNKNOWN',
    amount: signal.amount || 0,
    signature: signal.signature || '',
    detectedAt: Date.now(),
    used: false
  });

  writeQueue(queue);
  console.log(`[QUEUE][ADD] ${signal.symbol || 'UNKNOWN'} ${signal.mint}`);
}

function setActivePriorityMint(signal) {
  fs.writeFileSync(
    ACTIVE_FILE,
    JSON.stringify(
      {
        mint: signal.mint,
        symbol: signal.symbol || 'UNKNOWN',
        wallet: signal.wallet,
        source: signal.source || 'UNKNOWN',
        amount: signal.amount || 0,
        signature: signal.signature || '',
        detectedAt: Date.now(),
        used: false
      },
      null,
      2
    )
  );
  console.log(`[PRIORITY][ACTIVE] ${signal.mint}`);
}

function detectBuy(event) {
  if (event.type !== 'SWAP') return null;

  for (const t of event.tokenTransfers || []) {
    const tracked =
      !TRACKED_WALLETS.size ||
      TRACKED_WALLETS.has(t.toUserAccount) ||
      TRACKED_WALLETS.has(t.fromUserAccount);

    if (
      tracked &&
      t.toUserAccount &&
      !STABLE_MINTS.has(t.mint) &&
      Number(t.tokenAmount || 0) > 0
    ) {
      return {
        wallet: t.toUserAccount,
        mint: t.mint,
        amount: Number(t.tokenAmount || 0),
        symbol: t.symbol || 'UNKNOWN',
        source: event.source || 'UNKNOWN',
        signature: event.signature || '',
      };
    }
  }

  return null;
}

app.get('/helius', (_req, res) => {
  res.status(200).send('helius webhook online');
});

app.post('/helius', (req, res) => {
  try {
    const events = toArray(req.body);

    for (const event of events) {
      const signal = detectBuy(event);
      if (!signal) continue;

      console.log('🚀 [BUY SIGNAL]');
      console.log(`wallet: ${signal.wallet}`);
      console.log(`mint: ${signal.mint}`);
      console.log(`amount: ${signal.amount}`);
      console.log(`symbol: ${signal.symbol}`);
      console.log(`source: ${signal.source}`);
      console.log('---');

      addToQueue(signal);
      setActivePriorityMint(signal);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('ERROR:', err.message);
    res.status(500).send('error');
  }
});

app.listen(3001, '0.0.0.0', () => {
  console.log('Webhook running on port 3001');
});
