/**
 * Test script for token APIs (getTokenInfo, getTokenHolders, getTokenNarrative).
 * Run: node test/test-token.js
 */

import {
  getTokenInfo,
  getTokenHolders,
  getTokenNarrative,
} from "../tools/token.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

async function main() {
  console.log("=== Testing Token Tools (Jupiter API) ===\n");

  // Test 1: getTokenInfo
  console.log("1. Testing getTokenInfo (SOL)...");
  try {
    const info = await getTokenInfo({ query: SOL_MINT });
    console.log("   Result found:", info.found);
    if (info.results?.[0]) {
      console.log(
        `   Name: ${info.results[0].name} | Symbol: ${info.results[0].symbol}`,
      );
      console.log(
        `   Price: $${info.results[0].price} | Holders: ${info.results[0].holders}`,
      );
    }
  } catch (err) {
    console.error("   ❌ getTokenInfo Error:", err.message);
  }

  // Test 2: getTokenHolders
  console.log("\n2. Testing getTokenHolders (SOL)...");
  try {
    const holders = await getTokenHolders({ mint: SOL_MINT, limit: 5 });
    console.log("   Total fetched:", holders.total_fetched);
    console.log("   Top 10 holders %:", holders.top_10_real_holders_pct);
    console.log("   Sample holder address:", holders.holders?.[0]?.address);
  } catch (err) {
    console.error("   ❌ getTokenHolders Error:", err.message);
  }

  // Test 3: getTokenNarrative
  console.log("\n3. Testing getTokenNarrative (SOL)...");
  try {
    const narrative = await getTokenNarrative({ mint: SOL_MINT });
    console.log("   Narrative status:", narrative.status);
    console.log("   Narrative text:", narrative.narrative || "(None)");
  } catch (err) {
    console.error("   ❌ getTokenNarrative Error:", err.message);
  }

  console.log("\n=== Token Tools Test Finished ===");
}

main().catch(console.error);
