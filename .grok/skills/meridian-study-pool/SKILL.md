---
name: meridian-study-pool
description: >
  Study top LPers on a Meteora DLMM pool (hold time, win rate, strategy bias). Use for
  /meridian-study-pool, /study-pool, "study LPers", "who wins on this pool". Pass pool address.
metadata:
  short-description: "Study top LPers on a pool"
---

# Meridian study pool

Requires a pool address (user arg or from candidates).

```bash
node cli.js study --pool <POOL_ADDRESS>
```

Optional:

```bash
node cli.js pool-memory --pool <POOL_ADDRESS>
node cli.js pool-detail --pool <POOL_ADDRESS>
```

## Extract

- Average hold time (scalper vs holder regime)
- Top LPer win rate
- Dominant shape (bid_ask / spot / curve)
- Typical bin widths if present
- Whether this pool favors short fee snipes vs longer holds

## Deploy implication

| Pattern | Implication |
|---------|-------------|
| High win rate, short holds | Scalp fees; tighter management interval |
| High win rate, long holds | Fee farm; allow max-hold only if fees alive |
| Low win rate &lt; 50% | Reduce confidence / skip unless exceptional fees |
| Bid-ask winners on mature pool | Prefer bid_ask SOL-only below active |

Relate findings to live constraints: **SOL-only, bins_below ≥ 35, bins_above = 0**.
