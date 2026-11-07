/** Standalone setup: write public settings; secrets stay in user's environment. */
// 100% Strict TypeScript, Oracle Engineering Standards: Zero any, Zero unsafe assertions.
import readline from "node:readline/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { repoPath } from "./repo-root.js";

export interface SetupOptions {
  configFile?: string;
  exampleFile?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const rl = readline.createInterface({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
  });
  try {
    const file = options.configFile ?? repoPath("user-config.json");
    const examplePath = options.exampleFile ?? repoPath("user-config.example.json");
    const defaultsRaw: unknown = JSON.parse(fs.readFileSync(examplePath, "utf8"));
    const defaults =
      typeof defaultsRaw === "object" && defaultsRaw !== null
        ? { ...(defaultsRaw as Record<string, unknown>) }
        : {};
    delete defaults["_readme"];

    const priorRaw: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    const prior =
      typeof priorRaw === "object" && priorRaw !== null
        ? (priorRaw as Record<string, unknown>)
        : {};

    const next: Record<string, unknown> = { ...defaults, ...prior };
    console.log("Meridian standalone setup. Existing settings retained on Enter.");
    const wallet = (await rl.question("Public wallet address (blank to use WALLET_PRIVATE_KEY): ")).trim();
    if (wallet) next["walletAddress"] = new PublicKey(wallet).toBase58();
    const rpc = (await rl.question("RPC URL (blank to retain settings / use RPC_URL from the environment): ")).trim();
    if (rpc) {
      const parsed = new URL(rpc);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("RPC URL must use HTTP or HTTPS");
      next["rpcUrl"] = rpc;
    }
    next["shadowMode"] = true;
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    console.log("Saved user-config.json in shadow mode.");
    console.log("Add LP wallets with: node cli.js wallets add --wallet ADDRESS --name NAME");
    console.log("Set WALLET_PRIVATE_KEY in your environment for live signing; no LLM or Helius Wallet API key is needed.");
    console.log("Review user-config.json, then run npm start.");
  } finally {
    rl.close();
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  await runSetup();
}
