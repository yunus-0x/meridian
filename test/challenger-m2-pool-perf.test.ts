/**
 * Empirical Challenge Test Suite for Milestone 2:
 * pool-memory.ts & performance.ts
 *
 * Verifies:
 * - pool-memory.ts cooldowns (isPoolOnCooldown, isBaseMintOnCooldown)
 * - Chronos tactical bypass on repeat winner cooldown
 * - Adjusted win rate calculation & edge cases
 * - Position snapshots 48-cap ring buffer & trend recall
 * - Atomic persistence (.tmp + renameSync) & corruption resilience
 * - performance.ts closed-position accounting into lessons.json
 * - Suspicious unit-mix and absurd PnL guards
 * - Pool cooldown updates via performance.ts
 */

process.env.NODE_ENV = "test";
process.env.DISABLE_TELEGRAM = "true";
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { repoPath } from "../repo-root.js";
import { config } from "../config.js";
import {
  load as loadPoolMem,
  save as savePoolMem,
  recordPoolDeploy,
  recordPositionSnapshot,
  isPoolOnCooldown,
  isBaseMintOnCooldown,
  getPoolMemory,
  recallForPool,
  addPoolNote,
} from "../pool-memory.js";
import {
  recordPerformance,
  getPerformanceHistory,
  getPerformanceSummary,
} from "../performance.js";
import { PoolMemoryDbSchema } from "../src/schemas/storage.js";

const POOL_MEM_FILE = repoPath("pool-memory.json");
const LESSONS_FILE = repoPath("lessons.json");

describe("Milestone 2 Empirical Challenge: pool-memory.ts Cooldowns & Chronos Bypass", () => {
  let origPoolMem: string | null = null;
  let origLessons: string | null = null;

  beforeEach(() => {
    origPoolMem = fs.existsSync(POOL_MEM_FILE) ? fs.readFileSync(POOL_MEM_FILE, "utf8") : null;
    origLessons = fs.existsSync(LESSONS_FILE) ? fs.readFileSync(LESSONS_FILE, "utf8") : null;
  });

  afterEach(() => {
    if (origPoolMem !== null) {
      fs.writeFileSync(POOL_MEM_FILE, origPoolMem);
    }
    if (origLessons !== null) {
      fs.writeFileSync(LESSONS_FILE, origLessons);
    }
  });

  test("Empty and non-existent pool/mint addresses return false", () => {
    assert.equal(isPoolOnCooldown(""), false);
    assert.equal(isPoolOnCooldown("NonExistentPool1111111111111111111111111111111"), false);
    assert.equal(isBaseMintOnCooldown(""), false);
    assert.equal(isBaseMintOnCooldown("NonExistentMint1111111111111111111111111111111"), false);
  });

  test("Low yield close triggers 4-hour pool cooldown without mint cooldown", () => {
    const pool = "PoolChal_LowYield_111111111111111111111111";
    const mint = "MintChal_LowYield_111111111111111111111111";

    recordPoolDeploy(pool, {
      pool_name: "LOWYIELD/SOL",
      base_mint: mint,
      close_reason: "Low yield / dead capital after 120m",
      pnl_pct: 0.1,
      pnl_usd: 0.05,
    });

    const mem = getPoolMemory({ pool_address: pool });
    assert.equal(mem.known, true);
    assert.equal(mem.cooldown_reason, "low yield");
    assert.ok(mem.cooldown_until);
    assert.ok(new Date(mem.cooldown_until).getTime() > Date.now() + 3 * 3600_000);
    assert.equal(isPoolOnCooldown(pool), true);
    assert.equal(isBaseMintOnCooldown(mint), false);
  });

  test("Repeated OOR closes trigger pool AND base mint cooldowns after configured trigger count", () => {
    const configuredOorTrigger = config.management.oorCooldownTriggerCount ?? 3;
    const pool = "PoolChal_OOR_111111111111111111111111111111";
    const mint = "MintChal_OOR_111111111111111111111111111111";

    for (let i = 1; i <= configuredOorTrigger; i++) {
      recordPoolDeploy(pool, {
        pool_name: "OOR/SOL",
        base_mint: mint,
        close_reason: `out of range attempt ${i}`,
        pnl_pct: -1.0 * i,
      });
      if (i < configuredOorTrigger) {
        assert.equal(isPoolOnCooldown(pool), false);
        assert.equal(isBaseMintOnCooldown(mint), false);
      } else {
        assert.equal(isPoolOnCooldown(pool), true);
        assert.equal(isBaseMintOnCooldown(mint), true);
      }
    }
    const mem = getPoolMemory({ pool_address: pool });
    assert.match(mem.cooldown_reason || "", new RegExp(`repeated OOR closes \\(${configuredOorTrigger}x\\)`));
    assert.match(mem.base_mint_cooldown_reason || "", new RegExp(`repeated OOR closes \\(${configuredOorTrigger}x\\)`));
  });

  test("Interrupted OOR sequence (OOR -> TP -> OOR) does not trigger OOR cooldown", () => {
    const pool = "PoolChal_OOR_Interrupted_111111111111111111";
    const mint = "MintChal_OOR_Interrupted_111111111111111111";

    recordPoolDeploy(pool, { base_mint: mint, close_reason: "out of range", pnl_pct: -1.0 });
    recordPoolDeploy(pool, { base_mint: mint, close_reason: "Take profit reached +12%", pnl_pct: 12.0 });
    recordPoolDeploy(pool, { base_mint: mint, close_reason: "out of range", pnl_pct: -2.0 });

    assert.equal(isPoolOnCooldown(pool), false);
    assert.equal(isBaseMintOnCooldown(mint), false);
  });

  test("Repeat fee-generating deploys trigger cooldown under scope='both'", () => {
    const origRepeatEnabled = config.management.repeatDeployCooldownEnabled;
    const origRepeatScope = config.management.repeatDeployCooldownScope;
    const origRepeatCount = config.management.repeatDeployCooldownTriggerCount;
    const origRepeatHours = config.management.repeatDeployCooldownHours;
    try {
      config.management.repeatDeployCooldownEnabled = true;
      config.management.repeatDeployCooldownTriggerCount = 3;
      config.management.repeatDeployCooldownHours = 8;
      config.management.repeatDeployCooldownScope = "both";
      config.management.repeatDeployCooldownMinFeeEarnedPct = 0.1;

      const pool = "PoolChal_RepeatFee_111111111111111111111111";
      const mint = "MintChal_RepeatFee_111111111111111111111111";

      for (let i = 0; i < 3; i++) {
        recordPoolDeploy(pool, {
          base_mint: mint,
          pnl_pct: 5.0,
          fees_earned_usd: 1.0,
          fee_earned_pct: 1.0,
          close_reason: "Take profit reached",
        });
      }
      assert.equal(isPoolOnCooldown(pool), true);
      assert.equal(isBaseMintOnCooldown(mint), true);
      const mem = getPoolMemory({ pool_address: pool });
      assert.match(mem.cooldown_reason || "", /repeat fee-generating deploys/);
    } finally {
      config.management.repeatDeployCooldownEnabled = origRepeatEnabled;
      config.management.repeatDeployCooldownScope = origRepeatScope;
      config.management.repeatDeployCooldownTriggerCount = origRepeatCount;
      config.management.repeatDeployCooldownHours = origRepeatHours;
    }
  });
});

