/**
 * Token blacklist — mints the agent should never deploy into.
 *
 * Agent can blacklist via Telegram ("blacklist token, rugged").
 * Focused screening rejects blacklisted tokens before entry.
 */

import fs from "node:fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import {
  BlacklistDbSchema,
  BlacklistEntrySchema,
  type BlacklistDb,
  type BlacklistEntry,
} from "./src/schemas/storage.js";

export { BlacklistDbSchema, BlacklistEntrySchema };
export type { BlacklistDb, BlacklistEntry };

const BLACKLIST_FILE: string = repoPath("token-blacklist.json");

function load(): BlacklistDb {
  if (!fs.existsSync(BLACKLIST_FILE)) return {};
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf8"));
    return BlacklistDbSchema.parse(raw);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log("blacklist_error", `Invalid ${BLACKLIST_FILE}: ${msg}`);
    throw new Error(`Safety blacklist is unreadable: ${BLACKLIST_FILE}`);
  }
}

function save(data: BlacklistDb): void {
  const validated = BlacklistDbSchema.parse(data);
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(validated, null, 2));
}

/**
 * Returns true if mint is on the blacklist.
 * Used in standalone/screening.js before entry.
 */
export function isBlacklisted(mint?: string | null): boolean {
  if (!mint) return false;
  return Boolean(load()[mint]);
}

export interface AddToBlacklistInput {
  mint?: string;
  symbol?: string;
  reason?: string;
}

export type AddToBlacklistResult =
  | { error: string }
  | { already_blacklisted: true; mint: string; symbol: string; reason: string }
  | { blacklisted: true; mint: string; symbol: string; reason: string };

/**
 * Tool handler: add_to_blacklist
 */
export function addToBlacklist({ mint, symbol, reason }: AddToBlacklistInput): AddToBlacklistResult {
  if (!mint) return { error: "mint required" };
  const db = load();
  const existing = db[mint];
  if (existing) {
    return {
      already_blacklisted: true,
      mint,
      symbol: existing.symbol,
      reason: existing.reason,
    };
  }
  const entry: BlacklistEntry = {
    symbol: symbol || "UNKNOWN",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
    added_by: "agent",
  };
  db[mint] = entry;
  save(db);
  log("blacklist", `Blacklisted ${symbol || mint}: ${reason || "no reason provided"}`);
  return { blacklisted: true, mint, symbol: entry.symbol, reason: entry.reason };
}

export interface RemoveFromBlacklistInput {
  mint?: string;
}

export type RemoveFromBlacklistResult =
  | { error: string }
  | { removed: true; mint: string; was: BlacklistEntry };

/**
 * Tool handler: remove_from_blacklist
 */
export function removeFromBlacklist({ mint }: RemoveFromBlacklistInput): RemoveFromBlacklistResult {
  if (!mint) return { error: "mint required" };
  const db = load();
  const entry = db[mint];
  if (!entry) return { error: `Mint ${mint} not found on blacklist` };
  delete db[mint];
  save(db);
  log("blacklist", `Removed ${entry.symbol || mint} from blacklist`);
  return { removed: true, mint, was: entry };
}

export interface ListBlacklistResult {
  count: number;
  blacklist: Array<BlacklistEntry & { mint: string }>;
}

/**
 * Tool handler: list_blacklist
 */
export function listBlacklist(): ListBlacklistResult {
  const db = load();
  const entries: Array<BlacklistEntry & { mint: string }> = Object.entries(db).map(([mint, info]) => ({
    mint,
    ...info,
  }));
  return {
    count: entries.length,
    blacklist: entries,
  };
}
