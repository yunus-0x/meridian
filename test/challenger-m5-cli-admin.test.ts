// test/challenger-m5-cli-admin.test.ts — Empirical Adversarial Test Suite for M5
// Rigorously stress-tests CLI subcommands, flag validation, negative amount rejection,
// stderr JSON formatting, Telegram admin menu settings validation across all 54 paths & 8 env settings,
// and interactive setup public key & RPC validation with stream handling.
//
// Oracle Engineering Standards: Zero any, Zero unsafe type assertions.

import { describe, test, it, expect, assert, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";
import { REPO_ROOT, repoPath } from "../repo-root.js";
import { config } from "../config.js";
import {
  _test as adminTest,
  ADMIN_COMMANDS,
  parseSecretKey,
  type AdminSetting,
  type AdminSection,
  type NumberSetting,
  type EnumSetting,
  type EnvSetting,
} from "../standalone/telegram-admin.js";
import {
  CliSubcommandSchema,
  CliFlagsSchema,
  MonitorStatusOutputSchema,
  ConfigCliOutputSchema,
} from "../src/schemas/cli.js";
import { runSetup } from "../setup.js";

interface CliExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const StderrErrorSchema = z.object({
  error: z.string(),
});

const PerformanceCliOutputSchema = z.object({
  summary: z.unknown(),
  recent: z.object({
    positions: z.array(z.unknown()),
  }),
});

const WalletsCliOutputSchema = z.object({
  wallets: z.array(z.unknown()),
});

const BlacklistCliOutputSchema = z.object({
  blacklist: z.array(z.unknown()),
});

const BalanceCliOutputSchema = z.object({
  sol: z.unknown(),
  tokens: z.unknown(),
});

const PositionsCliOutputSchema = z.object({
  positions: z.unknown(),
});

const SetupWrittenConfigSchema = z.object({
  walletAddress: z.string().optional(),
  rpcUrl: z.string().optional(),
  shadowMode: z.boolean().optional(),
  _readme: z.unknown().optional(),
}).passthrough();

function runCli(args: string[], extraEnv: Record<string, string> = {}): CliExecResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DRY_RUN: "true",
    NODE_ENV: "test",
    DISABLE_TELEGRAM: "true",
    ...extraEnv,
  };
  delete env.LLM_API_KEY;
  delete env.OPENROUTER_API_KEY;
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.TELEGRAM_CHAT_ID;

  const res = spawnSync(process.execPath, ["--import=tsx", repoPath("cli.ts"), ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGKILL",
  });

  return {
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

function runCliJs(args: string[], extraEnv: Record<string, string> = {}): CliExecResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DRY_RUN: "true",
    NODE_ENV: "test",
    DISABLE_TELEGRAM: "true",
    ...extraEnv,
  };
  delete env.LLM_API_KEY;
  delete env.OPENROUTER_API_KEY;
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.TELEGRAM_CHAT_ID;

  const res = spawnSync(process.execPath, [repoPath("cli.js"), ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGKILL",
  });

  return {
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

function assertCliError(res: CliExecResult, expectedSnippet?: string | RegExp): void {
  assert.equal(res.status, 1, `Expected exit code 1, got ${res.status}. Output: ${res.stdout} / ${res.stderr}`);
  const trimmed = res.stderr.trim();
  const raw: unknown = JSON.parse(trimmed);
  const parsed = StderrErrorSchema.safeParse(raw);
  assert.ok(parsed.success, `Expected valid JSON on stderr: ${res.stderr}`);
  if (expectedSnippet instanceof RegExp) {
    assert.match(parsed.data.error, expectedSnippet);
  } else if (typeof expectedSnippet === "string") {
    assert.ok(
      parsed.data.error.includes(expectedSnippet),
      `Expected error message "${parsed.data.error}" to contain "${expectedSnippet}"`
    );
  }
}

function extractJson(text: string): unknown {
  const firstBrace = text.indexOf("\n{");
  const firstIndex = firstBrace >= 0 ? firstBrace + 1 : text.indexOf("{");
  if (firstIndex >= 0) {
    return JSON.parse(text.slice(firstIndex));
  }
  return JSON.parse(text.trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: CLI Subcommand Execution, Routing & Schema Integrity (All 17 Commands)
// ─────────────────────────────────────────────────────────────────────────────
test("Challenger M5: CLI Subcommand Execution & Schema Completeness (All 17 Subcommands)", () => {
  const expectedSubcommands = [
    "start",
    "status",
    "balance",
    "positions",
    "pnl",
    "screen",
    "pool",
    "active-bin",
    "manage",
    "close",
    "claim",
    "swap",
    "wallets",
    "blacklist",
    "performance",
    "config",
    "help",
  ] as const;

  // 1. Verify all 17 subcommands are accepted by Zod enum schema
  assert.equal(expectedSubcommands.length, 17, "Exactly 17 subcommands must be defined");
  for (const cmd of expectedSubcommands) {
    assert.equal(CliSubcommandSchema.parse(cmd), cmd);
  }
  assert.throws(() => CliSubcommandSchema.parse("invalid-command"));
  assert.throws(() => CliSubcommandSchema.parse(""));

  // 2. Subcommand: help & --help flag
  const helpRes = runCli(["help"]);
  assert.equal(helpRes.status, 0);
  assert.ok(helpRes.stdout.includes("Meridian — standalone wallet-triggered DLMM bot"));
  assert.ok(helpRes.stdout.includes("Commands:"));

  const helpFlagRes = runCli(["status", "--help"]);
  assert.equal(helpFlagRes.status, 0);
  assert.ok(helpFlagRes.stdout.includes("Meridian — standalone wallet-triggered DLMM bot"));

  // 3. Subcommand: config
  const configRes = runCli(["config"]);
  assert.equal(configRes.status, 0);
  const rawConfig: unknown = extractJson(configRes.stdout);
  const parsedConfig = ConfigCliOutputSchema.safeParse(rawConfig);
  assert.ok(parsedConfig.success, "config output matches ConfigCliOutputSchema");
  assert.equal(typeof parsedConfig.data.shadowMode, "boolean");

  // 4. Subcommand: status
  const statusRes = runCli(["status"]);
  assert.equal(statusRes.status, 0);
  const rawStatus: unknown = extractJson(statusRes.stdout);
  const parsedStatus = MonitorStatusOutputSchema.safeParse(rawStatus);
  assert.ok(parsedStatus.success, "status output matches MonitorStatusOutputSchema");

  // 5. Subcommand: performance (default 24h)
  const perfRes = runCli(["performance"]);
  assert.equal(perfRes.status, 0);
  const rawPerf: unknown = extractJson(perfRes.stdout);
  const parsedPerf = PerformanceCliOutputSchema.safeParse(rawPerf);
  assert.ok(parsedPerf.success, "performance output matches PerformanceCliOutputSchema");
  if (parsedPerf.success) {
    assert.ok(parsedPerf.data.summary !== undefined);
    assert.ok(Array.isArray(parsedPerf.data.recent.positions));
  }

  // 6. Subcommand: wallets (list)
  const walletsRes = runCli(["wallets"]);
  assert.equal(walletsRes.status, 0);
  const rawWallets: unknown = extractJson(walletsRes.stdout);
  const parsedWallets = WalletsCliOutputSchema.safeParse(rawWallets);
  assert.ok(parsedWallets.success, "wallets output matches WalletsCliOutputSchema");
  if (parsedWallets.success) {
    assert.ok(Array.isArray(parsedWallets.data.wallets));
  }

  // 7. Subcommand: blacklist (list)
  const blRes = runCli(["blacklist"]);
  assert.equal(blRes.status, 0);
  const rawBl: unknown = extractJson(blRes.stdout);
  const parsedBl = BlacklistCliOutputSchema.safeParse(rawBl);
  assert.ok(parsedBl.success, "blacklist output matches BlacklistCliOutputSchema");
  if (parsedBl.success) {
    assert.ok(Array.isArray(parsedBl.data.blacklist));
  }

  // 8. Subcommand: start (fails gracefully when lock is held by active parent)
  const lockFile = repoPath("standalone.lock");
  fs.writeFileSync(lockFile, String(process.pid));
  try {
    const startRes = runCli(["start"]);
    assertCliError(startRes, "Another standalone instance is running");
  } finally {
    fs.rmSync(lockFile, { force: true });
  }

  // 9. Subcommand: balance
  const balRes = runCli(["balance"]);
  assert.equal(balRes.status, 0);
  const rawBal: unknown = extractJson(balRes.stdout);
  const parsedBal = BalanceCliOutputSchema.safeParse(rawBal);
  assert.ok(parsedBal.success, "balance output matches BalanceCliOutputSchema");
  if (parsedBal.success) {
    assert.ok(parsedBal.data.sol !== undefined);
    assert.ok(parsedBal.data.tokens !== undefined);
  }

  // 10. Subcommand: positions
  const posRes = runCli(["positions"]);
  assert.equal(posRes.status, 0);
  const rawPos: unknown = extractJson(posRes.stdout);
  const parsedPos = PositionsCliOutputSchema.safeParse(rawPos);
  assert.ok(parsedPos.success, "positions output matches PositionsCliOutputSchema");
  if (parsedPos.success) {
    assert.ok(parsedPos.data.positions !== undefined);
  }

  // 11. Subcommand: manage
  const manageRes = runCli(["manage"]);
  assert.equal(manageRes.status, 0);

  // 12-17. Subcommands requiring flags: ensure routing handles missing flags
  assertCliError(runCli(["active-bin"]), "--pool is required");
  assertCliError(runCli(["pool"]), "--pool is required");
  assertCliError(runCli(["screen"]), "--mint is required");
  assertCliError(runCli(["pnl"]), "--pool is required");
  assertCliError(runCli(["close"]), "--position is required");
  assertCliError(runCli(["claim"]), "--position is required");
  assertCliError(runCli(["swap"]), "--amount is required");
  assertCliError(runCli(["swap", "--amount", "1"]), "--from is required");
  assertCliError(runCli(["swap", "--amount", "1", "--from", "MintA11111111111111111111111111111111"]), "--to is required");

  // Unknown command rejection
  assertCliError(runCli(["unknown-command-xyz"]), /Unknown command "unknown-command-xyz"/);
  assertCliError(runCli(["study"]), /Unknown command/);
  assertCliError(runCli(["candidates"]), /Unknown command/);
  assertCliError(runCli(["evolve"]), /Unknown command/);
  assertCliError(runCli(["deploy"]), /Unknown command/);
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: Adversarial Flag Boundaries, Missing Flags, Zero/Negative Rejection
// ─────────────────────────────────────────────────────────────────────────────
test("Challenger M5: Adversarial Boundary Validation on CLI Flags & Amounts", () => {
  // 1. Missing Flags Matrix across subcommands
  // pnl: needs --pool and --position
  assertCliError(runCli(["pnl", "--pool", "Pool11111111111111111111111111111111"]), "--position is required");
  assertCliError(runCli(["pnl", "--position", "Pos11111111111111111111111111111111"]), "--pool is required");
  assertCliError(runCli(["pnl", "--pool", "", "--position", "Pos11111111111111111111111111111111"]), "--pool is required");
  assertCliError(runCli(["pnl", "--pool", "   ", "--position", "Pos11111111111111111111111111111111"]), "--pool is required");

  // swap: needs --from, --to, --amount
  assertCliError(
    runCli(["swap", "--from", "MintA11111111111111111111111111111111", "--amount", "1.5"]),
    "--to is required"
  );
  assertCliError(
    runCli(["swap", "--to", "MintB11111111111111111111111111111111", "--amount", "1.5"]),
    "--from is required"
  );
  assertCliError(
    runCli(["swap", "--from", "MintA11111111111111111111111111111111", "--to", "MintB11111111111111111111111111111111"]),
    "--amount is required"
  );

  // 2. Zero & Negative Amounts on swap (--amount)
  const invalidAmounts = ["0", "-1", "-0.00001", "-100", "abc", "NaN", "Infinity", "-Infinity"];
  for (const amt of invalidAmounts) {
    const res = runCli([
      "swap",
      "--from",
      "MintA11111111111111111111111111111111",
      "--to",
      "MintB11111111111111111111111111111111",
      `--amount=${amt}`,
    ]);
    assertCliError(res, "--amount must be positive");
  }

  // 3. Zero & Negative Hours on performance (--hours)
  const invalidHours = ["0", "-1", "-24", "abc", "NaN", "Infinity", "-Infinity"];
  for (const h of invalidHours) {
    const res = runCli(["performance", `--hours=${h}`]);
    assertCliError(res, "--hours must be positive");
  }

  // Valid hours work cleanly
  const validHoursRes = runCli(["performance", "--hours=48"]);
  assert.equal(validHoursRes.status, 0);

  // 4. Sub-action flag requirements for wallets & blacklist
  assertCliError(runCli(["wallets", "add"]), "--wallet is required");
  assertCliError(runCli(["wallets", "add", "--wallet", ""]), "--wallet is required");
  assertCliError(runCli(["wallets", "remove"]), "--wallet is required");
  assertCliError(runCli(["wallets", "invalid_action"]), "Use wallets, wallets add, or wallets remove");

  assertCliError(runCli(["blacklist", "add"]), "--mint is required");
  assertCliError(runCli(["blacklist", "add", "--mint", ""]), "--mint is required");
  assertCliError(runCli(["blacklist", "remove"]), "--mint is required");
  assertCliError(runCli(["blacklist", "invalid_action"]), "Use blacklist, blacklist add, or blacklist remove");
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3: CLI Parity Verification (`cli.ts` vs `cli.js`)
// ─────────────────────────────────────────────────────────────────────────────
test("Challenger M5: Runtime Facade Parity (cli.ts vs cli.js)", () => {
  // Test that cli.js and cli.ts return identical exit codes and errors
  const cases: string[][] = [
    ["help"],
    ["config"],
    ["unknown-command"],
    ["screen"],
    ["pool"],
    ["pnl"],
    ["close"],
    ["claim"],
    ["swap", "--amount=0"],
    ["performance", "--hours=0"],
    ["wallets", "bogus"],
    ["blacklist", "bogus"],
  ];

  for (const args of cases) {
    const tsRes = runCli(args);
    const jsRes = runCliJs(args);

    assert.equal(
      tsRes.status,
      jsRes.status,
      `Status mismatch on [${args.join(" ")}]: ts=${tsRes.status}, js=${jsRes.status}`
    );

    if (tsRes.status === 1) {
      assertCliError(tsRes);
      assertCliError(jsRes);

      const tsErr = StderrErrorSchema.parse(JSON.parse(tsRes.stderr.trim())).error;
      const jsErr = StderrErrorSchema.parse(JSON.parse(jsRes.stderr.trim())).error;
      assert.equal(tsErr, jsErr, `Error message mismatch on [${args.join(" ")}]`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4: Telegram Admin Console — Exhaustive 54-Path & 8-Env Settings Stress
// ─────────────────────────────────────────────────────────────────────────────
test("Challenger M5: Telegram Admin Console — Exhaustive Validation Across All Settings", () => {
  const { SECTIONS, byKey, editHint, validate, sectionMenu, fmtValue, rootText } = adminTest;

  // 1. Contract & structure verification
  assert.ok(Array.isArray(SECTIONS), "SECTIONS must be an array");
  assert.equal(SECTIONS.length, 6, "Must have exactly 6 administrative sections");
  assert.ok(ADMIN_COMMANDS.length >= 6, "Must define at least 6 slash commands");

  const expectedSectionIds = ["trigger", "screening", "risk", "strategy", "exits", "rpc"];
  assert.deepEqual(
    SECTIONS.map((s: AdminSection) => s.id),
    expectedSectionIds,
    "Section IDs must match expected architectural order"
  );

  const allSettings: AdminSetting[] = SECTIONS.flatMap((s: AdminSection) => s.settings);
  assert.equal(allSettings.length, 62, "Must configure exactly 62 total settings");

  const pathBackedSettings = allSettings.filter((s: AdminSetting) => "path" in s);
  assert.equal(pathBackedSettings.length, 54, "Must configure exactly 54 live config path-backed settings");

  const envBackedSettings = allSettings.filter((s: AdminSetting) => s.type === "env");
  assert.equal(envBackedSettings.length, 8, "Must configure exactly 8 .env-backed settings");

  // 2. Iterate through every single setting and verify registration, hints, formatting, and live path
  for (const setting of allSettings) {
    assert.equal(byKey.get(setting.k), setting, `Setting ${setting.k} must be registered in byKey map`);

    const hint = editHint(setting);
    assert.ok(typeof hint === "string" && hint.length > 0, `editHint for ${setting.k} must be non-empty`);

    const formatted = fmtValue(setting);
    assert.ok(typeof formatted === "string", `fmtValue for ${setting.k} must return a string`);

    // Verify live path existence in domain config
    if ("path" in setting) {
      let currentTarget: unknown = config;
      for (const segment of setting.path) {
        function isRecord(val: unknown): val is Record<string, unknown> {
          return typeof val === "object" && val !== null;
        }
        assert.ok(
          isRecord(currentTarget),
          `Intermediate path segment for ${setting.k} must be an object`
        );
        assert.ok(
          isRecord(currentTarget) && segment in currentTarget,
          `Segment "${segment}" of path [${setting.path.join(".")}] for ${setting.k} must exist in live config`
        );
        if (isRecord(currentTarget)) {
          currentTarget = currentTarget[segment];
        }
      }
    }
  }

  // 3. Adversarial validation per type
  for (const setting of allSettings) {
    switch (setting.type) {
      case "int": {
        const minVal = setting.min ?? 0;
        const maxVal = setting.max ?? 1000;
        const validInt = Math.floor((minVal + maxVal) / 2);

        // Valid whole number
        assert.equal(validate(setting, String(validInt)), validInt);

        // Non-number throws
        assert.throws(() => validate(setting, "not_a_number"), /Must be a number/);
        assert.throws(() => validate(setting, "NaN"), /Must be a number/);

        // Float on integer throws
        assert.throws(() => validate(setting, `${validInt}.75`), /Must be a whole number/);

        // Boundary violations
        if (setting.min != null) {
          assert.throws(() => validate(setting, String(setting.min! - 1)), /Minimum is/);
        }
        if (setting.max != null) {
          assert.throws(() => validate(setting, String(setting.max! + 1)), /Maximum is/);
        }
        break;
      }
      case "float": {
        const minVal = setting.min ?? 0;
        const maxVal = setting.max ?? 1000;
        const validFloat = (minVal + maxVal) / 2;

        // Valid float
        assert.equal(validate(setting, String(validFloat)), validFloat);

        // Non-number throws
        assert.throws(() => validate(setting, "not_a_number"), /Must be a number/);
        assert.throws(() => validate(setting, "Infinity"), /Must be a number/);

        // Boundary violations
        if (setting.min != null) {
          assert.throws(() => validate(setting, String(setting.min! - 0.5)), /Minimum is/);
        }
        if (setting.max != null) {
          assert.throws(() => validate(setting, String(setting.max! + 0.5)), /Maximum is/);
        }
        break;
      }
      case "bool": {
        assert.equal(validate(setting, "on"), true);
        assert.equal(validate(setting, "ON"), true);
        assert.equal(validate(setting, "true"), true);
        assert.equal(validate(setting, "TRUE"), true);

        assert.equal(validate(setting, "off"), false);
        assert.equal(validate(setting, "OFF"), false);
        assert.equal(validate(setting, "false"), false);
        assert.equal(validate(setting, "FALSE"), false);

        assert.throws(() => validate(setting, "invalid_boolean"), /Send 'on' or 'off'/);
        assert.throws(() => validate(setting, "1"), /Send 'on' or 'off'/);
        assert.throws(() => validate(setting, "0"), /Send 'on' or 'off'/);
        break;
      }
      case "enum": {
        assert.ok(Array.isArray(setting.options) && setting.options.length > 0);
        for (const opt of setting.options) {
          assert.equal(validate(setting, opt), opt);
        }
        assert.throws(() => validate(setting, "completely_invalid_option_xyz"), /Must be one of/);
        break;
      }
      case "list": {
        assert.deepEqual(validate(setting, "itemA, itemB, itemC"), ["itemA", "itemB", "itemC"]);
        assert.deepEqual(validate(setting, "singleItem"), ["singleItem"]);
        assert.deepEqual(validate(setting, "none"), []);
        assert.deepEqual(validate(setting, "NONE"), []);
        assert.deepEqual(validate(setting, ""), []);
        break;
      }
      case "nullable": {
        assert.equal(validate(setting, "off"), null);
        assert.equal(validate(setting, "null"), null);
        assert.equal(validate(setting, "none"), null);
        assert.equal(validate(setting, "-"), null);

        assert.equal(validate(setting, "12"), 12);
        assert.equal(validate(setting, "0"), 0);

        assert.throws(() => validate(setting, "-5"), /Send a number ≥ 0, or 'off'/);
        assert.throws(() => validate(setting, "invalid_num"), /Send a number ≥ 0, or 'off'/);
        break;
      }
      case "env": {
        if (setting.kind === "url") {
          assert.equal(validate(setting, "https://api.mainnet-beta.solana.com"), "https://api.mainnet-beta.solana.com");
          assert.equal(validate(setting, "wss://api.mainnet-beta.solana.com"), "wss://api.mainnet-beta.solana.com");
          assert.equal(validate(setting, ""), "");
          assert.throws(() => validate(setting, "ftp://invalid-protocol.com"), /Must be an http\(s\):\/\/ or ws\(s\):\/\//);
          assert.throws(() => validate(setting, "plain-string"), /Must be an http\(s\):\/\/ or ws\(s\):\/\//);
        } else if (setting.kind === "secret") {
          assert.equal(validate(setting, "my_api_key_12345"), "my_api_key_12345");
          assert.throws(() => validate(setting, "api key with spaces"), /Key must not contain whitespace/);
        } else if (setting.kind === "enum") {
          assert.ok(Array.isArray(setting.options));
          for (const opt of setting.options!) {
            assert.equal(validate(setting, opt), opt);
          }
          assert.throws(() => validate(setting, "unknown_enum_choice"), /Must be one of/);
        }
        break;
      }
    }
  }

  // 4. Section Menu formatting & Inline Keyboard Payloads
  for (const section of SECTIONS) {
    const menu = sectionMenu(section);
    assert.ok(menu.text.includes(section.title), `Menu text must contain section title ${section.title}`);
    assert.ok(menu.text.includes(section.desc), `Menu text must contain section desc ${section.desc}`);
    assert.ok(Array.isArray(menu.keyboard), `Menu keyboard must be an array`);

    // Every setting must have a corresponding row in the keyboard
    assert.equal(menu.keyboard.length, section.settings.length + 1, "Must have row per setting + 1 back row");

    for (let i = 0; i < section.settings.length; i++) {
      const s = section.settings[i]!;
      const row = menu.keyboard[i]!;
      assert.equal(row.length, 1, "Each setting button is full-width");
      const btn = row[0]!;
      assert.ok(btn.text.includes(s.label ?? s.k));

      if (s.type === "bool") {
        assert.equal(btn.callback_data, `t:${s.k}`, "Boolean settings use 't:' toggle prefix");
      } else {
        assert.equal(btn.callback_data, `e:${s.k}`, "Non-boolean settings use 'e:' edit prefix");
      }
    }

    // Last row is back button
    const lastRow = menu.keyboard[menu.keyboard.length - 1]!;
    assert.equal(lastRow[0]!.callback_data, "s:root");
    assert.ok(lastRow[0]!.text.includes("Back"));
  }

  // 5. Root Menu Formatting
  assert.ok(rootText().includes("<b>⚙️ Meridian admin</b>"));
  assert.ok(rootText("Custom Status Note").includes("Custom Status Note"));
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5: Keypair SecretKey Parsing & Admin Interface Integrity
// ─────────────────────────────────────────────────────────────────────────────
test("Challenger M5: SecretKey Parser & Admin Cryptographic Verification", () => {
  // 1. Valid Keypair generation and base58 encoding
  const kp = Keypair.generate();
  const b58Str = bs58.encode(kp.secretKey);
  const parsedFromB58 = parseSecretKey(b58Str);
  assert.equal(parsedFromB58.publicKey.toBase58(), kp.publicKey.toBase58());

  // 2. Valid Keypair JSON byte array encoding
  const jsonArrStr = JSON.stringify(Array.from(kp.secretKey));
  const parsedFromJson = parseSecretKey(jsonArrStr);
  assert.equal(parsedFromJson.publicKey.toBase58(), kp.publicKey.toBase58());

  // 3. Adversarial / Malformed Key inputs
  assert.throws(() => parseSecretKey(""), /bad length/);
  assert.throws(() => parseSecretKey("not_a_base58_key_string!@#$"), /Non-base58 character/);
  assert.throws(() => parseSecretKey(JSON.stringify([1, 2, 3])), /bad array/);
  assert.throws(() => parseSecretKey(JSON.stringify(new Array(32).fill(1))), /bad array/);
  assert.throws(() => parseSecretKey(JSON.stringify(new Array(65).fill(1))), /bad array/);
  assert.throws(() => parseSecretKey("   [broken json"));
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 6: Interactive Setup (`setup.ts`) Stream Handling & Validation
// ─────────────────────────────────────────────────────────────────────────────
test("Challenger M5: Interactive Setup (`setup.ts`) Public Key, RPC & Stream Handling", async () => {
  const tmpDir = os.tmpdir();

  // Test Case 1: Valid Public Key and Valid HTTPS RPC URL
  {
    const tmpConfig = path.join(tmpDir, `setup-test-valid-${Date.now()}.json`);
    const input = new PassThrough();
    const output = new PassThrough();

    const testKp = Keypair.generate();
    const validPubkey = testKp.publicKey.toBase58();
    const validRpc = "https://mainnet.helius-rpc.com/?api-key=test12345";

    const setupPromise = runSetup({ configFile: tmpConfig, input, output });

    input.write(`${validPubkey}\n`);
    await new Promise((r) => setTimeout(r, 20));
    input.write(`${validRpc}\n`);
    await setupPromise;
    input.end();

    assert.ok(fs.existsSync(tmpConfig), "Config file must be created");
    const rawContent: unknown = JSON.parse(fs.readFileSync(tmpConfig, "utf8"));
    const parsedSetup = SetupWrittenConfigSchema.safeParse(rawContent);
    assert.ok(parsedSetup.success, "setup config matches schema");
    if (parsedSetup.success) {
      assert.equal(parsedSetup.data.walletAddress, validPubkey);
      assert.equal(parsedSetup.data.rpcUrl, validRpc);
      assert.equal(parsedSetup.data.shadowMode, true);
      assert.equal(parsedSetup.data._readme, undefined, "_readme must be deleted from written config");
    }

    // File mode check (0o600)
    const stat = fs.statSync(tmpConfig);
    assert.equal(stat.mode & 0o777, 0o600, "File mode must be 0o600");

    fs.rmSync(tmpConfig, { force: true });
  }

  // Test Case 2: Blank Inputs (Retain defaults / prior)
  {
    const tmpConfig = path.join(tmpDir, `setup-test-blank-${Date.now()}.json`);
    const input = new PassThrough();
    const output = new PassThrough();

    const setupPromise = runSetup({ configFile: tmpConfig, input, output });

    input.write("\n");
    await new Promise((r) => setTimeout(r, 20));
    input.write("\n");
    await setupPromise;
    input.end();

    const rawContent: unknown = JSON.parse(fs.readFileSync(tmpConfig, "utf8"));
    const parsedSetup = SetupWrittenConfigSchema.safeParse(rawContent);
    assert.ok(parsedSetup.success, "setup config matches schema");
    if (parsedSetup.success) {
      assert.equal(parsedSetup.data.shadowMode, true);
      assert.equal(parsedSetup.data.walletAddress, "");
    }

    fs.rmSync(tmpConfig, { force: true });
  }

  // Test Case 3: Adversarial Public Key Rejection
  {
    const tmpConfig = path.join(tmpDir, `setup-test-badkey-${Date.now()}.json`);
    const input = new PassThrough();
    const output = new PassThrough();

    const setupPromise = runSetup({ configFile: tmpConfig, input, output });

    input.write("invalid_solana_pubkey_that_is_not_base58!\n");

    await expect(setupPromise).rejects.toThrow(/Non-base58 character|Invalid public key input/);
    input.end();
    fs.rmSync(tmpConfig, { force: true });
  }

  // Test Case 4: Non-HTTP/HTTPS RPC URL Rejection
  {
    const tmpConfig = path.join(tmpDir, `setup-test-badrpc-${Date.now()}.json`);
    const input = new PassThrough();
    const output = new PassThrough();

    const setupPromise = runSetup({ configFile: tmpConfig, input, output });

    input.write("11111111111111111111111111111111\n");
    await new Promise((r) => setTimeout(r, 20));
    input.write("ftp://invalid-rpc-node.com\n");

    await expect(setupPromise).rejects.toThrow(/RPC URL must use HTTP or HTTPS/);
    input.end();
    fs.rmSync(tmpConfig, { force: true });
  }

  // Test Case 5: Malformed RPC URL Rejection
  {
    const tmpConfig = path.join(tmpDir, `setup-test-malformed-${Date.now()}.json`);
    const input = new PassThrough();
    const output = new PassThrough();

    const setupPromise = runSetup({ configFile: tmpConfig, input, output });

    input.write("11111111111111111111111111111111\n");
    await new Promise((r) => setTimeout(r, 20));
    input.write("completely_invalid_url\n");

    await expect(setupPromise).rejects.toThrow(/Invalid URL/);
    input.end();
    fs.rmSync(tmpConfig, { force: true });
  }
});
