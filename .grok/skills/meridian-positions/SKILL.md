---
name: meridian-positions
description: >
  List open Meridian DLMM positions with range status and whether action is needed.
  Use for /meridian-positions, /positions, "open positions", "what's open", "LP status".
metadata:
  short-description: "Open DLMM positions"
---

# Meridian positions

```bash
node cli.js positions
```

For each position, show:

| Field | Why it matters |
|-------|----------------|
| pair / pool | Identity |
| in_range | OOR risk |
| age_minutes | Max-hold / yield checks |
| pnl_pct / value | Exit rules |
| unclaimed fees | Claim threshold |
| strategy | Strategy-specific manage |
| instruction | Highest-priority override |

## Action hints (do not execute unless user asked to manage)

- Unclaimed fees ≥ config `minClaimAmount` → claim candidate
- OOR long enough → close candidate
- PnL ≤ stopLossPct → stop loss candidate
- Trailing active + drop from peak → trailing TP candidate

For full management actions, switch to `/meridian-manage`.

## Optional deep dive

If user names a position or wants detail:

```bash
node cli.js pnl <position_address>
```
