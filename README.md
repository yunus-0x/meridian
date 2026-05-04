# Meridian

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLMs.**

**Links:** [Website](https://agentmeridian.xyz) | [Telegram](https://t.me/agentmeridian) | [X](https://x.com/meridian_agent)

---

## What it does

- **Screens pools** — continuously scans Meteora DLMM pools against configurable thresholds (fee/TVL ratio, organic score, holder count, market cap, bin step, etc.) to surface high-quality opportunities
- **Manages positions** — opens, monitors, and closes LP positions autonomously; decides to STAY, CLOSE, or REDEPLOY based on live PnL, yield, and range data
- **Claims fees** — tracks unclaimed fees per position and claims when thresholds are met
- **Learns from performance** — studies top LPers in target pools, saves structured lessons, and evolves screening thresholds based on closed position history
- **Monitors any wallet** — look up open DLMM positions and top LPers for any Solana wallet or pool address
- **Telegram chat** — full agent chat via Telegram, plus cycle reports and out-of-range alerts sent automatically

---

## How it works

Meridian runs a **ReAct agent loop** — each cycle the LLM reasons over live data, calls tools, and acts. Two specialized agents run on independent cron schedules:

| Agent | Default interval | Role |
|---|---|---|
| **Hunter Alpha** | Every 30 min | Pool screening — finds and deploys into the best candidate |
| **Healer Alpha** | Every 10 min | Position management — evaluates each open position and acts |

A third **health check** runs hourly to summarize portfolio state.

### Agent harness

Meridian's agent harness is the runtime wrapper around every autonomous cycle. It gives both **main** and **experimental** agents the same control loop: load live state, inject relevant memory, expose only role-appropriate tools, execute tool calls, and return a readable cycle report.

The harness also keeps a structured decision log in `decision-log.json` for deployments, closes, skips, and no-deploy outcomes. Each entry records the actor, pool or position, summary, reason, key risks, metrics, and rejected alternatives. Recent decisions are injected back into the system prompt and are available through `get_recent_decisions`, so the agent can answer "why did you deploy?", "why did you close?", or "why did you skip?" without guessing after the fact.

**Data sources used by the agents:**
- `@meteora-ag/dlmm` SDK — on-chain position data, active bin, deploy/close transactions
- Meteora DLMM PnL API — position yield, fee accrual, PnL
- Wallet RPC — SOL and token balances
- Pool screening API — fee/TVL ratios, volume, organic scores, holder counts

Agents are powered via **OpenRouter** and can be swapped for any compatible model by changing `managementModel` / `screeningModel` in `user-config.json`.

---

## Requirements

- Node.js 18+
- [OpenRouter](https://openrouter.ai) API key
- Solana wallet (base58 private key)
- Telegram bot token (optional, for notifications)

---

## Setup

**1. Clone the repo**

```bash
git clone <repo-url>
cd dlmm-agent
```

**2. Install dependencies**

```bash
npm install
```

**3. Create `.env`**

```env
OPENROUTER_API_KEY=sk-or-...
WALLET_PRIVATE_KEY=your_base58_private_key
HELIUS_API_KEY=your_helius_key         # for wallet balance lookups
TELEGRAM_BOT_TOKEN=123456:ABC...       # optional
LPAGENT_API_KEY=lpagent_...            # optional, for study_top_lpers / get_top_lpers
DRY_RUN=true                           # set false for live trading
```

> **RPC**: defaults to `https://pump.helius-rpc.com` (no key needed). Override with `RPC_URL=` in `.env`.

Optional encrypted `.env` flow:

```bash
cp .env .env.raw
printf "replace-with-a-long-local-key\n" > .envrypt
npm run env:encrypt
```

Meridian loads envrypt-style encrypted values automatically. Keep `.env.raw` and `.envrypt` local; both are gitignored.

**4. Copy the example config**

```bash
cp user-config.example.json user-config.json
```

**5. Run**

```bash
npm run dev    # dry run — no on-chain transactions
npm start      # live mode
```

On startup Meridian fetches your wallet balance, open positions, and the top pool candidates, then begins autonomous cycles immediately.

---

## Config reference

All fields are optional — defaults shown. Edit `user-config.json`.

| Field | Default | Description |
|---|---|---|
| `walletKey` | — | Base58-encoded private key of the trading wallet |
| `rpcUrl` | — | Solana RPC endpoint URL |
| `dryRun` | `true` | Simulate all transactions without submitting |
| `deployAmountSol` | `0.5` | SOL to deploy per new position |
| `maxPositions` | `3` | Maximum concurrent open positions |
| `minSolToOpen` | `0.07` | Minimum wallet SOL balance before opening a new position |
| `managementIntervalMin` | `10` | How often the management agent runs (minutes) |
| `screeningIntervalMin` | `30` | How often the screening agent runs (minutes) |
| `managementModel` | `openrouter/healer-alpha` | LLM model for position management |
| `screeningModel` | `openrouter/hunter-alpha` | LLM model for pool screening |
| `generalModel` | `openrouter/healer-alpha` | LLM model for REPL chat and `/learn` |
| `minFeeActiveTvlRatio` | `0.05` | Minimum fee/active-TVL ratio (5%) |
| `minTvl` | `10000` | Minimum pool TVL in USD |
| `maxTvl` | `150000` | Maximum pool TVL in USD |
| `minOrganic` | `65` | Minimum organic score (0–100) |
| `minHolders` | `500` | Minimum token holder count |
| `timeframe` | `5m` | Candle timeframe used in screening |
| `category` | `trending` | Pool category filter for screening |
| `takeProfitPct` | `5` | Close position when PnL reaches this % threshold |
| `outOfRangeWaitMinutes` | `30` | Minutes a position can be out of range before alerting / acting |

---

## REPL commands

After startup, an interactive prompt is available. The prompt shows a live countdown to the next management and screening cycle.

```
[manage: 8m 12s | screen: 24m 3s]
>
```

| Command | Description |
|---|---|
| `1`, `2`, `3` ... | Deploy into that numbered pool from the current candidates list |
| `auto` | Let the agent pick the best pool and deploy automatically |
| `/status` | Refresh and display wallet balance and open positions |
| `/candidates` | Re-screen and display the current top pool candidates |
| `/learn` | Study top LPers across all current candidate pools and save lessons |
| `/learn <pool_address>` | Study top LPers from a specific pool address |
| `<wallet_address>` | Ask the agent to check any wallet's positions or a pool's top LPers |
| `/thresholds` | Show current screening thresholds and closed-position performance stats |
| `/evolve` | Trigger threshold evolution from performance data (requires 5+ closed positions) |
| `/stop` | Graceful shutdown |
| `<anything else>` | Free-form chat — ask the agent questions, request actions, analyze pools |

Free-form chat persists session history (last 10 exchanges), so you can have a continuous conversation: `"what do you think of pool #2?"`, `"close all positions"`, `"how much have we earned today?"`.

---

## Telegram

**Setup:**

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Add `TELEGRAM_BOT_TOKEN=<token>` to your `.env`
3. Set the exact Telegram chat and allowed controller user IDs in `.env`

Meridian no longer auto-registers the first chat for safety. You must set:

```env
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<target chat id>
TELEGRAM_ALLOWED_USER_IDS=<comma-separated Telegram user ids allowed to control the bot>
```

Security notes:
- If `TELEGRAM_CHAT_ID` is not set, inbound Telegram control is ignored.
- If the target chat is a group/supergroup and `TELEGRAM_ALLOWED_USER_IDS` is empty, inbound control is ignored.
- Notifications still go to the configured chat, but command/control is limited to the allowed user IDs.

**Notifications sent:**
- After every management cycle: full agent report (reasoning + decisions)
- After every screening cycle: full agent report (what it found, whether it deployed)
- When a position goes out of range past `outOfRangeWaitMinutes`
- On deploy: pair, amount, position address, tx hash
- On close: pair and PnL

You can also chat with the agent via Telegram using the same free-form interface as the REPL: `"check wallet 7tB8..."`, `"who are the top LPers in pool ABC..."`, `"close all positions"`, etc. Only explicitly allowed Telegram user IDs can issue commands.

---

## How it learns

Meridian accumulates structured knowledge in `lessons.json` with two components:

### Lessons (`/learn`)

Running `/learn` triggers the agent to call `study_top_lpers` on each top candidate pool. It analyzes the on-chain behavior of the best-performing LPs in those pools — hold duration, entry/exit timing, scalping vs. holding patterns, win rates — and saves 4–8 concrete, actionable lessons. Cross-pool patterns are weighted more heavily since they generalize better.

Saved lessons are injected into subsequent agent cycles as part of the system context, improving decision quality over time.

### Threshold evolution (`/evolve`)

After at least 5 positions have been closed, `/evolve` analyzes the performance record (win rate, average PnL, fee yields) and adjusts the screening thresholds in `user-config.json` accordingly. Changes take effect immediately — no restart needed. The rationale for each change is printed to the console.

Use `/thresholds` to see current values alongside performance stats.

---

## HiveMind

Meridian includes a collective intelligence layer called **HiveMind**. By default it uses Agent Meridian at `https://api.agentmeridian.xyz` with the built-in public key, so agents can register, pull shared lessons/presets, and push learning events without a separate registration flow.

**What you get:**
- Shared lessons from other Meridian agents
- Strategy presets and crowd performance context
- Role-aware lessons injected into future screener/manager prompts when `hiveMindPullMode` is `auto`

**What you share:**
- Lessons from `lessons.json`
- Closed-position performance events: pool, pool name, base mint, strategy, close reason, PnL, fees, and hold time
- Agent heartbeat metadata: agent ID, version, timestamp, and basic capability flags
- **Private keys and wallet balances are never sent**

HiveMind failures are non-blocking. If Agent Meridian is unavailable, the agent logs a warning and keeps running.

### Setup

No manual HiveMind registration command is required for the shared Agent Meridian setup. `agentId` is generated automatically on startup if it is missing.

To use a private HiveMind API key, check the Telegram announcement channel and set it as `hiveMindApiKey`.

Relevant config fields:

```json
{
  "agentId": "",
  "hiveMindUrl": "",
  "hiveMindApiKey": "",
  "hiveMindPullMode": "auto"
}
```

Blank `hiveMindUrl` and `hiveMindApiKey` values intentionally fall back to the Agent Meridian defaults. Set `hiveMindPullMode` to `manual` if you do not want shared lessons and presets pulled automatically.

### Disable

There is currently no empty-string disable path for HiveMind; blank values fall back to the built-in Agent Meridian defaults. A true off switch should be implemented as an explicit config flag before documenting HiveMind as disabled by clearing fields.

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with `npm run dev` (dry run) to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software.
