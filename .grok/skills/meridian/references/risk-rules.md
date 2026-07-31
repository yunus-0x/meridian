# Meridian risk rules (live agent)

These match `config.js` + `risk.js` + `state.js` + executor safety. Prefer JS deterministic exits over LLM invention.

## Deploy safety (hard)

- **SOL-only single-side**: `amount_x` must be 0. `bins_above` must be 0 for standard path.
- `bins_below` ≥ `MIN_SAFE_BINS_BELOW` (35) and within config min/max.
- Max positions, no duplicate pool, no duplicate base mint.
- Fresh pool thresholds: TVL, fee/active-TVL, volatility, bin_step.
- Deploy amount ≥ floor, ≤ maxDeployAmount, wallet keeps gasReserve.
- **Circuit breaker**: daily SOL/USD loss limit or consecutive losses → **no new deploys** (management still runs).

## Exit hierarchy (highest first)

1. **Instruction** on position (if set) — honor when condition met
2. **Stop loss** — default −25% PnL
3. **Breakeven after trailing** — once trailing armed, exit if PnL ≤ floor (~0.2%)
4. **Trailing TP** — dynamic drop widens with peak (base `trailingDropPct`, widen per peak, cap `trailingMaxDropPct`)
5. **Hard take-profit** — **only if trailing is OFF** (or `hardTakeProfitWhileTrailing: true`)
6. **Pumped far above range** — active_bin > upper + outOfRangeBinsToClose
7. **OOR wait** — minutes_out_of_range ≥ outOfRangeWaitMinutes
8. **Fee decay** — live fee/TVL < entry × feeDecayExitRatio (after min age)
9. **Max hold** — age ≥ maxHoldMinutes unless strong trailing runner
10. **Low yield** — fee/TVL < minFeePerTvl24h after minAgeBeforeYieldCheck

## Screening rank

- Prefer **fee / volatility edge**, degen balance score, rising volume/fees
- Penalize dying volume, poor personal pool-memory win rate
- Skip pools with adjusted_win_rate ≤ lowMemoryWinRateMax (enough samples)

## Sizing

- Wallet scale: `(sol - gasReserve) × positionSizePct`, clamp [deployAmountSol, maxDeployAmount]
- Optional **volatility damping**: smaller size when vol >> volSizeRef

## Swaps

Allowed only:

- Any token → SOL (exit path)
- SOL → USDC/USDT (park)

Never SOL → memecoin via LLM/agent swap tools.

## PnL sanity

If `pnl_pct_suspicious` or absurd PnL with residual value → **do not** act on PnL exits that tick.
