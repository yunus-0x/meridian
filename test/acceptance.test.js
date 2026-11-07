/**
 * Meridian Acceptance Test Suite (Tiers 1-4)
 * Requirement-driven & Opaque-box testing mapping Features 1-27 from PROJECT.md.
 *
 * Run: npx tsx --test test/acceptance.test.js
 */

process.env.NODE_ENV = 'test';
process.env.DISABLE_TELEGRAM = 'true';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { REPO_ROOT, repoPath } from '../repo-root.js';
import { log, logAction } from '../logger.js';
import { envryptEncrypt, envryptDecrypt } from '../envcrypt.js';
import { addSmartWallet, removeSmartWallet, listSmartWallets } from '../smart-wallets.js';
import { isBlacklisted, addToBlacklist, removeFromBlacklist, listBlacklist } from '../token-blacklist.js';
import { isDevBlocked, blockDev, unblockDev, listBlockedDevs } from '../dev-blocklist.js';
import { appendDecision, getRecentDecisions, getDecisionSummary } from '../decision-log.js';
import { config, computeDeployAmount } from '../config.js';
import { getDeterministicCloseRule, computeBinsBelow } from '../exit-rules.js';
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  minutesOutOfRange,
  isPostClaimSettling,
  POST_CLAIM_SETTLE_MS,
  confirmPeak,
  recordClose,
  getTrackedPosition,
  getTrackedPositions,
  syncOpenPositions,
} from '../state.js';
import { recordPerformance, getPerformanceHistory, getPerformanceSummary } from '../performance.js';
import { addPoolNote, getPoolMemory } from '../pool-memory.js';
import { connection, readRpc, fetchJson } from '../standalone/rpc.js';
import { aggregateTokenAccounts } from '../standalone/balances.js';
import { withWalletLock } from '../standalone/transactions.js';
import { decodeEvents, DLMM_PROGRAM } from '../standalone/events.js';
import { MonitorStore, qualifyingEvents, acceptEvents, finishSignal } from '../standalone/store.js';
import { normalizeMint } from '../tools/wallet.js';
import { executeTool } from '../tools/executor.js';
import { rejectToken, rejectPool } from '../standalone/screening.js';
import { localQuantizedForecast, buildTacticalSignals } from '../standalone/chronos.js';
import { isEnabled as isTelegramEnabled, notifyDeploy, notifyClose, notifySwap } from '../telegram.js';
import { _test as adminTest } from '../standalone/telegram-admin.js';

const require = createRequire(import.meta.url);

