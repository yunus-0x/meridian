/**
 * Meridian Acceptance Test Suite (Tiers 1-4)
 * Requirement-driven & Opaque-box testing mapping Features 1-27 from PROJECT.md.
 * Converted to 100% Vitest and strict Oracle TypeScript compliance.
 */

process.env.NODE_ENV = 'test';
process.env.DISABLE_TELEGRAM = 'true';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createRequire } from 'node:module';
import { z } from 'zod';

import { REPO_ROOT, repoPath } from '../repo-root.js';
import { log, logAction } from '../logger.js';
import { envryptEncrypt, envryptDecrypt } from '../envcrypt.js';
import { vi } from 'vitest';

vi.mock('../decision-log.js', async () => {
  return await vi.importActual<typeof import('../decision-log.js')>('../decision-log.ts');
});
vi.mock('../smart-wallets.js', async () => {
  return await vi.importActual<typeof import('../smart-wallets.js')>('../smart-wallets.ts');
});

import { addSmartWallet, removeSmartWallet, listSmartWallets } from '../smart-wallets.js';
import { isBlacklisted, addToBlacklist, removeFromBlacklist, listBlacklist } from '../token-blacklist.js';
import { isDevBlocked, blockDev, unblockDev, listBlockedDevs } from '../dev-blocklist.js';
import { appendDecision, getRecentDecisions, getDecisionSummary } from '../decision-log.js';
import { config, computeDeployAmount } from '../config.js';
import {
  getDeterministicCloseRule,
  computeBinsBelow,
  type DeterministicPositionMetrics,
  type ManagementConfigInput,
} from '../exit-rules.js';
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
import { connection } from '../standalone/rpc.js';
import { aggregateTokenAccounts } from '../standalone/balances.js';
import { withWalletLock } from '../standalone/transactions.js';
import { DLMM_PROGRAM } from '../standalone/events.js';
import {
  MonitorStore,
  acceptEvents,
  finishSignal,
  type MonitorEvent,
  type AcceptEventsOptions,
  type FinishSignalOptions,
} from '../standalone/store.js';
import { normalizeMint } from '../tools/wallet.js';
import { executeTool } from '../tools/executor.js';
import { rejectToken, rejectPool } from '../standalone/screening.js';
import { localQuantizedForecast, buildTacticalSignals } from '../standalone/chronos.js';
import type { GeckoCandleTuple } from '../src/schemas/api.js';
import { isEnabled as isTelegramEnabled, notifyDeploy, notifyClose, notifySwap } from '../telegram.js';
import { _test as adminTest } from '../standalone/telegram-admin.js';
import {
  snapshotStateFiles,
  restoreStateFiles,
  cleanDanglingLockFile,
} from './helpers/state-isolation.js';

const require = createRequire(import.meta.url);

function runCli(
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {}
): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DRY_RUN: 'true',
    NODE_ENV: 'test',
    DISABLE_TELEGRAM: 'true',
    ...extraEnv,
  };
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

beforeAll(() => {
  snapshotStateFiles();
});

