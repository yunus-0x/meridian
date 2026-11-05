import fs from 'node:fs';
import { repoPath } from '../repo-root.js';

export class MonitorStore {
  constructor(file = repoPath('wallet-monitor-state.json')) {
    this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
      version: 1, wallets: {}, pending: {}, seen: {}, events: [], signals: {}, attempts: {}, paused: false,
    };
    if (this.data.version !== 1 || !this.data.wallets || !this.data.attempts || !Array.isArray(this.data.events)) throw new Error('Invalid monitor state; refusing to discard recovery history');
  }
  save() {
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  prune(now = Date.now()) {
    this.data.events = this.data.events.filter(e => now - e.at < 10 * 60_000);
    for (const [key, at] of Object.entries(this.data.seen)) if (now - at > 24 * 3600_000) delete this.data.seen[key];
    for (const [mint, s] of Object.entries(this.data.signals)) if (s.done && now - s.createdAt > 24 * 3600_000) delete this.data.signals[mint];
    // Attempt records double as mint-level duplicate protection; a day matches
    // the pool-memory cooldown horizon. Never prune mid-submit checkpoints.
    for (const [mint, a] of Object.entries(this.data.attempts)) if (a.status !== "submitting" && now - a.at > 24 * 3600_000) delete this.data.attempts[mint];
  }
}
export function qualifyingEvents(events, mint, options, now = Date.now()) {
  const latest = new Map();
  for (const e of events) {
    if (e.mint !== mint || e.at > now || now - e.at > options.windowSec * 1000 || e.depositSol < options.minDepositSol) continue;
    const group = options.walletGroups[e.wallet] || e.wallet;
    if (!latest.has(group) || latest.get(group).at < e.at) latest.set(group, e);
  }
  return [...latest.values()];
}
export function acceptEvents(store, events, options, now = Date.now()) {
  for (const e of events) {
    if (!store.data.events.some(old => old.id === e.id)) store.data.events.push(e);
  }
  const triggered = [];
  for (const mint of new Set(events.map(e => e.mint))) {
    const existing = store.data.signals[mint];
    const recent = qualifyingEvents(store.data.events, mint, options, now);
    if (existing && (!existing.done || now < existing.cooldownUntil)) continue;
    // A completed signal cannot be reused after its cooldown.
    const fresh = recent.filter(e => !existing || e.at > existing.closedAt);
    if (fresh.length < options.walletThreshold) continue;
    const signal = { mint, createdAt: now, deadline: now + options.screeningDeadlineSec * 1000, nextCheck: now, events: fresh, done: false };
    store.data.signals[mint] = signal;
    triggered.push(signal);
  }
  store.prune(now);
  store.save();
  return triggered;
}
export function finishSignal(store, signal, reason, options = {}, now = Date.now()) {
  const cooldownSec = options?.cooldownSec ?? 300;
  Object.assign(signal, { done: true, reason, closedAt: now, cooldownUntil: now + cooldownSec * 1000 });
  store.save();
}
