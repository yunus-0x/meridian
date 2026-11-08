import fs from "node:fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import {
  SmartWalletSchema,
  SmartWalletsDbSchema,
  type SmartWallet,
  type SmartWalletsDb,
} from "./src/schemas/storage.js";
import { SolAddressSchema } from "./src/schemas/common.js";

export { SmartWalletSchema, SmartWalletsDbSchema };
export type { SmartWallet, SmartWalletsDb };

const WALLETS_PATH: string = repoPath("smart-wallets.json");
export const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function loadWallets(): SmartWalletsDb {
  if (!fs.existsSync(WALLETS_PATH)) return { wallets: [] };
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8"));
    const parsed = SmartWalletsDbSchema.safeParse(raw);
    if (!parsed.success) {
      log("smart_wallets_warn", `Invalid ${WALLETS_PATH}: schema validation failed`);
      return { wallets: [] };
    }
    return parsed.data;
  } catch {
    return { wallets: [] };
  }
}

function saveWallets(data: SmartWalletsDb): void {
  const validated = SmartWalletsDbSchema.parse(data);
  fs.writeFileSync(WALLETS_PATH, JSON.stringify(validated, null, 2));
}

export interface AddSmartWalletInput {
  name: string;
  address?: string | null;
  category?: string;
  type?: string;
}

export type AddSmartWalletResult =
  | { success: true; wallet: { name: string; address: string; category: string; type: string } }
  | { success: false; error: string };

export function addSmartWallet({
  name,
  address,
  category = "alpha",
  type = "lp",
}: AddSmartWalletInput): AddSmartWalletResult {
  if (!address || !SolAddressSchema.safeParse(address).success) {
    return { success: false, error: "Invalid Solana address format" };
  }
  const data = loadWallets();
  const existing = data.wallets.find((w) => w.address === address);
  if (existing) {
    return { success: false, error: `Already tracked as "${existing.name}"` };
  }
  const entry: SmartWallet = {
    name,
    address,
    category,
    type: type === "trader" ? "trader" : "lp",
    addedAt: new Date().toISOString(),
  };
  data.wallets.push(entry);
  saveWallets(data);
  log("smart_wallets", `Added wallet: ${name} (${category}, type=${type})`);
  return { success: true, wallet: { name, address, category, type: entry.type } };
}

export interface RemoveSmartWalletInput {
  address: string;
}

export type RemoveSmartWalletResult =
  | { success: true; removed: string }
  | { success: false; error: string };

export function removeSmartWallet({ address }: RemoveSmartWalletInput): RemoveSmartWalletResult {
  const data = loadWallets();
  const wallet = data.wallets.find((w) => w.address === address);
  if (!wallet) return { success: false, error: "Wallet not found" };
  data.wallets = data.wallets.filter((w) => w.address !== address);
  saveWallets(data);
  log("smart_wallets", `Removed wallet: ${wallet.name}`);
  return { success: true, removed: wallet.name };
}

export interface ListSmartWalletsResult {
  total: number;
  wallets: SmartWallet[];
}

export function listSmartWallets(): ListSmartWalletsResult {
  const { wallets } = loadWallets();
  return { total: wallets.length, wallets };
}
