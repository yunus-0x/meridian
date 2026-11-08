/**
 * Empirical Adversarial Challenge Suite for Milestone 3
 * Focus: standalone/transactions.ts (Mutex, Priority, Timeout, Deadlock Freedom)
 *        standalone/store.ts (Corruption rejection, Atomic Save with 0o600, Pruning invariants)
 */

process.env.NODE_ENV = "test";
process.env.DISABLE_TELEGRAM = "true";
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

import { describe, test, it, expect, assert, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  withWalletLock,
  isWalletLocked,
  getWalletLockQueueLength,
  resetWalletLockForTests,
} from "../standalone/transactions.js";
import {
  MonitorStore,
  type MonitorEvent,
  type MonitorSignal,
} from "../standalone/store.js";
import { MonitorAttemptSchema, type MonitorAttempt } from "../src/schemas/storage.js";

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("Adversarial Challenge 1: Mutex Concurrency, Priority Ordering & Non-preemption", () => {
  beforeEach(() => {
    resetWalletLockForTests();
  });

  afterEach(() => {
    resetWalletLockForTests();
  });

  test("Mutual Exclusion: at no point do two tasks run concurrently under heavy contention", async () => {
    let runningCount = 0;
    let maxConcurrent = 0;
    const taskCount = 30;

    const tasks = Array.from({ length: taskCount }, (_, i) => {
      const priority = i % 3 === 0 ? 10 : i % 3 === 1 ? 5 : 0;
      return withWalletLock(async () => {
        runningCount++;
        maxConcurrent = Math.max(maxConcurrent, runningCount);
        // Yield execution to event loop
        await new Promise((resolve) => setTimeout(resolve, 5));
        runningCount--;
      }, priority);
    });

    await Promise.all(tasks);
    await tick();

    assert.equal(maxConcurrent, 1, "Concurrency violation: more than 1 task ran simultaneously");
    assert.equal(runningCount, 0, "All tasks completed and decremented running count");
    assert.equal(isWalletLocked(), false, "Mutex released after all tasks complete");
    assert.equal(getWalletLockQueueLength(), 0, "Queue is empty after all tasks complete");
  });

  test("In-flight non-preemption: priority 10 arriving during in-flight priority 0 NEVER pre-empts it", async () => {
    const trace: string[] = [];
    let blockerStarted = false;

    // Start a low-priority task (priority 0)
    const p0 = withWalletLock(async () => {
      trace.push("p0:start");
      blockerStarted = true;
      await new Promise((r) => setTimeout(r, 40));
      trace.push("p0:finish");
      return "p0_done";
    }, 0);

    // Wait until p0 has started running
    while (!blockerStarted) {
      await new Promise((r) => setTimeout(r, 1));
    }

    assert.equal(isWalletLocked(), true, "p0 must be holding the lock");

    // While p0 is running, enqueue high-priority exit (priority 10) and medium (priority 5)
    const p10 = withWalletLock(async () => {
      trace.push("p10:start");
      await new Promise((r) => setTimeout(r, 5));
      trace.push("p10:finish");
      return "p10_done";
    }, 10);

    const p5 = withWalletLock(async () => {
      trace.push("p5:start");
      await new Promise((r) => setTimeout(r, 5));
      trace.push("p5:finish");
      return "p5_done";
    }, 5);

    await Promise.all([p0, p10, p5]);
    await tick();

    // Check trace: p0 must finish completely before p10 starts, and p10 must finish before p5 starts
    assert.deepEqual(trace, [
      "p0:start",
      "p0:finish",
      "p10:start",
      "p10:finish",
      "p5:start",
      "p5:finish",
    ]);
  });

  test("Strict multi-tier priority sorting (10 > 5 > 0) with FIFO preservation for identical priorities", async () => {
    const executed: string[] = [];
    let blockerResolve: (() => void) | null = null;
    const blockerPromise = new Promise<void>((r) => { blockerResolve = r; });

    // Hold the lock with an initial blocker
    const blocker = withWalletLock(async () => {
      await blockerPromise;
    }, 0);

    // Enqueue mixed priorities in interleaved/reverse order
    // 3 items of prio 0, 3 items of prio 5, 3 items of prio 10
    const queueOrder = [
      { id: "p0_first", prio: 0 },
      { id: "p5_first", prio: 5 },
      { id: "p10_first", prio: 10 },
      { id: "p0_second", prio: 0 },
      { id: "p10_second", prio: 10 },
      { id: "p5_second", prio: 5 },
      { id: "p10_third", prio: 10 },
      { id: "p5_third", prio: 5 },
      { id: "p0_third", prio: 0 },
    ];

    const promises = queueOrder.map((item) =>
      withWalletLock(async () => {
        executed.push(item.id);
      }, item.prio)
    );

    // Verify all 9 items are waiting in the queue
    assert.equal(getWalletLockQueueLength(), 9);

    // Release blocker
    blockerResolve!();
    await blocker;
    await Promise.all(promises);
    await tick();

    // Expected order:
    // All p10s in arrival order, then all p5s in arrival order, then all p0s in arrival order
    assert.deepEqual(executed, [
      "p10_first",
      "p10_second",
      "p10_third",
      "p5_first",
      "p5_second",
      "p5_third",
      "p0_first",
      "p0_second",
      "p0_third",
    ]);
  });
});

