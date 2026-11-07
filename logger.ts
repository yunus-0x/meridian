import fs from "node:fs";
import path from "node:path";
import { repoPath } from "./repo-root.js";
import {
  LogLevelSchema,
  ActionLogEntrySchema,
  type LogLevel,
  type ActionLogEntry,
  type ActionLogRecord,
} from "./src/schemas/logging.js";

export { LogLevelSchema, ActionLogEntrySchema };
export type { LogLevel, ActionLogEntry, ActionLogRecord };

const LOG_DIR: string = repoPath("logs");
const rawLogLevel = process.env.LOG_LEVEL || "info";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const parsedLogLevel = LogLevelSchema.safeParse(rawLogLevel);
const currentLevel: number = parsedLogLevel.success
  ? (LEVELS[parsedLogLevel.data] ?? 1)
  : 1;

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * General log function.
 */
export function log(category: string, message: string): void {
  const level: LogLevel = category.includes("error")
    ? "error"
    : category.includes("warn")
    ? "warn"
    : category.includes("debug")
    ? "debug"
    : "info";

  const levelVal = LEVELS[level] ?? 1;
  if (levelVal < currentLevel) return;

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${category.toUpperCase()}] ${message}`;

  // Console output
  console.log(line);

  // File output (daily rotation)
  const dateStr = timestamp.split("T")[0];
  const logFile = path.join(LOG_DIR, `agent-${dateStr}.log`);
  fs.appendFileSync(logFile, line + "\n");
}

function actionHint(action: ActionLogEntry): string {
  const a: Record<string, unknown> = action.args ?? {};
  const r: Record<string, unknown> =
    typeof action.result === "object" && action.result !== null ? action.result : {};
  switch (action.tool) {
    case "deploy_position": {
      const poolName = typeof a["pool_name"] === "string" ? a["pool_name"] : "";
      const poolAddr = typeof a["pool_address"] === "string" ? a["pool_address"].slice(0, 8) : "";
      const amountSol = a["amount_sol"] != null ? String(a["amount_sol"]) : "";
      return ` ${poolName || poolAddr} ${amountSol} SOL`;
    }
    case "close_position": {
      const posAddr = typeof a["position_address"] === "string" ? a["position_address"].slice(0, 8) : "";
      const pnlUsd = typeof r["pnl_usd"] === "number" ? r["pnl_usd"] : null;
      const pnlPct = r["pnl_pct"] != null ? String(r["pnl_pct"]) : "";
      const pnlStr = pnlUsd != null ? ` | PnL $${pnlUsd >= 0 ? "+" : ""}${pnlUsd} (${pnlPct}%)` : "";
      return ` ${posAddr}${pnlStr}`;
    }
    case "claim_fees": {
      const posAddr = typeof a["position_address"] === "string" ? a["position_address"].slice(0, 8) : "";
      return ` ${posAddr}`;
    }
    case "get_active_bin": {
      const binId = r["binId"] != null ? String(r["binId"]) : "";
      return ` bin ${binId}`;
    }
    case "get_pool_detail": {
      const name = typeof r["name"] === "string" ? r["name"] : "";
      const poolAddr = typeof a["pool_address"] === "string" ? a["pool_address"].slice(0, 8) : "";
      return ` ${name || poolAddr}`;
    }
    case "get_my_positions": {
      const total = r["total_positions"] != null ? String(r["total_positions"]) : "";
      return ` ${total} positions`;
    }
    case "get_wallet_balance": {
      const sol = r["sol"] != null ? String(r["sol"]) : "";
      return ` ${sol} SOL`;
    }
    case "get_top_candidates": {
      const candidates = Array.isArray(r["candidates"]) ? r["candidates"] : [];
      return ` ${candidates.length} pools`;
    }
    case "swap_token": {
      const amount = a["amount"] != null ? String(a["amount"]) : "";
      const inMint = typeof a["input_mint"] === "string" ? a["input_mint"].slice(0, 6) : "";
      return ` ${amount} ${inMint}→SOL`;
    }
    case "update_config": {
      const applied = typeof r["applied"] === "object" && r["applied"] !== null ? Object.keys(r["applied"]) : [];
      return ` ${applied.join(", ")}`;
    }
    case "add_lesson": return ` saved`;
    case "clear_lessons": {
      const cleared = r["cleared"] != null ? String(r["cleared"]) : "";
      return ` cleared ${cleared}`;
    }
    default: return "";
  }
}

export function logAction(action: ActionLogEntry): void {
  const timestamp = new Date().toISOString();
  const entry: ActionLogRecord = { timestamp, ...action };

  // Console: single clean line, no raw JSON
  const status = action.success ? "✓" : "✗";
  const dur = action.duration_ms != null ? ` (${action.duration_ms}ms)` : "";
  const hint = actionHint(action);
  console.log(`[${action.tool}] ${status}${hint}${dur}`);

  // File: full JSON for audit trail
  const dateStr = timestamp.split("T")[0];
  const actionsFile = path.join(LOG_DIR, `actions-${dateStr}.jsonl`);
  fs.appendFileSync(actionsFile, JSON.stringify(entry) + "\n");
}
