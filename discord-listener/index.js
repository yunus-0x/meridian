/**
 * meridian Discord listener — selfbot
 * Watches LP Army channels for Solana addresses and runs pre-check pipeline.
 * Uses discord.js-selfbot-v13 (personal automation, not a bot token).
 *
 * Env vars (from ../.env):
 *   DISCORD_USER_TOKEN     — your Discord account token (from browser DevTools)
 *   DISCORD_GUILD_ID       — LP Army server ID
 *   DISCORD_CHANNEL_IDS    — comma-separated channel IDs to monitor
 *   DISCORD_MIN_FEES_SOL   — minimum pool fees threshold (default: 5)
 */
import { Client } from "discord.js-selfbot-v13";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

// Load .env from parent directory (meridian root)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const dotenv = require("dotenv");
dotenv.config({ path: path.join(ROOT, ".env") });

import { runPreChecks } from "./pre-checks.js";

const SIGNALS_FILE = path.join(process.env.DATA_DIR || ROOT, "discord-signals.json");

// Solana address regex: base58, 32-44 chars
const SOL_ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

// Known non-address patterns to skip (short common words that match base58 range)
const FALSE_POSITIVE_SKIP = new Set([
  "solana", "meteora", "jupiter", "raydium", "orca",
]);

function isLikelySolanaAddress(str) {
  if (str.length < 32 || str.length > 44) return false;
  if (FALSE_POSITIVE_SKIP.has(str.toLowerCase())) return false;
  // Must contain digits (pure alpha strings are usually words)
  if (!/\d/.test(str)) return false;
  return true;
}

function loadSignals() {
  if (!fs.existsSync(SIGNALS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SIGNALS_FILE, "utf8")); } catch { return []; }
}

function saveSignal(record) {
  const signals = loadSignals();
  signals.unshift(record); // newest first
  // Keep last 100 signals
  fs.writeFileSync(SIGNALS_FILE, JSON.stringify(signals.slice(0, 100), null, 2));
}

async function processAddress(address, message) {
  const result = await runPreChecks(address);
  if (!result.pass) return;

  const record = {
    id: `${address.slice(0, 8)}-${Date.now()}`,
    pool_address: result.pool_address,
    base_mint: result.base_mint,
    base_symbol: result.symbol || "?",
    signal_source: "discord",
    discord_guild: message.guild?.name || "unknown",
    discord_channel: message.channel?.name || "unknown",
    discord_author: message.author?.username || "unknown",
    discord_message_snippet: message.content?.slice(0, 120) || "",
    queued_at: new Date().toISOString(),
    rug_score: result.rug_score ?? null,
    total_fees_sol: result.total_fees_sol ?? null,
    token_age_minutes: result.token_age_minutes ?? null,
    status: "pending",
  };

  saveSignal(record);
  console.log(`\n[QUEUED] ${record.base_symbol} → ${record.pool_address}`);
  console.log(`  from: @${record.discord_author} in #${record.discord_channel}`);
  console.log(`  → Check with: node ../cli.js discord-signals`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const TOKEN = process.env.DISCORD_USER_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CHANNEL_IDS = (process.env.DISCORD_CHANNEL_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

if (!TOKEN) {
  console.error("ERROR: DISCORD_USER_TOKEN not set in ../.env");
  process.exit(1);
}
if (!GUILD_ID) {
  console.error("ERROR: DISCORD_GUILD_ID not set in ../.env");
  process.exit(1);
}
if (CHANNEL_IDS.length === 0) {
  console.error("ERROR: DISCORD_CHANNEL_IDS not set in ../.env (comma-separated channel IDs)");
  process.exit(1);
}

const client = new Client({ checkUpdate: false });

client.on("ready", () => {
  console.log(`\n[meridian discord-listener] Connected as ${client.user?.tag}`);
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.warn(`WARNING: Guild ${GUILD_ID} not found in cache. Check DISCORD_GUILD_ID.`);
  } else {
    console.log(`Watching guild: ${guild.name}`);
    const channelNames = CHANNEL_IDS.map(id => {
      const ch = guild.channels.cache.get(id);
      return ch ? `#${ch.name}` : `#${id} (not found)`;
    });
    console.log(`Channels: ${channelNames.join(", ")}`);
  }
  console.log(`\nStreaming messages... (Ctrl+C to stop)\n`);
});

client.on("messageCreate", async (message) => {
  // Only process messages from configured guild + channels
  if (message.guildId !== GUILD_ID) return;
  if (!CHANNEL_IDS.includes(message.channelId)) return;
  // Skip own messages
  if (message.author?.id === client.user?.id) return;
  // Only process messages from Metlex Pool Bot
  if (message.author?.username !== "Metlex Pool Bot") return;

  const content = message.content || "";
  const embeds = message.embeds?.map(e => `${e.title || ""} ${e.description || ""}`).join(" ") || "";
  const fullText = `${content} ${embeds}`;

  const matches = [...fullText.matchAll(SOL_ADDR_RE)].map(m => m[0]);
  const unique = [...new Set(matches)].filter(isLikelySolanaAddress);

  if (unique.length === 0) return;

  console.log(`\n[message] @${message.author?.username} in #${message.channel?.name}: "${content.slice(0, 80)}"`);
  console.log(`  Addresses found: ${unique.join(", ")}`);

  // Process each address independently (don't await — handle concurrently but logged sequentially)
  for (const addr of unique) {
    await processAddress(addr, message);
  }
});

client.on("error", (err) => {
  console.error("[discord error]", err.message);
});

client.login(TOKEN);
