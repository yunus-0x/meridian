// test/challenger-m5.test.ts — Comprehensive Test Suite for Milestone 5
// Covers: telegram.ts, standalone/telegram-admin.ts, src/schemas/cli.ts,
// standalone/runtime.ts, setup.ts, scripts/check-syntax.ts, scripts/envcrypt.ts.

import { describe, test, it, expect, assert, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { REPO_ROOT } from "../repo-root.js";
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
  notifyDeploy,
  notifyClose,
  notifySwap,
} from "../telegram.js";
import {
  _test as adminTest,
  ADMIN_COMMANDS,
  parseSecretKey,
  startAdmin,
} from "../standalone/telegram-admin.js";
import {
  CliSubcommandSchema,
  CliFlagsSchema,
  MonitorStatusOutputSchema,
  ConfigCliOutputSchema,
} from "../src/schemas/cli.js";
import {
  manageOnce,
  DeployExecutionResultSchema,
  _test as runtimeTest,
} from "../standalone/runtime.js";
import { checkSyntax } from "../scripts/check-syntax.js";
import { usage as envcryptUsage } from "../scripts/envcrypt.js";

test("M5 Suite 1: Multi-layer Telegram Suppression & Alert Safety", async () => {
  // 1. Suppression checks
  assert.equal(isTelegramSuppressed(), true, "Telegram must be suppressed in test environment");
  assert.equal(isTelegramEnabled(), false, "isEnabled() must return false when suppressed");

  // 2. Safe execution when suppressed (never throws, never calls network)
  const sendRes = await sendMessage("Hello test");
  assert.equal(sendRes, null, "sendMessage returns null when suppressed");

  const htmlRes = await sendHTML("<b>Hello</b> test");
  assert.equal(htmlRes, null, "sendHTML returns null when suppressed");

  const menuRes = await sendMenu("Menu test", [[{ text: "Btn", callback_data: "data" }]]);
  assert.equal(menuRes, null, "sendMenu returns null when suppressed");

  const editRes = await editMenu(12345, "Edit test", [[{ text: "Btn", callback_data: "data" }]]);
  assert.equal(editRes, null, "editMenu returns null when suppressed");

  const answerRes = await answerCallbackQuery("cb123", "Alert text");
  assert.equal(answerRes, null, "answerCallbackQuery returns null when suppressed");

  const cmdsRes = await setBotCommands([{ command: "menu", description: "Menu" }]);
  assert.equal(cmdsRes, null, "setBotCommands returns null when suppressed");

  // 3. Trade alerts execute cleanly without sending real messages
  await expect(
    notifyDeploy({
      pair: "TEST/SOL",
      amountSol: 1.5,
      position: "Pos111111111111111111111111111111111",
      tx: "Tx11111111111111111111111111111111111111111",
      priceRange: { min: 0.00012, max: 0.00035 },
      rangeCoverage: { downside_pct: 15, upside_pct: 20, width_pct: 35 },
      binStep: 100,
      baseFee: 0.25,
    })
  ).resolves.not.toThrow();

  await expect(
    notifyClose({
      pair: "TEST/SOL",
      pnlUsd: 25.5,
      pnlPct: 12.3,
      solMode: false,
    })
  ).resolves.not.toThrow();

  await expect(
    notifyClose({
      pair: "TEST/SOL",
      pnlUsd: 0.15,
      pnlPct: -5.2,
      solMode: true,
    })
  ).resolves.not.toThrow();

  await expect(
    notifySwap({
      inputSymbol: "TEST",
      outputSymbol: "SOL",
      amountIn: 1000,
      amountOut: 1.25,
      tx: "TxSwap11111111111111111111111111111111",
    })
  ).resolves.not.toThrow();
});

