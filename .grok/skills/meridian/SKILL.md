---
name: meridian
description: >
  Hub skill for Meridian autonomous Meteora DLMM LP agent. Use when working on this
  repo, running LP ops, screening pools, managing positions, tuning risk, or the user
  says /meridian, "meridian", "dlmm agent", "meteora agent", "run screen", "run manage".
  Routes to specialized skills and enforces live agent safety (SOL-only deploy, risk circuit breaker).
metadata:
  short-description: "Meridian DLMM agent hub"
---

# Meridian — Grok hub

Autonomous **Meteora DLMM** liquidity agent (Solana). Engineering manual: `Claude.md` / `CLAUDE.md` at repo root.

## Read first

1. `Claude.md` — architecture, roles, persistent JSON files, safety invariants
2. `.grok/skills/meridian/references/risk-rules.md` — exits, circuit breaker, sizing
3. `.grok/skills/meridian/references/cli-commands.md` — `node cli.js` map
4. `.grok/skills/meridian/references/safety.md` — secrets & ops rules

## Skill map (slash)

| Intent | Skill |
|--------|--------|
| Wallet balance | `/meridian-balance` |
| Open positions | `/meridian-positions` |
| Top candidates | `/meridian-candidates` |
| Full screen + optional deploy | `/meridian-screen` |
| Manage / claim / close | `/meridian-manage` |
| Deep screener persona | `/meridian-screener` |
| Deep manager persona | `/meridian-manager` |
| Study top LPers | `/meridian-study-pool` |
| Compare pools for a token | `/meridian-pool-compare` |
| Pool OHLCV | `/meridian-pool-ohlcv` |

## Roles (daemon vs interactive)

| Role | Cadence | Tools |
|------|---------|--------|
| SCREENER | screening cron / `node cli.js screen` | deploy + research |
| MANAGER | management cron / `node cli.js manage` | close, claim, swap, pnl |
| GENERAL | Telegram / REPL | intent-filtered tools |

Interactive Grok skills call **CLI** (`node cli.js`). Daemon logic lives in `index.js` + `agent.js`.

## Critical live constraints (do not regress)

1. **SOL-only single-sided deploys** — safety rejects `amount_x > 0`; use `bins_above=0`
2. **Min bins_below = 35** (`MIN_SAFE_BINS_BELOW`)
3. **Trailing TP owns winners** — hard TP disabled while trailing is on (unless config override)
4. **Swap allowlist** — token→SOL or SOL→USDC/USDT only
5. **Circuit breaker** — after daily/consecutive losses, skip new deploys only
6. Lazy-load `@meteora-ag/dlmm` — never top-level import in new code

## Default workflow when user is vague

1. `node cli.js balance`
2. `node cli.js positions`
3. If positions > 0 → follow `/meridian-manage`
4. Else if funds ≥ deploy + gas → follow `/meridian-screen` (or candidates only if they ask to analyse)

## Subagents

For parallel deep work, spawn:

- `subagent_type: "screener"` — candidate analysis (read-heavy)
- `subagent_type: "manager"` — position actions

Give them the matching skill body + “repo root = meridian-dllm-agent”.