describe("Adversarial Challenge 2: Queue Timeout, Rejection Isolation & Deadlock Freedom", () => {
  beforeEach(() => {
    resetWalletLockForTests();
  });

  afterEach(() => {
    resetWalletLockForTests();
  });

  test("Queue timeout aborts waiting tasks without executing their functions", async () => {
    let functionExecuted = false;
    let blockerResolve: (() => void) | null = null;
    const blockerPromise = new Promise<void>((r) => { blockerResolve = r; });

    const blocker = withWalletLock(async () => {
      await blockerPromise;
    }, 0);

    const timedOutTask = withWalletLock(
      async () => {
        functionExecuted = true;
        return "should_not_run";
      },
      { priority: 10, timeoutMs: 25 }
    );

    await expect(timedOutTask).rejects.toThrow(
      /Wallet lock acquisition timed out after 25ms/
    );

    assert.equal(functionExecuted, false, "Timed out task body was executed!");

    blockerResolve!();
    await blocker;
    await tick();
    assert.equal(isWalletLocked(), false);
  });

  test("Partial timeouts do not deadlock surviving queued tasks", async () => {
    const results: string[] = [];
    let blockerResolve: (() => void) | null = null;
    const blocker = withWalletLock(async () => {
      await new Promise<void>((r) => { blockerResolve = r; });
    }, 0);

    // Attach assert.rejects immediately so rejection is handled as soon as timer fires
    const item1 = withWalletLock(async () => {
      results.push("item1");
    }, { priority: 10, timeoutMs: 20 });
    const p1 = expect(item1).rejects.toThrow(/timed out after 20ms/);

    const item2 = withWalletLock(async () => {
      results.push("item2");
    }, { priority: 5, timeoutMs: 150 });

    const item3 = withWalletLock(async () => {
      results.push("item3");
    }, { priority: 0, timeoutMs: 20 });
    const p3 = expect(item3).rejects.toThrow(/timed out after 20ms/);

    const item4 = withWalletLock(async () => {
      results.push("item4");
    }, 0);

    // Wait for timeouts of item1 and item3 to settle
    await Promise.all([p1, p3]);

    // Unblock the initial job
    blockerResolve!();
    await blocker;

    // Remaining items (item2 and item4) must complete cleanly
    await Promise.all([item2, item4]);
    await tick();

    assert.deepEqual(results, ["item2", "item4"]);
    assert.equal(isWalletLocked(), false);
    assert.equal(getWalletLockQueueLength(), 0);
  });

  test("All queued items timing out leaves mutex fully operational for future callers", async () => {
    let blockerResolve: (() => void) | null = null;
    const blocker = withWalletLock(async () => {
      await new Promise<void>((r) => { blockerResolve = r; });
    }, 0);

    const w1 = withWalletLock(async () => "w1", { priority: 10, timeoutMs: 15 });
    const p1 = expect(w1).rejects.toThrow(/timed out after 15ms/);

    const w2 = withWalletLock(async () => "w2", { priority: 5, timeoutMs: 15 });
    const p2 = expect(w2).rejects.toThrow(/timed out after 15ms/);

    const w3 = withWalletLock(async () => "w3", { priority: 0, timeoutMs: 15 });
    const p3 = expect(w3).rejects.toThrow(/timed out after 15ms/);

    await Promise.all([p1, p2, p3]);

    // Now release blocker
    blockerResolve!();
    await blocker;
    await tick();

    assert.equal(isWalletLocked(), false);
    assert.equal(getWalletLockQueueLength(), 0);

    // Immediate new task must execute without hang
    const freshResult = await withWalletLock(async () => "fresh_success", 0);
    assert.equal(freshResult, "fresh_success");
  });

  test("Error throwing inside locked function does not corrupt lock state or block next callers", async () => {
    const errorTask = withWalletLock(async () => {
      throw new Error("Simulated on-chain RPC error");
    }, 10);

    await expect(errorTask).rejects.toThrow(/Simulated on-chain RPC error/);
    await tick();
    assert.equal(isWalletLocked(), false);

    const subsequentTask = await withWalletLock(async () => "recovered", 0);
    assert.equal(subsequentTask, "recovered");
  });

  test("Timeout timer is cleared once active, not firing during long fn execution", async () => {
    let timedOutError = false;
    // Task has 30ms timeout, acquires lock immediately, and takes 60ms to execute
    const result = await withWalletLock(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return "executed_successfully";
    }, { priority: 10, timeoutMs: 30 }).catch((e) => {
      timedOutError = true;
      return "error";
    });

    assert.equal(timedOutError, false, "Timeout fired while fn was already active");
    assert.equal(result, "executed_successfully");
  });
});

