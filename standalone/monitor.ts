import { PublicKey, type Connection } from "@solana/web3.js";
import { listSmartWallets } from "../smart-wallets.js";
import { config } from "../config.js";
import { connection, readRpc, fetchJson } from "./rpc.js";
import { transactionEntries } from "./events.js";
import { acceptEvents, MonitorStore } from "./store.js";
import { log } from "../logger.js";
import { MeteoraPortfolioResponseSchema } from "../src/schemas/api.js";
import type { Config } from "../src/schemas/config.js";

type StandaloneConfig = Config["standalone"];

export interface WalletMonitorStats {
  transactions: number;
  entries: number;
  lastLagMs: number | null;
  errors: number;
}

export interface WalletMonitorDependencies {
  rpc?: typeof readRpc;
  wallets?: typeof listSmartWallets;
  entries?: typeof transactionEntries;
  onSignal?: (signal: unknown) => void;
}

export interface EnqueueOptions {
  save?: boolean;
}

export class WalletMonitor {
  store: MonitorStore;
  options: StandaloneConfig;
  rpc: typeof readRpc;
  wallets: typeof listSmartWallets;
  entries: typeof transactionEntries;
  onSignal: (signal: unknown) => void;
  subscriptions: Map<string, number>;
  running: boolean;
  reconciling: boolean;
  draining: boolean;
  stats: WalletMonitorStats;
  ws?: Connection;
  reconcileTimer?: NodeJS.Timeout;
  queueTimer?: NodeJS.Timeout;

  constructor(
    store: MonitorStore,
    options: StandaloneConfig,
    {
      rpc = readRpc,
      wallets = listSmartWallets,
      entries = transactionEntries,
      onSignal = () => {},
    }: WalletMonitorDependencies = {}
  ) {
    this.store = store;
    this.options = options;
    this.rpc = rpc;
    this.wallets = wallets;
    this.entries = entries;
    this.onSignal = onSignal;
    this.subscriptions = new Map();
    this.running = false;
    this.reconciling = false;
    this.draining = false;
    this.stats = { transactions: 0, entries: 0, lastLagMs: null, errors: 0 };
  }

  enqueue(
    wallet: string,
    signature: string,
    slot: number,
    { save = true }: EnqueueOptions = {}
  ): void {
    const key = `${wallet}:${signature}`;
    const walletState = this.store.data.wallets[wallet];
    if (!this.running || !walletState || slot <= walletState.baselineSlot) return;
    if (this.store.data.seen[key] || this.store.data.pending[key]) return;
    if (Object.keys(this.store.data.pending).length >= this.options.maxPendingTransactions) {
      throw new Error("Wallet queue is full; entry monitoring is degraded");
    }
    this.store.data.pending[key] = {
      wallet,
      signature,
      slot,
      queuedAt: Date.now(),
      retryAt: 0,
      failures: 0,
    };
    if (save) this.store.save();
  }

  healthy(): boolean {
    const wallets = this.wallets().wallets.filter((w) => !w.type || w.type === "lp");
    return (
      wallets.length >= this.options.walletThreshold &&
      wallets.every((w) => {
        const state = this.store.data.wallets[w.address];
        return (
          state &&
          !state.error &&
          Date.now() - state.reconciledAt < this.options.reconcileSec * 3000
        );
      })
    );
  }

  async start(): Promise<void> {
    this.running = true;
    this.ws = connection(
      this.options.monitorRpcUrl || config.pnl.rpcUrl || "",
      this.options.monitorWsUrl ?? undefined
    );
    await this.reconcile();
    this.reconcileTimer = setInterval(() => {
      void this.reconcile();
    }, this.options.reconcileSec * 1000);
    this.queueTimer = setInterval(() => {
      void this.drain();
    }, 1000);
  }

