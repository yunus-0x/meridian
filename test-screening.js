#!/usr/bin/env node
// Quick pipeline test — runs each stage, prints pass/fail per token
// Usage: node test-screening.js
import "dotenv/config";


import { config } from "./config.js";

// Force gmgn source + 5m indicator interval
config.gmgn.indicatorInterval = "5_MINUTE";
config.gmgn.indicatorFilter = true;

import { discoverGmgnPools } from "./tools/gmgn.js";

console.log("=== GMGN Screening Pipeline ===");
console.log(`minTvl: ${config.gmgn.minTvl ?? config.screening.minTvl}`);
console.log(`minHolders: ${config.gmgn.minHolders}`);
console.log(`minKol: ${config.gmgn.minKolCount}, requireKol: ${config.gmgn.requireKol}`);
console.log(`indicatorFilter: ${config.gmgn.indicatorFilter} @ ${config.gmgn.indicatorInterval}`);
console.log("================================\n");

const start = Date.now();
const result = await discoverGmgnPools({ limit: 5 });
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`\n=== RESULTS (${elapsed}s) ===`);
const sc = result.stage_counts || {};
console.log(`Ranked: ${result.total} → S1: ${sc.s1} → S2: ${sc.s2} → S3: ${sc.s3} → S4: ${sc.s4} → Final: ${sc.s5}\n`);

if (result.filtered_examples.length) {
  console.log("--- Filtered (examples) ---");
  for (const f of result.filtered_examples) {
    console.log(`  ✗ ${f.name}: ${f.reason}`);
  }
  console.log();
}

if (result.pools.length === 0) {
  console.log("No candidates passed.");
} else {
  console.log("--- Final Candidates ---");
  for (const p of result.pools) {
    console.log(`\n✓ ${p.name}`);
    console.log(`  pool:        ${p.pool}`);
    console.log(`  mint:        ${p.base?.mint}`);
    console.log(`  mcap:        $${(p.mcap || 0).toLocaleString()}`);
    console.log(`  holders:     ${p.holders}`);
    console.log(`  active_tvl:  $${(p.active_tvl || 0).toLocaleString()}`);
    console.log(`  fee/tvl:     ${p.fee_active_tvl_ratio}%`);
    console.log(`  bin_step:    ${p.bin_step}`);
    console.log(`  kol_wallets: ${p.gmgn_kol_wallets} | kol_names: ${p.gmgn_kol_names?.join(", ") || "-"}`);
    console.log(`  smart_wallets: ${p.gmgn_smart_wallets} | hold=${p.gmgn_smart_holding} accum=${p.gmgn_smart_accumulating} exit=${p.gmgn_smart_exiting}`);
    console.log(`  gmgn_score:  ${p.gmgn_score}`);
    console.log(`  price_vs_ath:${p.price_vs_ath_pct != null ? p.price_vs_ath_pct + "%" : "n/a"}`);
    console.log(`  launchpad:   ${p.launchpad || "n/a"}`);
  }
}
