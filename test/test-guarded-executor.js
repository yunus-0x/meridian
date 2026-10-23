import assert from "node:assert/strict";
import { createGuardedExecutor } from "../tools/guarded-executor.js";

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const H = 3_600_000;
const policy = { minTvl: 10000, maxTvl: 150000, minVolume: 500, minHolders: 500, minMcap: 150000, maxMcap: 10000000, minBinStep: 80, maxBinStep: 125, minFeeActiveTvlRatio: 0.05, minOrganic: 60, minTokenAgeHours: 5, maxTokenAgeHours: 36, maxDataAgeMs: 60000 };
const detail = (over = {}) => ({ tvl: 50000, volume: 5000, base_token_holders: 900, fee_active_tvl_ratio: 0.08, volatility: 2, dlmm_params: { bin_step: 100 }, token_x: { market_cap: 800000, organic_score: 70, created_at: NOW - 10 * H }, ...over });
let calls = [];
const mk = (d) => createGuardedExecutor({
  executeTool: async (n, a) => { calls.push([n, a]); return { success: true }; },
  fetchPoolDetail: async () => d,
  getPolicy: () => policy,
  now: () => NOW,
});
let n = 0;
const t = async (name, fn) => { calls = []; await fn(); n++; console.log("ok -", name); };

await t("agent cannot call self_update", async () => {
  const r = await mk(detail())("self_update", {});
  assert.equal(r.blocked, true); assert.equal(calls.length, 0);
});
await t("operator may call self_update", async () => {
  await mk(detail())("self_update", {}, { source: "operator" });
  assert.equal(calls.length, 1);
});
await t("update_config strips protected keys", async () => {
  const r = await mk(detail())("update_config", { changes: { stopLossPct: -99, minVolume: 900 }, reason: "x" });
  assert.deepEqual(calls[0][1].changes, { minVolume: 900 });
  assert.deepEqual(r.rejected_keys, ["stopLossPct"]);
});
await t("update_config with only protected keys is blocked", async () => {
  const r = await mk(detail())("update_config", { changes: { maxPositions: 99 } });
  assert.equal(r.blocked, true); assert.equal(calls.length, 0);
});
await t("deploy passes for in-window pool", async () => {
  const r = await mk(detail())("deploy_position", { pool_address: "P" });
  assert.equal(r.success, true); assert.equal(calls.length, 1);
});
await t("deploy blocked: token too old", async () => {
  const r = await mk(detail({ token_x: { market_cap: 800000, organic_score: 70, created_at: NOW - 80 * H } }))("deploy_position", { pool_address: "P" });
  assert.equal(r.blocked, true); assert.equal(calls.length, 0);
});
await t("deploy blocked: missing tvl", async () => {
  const r = await mk(detail({ tvl: null }))("deploy_position", { pool_address: "P" });
  assert.equal(r.blocked, true); assert.match(r.reason, /tvl unknown/);
});
await t("deploy blocked: pool lookup fails", async () => {
  const g = createGuardedExecutor({ executeTool: async () => ({}), fetchPoolDetail: async () => { throw new Error("503"); }, getPolicy: () => policy, now: () => NOW });
  const r = await g("deploy_position", { pool_address: "P" });
  assert.equal(r.blocked, true);
});
await t("other tools pass through", async () => {
  await mk(detail())("get_my_positions", {});
  assert.equal(calls.length, 1);
});
console.log(`${n} guarded-executor tests passed`);
