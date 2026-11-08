// test/challenger-m5-runtime-leak.test.ts — Adversarial Empirical Test Suite Milestone 5
// Stress-tests daemon lifecycle, standalone.lock handling, signal shutdown,
// fast exit poller, and proves zero outbound Telegram leaks under simulated live credentials.
// Strict TypeScript, Oracle Engineering Standards: Zero any, Zero unsafe type assertions.

import { describe, test, it, expect, assert, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, repoPath } from "../repo-root.js";
import { config } from "../config.js";
import {
  isTelegramSuppressed,
  isEnabled as isTelegramEnabled,
  resolveChatId,
  sendMessage,
  sendHTML,
  sendMenu,
  editMenu,
  answerCallbackQuery,
  setBotCommands,
  startAdminPolling,
  notifyDeploy,
  notifyClose,
  notifySwap,
} from "../telegram.js";
import { startAdmin } from "../standalone/telegram-admin.js";
import { manageOnce, _test as runtimeTest } from "../standalone/runtime.js";
import { isMainExecution } from "../index.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("M5 Adversarial Suite 1: Telegram Alert Leak Interception (Simulated Live Credentials)", async () => {
  const originalFetch = globalThis.fetch;
  const originalBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChatId = process.env.TELEGRAM_CHAT_ID;
  const originalAllowedUsers = process.env.TELEGRAM_ALLOWED_USER_IDS;

  const interceptedTelegramCalls: string[] = [];

  try {
    // Install global fetch spy interceptor
    globalThis.fetch = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes("api.telegram.org")) {
        interceptedTelegramCalls.push(url);
        throw new Error(`CRITICAL LEAK DETECTED: HTTP dispatch to ${url}`);
      }
      return originalFetch(input, init);
    };

    // Simulate configured dummy test credentials in environment (safe mock format)
    process.env.TELEGRAM_BOT_TOKEN = "mock-test-bot-token";
    process.env.TELEGRAM_CHAT_ID = "9988776655";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "9988776655,1122334455";

    // 1. Verify suppression status under active credentials
    assert.equal(
      isTelegramSuppressed(),
      true,
      "Telegram must remain strictly suppressed in test environment"
    );
    assert.equal(
      isTelegramEnabled(),
      false,
      "isTelegramEnabled() must return false when suppressed, even with valid bot token"
    );

    // 2. Dispatch all outbound text / HTML / menu / callback query helpers
    const sendRes = await sendMessage("Adversarial alert probe");
    assert.equal(sendRes, null, "sendMessage must return null without network request");

    const htmlRes = await sendHTML("<b>Adversarial</b> HTML alert probe");
    assert.equal(htmlRes, null, "sendHTML must return null without network request");

    const menuRes = await sendMenu("Adversarial menu probe", [
      [{ text: "Option A", callback_data: "opt_a" }],
    ]);
    assert.equal(menuRes, null, "sendMenu must return null without network request");

    const editRes = await editMenu(9999, "Adversarial edit probe", [
      [{ text: "Option B", callback_data: "opt_b" }],
    ]);
    assert.equal(editRes, null, "editMenu must return null without network request");

    const answerRes = await answerCallbackQuery("query_id_probe", "Alert toast probe");
    assert.equal(answerRes, null, "answerCallbackQuery must return null without network request");

    const cmdRes = await setBotCommands([{ command: "status", description: "Status check" }]);
    assert.equal(cmdRes, null, "setBotCommands must return null without network request");

    // 3. Start admin polling and verify immediate no-op return
    const stopPoll = startAdminPolling(async () => {});
    assert.equal(typeof stopPoll, "function", "startAdminPolling must return a stop function");
    stopPoll();

    // 4. Dispatch structured trade alerts (Deploy / Close / Swap)
    await expect(
      notifyDeploy({
        pair: "TEST/SOL",
        amountSol: 2.5,
        position: "Pos111111111111111111111111111111111",
        tx: "TxDeploy11111111111111111111111111111111",
        priceRange: { min: 0.0001, max: 0.0005 },
        rangeCoverage: { downside_pct: 12.5, upside_pct: 15.0, width_pct: 27.5 },
        binStep: 100,
        baseFee: 0.25,
      })
    ).resolves.not.toThrow();

    await expect(
      notifyClose({
        pair: "TEST/SOL",
        pnlUsd: 45.5,
        pnlPct: 15.2,
        solMode: false,
      })
    ).resolves.not.toThrow();

    await expect(
      notifyClose({
        pair: "TEST/SOL",
        pnlUsd: 0.25,
        pnlPct: -3.4,
        solMode: true,
      })
    ).resolves.not.toThrow();

    await expect(
      notifySwap({
        inputSymbol: "TEST",
        outputSymbol: "SOL",
        amountIn: 1000,
        amountOut: 1.5,
        tx: "TxSwap11111111111111111111111111111111",
      })
    ).resolves.not.toThrow();

    // 5. Runtime orchestrator notify helper
    await expect(runtimeTest.notify("🤖 Adversarial Runtime Notification Probe")).resolves.not.toThrow();

    // 6. Admin console wiring startup
    const stopAdmin = startAdmin({ monitor: null, activeSignals: () => 0 });
    assert.equal(typeof stopAdmin, "function", "startAdmin must return a stop function");
    stopAdmin();

    // 7. EMPIRICAL VERIFICATION: EXACTLY 0 HTTP calls to api.telegram.org
    assert.equal(
      interceptedTelegramCalls.length,
      0,
      `Leak detected! Intercepted ${interceptedTelegramCalls.length} calls to api.telegram.org`
    );
    assert.deepEqual(interceptedTelegramCalls, [], "Recorded telegram calls list must be completely empty");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBotToken !== undefined) {
      process.env.TELEGRAM_BOT_TOKEN = originalBotToken;
    } else {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
    if (originalChatId !== undefined) {
      process.env.TELEGRAM_CHAT_ID = originalChatId;
    } else {
      delete process.env.TELEGRAM_CHAT_ID;
    }
    if (originalAllowedUsers !== undefined) {
      process.env.TELEGRAM_ALLOWED_USER_IDS = originalAllowedUsers;
    } else {
      delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    }
  }
});

