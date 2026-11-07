process.env.NODE_ENV = 'test';
process.env.DISABLE_TELEGRAM = 'true';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../repo-root.js';

function sourceFiles(dir = REPO_ROOT) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name.startsWith('.') || ['node_modules','logs','discord-listener','docs','test'].includes(e.name)) return [];
    const file = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(file) : file.endsWith('.js') ? [file] : [];
  });
}
function run(args) {
  const env = { ...process.env, DRY_RUN: 'true', NODE_ENV: 'test', DISABLE_TELEGRAM: 'true' };
  delete env.LLM_API_KEY; delete env.OPENROUTER_API_KEY; delete env.TELEGRAM_BOT_TOKEN; delete env.TELEGRAM_CHAT_ID;
  const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

test('every relative static/dynamic module reference resolves after archiving', () => {
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g;
    for (const match of text.matchAll(re)) assert.ok(fs.existsSync(path.resolve(path.dirname(file), match[1])), `${path.relative(REPO_ROOT,file)} -> ${match[1]}`);
  }
});

test('standalone modules load without LLM credentials or network calls', () => {
  const result = run(['--input-type=module', '-e', `
    globalThis.fetch = () => { throw new Error('Unexpected network request during import'); };
    await import('./index.js');
    await import('./standalone/runtime.js');
    await import('./tools/executor.js');
    await import('./performance.js');
    console.log('loaded');
  `]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /loaded/);
});

test('CLI advertises focused screening and rejects archived commands', () => {
  const help = run(['cli.js', 'help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /screen --mint ADDRESS/);
  for (const command of ['study','candidates','evolve','deploy']) {
    const result = run(['cli.js', command]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown command/);
  }
  const screen = run(['cli.js', 'screen']);
  assert.equal(screen.status, 1);
  assert.match(screen.stderr, /--mint is required/);
});

test('Meteora position mapping retains balances, fees, PnL, bins and missing-data behavior', () => {
  const result = run(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const {config} = await import('./config.js');
    config.pnl.source = 'meteora';
    config.management.solMode = false;
    let missing = false;
    globalThis.fetch = async url => {
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
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test('active dependencies and configuration contain no retired agent integrations', async () => {
  const pkg=JSON.parse(fs.readFileSync(path.join(REPO_ROOT,'package.json'),'utf8'));
  for(const name of ['openai','jsonrepair','node-cron']) assert.equal(pkg.dependencies[name],undefined);
  const {config}=await import('../config.js');
  for(const key of ['llm','hiveMind','api','gmgn','indicators','darwin','opportunity']) assert.equal(config[key],undefined);
});

test('telegram admin menu schema is complete and every control renders', async () => {
  const {config} = await import('../config.js');
  const {_test} = await import('../standalone/telegram-admin.js');
  const {SECTIONS, byKey, editHint, validate, sectionMenu, fmtValue} = _test;
  assert.deepEqual(SECTIONS.map(s => s.id), ['trigger', 'screening', 'risk', 'strategy', 'exits', 'rpc']);
  assert.ok(SECTIONS.some(s => s.id === 'strategy' && s.settings.some(x => x.k === 'strategy')), 'strategy shape must be configurable');

  for (const section of SECTIONS) {
    assert.ok(section.settings.length > 0, `${section.id} has settings`);
    const menu = sectionMenu(section);
    assert.ok(menu.text && menu.keyboard.length > 1, `${section.id} renders`);
    for (const setting of section.settings) {
      assert.equal(byKey.get(setting.k), setting, `${setting.k} registered`);
      // These two threw on non-enum settings before the lazy-hint fix.
      assert.ok(typeof editHint(setting) === 'string' && editHint(setting).length > 0, `${setting.k} hint renders`);
      assert.ok(typeof fmtValue(setting) === 'string', `${setting.k} value renders`);
      if (setting.path) {
        let node = config;
        for (const p of setting.path) node = node?.[p];
        assert.notEqual(node, undefined, `${setting.k} path ${setting.path.join('.')} exists in live config`);
      }
      if (setting.type === 'enum' || setting.kind === 'enum') assert.ok(Array.isArray(setting.options) && setting.options.length, `${setting.k} has options`);
    }
  }

  // validate() round-trips and rejects per type.
  const byType = t => SECTIONS.flatMap(s => s.settings).find(s => s.type === t);
  const intSetting = byType('int');
  const inRange = Math.floor(((intSetting.min ?? 0) + (intSetting.max ?? 100)) / 2);
  assert.equal(typeof validate(intSetting, String(inRange)), 'number');
  assert.throws(() => validate(intSetting, 'abc'));
  assert.throws(() => validate(intSetting, String((intSetting.max ?? 1e9) + 1)));
  const boolSetting = byType('bool');
  assert.equal(validate(boolSetting, 'on'), true);
  assert.equal(validate(boolSetting, 'off'), false);
  assert.throws(() => validate(boolSetting, 'maybe'));
  const enumSetting = byType('enum');
  assert.equal(validate(enumSetting, enumSetting.options[0]), enumSetting.options[0]);
  assert.throws(() => validate(enumSetting, 'not-an-option'));
  const listSetting = byType('list');
  assert.deepEqual(validate(listSetting, 'a, b'), ['a', 'b']);
  assert.deepEqual(validate(listSetting, 'none'), []);
  const nullableSetting = byType('nullable');
  assert.equal(validate(nullableSetting, 'off'), null);
  assert.equal(validate(nullableSetting, '5'), 5);
});
