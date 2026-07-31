---
name: meridian-balance
description: >
  Check Meridian wallet SOL and token balances via CLI. Use when the user asks for
  balance, wallet, SOL holdings, portfolio cash, or runs /meridian-balance or /balance.
metadata:
  short-description: "Wallet SOL & tokens"
---

# Meridian balance

From repo root, run:

```bash
node cli.js balance
```

## Report

Summarise clearly:

- Wallet address (truncated ok)
- SOL balance + SOL USD
- USDC if any
- Non-dust tokens (symbol, balance, USD) — flag any base tokens left after closes (should usually be auto-swapped)
- Total USD if present
- Implied next deploy size: read `user-config.json` → `deployAmountSol`, `gasReserve`, `positionSizePct`, `maxDeployAmount` and compute roughly `(sol - gasReserve) * positionSizePct` clamped to floor/ceil
- Whether `sol >= deployAmountSol + gasReserve` for a new position

## Errors

If CLI fails (missing deps / env): say what failed; do not invent balances. Suggest `npm install` and configured `.env` (`WALLET_PRIVATE_KEY`, `RPC_URL`, `HELIUS_API_KEY`).

## Safety

Do not open or print `.env` / private keys.