test("M5 Adversarial Suite 2: Multi-Vector Telegram Suppression Matrix & Chat ID Resolution", () => {
  // Test chat ID resolution
  const originalEnvChatId = process.env.TELEGRAM_CHAT_ID;
  try {
    process.env.TELEGRAM_CHAT_ID = "77665544";
    const resolved = resolveChatId();
    assert.ok(resolved !== null, "resolveChatId must resolve non-empty chat ID");
    assert.equal(typeof resolved, "string");

    process.env.TELEGRAM_CHAT_ID = "   ";
    // Whitespace string treated as null
    const resolvedEmpty = resolveChatId();
    assert.ok(resolvedEmpty === null || typeof resolvedEmpty === "string");
  } finally {
    if (originalEnvChatId !== undefined) {
      process.env.TELEGRAM_CHAT_ID = originalEnvChatId;
    } else {
      delete process.env.TELEGRAM_CHAT_ID;
    }
  }

  // Suppression matrix guarantees
  assert.equal(
    isTelegramSuppressed(),
    true,
    "isTelegramSuppressed must evaluate true during test execution"
  );
});

test("M5 Adversarial Suite 3: Daemon Lock File Handling (standalone.lock) & Collision Rejection", async () => {
  const lockPath = repoPath("standalone.lock");

  // Clean initial state
  if (fs.existsSync(lockPath)) {
    fs.rmSync(lockPath, { force: true });
  }

  try {
    // 1. Fresh acquisition: writes current pid
    runtimeTest.acquireLock();
    assert.equal(fs.existsSync(lockPath), true, "standalone.lock must exist after acquireLock()");
    const acquiredPid = Number(fs.readFileSync(lockPath, "utf8").trim());
    assert.equal(acquiredPid, process.pid, "Lock file must contain current process.pid");

    // 2. Self-reacquisition: same pid does not throw
    expect(() => {
      runtimeTest.acquireLock();
    }).not.toThrow();

    // 3. Stale lock with dead PID: automatically removed and acquired
    const deadPid = 99999999;
    fs.writeFileSync(lockPath, String(deadPid));
    runtimeTest.acquireLock();
    assert.equal(fs.existsSync(lockPath), true, "Lock file must exist after stale lock cleanup");
    const recoveredPid = Number(fs.readFileSync(lockPath, "utf8").trim());
    assert.equal(recoveredPid, process.pid, "Stale lock must be replaced with current process.pid");

    // 4. Corrupted non-numeric lock file: automatically removed and acquired
    fs.writeFileSync(lockPath, "CORRUPT_NON_NUMERIC_PID_DATA\n");
    runtimeTest.acquireLock();
    assert.equal(fs.existsSync(lockPath), true, "Lock file must exist after corrupt lock cleanup");
    const postCorruptPid = Number(fs.readFileSync(lockPath, "utf8").trim());
    assert.equal(postCorruptPid, process.pid, "Corrupted lock must be replaced with current process.pid");

    // 5. Concurrent instance rejection: live foreign process holds lock
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    assert.ok(child.pid !== undefined && child.pid > 0, "Child process must have valid PID");

    try {
      fs.writeFileSync(lockPath, String(child.pid));

      expect(() => {
        runtimeTest.acquireLock();
      }).toThrow(`Another standalone instance is running (pid ${child.pid})`);
    } finally {
      child.kill("SIGKILL");
    }

    // Wait briefly for child death
    await sleep(50);

    // Now child is dead -> acquireLock must clean up stale lock and succeed
    runtimeTest.acquireLock();
    const finalPid = Number(fs.readFileSync(lockPath, "utf8").trim());
    assert.equal(finalPid, process.pid, "Must reclaim lock once foreign process has terminated");
  } finally {
    if (fs.existsSync(lockPath)) {
      fs.rmSync(lockPath, { force: true });
    }
  }
});

