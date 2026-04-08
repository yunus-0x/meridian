#!/usr/bin/env node
/**
 * meridian — Solana DLMM LP Agent CLI
 * Direct tool invocation with JSON output. Agent-native.
 */

import "dotenv/config";
import { parseArgs } from "util";
import os from "os";
import fs from "fs";
import path from "path";

// ─── DRY_RUN must be set before any tool imports ─────────────────
if (process.argv.includes("--dry-run")) process.env.DRY_RUN = "true";

// ─── Load .env from ~/.meridian/ if present ──────────────────────
const meridianDir = path.join(os.homedir(), ".meridian");
const meridianEnv = path.join(meridianDir, ".env");
if (fs.existsSync(meridianEnv)) {
  const { config: loadDotenv } = await import("dotenv");
  loadDotenv({ path: meridianEnv, override: false });
}

// ─── Output helpers ───────────────────────────────────────────────
function out(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function die(msg, extra = {}) {
  process.stderr.write(JSON.stringify({ error: msg, ...extra }) + "\n");
  process.exit(1);
}

// ─── SKILL.md generation ──────────────────────────────────────────
const SKILL_MD = `# meridian — Solana DLMM LP Agent CLI

Data dir: ~/.meridian/

## Commands

### meridian balance
Returns wallet SOL and token balances.
\`\`\`
Output: { wallet, sol, sol_usd, usdc, tokens: [{mint, symbol, balance, usd_value}], total_usd }
\`\`\`

### meridian positions
Returns all open DLMM positions.
\`\`\`
Output: { positions: [{position, pool, pair, in_range, age_minutes, ...}], total_positions }
\`\`\`

### meridian pnl <position_address>
Returns PnL for a specific position.
\`\`\`
Output: { pnl_pct, pnl_usd, unclaimed_fee_usd, all_time_fees_usd, current_value_usd, lower_bin, upper_bin, active_bin }
\`\`\`

### meridian screen [--dry-run] [--silent]
Runs one AI screening cycle to find and deploy new positions.
\`\`\`
Output: { done: true, report: "..." }
\`\`\`

### meridian manage [--dry-run] [--silent]
Runs one AI management cycle over open positions.
\`\`\`
Output: { done: true, report: "..." }
\`\`\`

### meridian deploy --pool <addr> --amount <sol> [--bins-below 69] [--bins-above 0] [--strategy bid_ask|spot] [--dry-run]
Deploys a new LP position. All safety checks apply.
\`\`\`
Output: { success, position, pool_name, txs, price_range, range_coverage, bin_step }
\`\`\`

### meridian claim --position <addr>
Claims accumulated swap fees for a position.
\`\`\`
Output: { success, position, txs, base_mint }
\`\`\`

### meridian close --position <addr> [--skip-swap] [--dry-run]
Closes a position. Auto-swaps base token to SOL unless --skip-swap.
\`\`\`
Output: { success, pnl_pct, pnl_usd, txs, base_mint }
\`\`\`

### meridian swap --from <mint> --to <mint> --amount <n> [--dry-run]
Swaps tokens via Jupiter. Use "SOL" as mint shorthand.
\`\`\`
Output: { success, tx, input_amount, output_amount }
\`\`\`

### meridian candidates [--limit 5]
Returns top pool candidates fully enriched: pool metrics, token audit, holders, smart wallets, narrative, active bin, pool memory.
\`\`\`
Output: { candidates: [{name, pool, bin_step, fee_pct, volume, tvl, organic_score, active_bin, smart_wallets, token: {holders, audit, global_fees_sol, ...}, holders, narrative, pool_memory}] }
\`\`\`

### meridian config get
Returns the full runtime config.

### meridian config set <key> <value>
Updates a config key. Parses value as JSON when possible.
\`\`\`
Valid keys: minTvl, maxTvl, minVolume, maxPositions, deployAmountSol, managementIntervalMin, screeningIntervalMin, managementModel, screeningModel, generalModel, autoSwapAfterClaim, minClaimAmount, outOfRangeWaitMinutes
\`\`\`

### meridian start [--dry-run]
Starts the autonomous agent with cron jobs (management + screening).

## Flags
--dry-run     Skip all on-chain transactions
--silent      Suppress Telegram notifications for this run
`;

fs.mkdirSync(meridianDir, { recursive: true });
fs.writeFileSync(path.join(meridianDir, "SKILL.md"), SKILL_MD);

// ─── Parse args ───────────────────────────────────────────────────
const argv = process.argv.slice(2);
const subcommand = argv.find(a => !a.startsWith("-"));
const sub2 = argv.filter(a => !a.startsWith("-"))[1]; // for "config get/set"
const silent = argv.includes("--silent");

if (!subcommand || subcommand === "help" || argv.includes("--help")) {
  process.stdout.write(SKILL_MD);
  process.exit(0);
}

// ─── Parse flags ──────────────────────────────────────────────────
const { values: flags } = parseArgs({
  args: argv,
  options: {
    pool:       { type: "string" },
    amount:     { type: "string" },
    position:   { type: "string" },
    from:       { type: "string" },
    to:         { type: "string" },
    strategy:   { type: "string" },
    "bins-below": { type: "string" },
    "bins-above": { type: "string" },
    "skip-swap":  { type: "boolean" },
    "dry-run":    { type: "boolean" },
    "silent":     { type: "boolean" },
    limit:        { type: "string" },
  },
  allowPositionals: true,
  strict: false,
});

// ─── Commands ─────────────────────────────────────────────────────

switch (subcommand) {

  // ── balance ──────────────────────────────────────────────────────
  case "balance": {
    const { getWalletBalances } = await import("./tools/wallet.js");
    out(await getWalletBalances({}));
    break;
  }

  // ── positions ────────────────────────────────────────────────────
  case "positions": {
    const { getMyPositions } = await import("./tools/dlmm.js");
    out(await getMyPositions({ force: true }));
    break;
  }

  // ── pnl <position_address> ───────────────────────────────────────
  case "pnl": {
    const posAddr = argv.find((a, i) => !a.startsWith("-") && i > 0 && argv[i - 1] !== "--position" && a !== "pnl");
    const positionAddress = flags.position || posAddr;
    if (!positionAddress) die("Usage: meridian pnl <position_address>");

    const { getTrackedPosition } = await import("./state.js");
    const { getPositionPnl, getMyPositions } = await import("./tools/dlmm.js");

    let poolAddress;
    const tracked = getTrackedPosition(positionAddress);
    if (tracked?.pool) {
      poolAddress = tracked.pool;
    } else {
      // Fall back: scan positions to find pool
      const pos = await getMyPositions({ force: true });
      const found = pos.positions?.find(p => p.position === positionAddress);
      if (!found) die("Position not found", { position: positionAddress });
      poolAddress = found.pool;
    }

    out(await getPositionPnl({ pool_address: poolAddress, position_address: positionAddress }));
    break;
  }

  // ── candidates ───────────────────────────────────────────────────
  case "candidates": {
    const { getTopCandidates } = await import("./tools/screening.js");
    const { getActiveBin } = await import("./tools/dlmm.js");
    const { getTokenInfo, getTokenHolders, getTokenNarrative } = await import("./tools/token.js");
    const { checkSmartWalletsOnPool } = await import("./smart-wallets.js");
    const { recallForPool } = await import("./pool-memory.js");

    const limit = parseInt(flags.limit || "5");
    const raw = await getTopCandidates({ limit });
    const pools = raw.candidates || raw.pools || [];

    const enriched = [];
    for (const pool of pools) {
      const mint = pool.base?.mint;
      const [activeBin, smartWallets, tokenInfo, holders, narrative] = await Promise.allSettled([
        getActiveBin({ pool_address: pool.pool }),
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
        mint ? getTokenHolders({ mint }) : Promise.resolve(null),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      ]);
      const ti = tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null;
      enriched.push({
        pool: pool.pool,
        name: pool.name,
        bin_step: pool.bin_step,
        fee_pct: pool.fee_pct,
        fee_active_tvl_ratio: pool.fee_active_tvl_ratio,
        volume: pool.volume_window,
        tvl: pool.active_tvl,
        volatility: pool.volatility,
        mcap: pool.mcap,
        organic_score: pool.organic_score,
        active_pct: pool.active_pct,
        price_change_pct: pool.price_change_pct,
        active_bin: activeBin.status === "fulfilled" ? activeBin.value?.binId : null,
        smart_wallets: smartWallets.status === "fulfilled" ? (smartWallets.value?.in_pool || []).map(w => w.name) : [],
        token: {
          mint,
          symbol: pool.base?.symbol,
          holders: pool.holders,
          mcap: ti?.mcap,
          launchpad: ti?.launchpad,
          global_fees_sol: ti?.global_fees_sol,
          price_change_1h: ti?.stats_1h?.price_change,
          net_buyers_1h: ti?.stats_1h?.net_buyers,
          audit: {
            top10_pct: ti?.audit?.top_holders_pct,
            bots_pct: ti?.audit?.bot_holders_pct,
          },
        },
        holders: holders.status === "fulfilled" ? holders.value : null,
        narrative: narrative.status === "fulfilled" ? narrative.value?.narrative : null,
        pool_memory: recallForPool(pool.pool) || null,
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    out({ candidates: enriched, total_screened: raw.total_screened });
    break;
  }

  // ── deploy ───────────────────────────────────────────────────────
  case "deploy": {
    if (!flags.pool) die("Usage: meridian deploy --pool <addr> --amount <sol>");
    if (!flags.amount) die("--amount is required");

    const { executeTool } = await import("./tools/executor.js");
    out(await executeTool("deploy_position", {
      pool_address: flags.pool,
      amount_y: parseFloat(flags.amount),
      strategy: flags.strategy,
      bins_below: flags["bins-below"] ? parseInt(flags["bins-below"]) : undefined,
      bins_above: flags["bins-above"] ? parseInt(flags["bins-above"]) : undefined,
    }));
    break;
  }

  // ── claim ────────────────────────────────────────────────────────
  case "claim": {
    if (!flags.position) die("Usage: meridian claim --position <addr>");
    const { executeTool } = await import("./tools/executor.js");
    out(await executeTool("claim_fees", { position_address: flags.position }));
    break;
  }

  // ── close ────────────────────────────────────────────────────────
  case "close": {
    if (!flags.position) die("Usage: meridian close --position <addr>");
    const { executeTool } = await import("./tools/executor.js");
    out(await executeTool("close_position", {
      position_address: flags.position,
      skip_swap: flags["skip-swap"] ?? false,
    }));
    break;
  }

  // ── swap ─────────────────────────────────────────────────────────
  case "swap": {
    if (!flags.from || !flags.to || !flags.amount) die("Usage: meridian swap --from <mint> --to <mint> --amount <n>");
    const { executeTool } = await import("./tools/executor.js");
    out(await executeTool("swap_token", {
      input_mint: flags.from,
      output_mint: flags.to,
      amount: parseFloat(flags.amount),
    }));
    break;
  }

  // ── screen ───────────────────────────────────────────────────────
  case "screen": {
    const { runScreeningCycle } = await import("./index.js");
    const report = await runScreeningCycle({ silent });
    out({ done: true, report: report || "No action taken" });
    break;
  }

  // ── manage ───────────────────────────────────────────────────────
  case "manage": {
    const { runManagementCycle } = await import("./index.js");
    const report = await runManagementCycle({ silent });
    out({ done: true, report: report || "No action taken" });
    break;
  }

  // ── config ───────────────────────────────────────────────────────
  case "config": {
    if (sub2 === "get" || !sub2) {
      const { config } = await import("./config.js");
      out(config);
    } else if (sub2 === "set") {
      const key = argv.filter(a => !a.startsWith("-"))[2];
      const rawVal = argv.filter(a => !a.startsWith("-"))[3];
      if (!key || rawVal === undefined) die("Usage: meridian config set <key> <value>");
      let value = rawVal;
      try { value = JSON.parse(rawVal); } catch { /* keep as string */ }
      const { executeTool } = await import("./tools/executor.js");
      out(await executeTool("update_config", { changes: { [key]: value }, reason: "CLI config set" }));
    } else {
      die(`Unknown config subcommand: ${sub2}. Use: get, set`);
    }
    break;
  }

  // ── start ────────────────────────────────────────────────────────
  case "start": {
    const { startCronJobs } = await import("./index.js");
    process.stderr.write("[meridian] Starting autonomous agent...\n");
    startCronJobs();
    break;
  }

  default:
    die(`Unknown command: ${subcommand}. Run 'meridian help' for usage.`);
}
