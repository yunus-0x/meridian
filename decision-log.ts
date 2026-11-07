import fs from "node:fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import {
  DecisionRecordSchema,
  DecisionLogDbSchema,
  type DecisionRecord,
  type DecisionLogDb,
} from "./src/schemas/storage.js";

export { DecisionRecordSchema, DecisionLogDbSchema };
export type { DecisionRecord, DecisionLogDb };

const DECISION_LOG_FILE: string = repoPath("decision-log.json");
const MAX_DECISIONS = 100;

function load(): DecisionLogDb {
  if (!fs.existsSync(DECISION_LOG_FILE)) {
    return { decisions: [] };
  }
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(DECISION_LOG_FILE, "utf8"));
    const parsed = DecisionLogDbSchema.safeParse(raw);
    if (!parsed.success) {
      log("decision_log_warn", `Invalid ${DECISION_LOG_FILE}: schema validation failed`);
      return { decisions: [] };
    }
    return parsed.data;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log("decision_log_warn", `Invalid ${DECISION_LOG_FILE}: ${msg}`);
    return { decisions: [] };
  }
}

function save(data: DecisionLogDb): void {
  const validated = DecisionLogDbSchema.parse(data);
  fs.writeFileSync(
    DECISION_LOG_FILE,
    JSON.stringify(
      validated,
      (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
      2
    )
  );
}

function sanitizeMetrics(metrics?: Record<string, unknown>): Record<string, unknown> {
  if (!metrics || typeof metrics !== "object") return {};
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metrics)) {
    cleaned[k] = typeof v === "bigint" ? v.toString() : v;
  }
  return cleaned;
}

function sanitize(value: unknown, maxLen = 280): string | null {
  if (value == null) return null;
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLen) || null;
}

export interface AppendDecisionInput {
  type?: string;
  actor?: string;
  pool?: string | null;
  pool_name?: string | null;
  position?: string | null;
  summary?: string | null;
  reason?: string | null;
  risks?: Array<unknown>;
  metrics?: Record<string, unknown>;
  rejected?: Array<unknown>;
}

export function appendDecision(entry: AppendDecisionInput): DecisionRecord {
  const data = load();
  const decision: DecisionRecord = {
    id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    type: entry.type || "note",
    actor: entry.actor || "GENERAL",
    pool: entry.pool || null,
    pool_name: sanitize(entry.pool_name || entry.pool, 120),
    position: entry.position || null,
    summary: sanitize(entry.summary),
    reason: sanitize(entry.reason, 500),
    risks: Array.isArray(entry.risks)
      ? (entry.risks.map((r) => sanitize(r, 140)).filter((r): r is string => Boolean(r)).slice(0, 6))
      : [],
    metrics: sanitizeMetrics(entry.metrics),
    rejected: Array.isArray(entry.rejected)
      ? (entry.rejected.map((r) => sanitize(r, 180)).filter((r): r is string => Boolean(r)).slice(0, 8))
      : [],
  };
  data.decisions.unshift(decision);
  data.decisions = data.decisions.slice(0, MAX_DECISIONS);
  save(data);
  return decision;
}

export function getRecentDecisions(limit = 10): DecisionRecord[] {
  const data = load();
  return (data.decisions || []).slice(0, limit);
}

export function getDecisionSummary(limit = 6): string {
  const decisions = getRecentDecisions(limit);
  if (!decisions.length) return "No recent structured decisions yet.";
  return decisions
    .map((d, i) => {
      const bits = [
        `${i + 1}. [${d.actor}] ${d.type.toUpperCase()} ${d.pool_name || d.pool || "unknown pool"}`,
        d.summary ? `summary: ${d.summary}` : null,
        d.reason ? `reason: ${d.reason}` : null,
        d.risks?.length ? `risks: ${d.risks.join(", ")}` : null,
        d.rejected?.length ? `rejected: ${d.rejected.join(" | ")}` : null,
      ].filter((b): b is string => Boolean(b));
      return bits.join(" | ");
    })
    .join("\n");
}
