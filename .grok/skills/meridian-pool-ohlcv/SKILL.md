---
name: meridian-pool-ohlcv
description: >
  Fetch price/volume history for a Meteora pool and judge entry timing. Use for
  /meridian-pool-ohlcv, /pool-ohlcv, "OHLCV", "volume trend", "is this pool dying".
metadata:
  short-description: "Pool OHLCV & volume trend"
---

# Meridian pool OHLCV

Argument: pool address.

```bash
curl -s "https://dlmm.datapi.meteora.ag/pools/<POOL>/ohlcv?timeframe=1h"
curl -s "https://dlmm.datapi.meteora.ag/pools/<POOL>/volume/history?timeframe=1h"
```

Also useful:

```bash
node cli.js pool-detail --pool <POOL>
node cli.js active-bin --pool <POOL>
```

## Analyse

- Price trend: up / down / sideways / violent
- Volume: rising, falling, spiky
- Consistency vs one-candle spikes
- Fee farm health: rising volume + stable price ≈ good; collapsing volume ≈ avoid / exit

## Entry guidance (LP, not directional spot)

| Regime | Guidance |
|--------|----------|
| Rising vol + range-bound price | Good fee farm |
| Pump vertical + volume climax | OOR upside risk; careful / skip |
| Dump + volume gone | Avoid; fee decay likely |
| Oscillating with steady swaps | Ideal for in-range bid_ask |

End with: **enter / wait / avoid** and one sentence why.
