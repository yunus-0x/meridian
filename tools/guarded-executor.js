import { evaluateEntry } from "../risk/entry-policy.js";
import { filterAgentConfigChanges, AGENT_FORBIDDEN_TOOLS } from "../risk/permissions.js";

/** Map a Meteora pool-discovery detail object to the candidate shape used by evaluateEntry. */
export function poolDetailToCandidate(detail, now = Date.now()) {
  const d = detail || {};
  return {
    tvl: d.tvl ?? d.active_tvl ?? null,
    volume: d.volume ?? null,
    holders: d.base_token_holders ?? d.token_x?.holders ?? null,
    mcap: d.token_x?.market_cap ?? d.base_token_market_cap ?? null,
    binStep: d.dlmm_params?.bin_step ?? d.pool_config?.bin_step ?? null,
    feeActiveTvlRatio: d.fee_active_tvl_ratio ?? null,
    volatility: d.volatility ?? null,
    organicScore: d.token_x?.organic_score ?? null,
    createdAt: d.token_x?.created_at ?? null,
    fetchedAt: now,
  };
}

/**
 * Wrap an existing executeTool with policy checks. Dependencies are injected so the
 * wrapper can be tested offline and the original executor stays unchanged.
 * deps: { executeTool, fetchPoolDetail(poolAddress), getPolicy(), log?(tag,msg), now?() }
 * ctx.source === "operator" bypasses agent-only restrictions (CLI use).
 */
export function createGuardedExecutor(deps) {
  const { executeTool, fetchPoolDetail, getPolicy } = deps;
  const log = deps.log || (() => {});
  const nowFn = deps.now || Date.now;

  return async function executeToolGuarded(name, args = {}, ctx = {}) {
    const tool = String(name || "").replace(/<.*$/, "").trim();
    const fromAgent = ctx.source !== "operator";

    if (fromAgent && AGENT_FORBIDDEN_TOOLS.has(tool)) {
      log("policy_block", `${tool} is not available to the autonomous agent`);
      return { blocked: true, reason: `${tool} is operator-only` };
    }

    if (fromAgent && tool === "update_config") {
      const { allowed, rejected } = filterAgentConfigChanges(args.changes);
      if (rejected.length) log("policy_block", `update_config rejected operator-only keys: ${rejected.join(", ")}`);
      if (Object.keys(allowed).length === 0) {
        return { success: false, blocked: true, rejected, reason: "no agent-modifiable keys in request" };
      }
      const res = await executeTool(tool, { ...args, changes: allowed });
      return rejected.length ? { ...res, rejected_keys: rejected } : res;
    }

    if (tool === "deploy_position") {
      const pool = args.pool_address;
      if (!pool) return { blocked: true, reason: "deploy_position requires pool_address" };
      let detail;
      try {
        detail = await fetchPoolDetail(pool);
      } catch (e) {
        return { blocked: true, reason: `could not verify pool before deploy: ${e.message}` };
      }
      if (!detail) return { blocked: true, reason: `pool ${pool} not found` };
      const verdict = evaluateEntry(poolDetailToCandidate(detail, nowFn()), getPolicy(), nowFn());
      if (!verdict.pass) {
        log("policy_block", `deploy blocked for ${pool}: ${verdict.reasons.join("; ")}`);
        return { blocked: true, reason: `entry policy: ${verdict.reasons.join("; ")}` };
      }
    }

    return executeTool(tool, args);
  };
}