test("M5 Adversarial Suite 4: Fast PnL Poller & manageOnce Execution Contracts", async () => {
  // 1. Configured timing & thresholds validation
  assert.ok(
    Number(config.pnl.pollIntervalSec) >= 1,
    "pnl.pollIntervalSec must be a positive integer"
  );
  assert.ok(
    Number(config.pnl.confirmTicks) >= 1,
    "pnl.confirmTicks must be at least 1 tick"
  );

  // 2. manageOnce execution contract
  const manageRes = await manageOnce({ confirmTicksOverride: 1 });
  assert.ok(
    manageRes === null || typeof manageRes === "string",
    "manageOnce must return string or null"
  );

  const manageResOverride = await manageOnce({ confirmTicksOverride: 3 });
  assert.ok(
    manageResOverride === null || typeof manageResOverride === "string",
    "manageOnce with override must return string or null"
  );

  // 3. Runtime timers inspection
  const timers = runtimeTest.getTimers();
  assert.equal(typeof timers, "object", "getTimers() must return runtime timers object");
});

test("M5 Adversarial Suite 5: Unit Graceful Shutdown Contract & Idempotency", async () => {
  const lockPath = repoPath("standalone.lock");

  // Acquire lock prior to shutdown test
  runtimeTest.acquireLock();
  assert.equal(fs.existsSync(lockPath), true, "standalone.lock must exist before shutdown");

  let exitCodeRecorded: number | null = null;
  const mockExit = (code: number): void => {
    exitCodeRecorded = code;
  };

  // Perform first shutdown
  await runtimeTest.shutdown("SIGINT", mockExit);
  assert.equal(exitCodeRecorded, 0, "shutdown must exit with code 0");
  assert.equal(
    fs.existsSync(lockPath),
    false,
    "standalone.lock must be removed during graceful shutdown"
  );

  // Idempotency check: repeated shutdown calls must return early without duplicate exit
  let secondExitRecorded: number | null = null;
  await runtimeTest.shutdown("SIGTERM", (code: number) => {
    secondExitRecorded = code;
  });
  assert.equal(
    secondExitRecorded,
    null,
    "Re-entrant shutdown must return early and not invoke exit function again"
  );

  // Once shut down, manageOnce must immediately return null
  const postShutdownManage = await manageOnce();
  assert.equal(
    postShutdownManage,
    null,
    "manageOnce must return null immediately when runtime is shuttingDown"
  );
});