describe("Adversarial Challenge 3: Store Persistence, Corruption Rejection & Pruning", () => {
  const testFile = path.resolve("./test-empirical-store.json");

  afterEach(() => {
    for (const p of [testFile, `${testFile}.tmp`]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // Ignore
      }
    }
  });

  test("Corrupted file content throws and preserves exact file contents on disk", () => {
    const corruptedPayload = "MALFORMED_JSON_{{{not_json";
    fs.writeFileSync(testFile, corruptedPayload, "utf8");

    assert.throws(
      () => new MonitorStore(testFile),
      /Invalid monitor state; refusing to discard recovery history/
    );

    // Ensure the file was not touched or emptied
    const diskContent = fs.readFileSync(testFile, "utf8");
    assert.equal(diskContent, corruptedPayload, "Corrupted file was modified or truncated!");
  });

  test("Schema invalid state throws and preserves exact disk state without wiping", () => {
    // Valid JSON but invalid schema (missing required fields or invalid types)
    const invalidSchemaPayload = JSON.stringify({
      version: "invalid_string_version",
      events: "not_an_array",
    });
    fs.writeFileSync(testFile, invalidSchemaPayload, "utf8");

    assert.throws(
      () => new MonitorStore(testFile),
      /Invalid monitor state; refusing to discard recovery history/
    );

    const diskContent = fs.readFileSync(testFile, "utf8");
    assert.equal(diskContent, invalidSchemaPayload, "Invalid state file was overwritten!");
  });

  test("Atomic save creates file with mode 0o600 permissions and leaves no leftover .tmp", () => {
    const store = new MonitorStore(testFile);
    store.data.seen["sig_alpha"] = Date.now();
    store.save();

    assert.ok(fs.existsSync(testFile), "Target file must exist");
    assert.equal(fs.existsSync(`${testFile}.tmp`), false, "Temporary .tmp file must not be left behind");

    const stat = fs.statSync(testFile);
    const mode = stat.mode & 0o777;
    // On POSIX systems, file permissions must be 0o600 (-rw-------)
    assert.equal(mode, 0o600, `Expected file mode 0o600, got 0o${mode.toString(8)}`);
  });

  test("Event pruning drops events >= 10 minutes old and retains younger ones", () => {
    const store = new MonitorStore(testFile);
    const now = 1_000_000;

    const freshEvent: MonitorEvent = {
      id: "ev_fresh",
      mint: "MINT_1",
      wallet: "WALLET_1",
      depositSol: 1.0,
      at: now - 5 * 60_000, // 5m old
    };

    const staleEvent: MonitorEvent = {
      id: "ev_stale",
      mint: "MINT_2",
      wallet: "WALLET_2",
      depositSol: 2.0,
      at: now - 11 * 60_000, // 11m old
    };

    store.data.events = [freshEvent, staleEvent];
    store.prune(now);

    assert.equal(store.data.events.length, 1);
    assert.equal(store.data.events[0]?.id, "ev_fresh");
  });

  test("Seen signatures pruning drops > 2 hours and caps at 5000 newest", () => {
    const store = new MonitorStore(testFile);
    const now = 10_000_000;

    // Add 1 stale (> 2h)
    store.data.seen["stale_sig"] = now - 3 * 3600_000;

    // Add 5005 fresh signatures with distinct timestamps
    for (let i = 0; i < 5005; i++) {
      store.data.seen[`sig_${i}`] = now - 1000 - i;
    }

    store.prune(now);

    assert.equal(store.data.seen["stale_sig"], undefined, "Stale signature > 2h was not pruned");
    const count = Object.keys(store.data.seen).length;
    assert.equal(count, 5000, `Expected seen count to be capped at 5000, got ${count}`);

    // Verify newest was retained and oldest of the 5005 was pruned
    assert.ok(store.data.seen["sig_0"] !== undefined, "Newest signature must be retained");
    assert.equal(store.data.seen["sig_5004"], undefined, "Oldest signature past cap must be pruned");
  });

  test("Signal lifecycle pruning: expired auto-closes, >24h removed, active preserved", () => {
    const store = new MonitorStore(testFile);
    const now = 20_000_000;

    // 1. Active signal whose deadline has passed
    const expiredSignal: MonitorSignal = {
      mint: "MINT_EXPIRED",
      createdAt: now - 5000,
      deadline: now - 1000, // in the past
      nextCheck: now,
      events: [],
      done: false,
    };

    // 2. Completed signal older than 24 hours
    const staleDoneSignal: MonitorSignal = {
      mint: "MINT_STALE_DONE",
      createdAt: now - 25 * 3600_000,
      deadline: now - 24 * 3600_000,
      nextCheck: now,
      events: [],
      done: true,
      reason: "completed",
    };

    // 3. Completed signal within 24 hours (e.g. cooldown)
    const freshDoneSignal: MonitorSignal = {
      mint: "MINT_FRESH_DONE",
      createdAt: now - 2 * 3600_000,
      deadline: now - 1 * 3600_000,
      nextCheck: now,
      events: [],
      done: true,
      reason: "completed",
    };

    // 4. Active signal still within deadline
    const activeSignal: MonitorSignal = {
      mint: "MINT_ACTIVE",
      createdAt: now - 1000,
      deadline: now + 60_000,
      nextCheck: now,
      events: [],
      done: false,
    };

    store.data.signals = {
      MINT_EXPIRED: expiredSignal,
      MINT_STALE_DONE: staleDoneSignal,
      MINT_FRESH_DONE: freshDoneSignal,
      MINT_ACTIVE: activeSignal,
    };

    store.prune(now);

    // MINT_EXPIRED should be marked done: true with reason 'expired'
    assert.equal(store.data.signals["MINT_EXPIRED"]?.done, true);
    assert.equal(store.data.signals["MINT_EXPIRED"]?.reason, "expired");
    assert.equal(store.data.signals["MINT_EXPIRED"]?.closedAt, now);

    // MINT_STALE_DONE should be pruned
    assert.equal(store.data.signals["MINT_STALE_DONE"], undefined);

    // MINT_FRESH_DONE should be kept
    assert.ok(store.data.signals["MINT_FRESH_DONE"]);

    // MINT_ACTIVE should remain untouched
    assert.equal(store.data.signals["MINT_ACTIVE"]?.done, false);
  });

  test("Attempt records: 'submitting' status NEVER pruned even after > 24 hours", () => {
    const store = new MonitorStore(testFile);
    const now = 50_000_000;

    const normalOldAttempt: MonitorAttempt = {
      at: now - 25 * 3600_000,
      status: "failed",
      mint: "MINT_OLD",
      pool: "POOL_OLD",
      failures: 0,
      txs: [],
    };

    const inFlightSubmittingAttempt: MonitorAttempt = {
      at: now - 30 * 3600_000, // 30 hours old!
      status: "submitting",
      mint: "MINT_SUBMITTING",
      pool: "POOL_SUBMITTING",
      failures: 0,
      txs: [],
    };

    const freshAttempt: MonitorAttempt = {
      at: now - 1 * 3600_000,
      status: "proposed",
      mint: "MINT_FRESH",
      pool: "POOL_FRESH",
      failures: 0,
      txs: [],
    };

    store.data.attempts = {
      MINT_OLD: normalOldAttempt,
      MINT_SUBMITTING: inFlightSubmittingAttempt,
      MINT_FRESH: freshAttempt,
    };

    store.prune(now);

    assert.equal(store.data.attempts["MINT_OLD"], undefined, "Old non-submitting attempt should be pruned");
    assert.ok(store.data.attempts["MINT_SUBMITTING"], "Submitting attempt must NEVER be pruned");
    assert.equal(store.data.attempts["MINT_SUBMITTING"]?.status, "submitting");
    assert.ok(store.data.attempts["MINT_FRESH"], "Fresh attempt should be kept");
  });
});

