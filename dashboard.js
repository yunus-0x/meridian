/**
 * Meridian Web Dashboard
 *
 * Express + WebSocket server. Start via startDashboard() from index.js.
 * Access at http://your-vps:3000  (or DASHBOARD_PORT)
 * Protect with DASHBOARD_TOKEN in .env
 */

import http from "http";
import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { log } from "./logger.js";
import { config, reloadScreeningThresholds } from "./config.js";
import { getMyPositions } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { getPerformanceSummary, getPerformanceHistory } from "./lessons.js";
import { getMarketMode, setMarketMode } from "./market-mode.js";
import { executeTool } from "./tools/executor.js";

const require = createRequire(import.meta.url);
const express = require("express");
const { WebSocketServer } = require("ws");

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_LOG_HISTORY = 500;
const recentLogs = [];
let _broadcast = () => {};

// ── Log event hook (emitted by logger.js) ────────────────────
process.on("dashboard:log", (entry) => {
  recentLogs.push(entry);
  if (recentLogs.length > MAX_LOG_HISTORY) recentLogs.shift();
  _broadcast("log", entry);
});

// ── Called from index.js to push cycle/deploy/close events ───
export function dashboardEvent(type, data) {
  _broadcast(type, data);
}

// ── Main export ───────────────────────────────────────────────
export function startDashboard({ runManagement, runScreening }) {
  const port   = parseInt(process.env.DASHBOARD_PORT  || "3000");
  const token  = process.env.DASHBOARD_TOKEN          || null;

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // ── Auth middleware ───────────────────────────────────────
  function auth(req, res, next) {
    if (!token) return next();
    const t = req.headers["x-dashboard-token"] || req.query.token;
    if (t !== token) return res.status(401).json({ error: "Unauthorized" });
    next();
  }

  // ── Serve dashboard HTML ──────────────────────────────────
  const HTML_PATH = join(__dirname, "dashboard.html");
  app.get("/", (req, res) => {
    if (!existsSync(HTML_PATH)) {
      return res.status(404).send("dashboard.html not found");
    }
    res.setHeader("Content-Type", "text/html");
    res.send(readFileSync(HTML_PATH, "utf8"));
  });

  // ── REST API ──────────────────────────────────────────────

  // GET /api/status — wallet + summary
  app.get("/api/status", auth, async (req, res) => {
    let balance = null, posResult = null, modeInfo = null;
    try {
      [balance, posResult] = await Promise.all([
        getWalletBalances().catch(() => null),
        getMyPositions({ silent: true }).catch(() => null),
      ]);
    } catch {}
    try { modeInfo = getMarketMode(); } catch {}
    res.json({
      ok: true,
      dry_run: process.env.DRY_RUN === "true",
      uptime_s: Math.floor(process.uptime()),
      balance,
      positions_count: posResult?.total_positions ?? 0,
      market_mode: modeInfo?.current_mode ?? "auto",
      schedule: {
        managementIntervalMin: config.schedule?.managementIntervalMin ?? 10,
        screeningIntervalMin:  config.schedule?.screeningIntervalMin  ?? 30,
      },
    });
  });

  // GET /api/positions — full position list
  app.get("/api/positions", auth, async (req, res) => {
    try {
      const result = await getMyPositions({ force: true, silent: true });
      res.json(result ?? { positions: [], total_positions: 0 });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/candidates — top pool candidates
  app.get("/api/candidates", auth, async (req, res) => {
    try {
      const result = await getTopCandidates({ limit: 8 });
      res.json(result ?? { candidates: [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/performance — closed position stats
  app.get("/api/performance", auth, (req, res) => {
    try {
      const summary = getPerformanceSummary();
      const history = getPerformanceHistory({ hours: 72, limit: 20 });
      res.json({ summary, history });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/config — live config snapshot
  app.get("/api/config", auth, (req, res) => {
    try { res.json({
      risk:       config.risk,
      schedule:   config.schedule,
      marketMode: config.marketMode ?? "auto",
      management: {
        deployAmountSol:      config.management.deployAmountSol,
        positionSizePct:      config.management.positionSizePct,
        stopLossPct:          config.management.stopLossPct,
        maxDrawdownFromPeak:  config.management.maxDrawdownFromPeak,
        takeProfitFeePct:     config.management.takeProfitFeePct,
        trailingTriggerPct:   config.management.trailingTriggerPct,
        trailingDropPct:      config.management.trailingDropPct,
        outOfRangeWaitMinutes: config.management.outOfRangeWaitMinutes,
        belowOORWaitMinutes:  config.management.belowOORWaitMinutes,
        rebalanceOnOOR:       config.management.rebalanceOnOOR,
        minFeeVelocityPct:    config.management.minFeeVelocityPct,
        minClaimAmount:       config.management.minClaimAmount,
      },
      screening: {
        minFeeActiveTvlRatio: config.screening.minFeeActiveTvlRatio,
        minTvl:               config.screening.minTvl,
        maxTvl:               config.screening.maxTvl,
        minVolume:            config.screening.minVolume,
        minOrganic:           config.screening.minOrganic,
        minHolders:           config.screening.minHolders,
        minMcap:              config.screening.minMcap,
        maxMcap:              config.screening.maxMcap,
        minBinStep:           config.screening.minBinStep,
        maxBinStep:           config.screening.maxBinStep,
        maxVolatility:        config.screening.maxVolatility,
        minPoolAgeHours:      config.screening.minPoolAgeHours,
        maxPoolAgeHours:      config.screening.maxPoolAgeHours,
      },
    }); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/config — update a single config key
  app.post("/api/config", auth, async (req, res) => {
    try {
      const { key, value } = req.body;
      if (!key) return res.status(400).json({ error: "key required" });
      const result = await executeTool("update_config", { [key]: value });
      _broadcast("config_updated", { key, value });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/action — trigger bot actions
  app.post("/api/action", auth, async (req, res) => {
    try {
      const { action, params = {} } = req.body;
      let result;

      switch (action) {
        case "manage":
          runManagement({ silent: false })
            .catch((e) => log("dashboard", `Triggered management error: ${e.message}`));
          result = { started: true, message: "Management cycle triggered" };
          break;

        case "screen":
          runScreening({ silent: false })
            .catch((e) => log("dashboard", `Triggered screening error: ${e.message}`));
          result = { started: true, message: "Screening cycle triggered" };
          break;

        case "set_market_mode": {
          const r = setMarketMode(params.mode, { applyToConfig: config });
          if (r.success) reloadScreeningThresholds();
          result = r;
          break;
        }

        case "close_position":
          if (!params.position_address) return res.status(400).json({ error: "position_address required" });
          result = await executeTool("close_position", {
            position_address: params.position_address,
            reason: "dashboard_manual",
          });
          break;

        case "claim_fees":
          if (!params.position_address) return res.status(400).json({ error: "position_address required" });
          result = await executeTool("claim_fees", { position_address: params.position_address });
          break;

        default:
          return res.status(400).json({ error: `Unknown action: ${action}` });
      }

      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/logs — recent log history (for initial load)
  app.get("/api/logs", auth, (req, res) => {
    res.json({ logs: recentLogs.slice(-200) });
  });

  // ── HTTP + WebSocket server ───────────────────────────────
  const server = http.createServer(app);
  const wss    = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    // Auth check
    try {
      const url = new URL(req.url, "http://localhost");
      if (token && url.searchParams.get("token") !== token) {
        ws.close(4001, "Unauthorized");
        return;
      }
    } catch {
      ws.close(4001, "Bad request");
      return;
    }

    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("error", () => {});

    // Send log history immediately on connect
    for (const entry of recentLogs.slice(-100)) {
      try { ws.send(JSON.stringify({ type: "log", data: entry })); } catch {}
    }
    try { ws.send(JSON.stringify({ type: "connected", data: { ts: new Date().toISOString() } })); } catch {}
  });

  // Heartbeat — prune dead connections
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);
  wss.on("close", () => clearInterval(heartbeat));

  // Auto-push position snapshot every 60s to all connected clients
  const posPush = setInterval(async () => {
    if (wss.clients.size === 0) return;
    try {
      const result = await getMyPositions({ silent: true }).catch(() => null);
      if (result) _broadcast("positions", result);
    } catch {}
  }, 60_000);
  server.on("close", () => clearInterval(posPush));

  // Broadcast function
  _broadcast = (type, data) => {
    const msg = JSON.stringify({ type, data });
    wss.clients.forEach((ws) => {
      if (ws.readyState === 1) { try { ws.send(msg); } catch {} }
    });
  };

  server.listen(port, "0.0.0.0", () => {
    const url = token
      ? `http://YOUR_VPS_IP:${port}/?token=${token}`
      : `http://YOUR_VPS_IP:${port}`;
    log("dashboard", `Dashboard running → ${url}`);
  });

  server.on("error", (e) => {
    log("dashboard_error", `Dashboard failed to start: ${e.message}`);
  });

  return { broadcast: _broadcast };
}
