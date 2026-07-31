---
name: meridian-manage
description: >
  Review open Meridian DLMM positions and take management actions (claim, close, swap).
  Use for /meridian-manage, /manage, "manage positions", "claim fees", "close if OOR",
  "trailing TP check", "run management cycle".
metadata:
  short-description: "Manage open LP positions"
---

# Meridian manage

Full position management cycle. Read risk rules:

- `.grok/skills/meridian/references/risk-rules.md`

## Fast path (preferred)

One AI management cycle (daemon logic: deterministic rules + LLM only when needed):

```bash
node cli.js manage
```

Use `--dry-run` if the user wants no on-chain effects.

Report the returned JSON `report` and stop unless the user wants manual CLI control.

---

## Manual path (when debugging or user wants step-by-step)

### 1. Snapshot

```bash
node cli.js positions
node cli.js balance
node cli.js lessons
```

### 2. Per position

```bash
node cli.js pnl <POSITION_ADDRESS>
```

Note: `strategy`, `instruction`, `pnl_pct`, `in_range`, unclaimed fees, age.

### 3. Priority order

1. **Instruction** met → execute immediately (close/claim as specified)
2. **Stop loss** (default ≤ −25%) → close
3. **Breakeven after trailing** → close if trail armed and PnL ≤ floor
4. **Trailing TP** (dynamic drop from peak) → close
5. **Hard TP** only if trailing is **disabled** in config
6. **Pumped far above range** → close
7. **OOR wait exceeded** → close
8. **Fee decay** vs entry → close
9. **Max hold** (stagnant) → close; strong trailing runners may hold
10. **Low yield** after min age → close
11. **Claim** if unclaimed fees ≥ `minClaimAmount`
12. Else **hold**

### 4. Strategy-specific extras (library)

| Strategy | Extra behavior |
|----------|----------------|
| `fee_compounding` | Claim then add-liquidity back if CLI supports and still in range |
| `partial_harvest` | Withdraw ~50% at ~10% return; swap harvested base → SOL |
| `single_sided_reseed` | OOR downside + volume alive: reseed path; else close |
| `custom_ratio_spot` / default | Standard rules above |
| `multi_layer` | Manage each layer/position independently |

**Live executor note:** standard autonomous path is **SOL-only** deploy. Complex multi-ratio deploys may be blocked by safety — do not fight the executor.

### 5. Execute

```bash
node cli.js claim --position <addr>
node cli.js close --position <addr>
# only if auto-swap failed / skip_swap used:
node cli.js swap --from <base_mint> --to SOL --amount <bal>
```

**Swap safety:** token→SOL or SOL→USDC/USDT only.

### 6. After closes

```bash
node cli.js evolve
node cli.js lessons add "<concise PREFER/AVOID rule from this cycle>"
```

## Execution rules

- Sequential only; wait for each command’s JSON
- Never close without fresh PnL (unless positions payload already has trustworthy PnL)
- Never invent addresses
- Prefer `node cli.js manage` over reinventing the deterministic engine when possible