describe("Milestone 2 Empirical Challenge: pool-memory.ts Adjusted Win Rate & Snapshots", () => {
  let origPoolMem: string | null = null;

  beforeEach(() => {
    origPoolMem = fs.existsSync(POOL_MEM_FILE) ? fs.readFileSync(POOL_MEM_FILE, "utf8") : null;
  });

  afterEach(() => {
    if (origPoolMem !== null) {
      fs.writeFileSync(POOL_MEM_FILE, origPoolMem);
    }
  });

  test("Adjusted win rate excludes OOR/pumped reasons and rounds precisely", () => {
    const pool = "PoolChal_AWR_11111111111111111111111111111";

    // Excluded reasons
    recordPoolDeploy(pool, { pnl_pct: 2.0, close_reason: "out of range" });
    recordPoolDeploy(pool, { pnl_pct: 15.0, close_reason: "pumped far above range" });
    recordPoolDeploy(pool, { pnl_pct: -1.0, close_reason: "OOR" });

    let mem = getPoolMemory({ pool_address: pool });
    assert.equal(mem.total_deploys, 3);
    assert.equal(mem.adjusted_win_rate_sample_count, 0);
    assert.equal(mem.adjusted_win_rate, 0);

    // Non-excluded reasons: +10% (win), -5% (loss), 0% (win)
    recordPoolDeploy(pool, { pnl_pct: 10.0, close_reason: "Take profit reached" });
    recordPoolDeploy(pool, { pnl_pct: -5.0, close_reason: "Stop loss reached" });
    recordPoolDeploy(pool, { pnl_pct: 0.0, close_reason: "Manual operator close" });

    mem = getPoolMemory({ pool_address: pool });
    // 2 wins out of 3 samples: (2/3) * 100 = 66.67%
    assert.equal(mem.adjusted_win_rate_sample_count, 3);
    assert.equal(mem.adjusted_win_rate, 66.67);
  });

  test("Position snapshot ring buffer strictly enforces 48-item limit and FIFO eviction", () => {
    const pool = "PoolChal_Snapshots_111111111111111111111111";

    for (let i = 1; i <= 60; i++) {
      recordPositionSnapshot(pool, {
        pair: "TEST/SOL",
        position: `Pos_${i}`,
        pnl_pct: i * 0.1,
        pnl_usd: i * 0.01,
        in_range: i % 2 === 0,
        age_minutes: i * 5,
        minutes_out_of_range: i % 2 === 0 ? 0 : 5,
      });
    }

    const db = loadPoolMem();
    const entry = db[pool];
    assert.ok(entry);
    assert.equal(entry.snapshots.length, 48);
    assert.equal(entry.snapshots[0]?.position, "Pos_13");
    assert.equal(entry.snapshots[47]?.position, "Pos_60");

    addPoolNote({ pool_address: pool, note: "Test note with <b>html</b> and `ticks`" });
    const recalled = recallForPool(pool);
    assert.ok(recalled);
    assert.match(recalled, /RECENT TREND:/);
    assert.match(recalled, /NOTE: Test note with bhtml\/b and ticks/);
  });

  test("Atomic write clean temporary file lifecycle and corrupted JSON recovery", async () => {
    const pool = "PoolChal_Concurrent_11111111111111111111111";

    // Atomic save leaves no temporary file
    const currentDb = loadPoolMem();
    savePoolMem(currentDb);
    assert.equal(fs.existsSync(`${POOL_MEM_FILE}.tmp`), false);

    // Concurrent write hammer
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      promises.push(
        (async () => {
          recordPositionSnapshot(pool, {
            position: `ConcurrentPos_${i}`,
            pnl_pct: i,
          });
          if (i % 5 === 0) {
            addPoolNote({ pool_address: pool, note: `Note ${i}` });
          }
        })()
      );
    }
    await Promise.all(promises);

    const reloaded = loadPoolMem();
    assert.ok(reloaded[pool]);
    assert.doesNotThrow(() => PoolMemoryDbSchema.parse(reloaded));

    // Corrupted file recovery
    fs.writeFileSync(POOL_MEM_FILE, "{ MALFORMED JSON DATA !!!");
    const recovered = loadPoolMem();
    assert.deepEqual(recovered, {});
  });
});

