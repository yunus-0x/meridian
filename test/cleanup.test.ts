// test/cleanup.test.ts — Vitest Conversion for Repository Cleanup & Invariant Verification
// Strictly adheres to Oracle TypeScript Standards: Zero any, Zero unsafe assertions, Domain Purity.

import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { z } from 'zod';
import { REPO_ROOT } from '../repo-root.js';

/**
 * Recursively collects all JavaScript source files in the repository,
 * ignoring test, tooling, logging, docs, and build directories.
 */
function sourceFiles(dir: string = REPO_ROOT): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (
      entry.name.startsWith('.') ||
      ['node_modules', 'logs', 'discord-listener', 'docs', 'test'].includes(entry.name)
    ) {
      return [];
    }
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(fullPath) : fullPath.endsWith('.js') ? [fullPath] : [];
  });
}

/**
 * Executes a Node subprocess with clean test environment and 15s timeout.
 */
function run(args: readonly string[]): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DRY_RUN: 'true',
    NODE_ENV: 'test',
    DISABLE_TELEGRAM: 'true',
  };
  delete env.LLM_API_KEY;
  delete env.OPENROUTER_API_KEY;
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.TELEGRAM_CHAT_ID;

  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });

  expect(result.error).toBeUndefined();
  return result;
}

describe('Repository Cleanup & Post-Archival Invariants', () => {
  test('every relative static/dynamic module reference resolves after archiving', () => {
    for (const file of sourceFiles()) {
      const text = fs.readFileSync(file, 'utf8');
      const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g;
      for (const match of text.matchAll(re)) {
        const importPath = match[1];
        if (!importPath) {
          continue;
        }
        const resolvedPath = path.resolve(path.dirname(file), importPath);
        expect(
          fs.existsSync(resolvedPath),
          `${path.relative(REPO_ROOT, file)} -> ${importPath}`
        ).toBe(true);
      }
    }
  });

  test('standalone modules load without LLM credentials or network calls', { timeout: 15_000 }, () => {
    const result = run(['--input-type=module', '-e', `
      globalThis.fetch = () => { throw new Error('Unexpected network request during import'); };
      await import('./index.js');
      await import('./standalone/runtime.js');
      await import('./tools/executor.js');
      await import('./performance.js');
      console.log('loaded');
    `]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/loaded/);
  });

  test('CLI advertises focused screening and rejects archived commands', { timeout: 15_000 }, () => {
    const help = run(['cli.js', 'help']);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toMatch(/screen --mint ADDRESS/);

    for (const command of ['study', 'candidates', 'evolve', 'deploy']) {
      const result = run(['cli.js', command]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Unknown command/);
    }

    const screen = run(['cli.js', 'screen']);
    expect(screen.status).toBe(1);
    expect(screen.stderr).toMatch(/--mint is required/);
  });

  test('Meteora position mapping retains balances, fees, PnL, bins and missing-data behavior', { timeout: 15_000 }, () => {
    const result = run(['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const {config} = await import('./config.js');
      config.pnl.source = 'meteora';
      config.management.solMode = false;
      let missing = false;
      globalThis.fetch = async (url) => {
        if (url.includes('/portfolio/open?')) return {ok:true, json:async()=>({pools:[{poolAddress:'pool',listPositions:['cleanup-test-position'],tokenX:'X',tokenY:'SOL',tokenXMint:'mint'}]})};
        if (url.includes('/positions/pool/pnl?')) return {ok:true, json:async()=>({positions:missing?[]:[{
          positionAddress:'cleanup-test-position',lowerBinId:10,upperBinId:20,poolActiveBinId:15,isOutOfRange:false,
          pnlPctChange:12,pnlUsd:12,feePerTvl24h:8,createdAt:Math.floor(Date.now()/1000)-3600,
          unrealizedPnl:{balances:110,unclaimedFeeTokenX:{usd:1},unclaimedFeeTokenY:{usd:1}},
          allTimeDeposits:{total:{usd:100}},allTimeWithdrawals:{total:{usd:0}},allTimeFees:{total:{usd:0}}
        }]})};
        throw new Error('Unexpected data source: '+url);
      };
      const {getMyPositions} = await import('./tools/dlmm.js');
      const options={force:true,silent:true,wallet_address:'11111111111111111111111111111111'};
      const result=await getMyPositions(options);
      assert.equal(result.source,'meteora');
      const p=result.positions[0];
      assert.equal(p.total_value_usd,110);assert.equal(p.unclaimed_fees_usd,2);
      assert.equal(p.pnl_pct,12);assert.equal(p.pnl_pct_derived,12);
      assert.equal(p.lower_bin,10);assert.equal(p.upper_bin,20);assert.equal(p.active_bin,15);
      assert.equal(p.pnl_pct_suspicious,false);
      missing=true;
      const unavailable=(await getMyPositions(options)).positions[0];
      assert.equal(unavailable.total_value_usd,null);assert.equal(unavailable.pnl_pct,null);
      assert.equal(unavailable.pnl_pct_suspicious,true);
    `]);
    expect(result.status, result.stderr + result.stdout).toBe(0);
  });

  test('active dependencies and configuration contain no retired agent integrations', async () => {
    const pkgPath = path.join(REPO_ROOT, 'package.json');
    const rawPkg: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    const PackageJsonSchema = z.object({
      dependencies: z.record(z.string()).optional().default({}),
    });
    const pkg = PackageJsonSchema.parse(rawPkg);

    for (const name of ['openai', 'jsonrepair', 'node-cron']) {
      expect(pkg.dependencies[name]).toBeUndefined();
    }

    const { config } = await import('../config.js');
    const retiredKeys = [
      'llm',
      'hiveMind',
      'api',
      'gmgn',
      'indicators',
      'darwin',
      'opportunity',
    ] as const;

    for (const key of retiredKeys) {
      expect(Reflect.get(config, key)).toBeUndefined();
    }
  });

  test('telegram admin menu schema is complete and every control renders', async () => {
    const { config } = await import('../config.js');
    const { _test } = await import('../standalone/telegram-admin.js');
    const { SECTIONS, byKey, editHint, validate, sectionMenu, fmtValue } = _test;

    expect(SECTIONS.map((s) => s.id)).toEqual([
      'trigger',
      'screening',
      'risk',
      'strategy',
      'exits',
      'rpc',
    ]);
    expect(
      SECTIONS.some((s) => s.id === 'strategy' && s.settings.some((x) => x.k === 'strategy')),
      'strategy shape must be configurable'
    ).toBe(true);

    for (const section of SECTIONS) {
      expect(section.settings.length, `${section.id} has settings`).toBeGreaterThan(0);
      const menu = sectionMenu(section);
      expect(Boolean(menu.text && menu.keyboard.length > 1), `${section.id} renders`).toBe(true);

      for (const setting of section.settings) {
        expect(byKey.get(setting.k), `${setting.k} registered`).toBe(setting);
        const hint = editHint(setting);
        expect(typeof hint === 'string' && hint.length > 0, `${setting.k} hint renders`).toBe(true);
        const val = fmtValue(setting);
        expect(typeof val === 'string', `${setting.k} value renders`).toBe(true);

        if ('path' in setting && setting.path) {
          let node: unknown = config;
          for (const p of setting.path) {
            if (typeof node === 'object' && node !== null && p in node) {
              node = Reflect.get(node, p);
            } else {
              node = undefined;
              break;
            }
          }
          expect(
            node,
            `${setting.k} path ${setting.path.join('.')} exists in live config`
          ).not.toBeUndefined();
        }

        const isEnum =
          setting.type === 'enum' ||
          ('kind' in setting && setting.kind === 'enum');
        if (isEnum) {
          const hasOptions =
            'options' in setting &&
            Array.isArray(setting.options) &&
            setting.options.length > 0;
          expect(hasOptions, `${setting.k} has options`).toBe(true);
        }
      }
    }

    // validate() round-trips and rejects per type.
    type AdminSetting = (typeof SECTIONS)[number]['settings'][number];
    const byType = (t: string): AdminSetting | undefined =>
      SECTIONS.flatMap((s) => s.settings).find((s) => s.type === t);

    const intSetting = byType('int');
    expect(intSetting).toBeDefined();
    if (intSetting && (intSetting.type === 'int' || intSetting.type === 'float')) {
      const min = intSetting.min ?? 0;
      const max = intSetting.max ?? 100;
      const inRange = Math.floor((min + max) / 2);
      expect(typeof validate(intSetting, String(inRange))).toBe('number');
      expect(() => validate(intSetting, 'abc')).toThrow();
      expect(() => validate(intSetting, String((intSetting.max ?? 1e9) + 1))).toThrow();
    }

    const boolSetting = byType('bool');
    expect(boolSetting).toBeDefined();
    if (boolSetting) {
      expect(validate(boolSetting, 'on')).toBe(true);
      expect(validate(boolSetting, 'off')).toBe(false);
      expect(() => validate(boolSetting, 'maybe')).toThrow();
    }

    const enumSetting = byType('enum');
    expect(enumSetting).toBeDefined();
    if (enumSetting && enumSetting.type === 'enum' && enumSetting.options) {
      const firstOption = enumSetting.options[0];
      expect(firstOption).toBeDefined();
      if (firstOption !== undefined) {
        expect(validate(enumSetting, firstOption)).toBe(firstOption);
      }
      expect(() => validate(enumSetting, 'not-an-option')).toThrow();
    }

    const listSetting = byType('list');
    expect(listSetting).toBeDefined();
    if (listSetting) {
      expect(validate(listSetting, 'a, b')).toEqual(['a', 'b']);
      expect(validate(listSetting, 'none')).toEqual([]);
    }

    const nullableSetting = byType('nullable');
    expect(nullableSetting).toBeDefined();
    if (nullableSetting) {
      expect(validate(nullableSetting, 'off')).toBeNull();
      expect(validate(nullableSetting, '5')).toBe(5);
    }
  });
});
