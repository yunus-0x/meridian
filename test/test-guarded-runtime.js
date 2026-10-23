import assert from "node:assert/strict";
import { buildPolicy, createPoolDetailFetcher } from "../tools/guarded-runtime.js";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok -", name); };

await t("buildPolicy maps screening config and sets data freshness", async () => {
  const p = buildPolicy({ minTvl: 1, maxTvl: 2, minTokenAgeHours: 5, maxTokenAgeHours: 36, minOrganic: 60 });
  assert.equal(p.minTvl, 1); assert.equal(p.minTokenAgeHours, 5); assert.equal(p.maxTokenAgeHours, 36);
  assert.equal(p.maxDataAgeMs, 120000);
});
const mkFetch = (byTf, urls = []) => async (url) => {
  urls.push(url);
  const tf = new URL(url).searchParams.get("timeframe");
  const body = byTf[tf];
  if (body === "ERR") return { ok: false, status: 503, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ data: body ? [structuredClone(body)] : [] }) };
};
await t("5m screening: volatility is taken from the 30m window", async () => {
  const urls = [];
  const f = createPoolDetailFetcher(mkFetch({ "5m": { tvl: 1, volatility: 0 }, "30m": { volatility: 3.2 } }, urls), () => "5m");
  const d = await f("POOL");
  assert.equal(d.volatility, 3.2); assert.equal(urls.length, 2);
  assert.match(urls[0], /pool_address%3DPOOL/);
});
await t("1h screening: single request, volatility unchanged", async () => {
  const urls = [];
  const f = createPoolDetailFetcher(mkFetch({ "1h": { tvl: 1, volatility: 1.5 } }, urls), () => "1h");
  assert.equal((await f("P")).volatility, 1.5); assert.equal(urls.length, 1);
});
await t("unknown pool returns null; API error throws", async () => {
  assert.equal(await createPoolDetailFetcher(mkFetch({ "5m": null }), () => "5m")("P"), null);
  await assert.rejects(createPoolDetailFetcher(mkFetch({ "5m": "ERR" }), () => "5m")("P"), /503/);
});
await t("missing 30m volatility leaves original value (policy then rejects unusable volatility)", async () => {
  const f = createPoolDetailFetcher(mkFetch({ "5m": { volatility: 0 }, "30m": { volatility: null } }), () => "5m");
  assert.equal((await f("P")).volatility, 0);
});
console.log(`${n} guarded-runtime tests passed`);
