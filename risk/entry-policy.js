/**
 * Entry policy: pure, dependency-free validation helpers.
 * Principle: missing, malformed or stale data never passes a required check.
 */

const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** Strict numeric parse. null/undefined/""/NaN/Infinity -> null (never 0). */
export function strictNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Normalize an epoch timestamp given in seconds or milliseconds to ms. */
export function toEpochMs(value) {
  const n = strictNumber(value);
  if (n === null || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** Token age in hours, or null when the creation time is unusable or in the future. */
export function tokenAgeHours(createdAt, now = Date.now()) {
  const ms = toEpochMs(createdAt);
  if (ms === null) return null;
  if (ms > now + FUTURE_TOLERANCE_MS) return null;
  return Math.max(0, (now - ms) / 3_600_000);
}

/** Age window check. Inactive when both bounds are null; unknown age fails when active. */
export function evaluateTokenAge(createdAt, { minHours = null, maxHours = null } = {}, now = Date.now()) {
  const min = strictNumber(minHours);
  const max = strictNumber(maxHours);
  if (min === null && max === null) return { pass: true, ageHours: tokenAgeHours(createdAt, now) };
  const age = tokenAgeHours(createdAt, now);
  if (age === null) return { pass: false, reason: "token age unknown or invalid", ageHours: null };
  if (min !== null && age < min) return { pass: false, reason: `token age ${age.toFixed(2)}h below min ${min}h`, ageHours: age };
  if (max !== null && age > max) return { pass: false, reason: `token age ${age.toFixed(2)}h above max ${max}h`, ageHours: age };
  return { pass: true, ageHours: age };
}

const REQUIRED_NUMERIC = [
  ["tvl", "tvl", "min", "minTvl"],
  ["tvl", "tvl", "max", "maxTvl"],
  ["volume", "volume", "min", "minVolume"],
  ["holders", "holders", "min", "minHolders"],
  ["mcap", "mcap", "min", "minMcap"],
  ["mcap", "mcap", "max", "maxMcap"],
  ["binStep", "binStep", "min", "minBinStep"],
  ["binStep", "binStep", "max", "maxBinStep"],
  ["feeActiveTvlRatio", "fee/active-TVL", "min", "minFeeActiveTvlRatio"],
  ["organicScore", "organic score", "min", "minOrganic"],
];

/**
 * Evaluate a candidate against a policy snapshot.
 * candidate: { tvl, volume, holders, mcap, binStep, feeActiveTvlRatio, volatility, organicScore, createdAt, fetchedAt }
 * policy: threshold keys listed above plus minTokenAgeHours, maxTokenAgeHours, maxDataAgeMs.
 * Returns { pass, reasons[] }.
 */
export function evaluateEntry(candidate, policy = {}, now = Date.now()) {
  const reasons = [];
  const c = candidate || {};

  for (const [field, label, kind, key] of REQUIRED_NUMERIC) {
    const limit = strictNumber(policy[key]);
    if (limit === null || (kind === "min" && limit <= 0)) continue;
    const v = strictNumber(c[field]);
    if (v === null) { reasons.push(`${label} unknown`); continue; }
    if (kind === "min" && v < limit) reasons.push(`${label} ${v} below ${key} ${limit}`);
    if (kind === "max" && v > limit) reasons.push(`${label} ${v} above ${key} ${limit}`);
  }

  const vol = strictNumber(c.volatility);
  if (vol === null || vol <= 0) reasons.push(`volatility ${vol ?? "unknown"} unusable`);

  const age = evaluateTokenAge(c.createdAt, {
    minHours: policy.minTokenAgeHours,
    maxHours: policy.maxTokenAgeHours,
  }, now);
  if (!age.pass) reasons.push(age.reason);

  const maxDataAgeMs = strictNumber(policy.maxDataAgeMs);
  if (maxDataAgeMs !== null && maxDataAgeMs > 0) {
    const fetched = toEpochMs(c.fetchedAt);
    if (fetched === null) reasons.push("data timestamp unknown");
    else if (now - fetched > maxDataAgeMs) reasons.push(`data stale (${Math.round((now - fetched) / 1000)}s)`);
  }

  return { pass: reasons.length === 0, reasons, ageHours: age.ageHours ?? null };
}
