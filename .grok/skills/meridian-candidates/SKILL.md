---
name: meridian-candidates
description: >
  Fetch and analyse top Meridian pool candidates (fee/TVL, organic, holders, smart wallets,
  pool memory, degen/rank scores). Use for /meridian-candidates, /candidates, "what pools",
  "screen without deploy", "top opportunities".
metadata:
  short-description: "Top pool candidates"
---

# Meridian candidates

## 1. Fetch

```bash
node cli.js candidates --limit 5
```

Optional context:

```bash
node cli.js lessons
node cli.js blacklist list
node cli.js discord-signals
```

## 2. Optional external signals (if installed)

```bash
onchainos signal list --chain solana --wallet-type 1
onchainos token trending --chains solana
```

If `onchainos` is missing, skip and note it — do not fail the skill.

## 3. Score & recommend

For each candidate evaluate:

| Check | Rule |
|-------|------|
| fee / active TVL | Higher better; hard floor from config (~0.05%) |
| fee / volatility | **Primary LP edge** — high fees vs vol |
| organic | Prefer ≥70; hard reject &lt; minOrganic |
| bot % | Reject &gt; maxBotHoldersPct (default 30) |
| top10 | Reject &gt; maxTop10Pct (default 60) |
| degen_score / rank_score | Prefer balanced efficiency |
| smart wallets | Strong boost if present |
| pool_memory | Penalize low adj win rate / serial OOR |
| volume/fee change | Avoid dying farms (sharp negative %) |
| PVP / launchpad | Respect avoid/block lists |

## 4. Output format

1. Ranked table: name, pool (short), fee/aTVL, vol, organic, degen, memory note, **deploy yes/no**
2. Top pick with 3–5 bullet reasons
3. Explicit rejects with one-line reason
4. **Do not deploy** unless the user asked to deploy or invoked `/meridian-screen`

## Safety

Never recommend blacklisted mints. Align with SOL-only single-sided deploy (no “swap half to token then two-sided” unless user overrides agent safety — live executor blocks amount_x).
