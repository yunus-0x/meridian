/**
 * Dev (deployer) blocklist — deployer wallet addresses that should never be deployed into.
 *
 * Agent/user can add deployers via Telegram ("block this deployer").
 * Screening hard-filters any pool whose base token was deployed by a blocked wallet
 * before the pool list reaches the LLM.
 */

import fs from "fs";
import { log } from "./logger.js";

const BLOCKLIST_FILE = `${process.env.DATA_DIR || "."}/dev-blocklist.json`;

function load() {
  if (!fs.existsSync(BLOCKLIST_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BLOCKLIST_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(BLOCKLIST_FILE, JSON.stringify(data, null, 2));
}

export function isDevBlocked(devWallet) {
  if (!devWallet) return false;
  return !!load()[devWallet];
}

export function getBlockedDevs() {
  return load();
}

export function blockDev({ wallet, reason, label }) {
  if (!wallet) return { error: "wallet required" };
  const db = load();
  if (db[wallet]) return { already_blocked: true, wallet, label: db[wallet].label, reason: db[wallet].reason };
  db[wallet] = {
    label: label || "unknown",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
  };
  save(db);
  log("dev_blocklist", `Blocked deployer ${label || wallet}: ${reason}`);
  return { blocked: true, wallet, label, reason };
}

export function unblockDev({ wallet }) {
  if (!wallet) return { error: "wallet required" };
  const db = load();
  if (!db[wallet]) return { error: `Wallet ${wallet} not on dev blocklist` };
  const entry = db[wallet];
  delete db[wallet];
  save(db);
  log("dev_blocklist", `Removed deployer ${entry.label || wallet} from blocklist`);
  return { unblocked: true, wallet, was: entry };
}

export function listBlockedDevs() {
  const db = load();
  const entries = Object.entries(db).map(([wallet, info]) => ({ wallet, ...info }));
  return { count: entries.length, blocked_devs: entries };
}