describe("Adversarial Challenge 4: Monte Carlo Mutex Stress Under Random Contention", () => {
  beforeEach(() => {
    resetWalletLockForTests();
  });

  afterEach(() => {
    resetWalletLockForTests();
  });

  test("100 concurrent randomized operations complete without deadlock or corruption", async () => {
    const totalOps = 100;
    let concurrencyCount = 0;
    let maxConcurrency = 0;
    const priorities = [0, 5, 10];

    const promises = Array.from({ length: totalOps }, (_, i) => {
      const priority = priorities[i % 3]!;
      const timeoutMs = (i % 7 === 0) ? 5 : undefined; // Some intentionally aggressive timeouts

      return withWalletLock(
        async () => {
          concurrencyCount++;
          maxConcurrency = Math.max(maxConcurrency, concurrencyCount);
          const workMs = (i % 4) + 1; // 1-4ms
          await new Promise((r) => setTimeout(r, workMs));
          concurrencyCount--;
          return `op_${i}`;
        },
        timeoutMs ? { priority, timeoutMs } : priority
      );
    });

    const settled = await Promise.allSettled(promises);

    assert.equal(maxConcurrency, 1, "Concurrency invariant violated during Monte Carlo test");
    assert.equal(concurrencyCount, 0, "All operations cleanly decremented active counter");

    const succeeded = settled.filter((s) => s.status === "fulfilled").length;
    const failed = settled.filter((s) => s.status === "rejected").length;

    assert.equal(succeeded + failed, totalOps);
    assert.ok(succeeded > 70, `Expected majority of ops to succeed, got ${succeeded}`);

    await tick();

    // Mutex state must be completely clean and usable
    assert.equal(isWalletLocked(), false);
    assert.equal(getWalletLockQueueLength(), 0);

    const postCheck = await withWalletLock(async () => "post_storm_clean", 0);
    assert.equal(postCheck, "post_storm_clean");
  });
});