test("M5 Suite 2: Telegram Admin Console & Schema Integrity", () => {
  const { SECTIONS, byKey, editHint, validate, sectionMenu, fmtValue, rootText } = adminTest;
  assert.ok(Array.isArray(SECTIONS), "SECTIONS is an array");
  assert.equal(SECTIONS.length, 6, "Has exactly 6 settings sections");
  assert.ok(ADMIN_COMMANDS.length >= 6, "Has all admin commands");

  // Check all section IDs
  const sectionIds = SECTIONS.map((s) => s.id);
  assert.deepEqual(sectionIds, ["trigger", "screening", "risk", "strategy", "exits", "rpc"]);

  // Keypair parsing
  const testKp = Keypair.generate();
  const b58Secret = bs58.encode(testKp.secretKey);
  const parsedFromB58 = parseSecretKey(b58Secret);
  assert.equal(parsedFromB58.publicKey.toBase58(), testKp.publicKey.toBase58());

  const jsonArrSecret = JSON.stringify(Array.from(testKp.secretKey));
  const parsedFromJson = parseSecretKey(jsonArrSecret);
  assert.equal(parsedFromJson.publicKey.toBase58(), testKp.publicKey.toBase58());

  assert.throws(() => parseSecretKey("invalid_secret_key"));
  assert.throws(() => parseSecretKey(JSON.stringify([1, 2, 3])));

  // Value formatting and validation
  const intSetting = byKey.get("walletThreshold");
  assert.ok(intSetting);
  assert.equal(validate(intSetting, "3"), 3);
  assert.throws(() => validate(intSetting, "abc"));
  assert.throws(() => validate(intSetting, "0")); // below min 1

  const floatSetting = byKey.get("stopLossPct");
  assert.ok(floatSetting);
  assert.equal(validate(floatSetting, "-15.5"), -15.5);
  assert.throws(() => validate(floatSetting, "5")); // above max 0

  const boolSetting = byKey.get("trailingTakeProfit");
  assert.ok(boolSetting);
  assert.equal(validate(boolSetting, "on"), true);
  assert.equal(validate(boolSetting, "off"), false);
  assert.throws(() => validate(boolSetting, "invalid"));

  const listSetting = byKey.get("allowedLaunchpads");
  assert.ok(listSetting);
  assert.deepEqual(validate(listSetting, "pump, meteora"), ["pump", "meteora"]);
  assert.deepEqual(validate(listSetting, "none"), []);

  const envSetting = byKey.get("ENV:RPC_URL");
  assert.ok(envSetting);
  assert.equal(validate(envSetting, "https://mainnet.helius-rpc.com/?api-key=test"), "https://mainnet.helius-rpc.com/?api-key=test");
  assert.throws(() => validate(envSetting, "ftp://invalid-url"));

  // Text formatting
  assert.ok(rootText().includes("Meridian admin"));
  assert.ok(rootText("Custom Note").includes("Custom Note"));
});

test("M5 Suite 3: CLI Subcommand & Flags Schemas", () => {
  // Validate CLI subcommands enum
  const validSubcommands = [
    "start", "status", "balance", "positions", "pnl", "screen",
    "pool", "active-bin", "manage", "close", "claim", "swap",
    "wallets", "blacklist", "performance", "config", "help"
  ];
  for (const cmd of validSubcommands) {
    assert.equal(CliSubcommandSchema.parse(cmd), cmd);
  }
  assert.throws(() => CliSubcommandSchema.parse("invalid_subcommand"));

  // Validate Flags schema
  const parsedFlags = CliFlagsSchema.parse({
    wallet: "11111111111111111111111111111111",
    pool: "Pool11111111111111111111111111111111",
    "dry-run": true,
    amount: "1.5",
  });
  assert.equal(parsedFlags["dry-run"], true);
  assert.equal(parsedFlags.amount, "1.5");

  // Validate MonitorStatus schema
  const validStatus = MonitorStatusOutputSchema.parse({
    started: true,
    shadow: true,
    pending_transactions: 0,
    wallets: {},
  });
  assert.equal(validStatus.started, true);
  assert.equal(validStatus.shadow, true);

  // Validate ConfigCli output schema
  const validConfig = ConfigCliOutputSchema.parse({
    shadowMode: true,
    risk: { maxPositions: 3 },
    screening: { minOrganic: 60 },
    management: { gasReserve: 0.2 },
    strategy: { defaultBinsBelow: 45 },
    schedule: { managementIntervalMin: 10 },
  });
  assert.equal(validConfig.shadowMode, true);
});

test("M5 Suite 4: Utility Scripts (Syntax Checker & Envcrypt CLI)", () => {
  // 1. checkSyntax utility
  const syntaxPass = checkSyntax({ dir: REPO_ROOT });
  assert.equal(syntaxPass, true, "Syntax checker passes across repository");

  // 2. envcrypt usage
  expect(() => {
    envcryptUsage();
  }).not.toThrow();
});

test("M5 Suite 5: Standalone Runtime Contracts & Deterministic Execution", async () => {
  // 1. DeployExecutionResultSchema boundary validation
  const validDeployResult = DeployExecutionResultSchema.parse({
    success: true,
    dry_run: true,
    position: "pos123",
    txs: ["tx123"],
    amountSol: 1.0,
  });
  assert.equal(validDeployResult.success, true);
  assert.equal(validDeployResult.dry_run, true);

  const blockedResult = DeployExecutionResultSchema.parse({
    blocked: true,
    reason: "Portfolio full",
  });
  assert.equal(blockedResult.blocked, true);

  // 2. manageOnce dry-run execution
  const res = await manageOnce({ confirmTicksOverride: 1 });
  assert.ok(res === null || typeof res === "string");

  // 3. Runtime test harness hooks
  assert.ok(typeof runtimeTest.acquireLock === "function");
  assert.ok(typeof runtimeTest.drainSignals === "function");
  assert.ok(typeof runtimeTest.attemptEntry === "function");
  assert.ok(typeof runtimeTest.finalRecheck === "function");
  assert.ok(typeof runtimeTest.notify === "function");
  assert.ok(typeof runtimeTest.getTimers === "function");
  assert.ok(typeof runtimeTest.getSignalQueue === "function");
});