  async reconcile(): Promise<void> {
    if (!this.running || this.reconciling) return;
    this.reconciling = true;
    try {
      const wallets = this.wallets().wallets.filter((w) => !w.type || w.type === "lp");
      const addresses = new Set(wallets.map((w) => w.address));

      for (const [address, id] of this.subscriptions) {
        if (!addresses.has(address)) {
          if (this.ws) {
            await this.ws.removeOnLogsListener(id).catch(() => {});
          }
          this.subscriptions.delete(address);
        }
      }

      for (const address of Object.keys(this.store.data.wallets)) {
        if (!addresses.has(address)) {
          delete this.store.data.wallets[address];
          this.store.data.events = this.store.data.events.filter((e) => e.wallet !== address);
        }
      }

      for (const w of wallets) {
        if (!this.running) break;
        try {
          if (!this.store.data.wallets[w.address]) {
            const baselineSlot = await this.rpc("monitor", (c) => c.getSlot("confirmed"));
            const rawPortfolio: unknown = await fetchJson(
              `https://dlmm.datapi.meteora.ag/portfolio/open?user=${w.address}`
            );
            const parsedPortfolio = MeteoraPortfolioResponseSchema.safeParse(rawPortfolio);
            if (!parsedPortfolio.success || !Array.isArray(parsedPortfolio.data.pools)) {
              throw new Error("Unexpected Meteora portfolio response");
            }
            this.store.data.wallets[w.address] = {
              baselineSlot,
              cursor: null,
              baselinePools: parsedPortfolio.data.pools.map((p) => p.poolAddress),
              reconciledAt: 0,
              error: null,
            };
            this.store.save();
          }

          if (this.ws && !this.subscriptions.has(w.address)) {
            const id = this.ws.onLogs(
              new PublicKey(w.address),
              (event, context) => {
                if (event.err) return;
                try {
                  this.enqueue(w.address, event.signature, context.slot);
                } catch (e: unknown) {
                  const state = this.store.data.wallets[w.address];
                  if (state) {
                    state.error = e instanceof Error ? e.message : String(e);
                    this.store.save();
                  }
                }
              },
              "confirmed"
            );
            this.subscriptions.set(w.address, id);
          }

          const state = this.store.data.wallets[w.address];
          if (!state) continue;

          let before: string | undefined;
          let newest: string | undefined;
          let complete = false;
          const found: Array<{ signature: string; slot: number; blockTime?: number | null }> = [];

          for (let page = 0; page < 10; page++) {
            const signatures = await this.rpc("monitor", (c) =>
              c.getSignaturesForAddress(
                new PublicKey(w.address),
                { limit: 100, ...(before ? { before } : {}) },
                "confirmed"
              )
            );
            if (!newest && signatures.length > 0 && signatures[0]) {
              newest = signatures[0].signature;
            }
            for (const s of signatures) {
              if (
                s.signature === state.cursor ||
                s.slot <= state.baselineSlot ||
                (s.blockTime != null && Date.now() - s.blockTime * 1000 > this.options.windowSec * 1000)
              ) {
                complete = true;
                break;
              }
              if (!s.err) found.push(s);
            }
            if (complete || signatures.length < 100) {
              complete = true;
              break;
            }
            const lastSig = signatures.at(-1);
            if (lastSig) before = lastSig.signature;
          }

          if (!complete) {
            throw new Error(
              "Signature backfill limit reached; entries paused until history catches up"
            );
          }

          for (const s of found.reverse()) {
            this.enqueue(w.address, s.signature, s.slot, { save: false });
          }
          state.cursor = newest || state.cursor;
          state.error = null;
          state.reconciledAt = Date.now();
          this.store.save();
        } catch (e: unknown) {
          this.stats.errors++;
          const state = this.store.data.wallets[w.address];
          const msg = e instanceof Error ? e.message : String(e);
          if (state) {
            state.error = msg;
            this.store.save();
          }
          log("monitor_warn", `Wallet ${w.address.slice(0, 8)}: ${msg}`);
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  async drain(): Promise<void> {
    if (!this.running || this.draining) return;
    this.draining = true;
    let dirty = false;
    try {
      const pendingEntries = Object.entries(this.store.data.pending).slice(0, 20);
      for (const [key, pending] of pendingEntries) {
        if (!this.running) break;
        if (pending.retryAt > Date.now()) continue;
        dirty = true;
        try {
          if (
            !this.store.data.wallets[pending.wallet] ||
            Date.now() - pending.queuedAt > this.options.windowSec * 1000 ||
            (pending.failures ?? 0) >= 3
          ) {
            delete this.store.data.pending[key];
            continue;
          }

          const tx = await this.rpc("monitor", (c) =>
            c.getTransaction(pending.signature, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            })
          );
          if (!tx) throw new Error("Confirmed transaction not yet available");
          this.stats.transactions++;
          const events = await this.entries(tx, pending.signature, pending.wallet, this.options);
          this.stats.entries += events.length;
          if (events.length && tx.blockTime != null) {
            this.stats.lastLagMs = Date.now() - tx.blockTime * 1000;
          }
          this.store.data.seen[key] = Date.now();
          delete this.store.data.pending[key];
          const signals = acceptEvents(this.store, events, this.options);
          for (const signal of signals) {
            this.onSignal(signal);
          }
        } catch {
          pending.failures = (pending.failures ?? 0) + 1;
          pending.retryAt =
            Date.now() + Math.min(15_000, 1000 * 2 ** Math.min(pending.failures, 4));
          this.stats.errors++;
        }
      }
      if (dirty) this.store.save();
    } finally {
      this.draining = false;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.queueTimer) clearInterval(this.queueTimer);
    if (this.ws) {
      await Promise.allSettled(
        [...this.subscriptions.values()].map((id) => this.ws?.removeOnLogsListener(id))
      );
    }
    this.subscriptions.clear();
  }
}