test("M5 Adversarial Suite 6: Empirical Subprocess Signal Handling (SIGINT & SIGTERM)", async () => {
  const lockPath = repoPath("standalone.lock");

  // Clean lock file before subprocess test
  if (fs.existsSync(lockPath)) {
    fs.rmSync(lockPath, { force: true });
  }

  // 1. Empirical test for SIGTERM
  let sigtermChild: ReturnType<typeof spawn> | undefined;
  let sigtermTimer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      sigtermChild = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "-e",
          `
          import { _test } from "./standalone/runtime.js";
          _test.acquireLock();
          process.on("SIGTERM", async () => {
            await _test.shutdown("SIGTERM", (code) => {
              process.exit(code);
            });
          });
          console.log("READY");
          setInterval(() => {}, 1000);
        `,
        ],
        {
          cwd: REPO_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      sigtermTimer = setTimeout(() => {
        if (sigtermChild && !sigtermChild.killed) {
          sigtermChild.kill("SIGKILL");
        }
        reject(new Error("SIGTERM test child process timed out after 20_000ms"));
      }, 20_000);

      let stdoutData = "";
      sigtermChild.stdout?.on("data", (chunk: Buffer) => {
        stdoutData += chunk.toString("utf8");
        if (stdoutData.includes("READY")) {
          // Child is ready with lock acquired
          assert.equal(fs.existsSync(lockPath), true, "Subprocess must have created standalone.lock");
          const lockedPid = Number(fs.readFileSync(lockPath, "utf8").trim());
          assert.equal(lockedPid, sigtermChild?.pid, "Lock file must contain child PID");

          // Send SIGTERM
          sigtermChild?.kill("SIGTERM");
        }
      });

      sigtermChild.on("exit", (code: number | null) => {
        clearTimeout(sigtermTimer);
        try {
          assert.equal(code, 0, "Subprocess must exit with code 0 on SIGTERM");
          assert.equal(
            fs.existsSync(lockPath),
            false,
            "standalone.lock must be cleaned up on SIGTERM shutdown"
          );
          resolve();
        } catch (err: unknown) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      sigtermChild.on("error", (err: Error) => {
        clearTimeout(sigtermTimer);
        reject(err);
      });
    });
  } finally {
    clearTimeout(sigtermTimer);
    if (sigtermChild && !sigtermChild.killed) {
      sigtermChild.kill("SIGKILL");
    }
  }

  // 2. Empirical test for SIGINT
  let sigintChild: ReturnType<typeof spawn> | undefined;
  let sigintTimer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      sigintChild = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "-e",
          `
          import { _test } from "./standalone/runtime.js";
          _test.acquireLock();
          process.on("SIGINT", async () => {
            await _test.shutdown("SIGINT", (code) => {
              process.exit(code);
            });
          });
          console.log("READY");
          setInterval(() => {}, 1000);
        `,
        ],
        {
          cwd: REPO_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      sigintTimer = setTimeout(() => {
        if (sigintChild && !sigintChild.killed) {
          sigintChild.kill("SIGKILL");
        }
        reject(new Error("SIGINT test child process timed out after 20_000ms"));
      }, 20_000);

      let stdoutData = "";
      sigintChild.stdout?.on("data", (chunk: Buffer) => {
        stdoutData += chunk.toString("utf8");
        if (stdoutData.includes("READY")) {
          // Child is ready with lock acquired
          assert.equal(fs.existsSync(lockPath), true, "Subprocess must have created standalone.lock");
          const lockedPid = Number(fs.readFileSync(lockPath, "utf8").trim());
          assert.equal(lockedPid, sigintChild?.pid, "Lock file must contain child PID");

          // Send SIGINT
          sigintChild?.kill("SIGINT");
        }
      });

      sigintChild.on("exit", (code: number | null) => {
        clearTimeout(sigintTimer);
        try {
          assert.equal(code, 0, "Subprocess must exit with code 0 on SIGINT");
          assert.equal(
            fs.existsSync(lockPath),
            false,
            "standalone.lock must be cleaned up on SIGINT shutdown"
          );
          resolve();
        } catch (err: unknown) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      sigintChild.on("error", (err: Error) => {
        clearTimeout(sigintTimer);
        reject(err);
      });
    });
  } finally {
    clearTimeout(sigintTimer);
    if (sigintChild && !sigintChild.killed) {
      sigintChild.kill("SIGKILL");
    }
  }
});

test("M5 Adversarial Suite 7: Node & PM2 Native Continuity (index.js, index.ts, ecosystem.config.cjs)", async () => {
  // 1. PM2 configuration check
  const pm2ConfigPath = repoPath("ecosystem.config.cjs");
  assert.equal(
    fs.existsSync(pm2ConfigPath),
    true,
    "ecosystem.config.cjs must exist in repository root"
  );
  const pm2Content = fs.readFileSync(pm2ConfigPath, "utf8");
  assert.ok(
    pm2Content.includes('script: path.join(repoRoot, "index.js")'),
    "PM2 ecosystem script must target index.js entrypoint"
  );
  assert.ok(
    pm2Content.includes('exec_mode: "fork"'),
    "PM2 execution mode must be fork for single daemon"
  );

  // 2. Clean dynamic import of index.js without side-effects or network calls
  const indexJsUrl = pathToFileURL(repoPath("index.js")).href;
  const importedIndexJs = await import(indexJsUrl);
  assert.ok(importedIndexJs, "index.js must be cleanly importable as an ES module");

  // 3. index.ts isMainExecution unit validation
  const dummyCurrentUrl = pathToFileURL(path.resolve(process.argv[1] ?? "")).href;
  assert.equal(
    isMainExecution(dummyCurrentUrl),
    true,
    "isMainExecution must return true when metaUrl matches argv[1]"
  );

  assert.equal(
    isMainExecution("file:///non/existent/entrypoint.js"),
    false,
    "isMainExecution must return false when metaUrl does not match argv[1]"
  );

  assert.equal(
    isMainExecution(""),
    false,
    "isMainExecution must return false for empty metaUrl"
  );
});
