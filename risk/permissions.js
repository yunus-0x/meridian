/**
 * Operator-owned configuration keys. The autonomous agent may not change these
 * through update_config; they can only be edited by the operator in user-config.json.
 */
export const OPERATOR_ONLY_KEYS = new Set([
  "minTokenAgeHours", "maxTokenAgeHours",
  "stopLossPct", "maxPositions", "maxDeployAmount",
  "deployAmountSol", "positionSizePct", "gasReserve", "minSolToOpen",
  "hiveMindUrl", "hiveMindApiKey", "agentMeridianApiUrl", "publicApiKey",
  "pnlRpcUrl", "pnlSource", "gmgnApiKey",
  "excludeHighSupplyConcentration", "maxTop10Pct", "maxBotHoldersPct",
  "blockedLaunchpads", "allowedLaunchpads",
]);

export function filterAgentConfigChanges(changes) {
  const allowed = {};
  const rejected = [];
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return { allowed, rejected };
  for (const [key, value] of Object.entries(changes)) {
    const protectedKey = [...OPERATOR_ONLY_KEYS].some((k) => k.toLowerCase() === String(key).toLowerCase());
    if (protectedKey) rejected.push(key);
    else allowed[key] = value;
  }
  return { allowed, rejected };
}

/** Tools the autonomous agent must not be able to call. */
export const AGENT_FORBIDDEN_TOOLS = new Set(["self_update"]);
