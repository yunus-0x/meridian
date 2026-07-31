---
name: meridian-pool-compare
description: >
  Compare Meteora DLMM pools for a token by fee/TVL, volume, bin step. Use for
  /meridian-pool-compare, /pool-compare, "best pool for TOKEN", "which bin step".
metadata:
  short-description: "Compare pools for a token"
---

# Meridian pool compare

Argument: token symbol or mint.

## 1. Prefer Meridian search when possible

```bash
node cli.js search-pools --query <TOKEN>
```

## 2. Meteora datapi (fallback / broader)

```bash
curl -s "https://dlmm.datapi.meteora.ag/pools/groups?query=<TOKEN>&sort_by=fee_tvl_ratio&page_size=10"
```

Optional protocol context:

```bash
curl -s "https://dlmm.datapi.meteora.ag/stats/protocol_metrics"
```

## 3. Rank

For each pool show:

- address, name
- bin_step (must fit config minBinStep–maxBinStep for deploy)
- volume / fees (window)
- fee_tvl_ratio / fee_active_tvl_ratio
- TVL / active TVL
- farm APR if any

**Pick** highest capital efficiency **with**:

- bin_step appropriate for volatility (very tight bins on degen = frequent OOR)
- enough TVL (not dust, not monopolized)
- not conflicting with open base-mint positions

## 4. Live agent fit

If recommending deploy into Meridian:

- Check blacklist, cooldowns via `node cli.js pool-memory --pool <addr>`
- Deploy path is **SOL-only bid_ask/spot below active**, not arbitrary two-sided ratios
