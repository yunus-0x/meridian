---
name: meridian-screen
description: >
  Full Meridian screening cycle: discord queue, wallet, candidates, deep research,
  optional deploy. Use for /meridian-screen, /screen, "find a pool and deploy",
  "run screening", "open a new position".
metadata:
  short-description: "Screen pools & deploy"
---

# Meridian screen

Read:

- `.grok/skills/meridian/references/risk-rules.md`
- `.grok/skills/meridian/references/safety.md`

## Fast path (preferred)

```bash
node cli.js screen
```

This runs the agent SCREENER cycle (hard filters, recon, circuit breaker, LLM deploy).  
Use `--dry-run` for simulation. Summarise the report and stop.

---

## Manual path (research + optional deploy)

Run **sequentially** from repo root.

### Step 0 — Discord queue

```bash
node cli.js discord-signals
```

If a signal is `pending`: treat as priority candidate; skip generic candidates if focusing that pool.  
If deep research hard-rejects it:

```bash
node cli.js blacklist add --mint <mint> --reason "discord signal — failed screening"
```

### Step 1 — Config & capital

```bash
node cli.js config
node cli.js balance
```

Need roughly `deployAmountSol + gasReserve` free SOL (unless dry-run).  
If circuit-breaker style losses are obvious from recent performance, **do not deploy**:

```bash
node cli.js performance
```

### Step 2 — Memory

```bash
node cli.js lessons
node cli.js blacklist list
```

### Step 3 — Candidates

```bash
node cli.js candidates --limit 5
```

Optional OKX (if installed):

```bash
onchainos signal list --chain solana --wallet-type 1
```

### Step 4 — Deep research (top 1–2)

For each shortlist pool/mint:

```bash
node cli.js token-info --query <mint>
node cli.js token-holders --mint <mint>
node cli.js token-narrative --mint <mint>
node cli.js pool-detail --pool <pool>
node cli.js active-bin --pool <pool>
node cli.js study --pool <pool>
node cli.js pool-memory --pool <pool>
```

### Step 5 — Decide

**Hard reject:** bot% high, top10 high, organic low, blacklisted, blocked launchpad, unusable volatility, poor memory WR, dead volume, fee/TVL below floor.

**Prefer:** high fee/vol edge, degen balance, smart wallets, rising volume/fees, strong study win rate.

### Step 6 — Deploy (only if yes)

Live agent constraints:

- **SOL only** — do not swap to base for two-sided deploy (executor blocks `amount_x > 0`)
- `bins_above = 0`
- `bins_below` ≥ 35 (and within config)
- Strategy usually `bid_ask` (config `strategy`)

```bash
node cli.js deploy --pool <pool> --amount <sol> --bins-below <N> --bins-above 0 --strategy bid_ask
```

Explain ranking, research findings, amount, and risks **before** deploy when the user is interactive.

## Do not

- Background long txs
- Buy memecoins via swap “to balance the pool”
- Ignore blacklist / cooldowns / max positions
