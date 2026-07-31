# Meridian CLI quick reference

Run from repo root: `node cli.js <cmd> ...`  
JSON on stdout. Prefer sequential commands (wait for each). Never background deploy/close/swap.

## Read

| Command | Purpose |
|---------|---------|
| `balance` | Wallet SOL + tokens |
| `positions` | Open DLMM positions |
| `pnl <position>` | PnL, fees, bins for one position |
| `candidates --limit N` | Enriched top candidates |
| `token-info --query <mint>` | Audit, mcap, stats |
| `token-holders --mint <mint>` | Top holders, bot % |
| `token-narrative --mint <mint>` | Narrative |
| `pool-detail --pool <addr>` | Pool metrics |
| `active-bin --pool <addr>` | Active bin / price |
| `study --pool <addr>` | Top LPer patterns |
| `pool-memory --pool <addr>` | Personal deploy history |
| `search-pools --query <q>` | Search pools |
| `lessons` | Learned rules |
| `performance` | Closed history |
| `blacklist list` | Blocked mints |
| `discord-signals` | Discord queue |
| `config` | Live config snapshot |

## Write (protected)

| Command | Purpose |
|---------|---------|
| `deploy --pool <addr> --amount <sol> [--bins-below N] [--strategy bid_ask\|spot]` | SOL-only deploy |
| `claim --position <addr>` | Claim fees |
| `close --position <addr> [--skip-swap]` | Close (+ auto-swap base→SOL) |
| `swap --from <mint> --to <mint> --amount <n>` | Jupiter swap (restricted: token→SOL or SOL→stable) |
| `screen [--silent] [--dry-run]` | One AI screening cycle |
| `manage [--silent] [--dry-run]` | One AI management cycle |
| `blacklist add --mint <m> --reason <t>` | Block token |
| `evolve` | Threshold evolution |
| `lessons add <text>` | Record lesson |

## Flags

- `--dry-run` — no on-chain txs (set before imports via argv)