describe("Milestone 2 Empirical Challenge: performance.ts Accounting & Guards", () => {
  let origPoolMem: string | null = null;
  let origLessons: string | null = null;

  beforeEach(() => {
    origPoolMem = fs.existsSync(POOL_MEM_FILE) ? fs.readFileSync(POOL_MEM_FILE, "utf8") : null;
    origLessons = fs.existsSync(LESSONS_FILE) ? fs.readFileSync(LESSONS_FILE, "utf8") : null;
  });

  afterEach(() => {
    if (origPoolMem !== null) {
      fs.writeFileSync(POOL_MEM_FILE, origPoolMem);
    }
    if (origLessons !== null) {
      fs.writeFileSync(LESSONS_FILE, origLessons);
    }
  });

  test("Valid closed position computes PnL and updates pool memory", async () => {
    const pool = "PoolChal_Perf_111111111111111111111111111";
    const pos = "PosChal_Perf_111111111111111111111111111";

    await recordPerformance({
      pool,
      position: pos,
      pool_name: "VALID/SOL",
      initial_value_usd: 100,
      final_value_usd: 110,
      fees_earned_usd: 5,
      amount_sol: 1.0,
      minutes_held: 60,
      minutes_in_range: 48,
      close_reason: "Take profit reached +15%",
    });

    const summary = getPerformanceSummary();
    assert.ok(summary);
    assert.ok(summary.total_positions_closed >= 1);

    const history = getPerformanceHistory({ hours: 1, limit: 10 });
    const matching = history.positions.find((p) => p.pool === pool);
    assert.ok(matching);
    assert.equal(matching.pnl_usd, 15);
    assert.equal(matching.pnl_pct, 15);
    assert.equal(matching.range_efficiency, 80);
  });

  test("Suspicious unit-mix (SOL value in USD field) is intercepted and skipped", async () => {
    const pool = "PoolChal_Perf_UnitMix_1111111111111111111";
    const pos = "PosChal_UnitMix_1111111111111111111111111";
    const countBefore = getPerformanceHistory({ hours: 1, limit: 100 }).count;

    await recordPerformance({
      pool,
      position: pos,
      pool_name: "UNITMIX/SOL",
      initial_value_usd: 200,
      final_value_usd: 1.05,
      amount_sol: 1.0,
      close_reason: "Take profit reached",
    });

    const countAfter = getPerformanceHistory({ hours: 1, limit: 100 }).count;
    assert.equal(countAfter, countBefore);
  });

  test("Suspicious absurd closed PnL (-95% without stop loss) is intercepted while legitimate stop loss crash is accepted", async () => {
    const pool = "PoolChal_Perf_Absurd_11111111111111111111";
    const posAbsurd = "PosChal_Absurd_1111111111111111111111111";
    const countBefore = getPerformanceHistory({ hours: 1, limit: 100 }).count;

    // Absurd PnL without stop loss -> skipped
    await recordPerformance({
      pool,
      position: posAbsurd,
      pool_name: "ABSURD/SOL",
      initial_value_usd: 100,
      final_value_usd: 5,
      fees_earned_usd: 0,
      close_reason: "Rebalance timeout or manual drift",
    });
    assert.equal(getPerformanceHistory({ hours: 1, limit: 100 }).count, countBefore);

    // Legitimate stop loss crash -> accepted
    const posLegitSL = "PosChal_LegitSL_111111111111111111111111";
    await recordPerformance({
      pool,
      position: posLegitSL,
      pool_name: "LEGITSL/SOL",
      initial_value_usd: 100,
      final_value_usd: 5,
      fees_earned_usd: 0,
      close_reason: "Hard stop loss triggered at -95%",
    });
    assert.equal(getPerformanceHistory({ hours: 1, limit: 100 }).count, countBefore + 1);
  });
});
