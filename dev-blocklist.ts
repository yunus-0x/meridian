/**
 * Dev (deployer) blocklist — deployer wallet addresses that should never be deployed into.
 *
 * Agent/user can add deployers via Telegram ("block deployer").
 * Screening hard-filters any pool whose base token was deployed by a blocked wallet
 * before focused screening can approve the token.
 */

import fs from "node:fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import {
  DevBlocklistDbSchema,
  type DevBlocklistDb,
  type BlockedDevEntry,
} from "./src/schemas/storage.js";

export { DevBlocklistDbSchema };
export type { DevBlocklistDb, BlockedDevEntry };

const BLOCKLIST_FILE: string = repoPath("dev-blocklist.json");

function load(): DevBlocklistDb {
  if (!fs.existsSync(BLOCKLIST_FILE)) return {};
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(BLOCKLIST_FILE, "utf8"));
    return DevBlocklistDbSchema.parse(raw);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log("dev_blocklist_error", `Invalid ${BLOCKLIST_FILE}: ${msg}`);
    throw new Error(`Safety blocklist is unreadable: ${BLOCKLIST_FILE}`);
  }
}

function save(data: DevBlocklistDb): void {
  const validated = DevBlocklistDbSchema.parse(data);
  fs.writeFileSync(BLOCKLIST_FILE, JSON.stringify(validated, null, 2));
}

export function isDevBlocked(devWallet?: string | null): boolean {
  if (!devWallet) return false;
  return Boolean(load()[devWallet]);
}

export function getBlockedDevs(): DevBlocklistDb {
  return load();
}

export interface BlockDevInput {
  wallet?: string;
  reason?: string;
  label?: string;
}

export type BlockDevResult =
  | { error: string }
  | { already_blocked: true; wallet: string; label: string; reason: string }
  | { blocked: true; wallet: string; label: string; reason: string };

export function blockDev({ wallet, reason, label }: BlockDevInput): BlockDevResult {
  if (!wallet) return { error: "wallet required" };
  const db = load();
  const existing = db[wallet];
  if (existing) {
    return { already_blocked: true, wallet, label: existing.label, reason: existing.reason };
  }
  const entry: BlockedDevEntry = {
    label: label || "unknown",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
  };
  db[wallet] = entry;
  save(db);
  log("dev_blocklist", `Blocked deployer ${label || wallet}: ${reason || "no reason provided"}`);
  return { blocked: true, wallet, label: entry.label, reason: entry.reason };
}

export interface UnblockDevInput {
  wallet?: string;
}

export type UnblockDevResult =
  | { error: string }
  | { unblocked: true; wallet: string; was: BlockedDevEntry };

export function unblockDev({ wallet }: UnblockDevInput): UnblockDevResult {
  if (!wallet) return { error: "wallet required" };
  const db = load();
  const entry = db[wallet];
  if (!entry) return { error: `Wallet ${wallet} not on dev blocklist` };
  delete db[wallet];
  save(db);
  log("dev_blocklist", `Removed deployer ${entry.label || wallet} from blocklist`);
  return { unblocked: true, wallet, was: entry };
}

export interface ListBlockedDevsResult {
  count: number;
  blocked_devs: Array<BlockedDevEntry & { wallet: string }>;
}

export function listBlockedDevs(): ListBlockedDevsResult {
  const db = load();
  const entries: Array<BlockedDevEntry & { wallet: string }> = Object.entries(db).map(
    ([wallet, info]) => ({ wallet, ...info })
  );
  return { count: entries.length, blocked_devs: entries };
}