function runCli(args, extraEnv = {}) {
  const env = { ...process.env, DRY_RUN: 'true', NODE_ENV: 'test', DISABLE_TELEGRAM: 'true', ...extraEnv };
  delete env.LLM_API_KEY;
  delete env.OPENROUTER_API_KEY;
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.TELEGRAM_CHAT_ID;
  return spawnSync(process.execPath, ['cli.js', ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

const BACKED_UP_FILES = [
  'smart-wallets.json',
  'token-blacklist.json',
  'dev-blocklist.json',
  'decision-log.json',
  'state.json',
];

const backups = new Map();

before(() => {
  for (const name of BACKED_UP_FILES) {
    const fullPath = repoPath(name);
    if (fs.existsSync(fullPath)) {
      backups.set(name, fs.readFileSync(fullPath, 'utf8'));
    }
  }
});

after(() => {
  for (const name of BACKED_UP_FILES) {
    const fullPath = repoPath(name);
    if (backups.has(name)) {
      fs.writeFileSync(fullPath, backups.get(name));
    } else if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TIER 1: Feature Baseline & Happy Path Coverage (Features 1-5, 8, 14, 21-26)
// ─────────────────────────────────────────────────────────────────────────────
describe('Tier 1: Feature Baseline & Happy Path Coverage', () => {
  test('F1 & F25: PM2 ecosystem config and daemon entrypoint integrity', () => {
    const ecosystemPath = repoPath('ecosystem.config.cjs');
    assert.ok(fs.existsSync(ecosystemPath), 'ecosystem.config.cjs must exist');
    const ecosystem = require(ecosystemPath);
    assert.ok(Array.isArray(ecosystem.apps) && ecosystem.apps.length > 0, 'apps array configured');
    const app = ecosystem.apps[0];
    assert.equal(app.name, 'meridian');
    assert.equal(app.script, path.join(REPO_ROOT, 'index.js'));
    assert.equal(app.interpreter, 'node');
    assert.equal(app.exec_mode, 'fork');

    const indexContent = fs.readFileSync(repoPath('index.js'), 'utf8');
    assert.match(indexContent, /import "\.\/envcrypt\.js"/);
    assert.match(indexContent, /startStandalone/);
  });

  test('F3: Core storage & utilities (repoPath, logger, decision-log, envcrypt)', () => {
    assert.equal(repoPath('test-subpath'), path.join(REPO_ROOT, 'test-subpath'));

    // Logger writes without throwing
    assert.doesNotThrow(() => {
      log('test_cat', 'Unit test log message');
      logAction({ tool: 'get_wallet_balance', success: true, duration_ms: 12, result: { sol: 1.5 } });
    });

    // Decision-log append and read (including BigInt serialization)
    const dec = appendDecision({
      type: 'test_decision',
      actor: 'TEST_WRITER',
      pool: 'PoolTest111111111111111111111111111111111',
      pool_name: 'TEST-SOL',
      summary: 'Acceptance test summary',
      reason: 'Validation of decision logging mechanism',
      risks: ['risk1', 'risk2'],
      metrics: { lamports: 1000000000n },
    });
    assert.ok(dec.id && dec.id.startsWith('dec_'));
    assert.equal(dec.actor, 'TEST_WRITER');
    assert.equal(dec.metrics.lamports, '1000000000');
    const recent = getRecentDecisions(5);
    assert.ok(recent.some(d => d.id === dec.id));
    const summary = getDecisionSummary(5);
    assert.match(summary, /TEST_WRITER/);

    // Envcrypt roundtrip
    const secret = 'super-secret-key-12345';
    const key = 'encryption-key-passphrase';
    const encrypted = envryptEncrypt(secret, key);
    assert.notEqual(encrypted, secret);
    const decrypted = envryptDecrypt(encrypted, key);
    assert.equal(decrypted, secret);
  });

  test('F4: Smart wallets, token blacklist and dev blocklist CRUD operations', () => {
    const testWallet = 'Wa11t11111111111111111111111111111111111111';
    const addRes = addSmartWallet({ name: 'AlphaWhale', address: testWallet, category: 'alpha', type: 'lp' });
    assert.equal(addRes.success, true);
    assert.equal(addRes.wallet.name, 'AlphaWhale');

    const listRes = listSmartWallets();
    assert.ok(listRes.wallets.some(w => w.address === testWallet));

    const removeRes = removeSmartWallet({ address: testWallet });
    assert.equal(removeRes.success, true);
    assert.equal(removeRes.removed, 'AlphaWhale');

    // Token blacklist CRUD
    const testMint = 'BadMint111111111111111111111111111111111111';
    assert.equal(isBlacklisted(testMint), false);
    const blAdd = addToBlacklist({ mint: testMint, symbol: 'RUG', reason: 'Malicious dev drain' });
    assert.equal(blAdd.blacklisted, true);
    assert.equal(isBlacklisted(testMint), true);
    const blList = listBlacklist();
    assert.ok(blList.blacklist.some(t => t.mint === testMint));
    const blRem = removeFromBlacklist({ mint: testMint });
    assert.equal(blRem.removed, true);
    assert.equal(isBlacklisted(testMint), false);

    // Dev blocklist CRUD
    const testDev = 'Dev11111111111111111111111111111111111111111';
    assert.equal(isDevBlocked(testDev), false);
    const devAdd = blockDev({ wallet: testDev, label: 'SerialRugger', reason: 'Multiple abandoned pools' });
    assert.equal(devAdd.blocked, true);
    assert.equal(isDevBlocked(testDev), true);
    const devList = listBlockedDevs();
    assert.ok(devList.blocked_devs.some(d => d.wallet === testDev));
    const devRem = unblockDev({ wallet: testDev });
    assert.equal(devRem.unblocked, true);
    assert.equal(isDevBlocked(testDev), false);
  });

  test('F5: Config management structure and computeDeployAmount dynamic compounding', () => {
    assert.ok(config.standalone && typeof config.standalone === 'object');
    assert.ok(config.risk && typeof config.risk === 'object');
    assert.ok(config.screening && typeof config.screening === 'object');
    assert.ok(config.management && typeof config.management === 'object');
    assert.ok(config.strategy && typeof config.strategy === 'object');

    // computeDeployAmount scaling
    const smallWallet = computeDeployAmount(0.5);
    assert.ok(typeof smallWallet === 'number');
    assert.ok(smallWallet >= 0);

    const midWallet = computeDeployAmount(10.0, 1.0);
    assert.ok(midWallet >= config.management.deployAmountSol);
    assert.ok(midWallet <= config.risk.maxDeployAmount);

    // Conviction multiplier sensitivity (clamped to [0.75, 1.25])
    const lowConv = computeDeployAmount(10.0, 0.5);
    const highConv = computeDeployAmount(10.0, 1.5);
    assert.ok(highConv >= lowConv, `highConv (${highConv}) should be >= lowConv (${lowConv})`);
  });

  test('F8: Performance tracking and pool memory', () => {
    const summary = getPerformanceSummary();
    assert.ok(summary === null || typeof summary === 'object');

    const history = getPerformanceHistory({ hours: 24 });
    assert.ok(Array.isArray(history.positions));

    const pool = 'PoolMemTest1111111111111111111111111111111';
    addPoolNote({ pool_address: pool, note: 'Tested note insertion' });
    const mem = getPoolMemory({ pool_address: pool });
    assert.ok(mem && mem.notes.some(n => n.note === 'Tested note insertion'));
  });

  test('F14 & F21 & F22: Wallet mint normalization, Telegram formatting, and Admin UI schema', async () => {
    assert.equal(normalizeMint('So11111111111111111111111111111111111111112'), 'So11111111111111111111111111111111111111112');
    assert.equal(normalizeMint('SOL'), 'So11111111111111111111111111111111111111112');
    assert.equal(normalizeMint('native'), 'So11111111111111111111111111111111111111112');

    // Telegram formatters execute safely (mocked to prevent spamming user's live bot)
    assert.equal(typeof isTelegramEnabled(), 'boolean');
    assert.equal(isTelegramEnabled(), false);
    await assert.doesNotReject(async () => {
      await notifyDeploy({ pair: 'TEST/SOL', amountSol: 1, position: 'pos123', tx: 'tx123' });
      await notifyClose({ pair: 'TEST/SOL', pnlUsd: 10, pnlPct: 5, solMode: false });
      await notifySwap({ inputSymbol: 'TEST', outputSymbol: 'SOL', amountIn: 100, amountOut: 1, tx: 'tx123' });
    });

    // Admin UI Schema verification
    const { SECTIONS, byKey, validate, fmtValue } = adminTest;
    assert.ok(SECTIONS.length >= 6);
    const sectionIds = SECTIONS.map(s => s.id);
    assert.deepEqual(sectionIds, ['trigger', 'screening', 'risk', 'strategy', 'exits', 'rpc']);

    const riskSection = SECTIONS.find(s => s.id === 'risk');
    assert.ok(riskSection && riskSection.settings.length > 0);
    const maxPos = byKey.get('maxPositions');
    assert.ok(maxPos);
    assert.equal(validate(maxPos, '5'), 5);
    assert.match(fmtValue(maxPos), /\d+/);
  });

  test('F24 & F26: CLI 17 subcommands and utility scripts invocation', () => {
    // 1. Help command advertising all 17 subcommands
    const helpRes = runCli(['help']);
    assert.equal(helpRes.status, 0);
    const expectedSubcommands = [
      'start', 'status', 'balance', 'positions', 'pnl', 'screen',
      'pool', 'active-bin', 'manage', 'close', 'claim', 'swap',
      'wallets', 'blacklist', 'performance', 'config', 'help',
    ];
    for (const cmd of expectedSubcommands) {
      assert.match(helpRes.stdout, new RegExp(`\\b${cmd}\\b`), `CLI help must list subcommand '${cmd}'`);
    }

    // 2. Config command
    const configRes = runCli(['config']);
    assert.equal(configRes.status, 0);
    const parsedConfig = JSON.parse(configRes.stdout);
    assert.ok('risk' in parsedConfig && 'screening' in parsedConfig);

    // 3. Wallets list command
    const walletsRes = runCli(['wallets']);
    assert.equal(walletsRes.status, 0);
    const parsedWallets = JSON.parse(walletsRes.stdout);
    assert.ok('wallets' in parsedWallets);

    // 4. Blacklist list command
    const blRes = runCli(['blacklist']);
    assert.equal(blRes.status, 0);
    const parsedBl = JSON.parse(blRes.stdout);
    assert.ok('blacklist' in parsedBl);

    // 5. Scripts syntax verification script
    const syntaxRes = spawnSync(process.execPath, ['scripts/check-syntax.js'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(syntaxRes.status, 0, syntaxRes.stderr);

    // 6. Scripts envrypt CLI
    const envcryptCli = spawnSync(process.execPath, ['scripts/envrypt.js'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(envcryptCli.status, 0);
    assert.match(envcryptCli.stdout, /Usage:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TIER 2: Boundary, Corner & Adversarial Cases (Features 2, 4, 9, 10, 17, 18)
// ─────────────────────────────────────────────────────────────────────────────
describe('Tier 2: Boundary, Corner & Adversarial Integrity', () => {
  test('F4 & F2: Corrupted/unreadable safety blacklist throws explicit descriptive error', () => {
    const blacklistFile = repoPath('token-blacklist.json');
    const blocklistFile = repoPath('dev-blocklist.json');

    const origBlacklist = fs.existsSync(blacklistFile) ? fs.readFileSync(blacklistFile, 'utf8') : null;
    const origBlocklist = fs.existsSync(blocklistFile) ? fs.readFileSync(blocklistFile, 'utf8') : null;

    try {
      // 1. Genuinely test token-blacklist.ts error branch on unreadable/corrupted file
      fs.writeFileSync(blacklistFile, 'MALFORMED_JSON_CONTENT{{{');
      assert.throws(
        () => isBlacklisted('Mint111111111111111111111111111111111111'),
        /Safety blacklist is unreadable:/
      );

      // 2. Genuinely test dev-blocklist.ts error branch on unreadable/corrupted file
      fs.writeFileSync(blocklistFile, 'MALFORMED_JSON_CONTENT{{{');
      assert.throws(
        () => isDevBlocked('Dev1111111111111111111111111111111111111'),
        /Safety blocklist is unreadable:/
      );
    } finally {
      if (origBlacklist !== null) {
        fs.writeFileSync(blacklistFile, origBlacklist);
      } else if (fs.existsSync(blacklistFile)) {
        fs.unlinkSync(blacklistFile);
      }

      if (origBlocklist !== null) {
        fs.writeFileSync(blocklistFile, origBlocklist);
      } else if (fs.existsSync(blocklistFile)) {
        fs.unlinkSync(blocklistFile);
      }
    }
  });

  test('F4: Solana public key boundary validation', () => {
    const invalidKeys = [
      'too-short',
      '00000000000000000000000000000000000000000000',
      'IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII',
      'llllllllllllllllllllllllllllllllllllllllllll',
      'OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO',
      'z'.repeat(44),
      '',
      null,
    ];

    for (const key of invalidKeys) {
      const res = addSmartWallet({ name: 'BadKey', address: key });
      assert.equal(res.success, false);
      assert.equal(res.error, 'Invalid Solana address format');
    }
  });

  test('F9: Solana RPC Client boundary validation & missing RPC_URL handling', async () => {
    assert.throws(
      () => connection(''),
      /Configure RPC_URL/
    );

    assert.throws(
      () => connection('ftp://rpc.solana.com'),
      /`http:` or `https:`/i
    );
  });

  test('F10: Token balance aggregation edge cases (zero balance, decimal conflict, program merge)', () => {
    const MINT = 'MintAgg111111111111111111111111111111111111';
    const acct = (mint, amount, decimals) => ({
      account: { data: { parsed: { info: { mint, tokenAmount: { amount: String(amount), decimals } } } } },
    });

    // 1. Zero balances dropped
    const respZero = [{ value: [acct('MINT_A', 0, 6)] }];
    assert.deepEqual(aggregateTokenAccounts(respZero), []);

    // 2. Aggregate across programs
    const respMulti = [
      { value: [acct(MINT, 1000, 6)] },
      { value: [acct(MINT, 2500, 6)] },
    ];
    const agg = aggregateTokenAccounts(respMulti);
    assert.equal(agg.length, 1);
    assert.equal(agg[0].mint, MINT);
    assert.equal(agg[0].balance, 0.0035);

    // 3. Conflicting decimals thrown
    const respConflict = [
      { value: [acct(MINT, 1, 6)] },
      { value: [acct(MINT, 1, 9)] },
    ];
    assert.throws(() => aggregateTokenAccounts(respConflict), /Conflicting token decimals/i);
  });

  test('F17 & F24: Tool executor & CLI boundary enforcement (missing flags, invalid amounts)', async () => {
    // Missing flags in CLI
    const missingMint = runCli(['screen']);
    assert.equal(missingMint.status, 1);
    assert.match(missingMint.stderr, /--mint is required/);

    const missingPool = runCli(['pnl', '--position', 'pos1']);
    assert.equal(missingPool.status, 1);
    assert.match(missingPool.stderr, /--pool is required/);

    // Non-positive amount in swap CLI
    const negSwap = runCli(['swap', '--from', 'MINT1', '--to', 'MINT2', '--amount', '0']);
    assert.equal(negSwap.status, 1);
    assert.match(negSwap.stderr, /--amount must be positive/);

    // Executor returns error for unknown tool
    const res = await executeTool('unknown_hypothetical_tool', {});
    assert.match(res.error, /Unknown tool/i);
  });

  test('F18: Token & Pool screening rejection guards', () => {
    const mint = 'TargetMint111111111111111111111111111111111';
    const settings = {
      minTokenFeesSol: 30,
      maxBotHoldersPct: 30,
      maxTop10Pct: 60,
      minTvl: 10_000,
      maxTvl: 150_000,
      minBinStep: 80,
      maxBinStep: 125,
      minOrganic: 60,
      minQuoteOrganic: 60,
      minHolders: 500,
      allowedLaunchpads: [],
      blockedLaunchpads: [],
    };

    // Stale token rejected
    const staleToken = {
      id: mint,
      updatedAt: new Date(Date.now() - 400_000).toISOString(),
      audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, botHoldersPercentage: 10, topHoldersPercentage: 30 },
      organicScore: 80,
      holderCount: 1000,
      fees: 50,
    };
    assert.match(rejectToken(staleToken, mint, settings), /stale/i);

    // Mint authority enabled rejected
    const authEnabledToken = {
      id: mint,
      updatedAt: new Date(Date.now() - 10_000).toISOString(),
      audit: { mintAuthorityDisabled: false, freezeAuthorityDisabled: true, botHoldersPercentage: 10, topHoldersPercentage: 30 },
      organicScore: 80,
      holderCount: 1000,
      fees: 50,
    };
    assert.match(rejectToken(authEnabledToken, mint, settings), /authority is enabled/i);

    // Pool above max TVL rejected
    const highTvlPool = {
      pool_address: 'PoolHigh111111111111111111111111111111111111',
      token_x: { address: mint, warnings: [] },
      token_y: { address: config.tokens.SOL, warnings: [], organic_score: 80 },
      pool_type: 'dlmm',
      is_blacklisted: false,
      tvl: 500_000,
      active_tvl: 450_000,
      volume: 1000,
      fee_active_tvl_ratio: 0.1,
      dlmm_params: { bin_step: 100 },
      volatility: 1.5,
      pool_price: 1.0,
    };
    assert.match(rejectPool(highTvlPool, mint, settings), /TVL outside limits/i);
  });

  test('F3: High-byte XOR encryption adversarial byte-range fidelity', () => {
    const allBytes = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) allBytes[i] = i;
    const testSecret = allBytes.toString('binary');
    const complexKey = 'k\u00ff\u00fe99-special-pass';

    const encrypted = envryptEncrypt(testSecret, complexKey);
    const decrypted = envryptDecrypt(encrypted, complexKey);
    assert.equal(decrypted, testSecret);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TIER 3: Cross-Feature Integration Contracts (Features 6, 7, 11, 12, 13, 19)
// ─────────────────────────────────────────────────────────────────────────────
describe('Tier 3: Cross-Feature Integration Contracts', () => {
  test('F11: withWalletLock mutex prioritizes exits ahead of standard writes', async () => {
    const executionOrder = [];
    let resolveFirst;
    const firstBarrier = new Promise(r => { resolveFirst = r; });

    // 1. Start long running standard operation
    const op1 = withWalletLock(async () => {
      executionOrder.push('op1_started');
      await firstBarrier;
      executionOrder.push('op1_ended');
      return 'op1';
    }, 0);

    await new Promise(r => setTimeout(r, 10));

    // 2. Queue standard write (priority = 0)
    const op2 = withWalletLock(async () => {
      executionOrder.push('op2_standard');
      return 'op2';
    }, 0);

    // 3. Queue high priority exit (priority = 10)
    const op3 = withWalletLock(async () => {
      executionOrder.push('op3_priority_exit');
      return 'op3';
    }, 10);

    resolveFirst();
    await Promise.all([op1, op2, op3]);

    assert.deepEqual(executionOrder, [
      'op1_started',
      'op1_ended',
      'op3_priority_exit',
      'op2_standard',
    ]);
  });

  test('F12 & F13: DLMM CPI events decoding & MonitorStore aggregation contract', () => {
    assert.equal(DLMM_PROGRAM, 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

    const MINT = 'MintTarget11111111111111111111111111111111';
    const W1 = 'Wa11111111111111111111111111111111111111111';
    const W2 = 'Wa22222222222222222222222222222222222222222';
    const now = Date.now();
    const options = {
      walletThreshold: 2,
      windowSec: 120,
      screeningDeadlineSec: 120,
      minDepositSol: 0.1,
      cooldownSec: 300,
      walletGroups: {},
    };

    const makeEvt = (wallet, depositSol, at) => ({
      id: `sig:${wallet}:${depositSol}:${at}`,
      wallet,
      mint: MINT,
      pool: 'Pool111111111111111111111111111111111111111',
      depositSol,
      at,
    });

    const storeFile = path.join(os.tmpdir(), `store-test-${Date.now()}.json`);
    const store = new MonitorStore(storeFile);
    const sig1 = acceptEvents(store, [makeEvt(W1, 1.0, now)], options, now);
    assert.equal(sig1.length, 0);

    const sig2 = acceptEvents(store, [makeEvt(W2, 1.5, now + 1000)], options, now + 1000);
    assert.equal(sig2.length, 1);
    assert.equal(sig2[0].mint, MINT);
    assert.ok(sig2[0].deadline > now);

    finishSignal(store, sig2[0], 'Test cycle completed', options, now + 2000);

    const sig3 = acceptEvents(store, [makeEvt(W1, 2.0, now + 3000), makeEvt(W2, 2.0, now + 3000)], options, now + 3000);
    assert.equal(sig3.length, 0);

    if (fs.existsSync(storeFile)) fs.unlinkSync(storeFile);
  });

  test('F6 & F19: Chronos quantized forecasting & tactical signals contract', () => {
    const synthCandles = Array.from({ length: 60 }, (_, i) => {
      const p = 1.0 + Math.sin(i / 4) * 0.04 + i * 0.001;
      return [1700000000 + i * 300, p * 0.995, p * 1.01, p * 0.99, p, 1000 + i * 25];
    });

    const forecast = localQuantizedForecast(synthCandles, { poolAddress: 'PoolTest', binStep: 100 });
    assert.ok(forecast);
    assert.ok(forecast.summary.p10_pct <= forecast.summary.p50_pct);
    assert.ok(forecast.summary.p50_pct <= forecast.summary.p90_pct);
    assert.ok(forecast.recommended_bins.bins_below >= config.strategy.minBinsBelow);

    const bullSignals = buildTacticalSignals({
      p10Pct: -5,
      p50Pct: 3.2,
      p90Pct: 18,
      rsi14: 58,
      bbPctB: 0.65,
      modelAgreement: 0.82,
    });
    assert.ok(bullSignals);
    assert.equal(bullSignals.x_ratio_mult, 0.85);
    assert.equal(bullSignals.conviction_mult, 1.15);
    assert.equal(bullSignals.let_winners_run, true);

    const binsLowVol = computeBinsBelow(1.0, 100);
    const binsHighVol = computeBinsBelow(5.0, 100);
    assert.ok(binsHighVol >= binsLowVol);
  });

  test('F6 & F7: Deterministic exit rules contract across all triggers', () => {
    const pos = base => ({
      position: 'Pos111111111111111111111111111111111111111',
      pair: 'T/SOL',
      pnl_pct: 0,
      active_bin: 100,
      lower_bin: 50,
      upper_bin: 100,
      minutes_out_of_range: 0,
      age_minutes: 90,
      fee_per_tvl_24h: 10,
      ...base,
    });
    const mgmt = {
      ...config.management,
      takeProfitPct: 8,
      outOfRangeBinsToClose: 25,
      outOfRangeAboveWaitMinutes: 60,
      outOfRangeBelowWaitMinutes: 240,
    };

    // 1. Hard Stop-Loss (-60%) -> Rule 1
    const slRule = getDeterministicCloseRule(pos({ pnl_pct: -60 }), mgmt);
    assert.equal(slRule?.rule, 1);
    assert.match(slRule.reason, /Stop loss/i);

    // 2. Take-Profit (+10%) -> Rule 2
    const tpRule = getDeterministicCloseRule(pos({ pnl_pct: 10 }), mgmt);
    assert.equal(tpRule?.rule, 2);
    assert.match(tpRule.reason, /Take profit/i);

    // 3. Pumped far above range -> Rule 3
    const pumpRule = getDeterministicCloseRule(pos({ active_bin: 130 }), mgmt);
    assert.equal(pumpRule?.rule, 3);
    assert.match(pumpRule.reason, /Pumped far above range/i);

    // 4. OOR above closes after 60m -> Rule 4
    const oorAboveRule = getDeterministicCloseRule(pos({ active_bin: 105, minutes_out_of_range: 65 }), mgmt);
    assert.equal(oorAboveRule?.rule, 4);

    // 5. Suspicious PnL guard (never closes on PnL triggers when suspicious)
    const suspRule = getDeterministicCloseRule(pos({ pnl_pct: -95, pnl_pct_suspicious: true }), mgmt);
    assert.equal(suspRule, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TIER 4: Real-World Scenarios & Convergence Lifecycle (Features 7, 8, 15, 16, 20, 23)
// ─────────────────────────────────────────────────────────────────────────────
describe('Tier 4: Real-World Scenarios & Convergence Lifecycle', () => {
  test('F20 & F13: Smart wallet convergence end-to-end signal lifecycle', () => {
    const tempStorePath = path.join(os.tmpdir(), `convergence-store-${Date.now()}.json`);
    const store = new MonitorStore(tempStorePath);
    const targetMint = 'ConvergenceToken1111111111111111111111111';
    const now = Date.now();
    const opts = {
      walletThreshold: 2,
      windowSec: 60,
      screeningDeadlineSec: 60,
      minDepositSol: 0.1,
      cooldownSec: 180,
      walletGroups: {},
    };

    const ev1 = {
      id: 'tx_w1_pos1',
      wallet: 'AlphaWallet11111111111111111111111111111111',
      mint: targetMint,
      pool: 'PoolAlpha1111111111111111111111111111111111',
      depositSol: 2.5,
      at: now,
    };
    const r1 = acceptEvents(store, [ev1], opts, now);
    assert.equal(r1.length, 0, 'Single wallet deposit must not emit signal');

    const ev2 = {
      id: 'tx_w2_pos2',
      wallet: 'AlphaWallet22222222222222222222222222222222',
      mint: targetMint,
      pool: 'PoolAlpha1111111111111111111111111111111111',
      depositSol: 3.0,
      at: now + 5000,
    };
    const r2 = acceptEvents(store, [ev2], opts, now + 5000);
    assert.equal(r2.length, 1, 'Two independent alpha wallets must converge into a signal');
    const signal = r2[0];
    assert.equal(signal.mint, targetMint);
    assert.equal(signal.events.length, 2);

    finishSignal(store, signal, 'Autonomous deploy completed', opts, now + 10_000);
    assert.ok(signal.cooldownUntil >= now + 10_000);

    if (fs.existsSync(tempStorePath)) fs.unlinkSync(tempStorePath);
  });

  test('F7 & F8 & F15 & F16: Complete position lifecycle (deploy -> OOR -> peak -> close -> record)', async () => {
    const posAddress = 'PosLifecycle111111111111111111111111111111111';
    const poolAddress = 'PoolLifecycle11111111111111111111111111111111';

    // 1. Deploy & Track
    trackPosition({
      position: posAddress,
      pool: poolAddress,
      pool_name: 'LIFE/SOL',
      amount_sol: 1.0,
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      strategy: 'spot',
      base_mint: 'LifeToken111111111111111111111111111111111',
    });

    const tracked = getTrackedPosition(posAddress);
    assert.ok(tracked);
    assert.equal(tracked.pool, poolAddress);
    assert.equal(tracked.pool_name, 'LIFE/SOL');

    // 2. Mark Out of Range
    markOutOfRange(posAddress);
    const oorPos = getTrackedPosition(posAddress);
    assert.ok(oorPos.out_of_range_since);
    assert.ok(minutesOutOfRange(posAddress) >= 0);

    // 3. Mark In Range again
    markInRange(posAddress);
    assert.equal(getTrackedPosition(posAddress).out_of_range_since, null);

    // 4. Confirm Peak PnL progression (confirmTicks = 2)
    const tick1 = confirmPeak(posAddress, 5.0, 2);
    assert.equal(tick1, false, 'First tick should not confirm peak immediately');
    const tick2 = confirmPeak(posAddress, 5.0, 2);
    assert.equal(tick2, true, 'Second consecutive tick must confirm peak');
    assert.equal(getTrackedPosition(posAddress).peak_pnl_pct, 5.0);

    // 5. Post-claim settling guard
    assert.equal(isPostClaimSettling(posAddress), false);
    const posWithClaim = getTrackedPosition(posAddress);
    posWithClaim.last_claim_at = new Date().toISOString();
    assert.equal(isPostClaimSettling(posWithClaim), true, 'Position within 60s of claim must be in settling state');
    assert.equal(isPostClaimSettling(posWithClaim, Date.now() + POST_CLAIM_SETTLE_MS + 1000), false, 'Settling state clears after 60s');

    // 6. Record Close & sync
    recordClose(posAddress, 'Take profit reached +15%');
    const closed = getTrackedPosition(posAddress);
    assert.equal(closed.closed, true);

    syncOpenPositions([]);
    const active = getTrackedPositions(true);
    assert.ok(!active.some(p => p.position === posAddress));

    // 7. Record Performance
    await recordPerformance({
      pool_name: 'LIFE/SOL',
      pool: poolAddress,
      position: posAddress,
      minutes_held: 45,
      pnl_usd: 12.5,
      pnl_pct: 12.5,
      close_reason: 'Take profit reached +15%',
    });
  });

  test('F23: Standalone runtime cycle dry-run execution continuity', async () => {
    const { manageOnce } = await import('../standalone/runtime.js');
    assert.equal(typeof manageOnce, 'function');

    // Execution should complete safely in dry-run without unhandled rejections
    const result = await manageOnce({ confirmTicksOverride: 1 });
    assert.ok(result === null || typeof result === 'string' || typeof result === 'object');
  });
});