describe("Adversarial Challenge 5: Store Convergence Rules & Mutex Edge Cases", () => {
  const testFile = path.resolve("./test-empirical-store-extra.json");

  beforeEach(() => {
    resetWalletLockForTests();
  });

  afterEach(() => {
    resetWalletLockForTests();
    for (const p of [testFile, `${testFile}.tmp`]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // Ignore
      }
    }
  });

  test("In-memory corrupted state before save() throws and prevents writing corrupted state to disk", () => {
    const store = new MonitorStore(testFile);
    store.save(); // valid save
    assert.ok(fs.existsSync(testFile));
    const validOnDisk = fs.readFileSync(testFile, "utf8");

    // Corrupt in-memory state
    // @ts-expect-error Deliberate corruption for test
    store.data.version = "not_a_number";

    assert.throws(
      () => store.save(),
      /invalid_literal|expected 1/
    );

    // Verify disk content was NOT altered by failed save
    const diskAfterFailedSave = fs.readFileSync(testFile, "utf8");
    assert.equal(diskAfterFailedSave, validOnDisk);
  });

  test("qualifyingEvents rejects future timestamps, dust deposits, and dedups by wallet & group", async () => {
    const now = 5_000_000;
    const opts = {
      windowSec: 120, // 2 minutes
      minDepositSol: 0.5,
      walletGroups: {
        "WALLET_G1_A": "GROUP_1",
        "WALLET_G1_B": "GROUP_1",
      },
    };

    const events: MonitorEvent[] = [
      // Future event (attack: forged future timestamp)
      { id: "e_future", mint: "MINT_X", wallet: "W_FUTURE", depositSol: 5.0, at: now + 5000 },
      // Dust deposit (< minDepositSol)
      { id: "e_dust", mint: "MINT_X", wallet: "W_DUST", depositSol: 0.1, at: now - 1000 },
      // Stale event (> windowSec)
      { id: "e_stale", mint: "MINT_X", wallet: "W_STALE", depositSol: 1.0, at: now - 200_000 },
      // Other mint
      { id: "e_other", mint: "MINT_OTHER", wallet: "W_OTHER", depositSol: 1.0, at: now - 1000 },
      // Group 1: wallet A deposited at now - 2000
      { id: "e_g1_a", mint: "MINT_X", wallet: "WALLET_G1_A", depositSol: 1.0, at: now - 2000 },
      // Group 1: wallet B deposited at now - 1000 (newer, should replace wallet A)
      { id: "e_g1_b", mint: "MINT_X", wallet: "WALLET_G1_B", depositSol: 1.5, at: now - 1000 },
      // Wallet C deposited twice (now - 3000, now - 500)
      { id: "e_c_1", mint: "MINT_X", wallet: "WALLET_C", depositSol: 2.0, at: now - 3000 },
      { id: "e_c_2", mint: "MINT_X", wallet: "WALLET_C", depositSol: 2.5, at: now - 500 },
    ];

    const qualified = (await import("../standalone/store.js")).qualifyingEvents(events, "MINT_X", opts, now);

    // Group 1 should only have 1 entry (e_g1_b), Wallet C should only have 1 entry (e_c_2)
    assert.equal(qualified.length, 2);
    const ids = qualified.map((e) => e.id).sort();
    assert.deepEqual(ids, ["e_c_2", "e_g1_b"]);
  });

  test("Synchronous exception inside withWalletLock fn is caught cleanly without hanging mutex", async () => {
    const errorTask = withWalletLock(() => {
      throw new Error("Immediate synchronous throw");
    }, 10);

    await expect(errorTask).rejects.toThrow(/Immediate synchronous throw/);
    await tick();

    assert.equal(isWalletLocked(), false);
    assert.equal(getWalletLockQueueLength(), 0);

    const nextTask = await withWalletLock(() => "sync_recovery", 0);
    assert.equal(nextTask, "sync_recovery");
  });

  test("Zero or negative timeoutMs does not trigger premature rejection", async () => {
    const resZero = await withWalletLock(async () => "ok_zero", { priority: 0, timeoutMs: 0 });
    assert.equal(resZero, "ok_zero");

    const resNeg = await withWalletLock(async () => "ok_neg", { priority: 0, timeoutMs: -50 });
    assert.equal(resNeg, "ok_neg");
  });
});
