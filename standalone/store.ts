// standalone/store.ts — MonitorState persistence, pruning, and convergence detection
// Oracle System Strict Mode: Zero any, Zero unsafe assertions, Domain Purity, DRY z.infer schemas.

import fs from "node:fs";
import { repoPath } from "../repo-root.js";
import {
  MonitorStateSchema,
  type MonitorState,
  type MonitorEvent,
  type MonitorSignal,
} from "../src/schemas/storage.js";

export { MonitorStateSchema };
export type { MonitorState, MonitorEvent, MonitorSignal };

export interface QualifyingEventsOptions {
  windowSec: number;
  minDepositSol: number;
  walletGroups?: Record<string, string>;
  [key: string]: unknown;
}

export interface AcceptEventsOptions extends QualifyingEventsOptions {
  walletThreshold: number;
  screeningDeadlineSec: number;
  cooldownSec?: number;
}

export interface FinishSignalOptions {
  cooldownSec?: number;
  [key: string]: unknown;
}

export class MonitorStore {
  readonly file: string;
  data: MonitorState;

  constructor(file: string = repoPath("wallet-monitor-state.json")) {
    this.file = file;

    if (fs.existsSync(file)) {
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (err: unknown) {
        throw new Error("Invalid monitor state; refusing to discard recovery history");
      }

      const parsed = MonitorStateSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error("Invalid monitor state; refusing to discard recovery history");
      }
      this.data = parsed.data;
    } else {
      this.data = {
        version: 1,
        wallets: {},
        pending: {},
        seen: {},
        events: [],
        signals: {},
        attempts: {},
        paused: false,
      };
    }

    this.prune();
  }

  /**
   * Atomically save validated monitor state to disk via temp file.
   * Mode 0o600 ensures POSIX-compliant private file permissions.
   */
  save(): void {
    const validated = MonitorStateSchema.parse(this.data);
    const tmpFile = `${this.file}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(validated, null, 2), { mode: 0o600 });
    fs.renameSync(tmpFile, this.file);
  }

  /**
   * Prune stale events, seen transactions, expired signals, and old attempts.
   * Attempt records with status === 'submitting' are NEVER pruned (mid-submit safety).
   */
  prune(now: number = Date.now()): void {
    this.data.events = this.data.events.filter((e) => now - e.at < 10 * 60_000);

    for (const [key, at] of Object.entries(this.data.seen)) {
      if (now - at > 2 * 3600_000) {
        delete this.data.seen[key];
      }
    }

    const seenEntries = Object.entries(this.data.seen);
    if (seenEntries.length > 5000) {
      seenEntries.sort((a, b) => b[1] - a[1]);
      this.data.seen = Object.fromEntries(seenEntries.slice(0, 5000));
    }

    for (const [mint, s] of Object.entries(this.data.signals)) {
      if (!s.done && now > s.deadline) {
        s.done = true;
        s.reason = s.reason || "expired";
        s.closedAt = now;
      }
      if (s.done && now - s.createdAt > 24 * 3600_000) {
        delete this.data.signals[mint];
      }
    }

    // Attempt records double as mint-level duplicate protection; 24h matches
    // the pool-memory cooldown horizon. Never prune mid-submit checkpoints.
    for (const [mint, a] of Object.entries(this.data.attempts)) {
      if (a.status !== "submitting" && now - a.at > 24 * 3600_000) {
        delete this.data.attempts[mint];
      }
    }
  }
}

/**
 * Filter events for a specific mint that satisfy window, deposit size, and dedup by wallet/group.
 */
export function qualifyingEvents(
  events: readonly MonitorEvent[],
  mint: string,
  options: QualifyingEventsOptions,
  now: number = Date.now()
): MonitorEvent[] {
  const latest = new Map<string, MonitorEvent>();

  for (const e of events) {
    if (
      e.mint !== mint ||
      e.at > now ||
      now - e.at > options.windowSec * 1000 ||
      e.depositSol < options.minDepositSol
    ) {
      continue;
    }

    const group = options.walletGroups?.[e.wallet] || e.wallet;
    const existing = latest.get(group);
    if (!existing || existing.at < e.at) {
      latest.set(group, e);
    }
  }

  return [...latest.values()];
}

/**
 * Accept newly discovered events, deduplicate against store, and generate convergence signals.
 */
export function acceptEvents(
  store: MonitorStore,
  events: readonly MonitorEvent[],
  options: AcceptEventsOptions,
  now: number = Date.now()
): MonitorSignal[] {
  for (const e of events) {
    if (!store.data.events.some((old) => old.id === e.id)) {
      store.data.events.push(e);
    }
  }

  const triggered: MonitorSignal[] = [];
  const uniqueMints = new Set(events.map((e) => e.mint));

  for (const mint of uniqueMints) {
    const existing = store.data.signals[mint];
    const recent = qualifyingEvents(store.data.events, mint, options, now);

    if (existing && (!existing.done || (existing.cooldownUntil != null && now < existing.cooldownUntil))) {
      continue;
    }

    // A completed signal cannot be reused after its cooldown.
    const fresh = recent.filter(
      (e) => !existing || (existing.closedAt != null && e.at > existing.closedAt)
    );

    if (fresh.length < options.walletThreshold) {
      continue;
    }

    const signal: MonitorSignal = {
      mint,
      createdAt: now,
      deadline: now + options.screeningDeadlineSec * 1000,
      nextCheck: now,
      events: fresh,
      done: false,
    };

    store.data.signals[mint] = signal;
    triggered.push(signal);
  }

  store.prune(now);
  store.save();
  return triggered;
}

/**
 * Mark an active signal as finished with reason, recording close timestamp and cooldown horizon.
 */
export function finishSignal(
  store: MonitorStore,
  signal: MonitorSignal,
  reason: string,
  options: FinishSignalOptions = {},
  now: number = Date.now()
): void {
  const cooldownSec = options?.cooldownSec ?? 300;
  signal.done = true;
  signal.reason = reason;
  signal.closedAt = now;
  signal.cooldownUntil = now + cooldownSec * 1000;
  store.save();
}
