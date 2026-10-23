import assert from "node:assert/strict";
import { strictNumber, toEpochMs, tokenAgeHours, evaluateTokenAge, evaluateEntry } from "../risk/entry-policy.js";
import { filterAgentConfigChanges, AGENT_FORBIDDEN_TOOLS } from "../risk/permissions.js";

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const H = 3_600_000;
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

t("strictNumber rejects null/empty/NaN/bool", () => {
  for (const v of [null, undefined, "", "  ", NaN, Infinity, true, "abc"]) assert.equal(strictNumber(v), null);
  assert.equal(strictNumber("12.5"), 12.5);
  assert.equal(strictNumber(0), 0);
});
t("toEpochMs handles seconds and ms", () => {
  assert.equal(toEpochMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(toEpochMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(toEpochMs(0), null);
});
t("future timestamp is invalid", () => {
  assert.equal(tokenAgeHours(NOW + 2 * H, NOW), null);
  assert.ok(tokenAgeHours(NOW + 60_000, NOW) >= 0);
});
t("age window 5-36h", () => {
  const w = { minHours: 5, maxHours: 36 };
  assert.equal(evaluateTokenAge(NOW - 4 * H, w, NOW).pass, false);
  assert.equal(evaluateTokenAge(NOW - 5 * H, w, NOW).pass, true);
  assert.equal(evaluateTokenAge(NOW - 36 * H, w, NOW).pass, true);
  assert.equal(evaluateTokenAge(NOW - 37 * H, w, NOW).pass, false);
});
t("unknown age fails when window active, passes when inactive", () => {
  assert.equal(evaluateTokenAge(null, { minHours: 5, maxHours: 36 }, NOW).pass, false);
  assert.equal(evaluateTokenAge(null, {}, NOW).pass, true);
});
const good = { tvl: 50000, volume: 5000, holders: 900, mcap: 800000, binStep: 100, feeActiveTvlRatio: 0.08, volatility: 2, organicScore: 70, createdAt: NOW - 10 * H, fetchedAt: NOW - 5000 };
const policy = { minTvl: 10000, maxTvl: 150000, minVolume: 500, minHolders: 500, minMcap: 150000, maxMcap: 10000000, minBinStep: 80, maxBinStep: 125, minFeeActiveTvlRatio: 0.05, minOrganic: 60, minTokenAgeHours: 5, maxTokenAgeHours: 36, maxDataAgeMs: 60000 };
t("good candidate passes", () => assert.deepEqual(evaluateEntry(good, policy, NOW).reasons, []));
t("missing tvl is rejected, not treated as 0 or skipped", () => {
  const r = evaluateEntry({ ...good, tvl: null }, policy, NOW);
  assert.equal(r.pass, false);
  assert.ok(r.reasons.some((x) => x.includes("tvl unknown")));
});
t("zero volatility and stale data are rejected", () => {
  assert.equal(evaluateEntry({ ...good, volatility: 0 }, policy, NOW).pass, false);
  assert.equal(evaluateEntry({ ...good, fetchedAt: NOW - 120000 }, policy, NOW).pass, false);
  assert.equal(evaluateEntry({ ...good, fetchedAt: undefined }, policy, NOW).pass, false);
});
t("out-of-window age is rejected in full evaluation", () => {
  assert.equal(evaluateEntry({ ...good, createdAt: NOW - 50 * H }, policy, NOW).pass, false);
});
t("agent cannot change operator-only keys (case-insensitive)", () => {
  const { allowed, rejected } = filterAgentConfigChanges({ stopLossPct: -90, MAXPOSITIONS: 50, minVolume: 1000, minTokenAgeHours: 0 });
  assert.deepEqual(allowed, { minVolume: 1000 });
  assert.deepEqual(rejected.sort(), ["MAXPOSITIONS", "minTokenAgeHours", "stopLossPct"]);
});
t("self_update is forbidden for the agent", () => assert.ok(AGENT_FORBIDDEN_TOOLS.has("self_update")));
console.log(`${n} tests passed`);
