import { PublicKey } from '@solana/web3.js';
import { listSmartWallets } from '../smart-wallets.js';
import { connection, readRpc, fetchJson } from './rpc.js';
import { transactionEntries } from './events.js';
import { acceptEvents } from './store.js';
import { log } from '../logger.js';

export class WalletMonitor {
  constructor(store, options, { rpc = readRpc, wallets = listSmartWallets, entries = transactionEntries, onSignal = () => {} } = {}) {
    Object.assign(this, { store, options, rpc, wallets, entries, onSignal });
    this.subscriptions = new Map(); this.running = false; this.reconciling = false; this.draining = false;
    this.stats = { transactions: 0, entries: 0, lastLagMs: null, errors: 0 };
  }
  enqueue(wallet, signature, slot, { save = true } = {}) {
    const key = `${wallet}:${signature}`;
    if (!this.running || !this.store.data.wallets[wallet] || slot <= this.store.data.wallets[wallet].baselineSlot) return;
    if (this.store.data.seen[key] || this.store.data.pending[key]) return;
    if (Object.keys(this.store.data.pending).length >= this.options.maxPendingTransactions) throw new Error('Wallet queue is full; entry monitoring is degraded');
    this.store.data.pending[key] = { wallet, signature, slot, queuedAt: Date.now(), retryAt: 0, failures: 0 };
    if (save) this.store.save();
  }
  healthy() {
    const wallets = this.wallets().wallets.filter(w => !w.type || w.type === 'lp');
    return wallets.length >= this.options.walletThreshold && wallets.every(w => {
      const state = this.store.data.wallets[w.address];
      return state && !state.error && Date.now() - state.reconciledAt < this.options.reconcileSec * 3000;
    });
  }
  async start() {
    this.running = true;
    this.ws = connection(this.options.monitorRpcUrl, this.options.monitorWsUrl);
    await this.reconcile();
    this.reconcileTimer = setInterval(() => this.reconcile(), this.options.reconcileSec * 1000);
    this.queueTimer = setInterval(() => this.drain(), 1000);
  }
  async reconcile() {
    if (!this.running || this.reconciling) return;
    this.reconciling = true;
    try {
      const wallets = this.wallets().wallets.filter(w => !w.type || w.type === 'lp');
      const addresses = new Set(wallets.map(w => w.address));
      for (const [address, id] of this.subscriptions) if (!addresses.has(address)) {
        await this.ws.removeOnLogsListener(id).catch(() => {});
        this.subscriptions.delete(address);
      }
      for (const address of Object.keys(this.store.data.wallets)) if (!addresses.has(address)) {
        delete this.store.data.wallets[address];
        this.store.data.events = this.store.data.events.filter(e => e.wallet !== address);
      }
      for (const w of wallets) {
        if (!this.running) break;
        try {
          if (!this.store.data.wallets[w.address]) {
            const baselineSlot = await this.rpc('monitor', c => c.getSlot('confirmed'));
            // Existing portfolio is a reconciliation baseline, never an entry signal.
            const portfolio = await fetchJson(`https://dlmm.datapi.meteora.ag/portfolio/open?user=${w.address}`);
            if (!Array.isArray(portfolio.pools)) throw new Error('Unexpected Meteora portfolio response');
            this.store.data.wallets[w.address] = { baselineSlot, cursor: null, baselinePools: portfolio.pools.map(p => p.poolAddress), reconciledAt: 0 };
            this.store.save();
          }
          if (!this.subscriptions.has(w.address)) {
            const id = this.ws.onLogs(new PublicKey(w.address), (event, context) => {
              if (event.err) return;
              try { this.enqueue(w.address, event.signature, context.slot); }
              catch (e) { this.store.data.wallets[w.address].error = e.message; this.store.save(); }
            }, 'confirmed');
            this.subscriptions.set(w.address, id);
          }
          const state = this.store.data.wallets[w.address];
          let before, newest, complete = false;
          const found = [];
          for (let page = 0; page < 10; page++) {
            const signatures = await this.rpc('monitor', c => c.getSignaturesForAddress(new PublicKey(w.address), { limit: 100, ...(before ? { before } : {}) }, 'confirmed'));
            newest ||= signatures[0]?.signature;
            for (const s of signatures) {
              if (s.signature === state.cursor || s.slot <= state.baselineSlot || (s.blockTime != null && Date.now() - s.blockTime * 1000 > this.options.windowSec * 1000)) { complete = true; break; }
              if (!s.err) found.push(s);
            }
            if (complete || signatures.length < 100) { complete = true; break; }
            before = signatures.at(-1).signature;
          }
          if (!complete) throw new Error('Signature backfill limit reached; entries paused until history catches up');
          for (const s of found.reverse()) this.enqueue(w.address, s.signature, s.slot, { save: false });
          state.cursor = newest || state.cursor;
          state.error = null; state.reconciledAt = Date.now();
          this.store.save();
        } catch (e) {
          this.stats.errors++;
          const state = this.store.data.wallets[w.address];
          if (state) { state.error = e.message; this.store.save(); }
          log('monitor_warn', `Wallet ${w.address.slice(0, 8)}: ${e.message}`);
        }
      }
    } finally { this.reconciling = false; }
  }
  async drain() {
    if (!this.running || this.draining) return;
    this.draining = true;
    let dirty = false;
    try {
      for (const [key, pending] of Object.entries(this.store.data.pending).slice(0, 20)) {
        if (!this.running) break;
        if (pending.retryAt > Date.now()) continue;
        dirty = true;
        try {
          if (!this.store.data.wallets[pending.wallet] || Date.now() - pending.queuedAt > this.options.windowSec * 1000 || (pending.failures ?? 0) >= 3) {
            delete this.store.data.pending[key]; continue;
          }
          const tx = await this.rpc('monitor', c => c.getTransaction(pending.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }));
          if (!tx) throw new Error('Confirmed transaction not yet available');
          this.stats.transactions++;
          const events = await this.entries(tx, pending.signature, pending.wallet, this.options);
          this.stats.entries += events.length;
          if (events.length) this.stats.lastLagMs = Date.now() - tx.blockTime * 1000;
          this.store.data.seen[key] = Date.now();
          delete this.store.data.pending[key];
          const signals = acceptEvents(this.store, events, this.options);
          for (const signal of signals) this.onSignal(signal);
        } catch {
          pending.failures++;
          pending.retryAt = Date.now() + Math.min(15_000, 1000 * 2 ** Math.min(pending.failures, 4));
          this.stats.errors++;
        }
      }
      if (dirty) this.store.save();
    } finally { this.draining = false; }
  }
  async stop() {
    this.running = false;
    clearInterval(this.reconcileTimer); clearInterval(this.queueTimer);
    await Promise.allSettled([...this.subscriptions.values()].map(id => this.ws.removeOnLogsListener(id)));
    this.subscriptions.clear();
  }
}