afterAll(() => {
  try {
    restoreStateFiles();
  } finally {
    cleanDanglingLockFile();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TIER 1: Feature Baseline & Happy Path Coverage (Features 1-5, 8, 14, 21-26)
// ─────────────────────────────────────────────────────────────────────────────
describe('Tier 1: Feature Baseline & Happy Path Coverage', () => {
  test('F1 & F25: PM2 ecosystem config and daemon entrypoint integrity', () => {
    const ecosystemPath = repoPath('ecosystem.config.cjs');
    expect(fs.existsSync(ecosystemPath)).toBe(true);

    const rawEcosystem: unknown = require(ecosystemPath);
    const EcosystemSchema = z.object({
      apps: z.array(
        z.object({
          name: z.string(),
          script: z.string(),
          interpreter: z.string(),
          exec_mode: z.string(),
        }).passthrough()
      ).min(1),
    }).passthrough();
    const ecosystem = EcosystemSchema.parse(rawEcosystem);

    const app = ecosystem.apps[0];
    expect(app).toBeDefined();
    if (!app) throw new Error('Ecosystem app configuration missing');
    expect(app.name).toBe('meridian');
    expect(app.script).toBe(path.join(REPO_ROOT, 'index.js'));
    expect(app.interpreter).toBe('node');
    expect(app.exec_mode).toBe('fork');

    const indexContent = fs.readFileSync(repoPath('index.js'), 'utf8');
    expect(indexContent).toMatch(/import "\.\/envcrypt\.js"/);
    expect(indexContent).toMatch(/startStandalone/);
  });

  test('F3: Core storage & utilities (repoPath, logger, decision-log, envcrypt)', () => {
    expect(repoPath('test-subpath')).toBe(path.join(REPO_ROOT, 'test-subpath'));

    // Logger writes without throwing
    expect(() => {
      log('test_cat', 'Unit test log message');
      logAction({ tool: 'get_wallet_balance', success: true, duration_ms: 12, result: { sol: 1.5 } });
    }).not.toThrow();

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
    expect(dec.id.startsWith('dec_')).toBe(true);
    expect(dec.actor).toBe('TEST_WRITER');
    expect(dec.metrics?.['lamports']).toBe('1000000000');

    const recent = getRecentDecisions(5);
    expect(recent.some(d => d.id === dec.id)).toBe(true);
    const summary = getDecisionSummary(5);
    expect(summary).toMatch(/TEST_WRITER/);

    // Envcrypt roundtrip
    const secret = 'super-secret-key-12345';
    const key = 'encryption-key-passphrase';
    const encrypted = envryptEncrypt(secret, key);
    expect(encrypted).not.toBe(secret);
    const decrypted = envryptDecrypt(encrypted, key);
    expect(decrypted).toBe(secret);
  });

  test('F4: Smart wallets, token blacklist and dev blocklist CRUD operations', () => {
    const testWallet = 'Wa11t11111111111111111111111111111111111111';
    const addRes = addSmartWallet({ name: 'AlphaWhale', address: testWallet, category: 'alpha', type: 'lp' });
    expect(addRes.success).toBe(true);
    if (!addRes.success) throw new Error('addSmartWallet failed');
    expect(addRes.wallet.name).toBe('AlphaWhale');

    const listRes = listSmartWallets();
    expect(listRes.wallets.some(w => w.address === testWallet)).toBe(true);

    const removeRes = removeSmartWallet({ address: testWallet });
    expect(removeRes.success).toBe(true);
    if (!removeRes.success) throw new Error('removeSmartWallet failed');
    expect(removeRes.removed).toBe('AlphaWhale');

    // Token blacklist CRUD
    const testMint = 'BadMint111111111111111111111111111111111111';
    expect(isBlacklisted(testMint)).toBe(false);
    const blAdd = addToBlacklist({ mint: testMint, symbol: 'RUG', reason: 'Malicious dev drain' });
    if (!('blacklisted' in blAdd)) throw new Error('Expected blacklisted in result');
    expect(blAdd.blacklisted).toBe(true);
    expect(isBlacklisted(testMint)).toBe(true);

    const blList = listBlacklist();
    expect(blList.blacklist.some(t => t.mint === testMint)).toBe(true);

    const blRem = removeFromBlacklist({ mint: testMint });
    if (!('removed' in blRem)) throw new Error('Expected removed in result');
    expect(blRem.removed).toBe(true);
    expect(isBlacklisted(testMint)).toBe(false);

    // Dev blocklist CRUD
    const testDev = 'Dev11111111111111111111111111111111111111111';
    expect(isDevBlocked(testDev)).toBe(false);
    const devAdd = blockDev({ wallet: testDev, label: 'SerialRugger', reason: 'Multiple abandoned pools' });
    if (!('blocked' in devAdd)) throw new Error('Expected blocked in result');
    expect(devAdd.blocked).toBe(true);
    expect(isDevBlocked(testDev)).toBe(true);

    const devList = listBlockedDevs();
    expect(devList.blocked_devs.some(d => d.wallet === testDev)).toBe(true);

    const devRem = unblockDev({ wallet: testDev });
    if (!('unblocked' in devRem)) throw new Error('Expected unblocked in result');
    expect(devRem.unblocked).toBe(true);
    expect(isDevBlocked(testDev)).toBe(false);
  });

  test('F5: Config management structure and computeDeployAmount dynamic compounding', () => {
    expect(typeof config.standalone).toBe('object');
    expect(typeof config.risk).toBe('object');
    expect(typeof config.screening).toBe('object');
    expect(typeof config.management).toBe('object');
    expect(typeof config.strategy).toBe('object');

    // computeDeployAmount scaling
    const smallWallet = computeDeployAmount(0.5);
    expect(typeof smallWallet).toBe('number');
    expect(smallWallet).toBeGreaterThanOrEqual(0);

    const midWallet = computeDeployAmount(10.0, 1.0);
    expect(midWallet).toBeGreaterThanOrEqual(config.management.deployAmountSol);
    expect(midWallet).toBeLessThanOrEqual(config.risk.maxDeployAmount);

    // Conviction multiplier sensitivity (clamped to [0.75, 1.25])
    const lowConv = computeDeployAmount(10.0, 0.5);
    const highConv = computeDeployAmount(10.0, 1.5);
    expect(highConv).toBeGreaterThanOrEqual(lowConv);
  });

  test('F8: Performance tracking and pool memory', () => {
    const summary = getPerformanceSummary();
    expect(summary === null || typeof summary === 'object').toBe(true);

    const history = getPerformanceHistory({ hours: 24 });
    expect(Array.isArray(history.positions)).toBe(true);

    const pool = 'PoolMemTest1111111111111111111111111111111';
    addPoolNote({ pool_address: pool, note: 'Tested note insertion' });
    const mem = getPoolMemory({ pool_address: pool });
    expect(mem).toBeDefined();
    expect(mem?.notes?.some(n => n.note === 'Tested note insertion')).toBe(true);
  });

  test('F14 & F21 & F22: Wallet mint normalization, Telegram formatting, and Admin UI schema', async () => {
    expect(normalizeMint('So11111111111111111111111111111111111111112')).toBe('So11111111111111111111111111111111111111112');
    expect(normalizeMint('SOL')).toBe('So11111111111111111111111111111111111111112');
    expect(normalizeMint('native')).toBe('So11111111111111111111111111111111111111112');

    // Telegram formatters execute safely
    expect(typeof isTelegramEnabled()).toBe('boolean');
    expect(isTelegramEnabled()).toBe(false);

    await expect((async () => {
      await notifyDeploy({ pair: 'TEST/SOL', amountSol: 1, position: 'pos123', tx: 'tx123' });
      await notifyClose({ pair: 'TEST/SOL', pnlUsd: 10, pnlPct: 5, solMode: false });
      await notifySwap({ inputSymbol: 'TEST', outputSymbol: 'SOL', amountIn: 100, amountOut: 1, tx: 'tx123' });
    })()).resolves.not.toThrow();

    // Admin UI Schema verification
    const { SECTIONS, byKey, validate, fmtValue } = adminTest;
    expect(SECTIONS.length).toBeGreaterThanOrEqual(6);
    const sectionIds = SECTIONS.map(s => s.id);
    expect(sectionIds).toEqual(['trigger', 'screening', 'risk', 'strategy', 'exits', 'rpc']);

    const riskSection = SECTIONS.find(s => s.id === 'risk');
    expect(riskSection).toBeDefined();
    expect(riskSection?.settings.length).toBeGreaterThan(0);

    const maxPos = byKey.get('maxPositions');
    expect(maxPos).toBeDefined();
    if (!maxPos) throw new Error('maxPositions setting missing');
    expect(validate(maxPos, '5')).toBe(5);
    expect(fmtValue(maxPos)).toMatch(/\d+/);
  });

  test('F24 & F26: CLI 17 subcommands and utility scripts invocation', () => {
    // 1. Help command advertising all 17 subcommands
    const helpRes = runCli(['help']);
    expect(helpRes.status).toBe(0);
    const expectedSubcommands = [
      'start', 'status', 'balance', 'positions', 'pnl', 'screen',
      'pool', 'active-bin', 'manage', 'close', 'claim', 'swap',
      'wallets', 'blacklist', 'performance', 'config', 'help',
    ];
    for (const cmd of expectedSubcommands) {
      expect(helpRes.stdout).toMatch(new RegExp(`\\b${cmd}\\b`));
    }

    // 2. Config command
    const configRes = runCli(['config']);
    expect(configRes.status).toBe(0);
    const rawConfig: unknown = JSON.parse(configRes.stdout);
    expect(rawConfig).toBeTypeOf('object');
    expect(rawConfig).not.toBeNull();
    expect(rawConfig).toHaveProperty('risk');
    expect(rawConfig).toHaveProperty('screening');

    // 3. Wallets list command
    const walletsRes = runCli(['wallets']);
    expect(walletsRes.status).toBe(0);
    const rawWallets: unknown = JSON.parse(walletsRes.stdout);
    expect(rawWallets).toBeTypeOf('object');
    expect(rawWallets).not.toBeNull();
    expect(rawWallets).toHaveProperty('wallets');

    // 4. Blacklist list command
    const blRes = runCli(['blacklist']);
    expect(blRes.status).toBe(0);
    const rawBl: unknown = JSON.parse(blRes.stdout);
    expect(rawBl).toBeTypeOf('object');
    expect(rawBl).not.toBeNull();
    expect(rawBl).toHaveProperty('blacklist');

    // 5. Scripts syntax verification script
    const syntaxRes: SpawnSyncReturns<string> = spawnSync(process.execPath, ['scripts/check-syntax.js'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(syntaxRes.status).toBe(0);

    // 6. Scripts envrypt CLI
    const envcryptCli: SpawnSyncReturns<string> = spawnSync(process.execPath, ['scripts/envrypt.js'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(envcryptCli.status).toBe(0);
    expect(envcryptCli.stdout).toMatch(/Usage:/);
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
      expect(() => isBlacklisted('Mint111111111111111111111111111111111111')).toThrow(
        /Safety blacklist is unreadable:/
      );

      // 2. Genuinely test dev-blocklist.ts error branch on unreadable/corrupted file
      fs.writeFileSync(blocklistFile, 'MALFORMED_JSON_CONTENT{{{');
      expect(() => isDevBlocked('Dev1111111111111111111111111111111111111')).toThrow(
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
    const invalidKeys: readonly (string | null)[] = [
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
      expect(res.success).toBe(false);
      if (res.success) throw new Error('Expected failure');
      expect(res.error).toBe('Invalid Solana address format');
    }
  });

  test('F9: Solana RPC Client boundary validation & missing RPC_URL handling', () => {
    expect(() => connection('')).toThrow(/Configure RPC_URL/);
    expect(() => connection('ftp://rpc.solana.com')).toThrow(/`http:` or `https:`/i);
  });

  test('F10: Token balance aggregation edge cases (zero balance, decimal conflict, program merge)', () => {
    const MINT = 'MintAgg111111111111111111111111111111111111';
    const acct = (mint: string, amount: number | string, decimals: number) => ({
      account: { data: { parsed: { info: { mint, tokenAmount: { amount: String(amount), decimals } } } } },
    });

    // 1. Zero balances dropped
    const respZero = [{ value: [acct('MINT_A', 0, 6)] }];
    expect(aggregateTokenAccounts(respZero)).toEqual([]);

    // 2. Aggregate across programs
    const respMulti = [
      { value: [acct(MINT, 1000, 6)] },
      { value: [acct(MINT, 2500, 6)] },
    ];
    const agg = aggregateTokenAccounts(respMulti);
    expect(agg).toHaveLength(1);
    expect(agg[0]?.mint).toBe(MINT);
    expect(agg[0]?.balance).toBe(0.0035);

    // 3. Conflicting decimals thrown
    const respConflict = [
      { value: [acct(MINT, 1, 6)] },
      { value: [acct(MINT, 1, 9)] },
    ];
    expect(() => aggregateTokenAccounts(respConflict)).toThrow(/Conflicting token decimals/i);
  });

  test('F17 & F24: Tool executor & CLI boundary enforcement (missing flags, invalid amounts)', async () => {
    // Missing flags in CLI
    const missingMint = runCli(['screen']);
    expect(missingMint.status).toBe(1);
    expect(missingMint.stderr).toMatch(/--mint is required/);

    const missingPool = runCli(['pnl', '--position', 'pos1']);
    expect(missingPool.status).toBe(1);
    expect(missingPool.stderr).toMatch(/--pool is required/);

    // Non-positive amount in swap CLI
    const negSwap = runCli(['swap', '--from', 'MINT1', '--to', 'MINT2', '--amount', '0']);
    expect(negSwap.status).toBe(1);
    expect(negSwap.stderr).toMatch(/--amount must be positive/);

    // Executor returns error for unknown tool
    const res = await executeTool('unknown_hypothetical_tool', {});
    if (!('error' in res)) throw new Error('Expected error in tool execution');
    expect(res.error).toMatch(/Unknown tool/i);
  });

  test('F18: Token & Pool screening rejection guards', () => {
    const mint = 'TargetMint111111111111111111111111111111111';
    const settings = {
      ...config.screening,
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
    expect(rejectToken(staleToken, mint, settings)).toMatch(/stale/i);

    // Mint authority enabled rejected
    const authEnabledToken = {
      id: mint,
      updatedAt: new Date(Date.now() - 10_000).toISOString(),
      audit: { mintAuthorityDisabled: false, freezeAuthorityDisabled: true, botHoldersPercentage: 10, topHoldersPercentage: 30 },
      organicScore: 80,
      holderCount: 1000,
      fees: 50,
    };
    expect(rejectToken(authEnabledToken, mint, settings)).toMatch(/authority is enabled/i);

    // Pool above max TVL rejected
    const highTvlPool = {
      pool_address: 'PoolHigh111111111111111111111111111111111111',
      token_x: { address: mint, warnings: [], organic_score: 80 },
      token_y: { address: config.tokens.SOL, warnings: [], organic_score: 80 },
      pool_type: 'dlmm' as const,
      is_blacklisted: false,
      tvl: 500_000,
      active_tvl: 450_000,
      volume: 1000,
      fee_active_tvl_ratio: 0.1,
      dlmm_params: { bin_step: 100 },
      volatility: 1.5,
      pool_price: 1.0,
    };
    expect(rejectPool(highTvlPool, mint, settings)).toMatch(/TVL outside limits/i);
  });

  test('F3: High-byte XOR encryption adversarial byte-range fidelity', () => {
    const allBytes = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) allBytes[i] = i;
    const testSecret = allBytes.toString('binary');
    const complexKey = 'k\u00ff\u00fe99-special-pass';

    const encrypted = envryptEncrypt(testSecret, complexKey);
    const decrypted = envryptDecrypt(encrypted, complexKey);
    expect(decrypted).toBe(testSecret);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TIER 3: Cross-Feature Integration Contracts (Features 6, 7, 11, 12, 13, 19)
// ─────────────────────────────────────────────────────────────────────────────
describe('Tier 3: Cross-Feature Integration Contracts', () => {
  test('F11: withWalletLock mutex prioritizes exits ahead of standard writes', async () => {
    const executionOrder: string[] = [];
    let resolveFirst!: () => void;
    const firstBarrier = new Promise<void>(r => { resolveFirst = r; });

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

    expect(executionOrder).toEqual([
      'op1_started',
      'op1_ended',
      'op3_priority_exit',
      'op2_standard',
    ]);
  });

  test('F12 & F13: DLMM CPI events decoding & MonitorStore aggregation contract', () => {
    expect(DLMM_PROGRAM).toBe('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

    const MINT = 'MintTarget11111111111111111111111111111111';
    const W1 = 'Wa11111111111111111111111111111111111111111';
    const W2 = 'Wa22222222222222222222222222222222222222222';
    const now = Date.now();
    const options: AcceptEventsOptions & FinishSignalOptions = {
      walletThreshold: 2,
      windowSec: 120,
      screeningDeadlineSec: 120,
      minDepositSol: 0.1,
      cooldownSec: 300,
      walletGroups: {},
    };

    const makeEvt = (wallet: string, depositSol: number, at: number): MonitorEvent => ({
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
    expect(sig1).toHaveLength(0);

    const sig2 = acceptEvents(store, [makeEvt(W2, 1.5, now + 1000)], options, now + 1000);
    expect(sig2).toHaveLength(1);
    const targetSig = sig2[0];
    expect(targetSig).toBeDefined();
    if (!targetSig) throw new Error('Expected target signal');
    expect(targetSig.mint).toBe(MINT);
    expect(targetSig.deadline).toBeGreaterThan(now);

    finishSignal(store, targetSig, 'Test cycle completed', options, now + 2000);

    const sig3 = acceptEvents(store, [makeEvt(W1, 2.0, now + 3000), makeEvt(W2, 2.0, now + 3000)], options, now + 3000);
    expect(sig3).toHaveLength(0);

    if (fs.existsSync(storeFile)) fs.unlinkSync(storeFile);
  });

  test('F6 & F19: Chronos quantized forecasting & tactical signals contract', () => {
    const synthCandles: GeckoCandleTuple[] = Array.from({ length: 60 }, (_, i) => {
      const p = 1.0 + Math.sin(i / 4) * 0.04 + i * 0.001;
      return [1700000000 + i * 300, p * 0.995, p * 1.01, p * 0.99, p, 1000 + i * 25];
    });

    const forecast = localQuantizedForecast(synthCandles, { poolAddress: 'PoolTest', binStep: 100 });
    expect(forecast).toBeDefined();
    if (!forecast) throw new Error('Forecast is undefined');
    expect(forecast.summary.p10_pct).toBeLessThanOrEqual(forecast.summary.p50_pct);
    expect(forecast.summary.p50_pct).toBeLessThanOrEqual(forecast.summary.p90_pct);
    expect(forecast.recommended_bins.bins_below).toBeGreaterThanOrEqual(config.strategy.minBinsBelow);

    const bullSignals = buildTacticalSignals({
      p10Pct: -5,
      p50Pct: 3.2,
      p90Pct: 18,
      rsi14: 58,
      bbPctB: 0.65,
      modelAgreement: 0.82,
    });
    expect(bullSignals).toBeDefined();
    if (!bullSignals) throw new Error('Bull signals undefined');
    expect(bullSignals.x_ratio_mult).toBe(0.85);
    expect(bullSignals.conviction_mult).toBe(1.15);
    expect(bullSignals.let_winners_run).toBe(true);

    const binsLowVol = computeBinsBelow(1.0, 100);
    const binsHighVol = computeBinsBelow(5.0, 100);
    expect(binsHighVol).toBeGreaterThanOrEqual(binsLowVol);
  });

  test('F6 & F7: Deterministic exit rules contract across all triggers', () => {
    const pos = (base: Partial<DeterministicPositionMetrics>): DeterministicPositionMetrics => ({
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

    const mgmt: ManagementConfigInput = {
      ...config.management,
      takeProfitPct: 8,
      outOfRangeBinsToClose: 25,
      outOfRangeAboveWaitMinutes: 60,
      outOfRangeBelowWaitMinutes: 240,
    };

    // 1. Hard Stop-Loss (-60%) -> Rule 1
    const slRule = getDeterministicCloseRule(pos({ pnl_pct: -60 }), mgmt);
    expect(slRule?.rule).toBe(1);
    expect(slRule?.reason).toMatch(/Stop loss/i);

    // 2. Take-Profit (+10%) -> Rule 2
    const tpRule = getDeterministicCloseRule(pos({ pnl_pct: 10 }), mgmt);
    expect(tpRule?.rule).toBe(2);
    expect(tpRule?.reason).toMatch(/Take profit/i);

    // 3. Pumped far above range -> Rule 3
    const pumpRule = getDeterministicCloseRule(pos({ active_bin: 130 }), mgmt);
    expect(pumpRule?.rule).toBe(3);
    expect(pumpRule?.reason).toMatch(/Pumped far above range/i);

    // 4. OOR above closes after 60m -> Rule 4
    const oorAboveRule = getDeterministicCloseRule(pos({ active_bin: 105, minutes_out_of_range: 65 }), mgmt);
    expect(oorAboveRule?.rule).toBe(4);

    // 5. Suspicious PnL guard (never closes on PnL triggers when suspicious)
    const suspRule = getDeterministicCloseRule(pos({ pnl_pct: -95, pnl_pct_suspicious: true }), mgmt);
    expect(suspRule).toBeNull();
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
    const opts: AcceptEventsOptions & FinishSignalOptions = {
      walletThreshold: 2,
      windowSec: 60,
      screeningDeadlineSec: 60,
      minDepositSol: 0.1,
      cooldownSec: 180,
      walletGroups: {},
    };

    const ev1: MonitorEvent = {
      id: 'tx_w1_pos1',
      wallet: 'AlphaWallet11111111111111111111111111111111',
      mint: targetMint,
      pool: 'PoolAlpha1111111111111111111111111111111111',
      depositSol: 2.5,
      at: now,
    };
    const r1 = acceptEvents(store, [ev1], opts, now);
    expect(r1).toHaveLength(0);

    const ev2: MonitorEvent = {
      id: 'tx_w2_pos2',
      wallet: 'AlphaWallet22222222222222222222222222222222',
      mint: targetMint,
      pool: 'PoolAlpha1111111111111111111111111111111111',
      depositSol: 3.0,
      at: now + 5000,
    };
    const r2 = acceptEvents(store, [ev2], opts, now + 5000);
    expect(r2).toHaveLength(1);
    const signal = r2[0];
    expect(signal).toBeDefined();
    if (!signal) throw new Error('Expected signal');
    expect(signal.mint).toBe(targetMint);
    expect(signal.events).toHaveLength(2);

    finishSignal(store, signal, 'Autonomous deploy completed', opts, now + 10_000);
    expect(signal.cooldownUntil).toBeGreaterThanOrEqual(now + 10_000);

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
      bin_range: { min: 80, max: 120 },
      active_bin: 100,
      strategy: 'spot',
    });

    const tracked = getTrackedPosition(posAddress);
    expect(tracked).toBeDefined();
    if (!tracked) throw new Error('tracked position missing');
    expect(tracked.pool).toBe(poolAddress);
    expect(tracked.pool_name).toBe('LIFE/SOL');

    // 2. Mark Out of Range
    markOutOfRange(posAddress);
    const oorPos = getTrackedPosition(posAddress);
    expect(oorPos).toBeDefined();
    if (!oorPos) throw new Error('oorPos missing');
    expect(oorPos.out_of_range_since).toBeDefined();
    expect(minutesOutOfRange(posAddress)).toBeGreaterThanOrEqual(0);

    // 3. Mark In Range again
    markInRange(posAddress);
    const inRangePos = getTrackedPosition(posAddress);
    expect(inRangePos).toBeDefined();
    if (!inRangePos) throw new Error('inRangePos missing');
    expect(inRangePos.out_of_range_since).toBeNull();

    // 4. Confirm Peak PnL progression (confirmTicks = 2)
    const tick1 = confirmPeak(posAddress, 5.0, 2);
    expect(tick1).toBe(false);
    const tick2 = confirmPeak(posAddress, 5.0, 2);
    expect(tick2).toBe(true);
    const peakPos = getTrackedPosition(posAddress);
    expect(peakPos).toBeDefined();
    if (!peakPos) throw new Error('peakPos missing');
    expect(peakPos.peak_pnl_pct).toBe(5.0);

    // 5. Post-claim settling guard
    expect(isPostClaimSettling(posAddress)).toBe(false);
    const posWithClaim = getTrackedPosition(posAddress);
    expect(posWithClaim).toBeDefined();
    if (!posWithClaim) throw new Error('posWithClaim missing');
    posWithClaim.last_claim_at = new Date().toISOString();
    expect(isPostClaimSettling(posWithClaim)).toBe(true);
    expect(isPostClaimSettling(posWithClaim, Date.now() + POST_CLAIM_SETTLE_MS + 1000)).toBe(false);

    // 6. Record Close & sync
    recordClose(posAddress, 'Take profit reached +15%');
    const closed = getTrackedPosition(posAddress);
    expect(closed).toBeDefined();
    if (!closed) throw new Error('closed position missing');
    expect(closed.closed).toBe(true);

    syncOpenPositions([]);
    const active = getTrackedPositions(true);
    expect(active.some(p => p.position === posAddress)).toBe(false);

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
    expect(typeof manageOnce).toBe('function');

    // Execution should complete safely in dry-run without unhandled rejections
    const result = await manageOnce({ confirmTicksOverride: 1 });
    expect(result === null || typeof result === 'string' || typeof result === 'object').toBe(true);
  });
});
