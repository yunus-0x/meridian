# Meridian

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLMs.**

Meridian runs continuous screening and management cycles, deploying capital into high-quality Meteora DLMM pools and closing positions based on live PnL, yield, and range data. It learns from every position it closes.

---

## What it does

- **Screens pools** — scans Meteora DLMM pools against configurable thresholds (fee/TVL ratio, organic score, holder count, mcap, bin step) and surfaces high-quality opportunities ranked by composite quality score
- **Manages positions** — monitors, claims fees, and closes LP positions autonomously; supports STAY, CLOSE, CLAIM, and REBALANCE actions based on live data
- **Rebalances OOR positions** — when price pumps above range, closes and immediately redeploys at the new active bin in the same pool (no screening cycle delay)
- **Learns from performance** — studies top LPers in target pools, saves structured lessons, and evolves screening thresholds based on closed position history
- **Market mode presets** — one command to switch between bullish/bearish/sideways/volatile/conservative parameter bundles
- **Telegram chat** — full agent chat via Telegram, plus cycle reports and OOR alerts
- **Claude Code integration** — run AI-powered screening and management directly from your terminal using Claude Code slash commands

---

## How it works

Meridian runs a **ReAct agent loop** — each cycle the LLM reasons over live data, calls tools, and acts. Two specialized agents run on independent cron schedules:

| Agent | Default interval | Role |
|---|---|---|
| **Screening Agent** | Every 30 min | Pool screening — finds and deploys into the best candidate |
| **Management Agent** | Every 10 min | Position management — evaluates each open position and acts |

**Data sources:**
- `@meteora-ag/dlmm` SDK — on-chain position data, active bin, deploy/close transactions
- Meteora DLMM PnL API — position yield, fee accrual, PnL
- OKX OnchainOS — smart money signals, token risk scoring
- Pool screening API — fee/TVL ratios, volume, organic scores, holder counts
- Jupiter API — token audit, mcap, launchpad, price stats

Agents are powered via **OpenRouter** and can be swapped for any compatible model.

---

## Requirements

- Node.js 18+
- [OpenRouter](https://openrouter.ai) API key
- Solana wallet (base58 private key)
- Solana RPC endpoint ([Helius](https://helius.xyz) recommended)
- Telegram bot token (optional)
- [Claude Code](https://claude.ai/code) CLI (optional, for terminal slash commands)

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/yunus-0x/meridian
cd meridian
npm install
```

### 2. Run the setup wizard

```bash
npm run setup
```

The wizard walks you through creating `.env` (API keys, wallet, RPC, Telegram) and `user-config.json` (risk preset, deploy size, thresholds, models). Takes about 2 minutes.

**Or set up manually:**

Create `.env`:

```env
WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
OPENROUTER_API_KEY=sk-or-...
HELIUS_API_KEY=your_helius_key          # for wallet balance lookups
TELEGRAM_BOT_TOKEN=123456:ABC...        # optional — for notifications + chat
TELEGRAM_CHAT_ID=                       # auto-filled on first message
DRY_RUN=true                            # set false for live trading
```

> Never put your private key or API keys in `user-config.json` — use `.env` only. Both files are gitignored.

Copy config and edit as needed:

```bash
cp user-config.example.json user-config.json
```

See [Config reference](#config-reference) below.

### 3. Run

```bash
npm run dev    # dry run — no on-chain transactions
npm start      # live mode
```

On startup Meridian fetches your wallet balance, open positions, and top pool candidates, then begins autonomous cycles immediately.

---

## Running modes

### Autonomous agent

```bash
npm start
```

Starts the full autonomous agent with cron-based screening + management cycles and an interactive REPL. The prompt shows a live countdown to the next cycle:

```
[manage: 8m 12s | screen: 24m 3s]
>
```

REPL commands:

| Command | Description |
|---|---|
| `/status` | Wallet balance and open positions |
| `/candidates` | Re-screen and display top pool candidates |
| `/learn` | Study top LPers across all current candidate pools |
| `/learn <pool_address>` | Study top LPers for a specific pool |
| `/thresholds` | Current screening thresholds and performance stats |
| `/evolve` | Trigger threshold evolution from performance data (needs 5+ closed positions) |
| `/stop` | Graceful shutdown |
| `<anything>` | Free-form chat — ask the agent anything, request actions, analyze pools |

---

### Claude Code terminal (recommended)

Install [Claude Code](https://claude.ai/code) and use it from inside the meridian directory.

```bash
cd meridian
claude
```

#### Slash commands

| Command | What it does |
|---|---|
| `/screen` | Full AI screening cycle — checks Discord queue, reads config, fetches candidates, runs deep research, and deploys if a winner is found |
| `/manage` | Full AI management cycle — checks all positions, evaluates PnL, claims fees, closes OOR/losing positions |
| `/balance` | Check wallet SOL and token balances |
| `/positions` | List all open DLMM positions with range status |
| `/candidates` | Fetch and enrich top pool candidates (pool metrics + token audit + smart money) |
| `/study-pool` | Study top LPers on a specific pool |
| `/pool-ohlcv` | Fetch price/volume history for a pool |
| `/pool-compare` | Compare all Meteora DLMM pools for a token pair by APR, fee/TVL ratio, and volume |

#### Loop mode

```
/loop 30m /screen     # screen every 30 minutes
/loop 10m /manage     # manage every 10 minutes
```

---

## Management rules

Management cycles run deterministically in JavaScript — no LLM cost for positions that just need to STAY. The LLM is only invoked when action is required.

| Rule | Trigger | Action |
|---|---|---|
| **Exit (Trailing TP)** | Peak PnL confirmed, then drops ≥ `trailingDropPct` from peak | CLOSE |
| **1 — Stop loss** | `pnl_pct ≤ stopLossPct` | CLOSE |
| **2 — Take profit** | `pnl_pct ≥ takeProfitFeePct` | CLOSE |
| **3 — Far above range** | `active_bin > upper_bin + outOfRangeBinsToClose` | CLOSE |
| **4 — OOR above range** | Price pumped above range, OOR for `outOfRangeWaitMinutes` | **REBALANCE** (or CLOSE if disabled) |
| **4b — OOR below range** | Price dumped below range, OOR for `belowOORWaitMinutes` | CLOSE (never rebalance) |
| **5 — Low yield** | `fee_per_tvl_24h < minFeePerTvl24h` after 60 min | CLOSE |
| **6 — Fee velocity collapse** | Fee accumulation rate dropped to `< minFeeVelocityPct%` of peak | CLOSE |
| **Claim** | `unclaimed_fees_usd ≥ minClaimAmount` | CLAIM |

### Rebalance (Rule 4)

When price pumps above your range, instead of closing and waiting for the next screening cycle, Meridian immediately redeploys in the same pool at the new active bin. This keeps capital working with zero dead time and no screening overhead.

Rule 4b (price dump below range) never rebalances — a token in freefall should not be LP'd again until it stabilizes.

### Fee velocity (Rule 6)

Meridian tracks fee accumulation per management cycle over a 3-hour rolling window. If the current fee earning rate drops to less than `minFeeVelocityPct`% (default 20%) of the position's peak rate, it exits before the 24h yield metric catches up. This typically catches dying pools 1-2 hours earlier than Rule 5.

---

## Screening & pool scoring

### Hard filters

Pools must pass all numeric thresholds before the LLM sees them:

`minFeeActiveTvlRatio`, `minTvl`, `maxTvl`, `minVolume`, `minOrganic`, `minHolders`, `minMcap`, `maxMcap`, `minBinStep`, `maxBinStep`, `maxVolatility` (optional)

Additional filters applied after API enrichment:
- **Price momentum guard** — skip pools where price already moved beyond `maxEntry5mPricePct` / `minEntry5mPricePct`
- **Wash trading** — skip OKX-flagged wash pools
- **Launchpad blocklist** — skip `blockedLaunchpads`
- **Bundler/holder concentration** — skip if `maxBundlersPct` or `maxTop10Pct` exceeded
- **Pool cooldown** — skip pools recently closed with OOR or stop-loss

### Composite quality score (0–100)

After hard filters, every eligible pool receives a quality score before the LLM sees it. Pools are sorted descending by score so the highest-quality pool is always presented first.

| Signal | Weight |
|---|---|
| `daily_yield_pct_est` | ×1.35 (primary profit signal) |
| `fee_per_position_est` | ×1.5 (your share vs. other LPs) |
| `fee_active_tvl_ratio` | ×10 |
| `organic_score` (60–100 rescaled to 0–20) | proportional |
| Smart money buy | +12 |
| KOL in clusters | +8 |
| Dev sold all (bullish) | +5 |
| DEX boost | +3 |
| Rugpull flag | −40 |
| Bundle % | −0.4× |
| Suspicious wallet % | −0.3× |
| Sniper % | −0.2× |

### Dynamic bins_below

Instead of a fixed bin count, Meridian calculates the optimal downside buffer from pool volatility at deploy time:

| Volatility | bins_below |
|---|---|
| 0 | 35 |
| 2.5 | 62 |
| 5 | 90 |
| 10+ | 120 (capped) |

The LLM can still override this by explicitly providing `bins_below`. If not provided, the server-side calculation applies.

---

## Market mode presets

Switch market posture with a single command via chat or `update_config`:

| Mode | Description | Key changes |
|---|---|---|
| `bullish` | Price trending up, ride momentum | Wider OOR wait, looser momentum guard |
| `bearish` | Downtrend, protect capital | Faster OOR/below exit, `minEntry5mPricePct` guard |
| `sideways` | Range-bound, fee farming | Tight bins, fast OOR reaction |
| `volatile` | High swings, wide buffers | Wide bins, longer OOR tolerance |
| `conservative` | Max safety | Higher organic/holder minimums, tightest stop loss |
| `auto` | Default — no preset override | Each param from user-config.json |

Chat command:
```
set market mode to bearish
```

Or via Telegram / REPL.

---

## Learning system

### Lessons

After every closed position, performance is analyzed and a lesson is derived. Lessons are injected into the next agent cycle as part of the system prompt.

```bash
node cli.js lessons add "Never deploy into pump.fun tokens under 2h old"
```

### Threshold evolution

After 5+ positions are closed, screening thresholds auto-evolve based on winner vs. loser patterns:
- `minFeeActiveTvlRatio` — raised if low-fee pools consistently lose
- `minOrganic` — raised if low-organic tokens consistently lose
- `maxVolatility` — tightened if losses cluster at high volatility

Run manually:
```bash
node cli.js evolve
```

Changes take effect immediately and persist in `user-config.json`.

---

## Config reference

All fields are optional — defaults shown. Edit `user-config.json`.

### Screening

| Field | Default | Description |
|---|---|---|
| `minFeeActiveTvlRatio` | `0.05` | Minimum fee/active-TVL ratio |
| `minTvl` | `10000` | Minimum pool TVL (USD) |
| `maxTvl` | `150000` | Maximum pool TVL (USD) |
| `minVolume` | `500` | Minimum pool volume |
| `minOrganic` | `60` | Minimum organic score (0–100) |
| `minHolders` | `500` | Minimum token holder count |
| `minMcap` | `150000` | Minimum market cap (USD) |
| `maxMcap` | `10000000` | Maximum market cap (USD) |
| `minBinStep` | `80` | Minimum bin step |
| `maxBinStep` | `125` | Maximum bin step |
| `timeframe` | `5m` | Candle timeframe for screening |
| `category` | `trending` | Pool category filter |
| `minTokenFeesSol` | `30` | Minimum all-time fees in SOL |
| `maxBundlersPct` | `30` | Maximum bundler % in top 100 holders |
| `maxTop10Pct` | `60` | Maximum top-10 holder concentration |
| `blockedLaunchpads` | `[]` | Launchpad names to never deploy into |
| `maxVolatility` | `null` | Skip pools above this volatility (null = disabled) |
| `maxEntry5mPricePct` | `null` | Skip pools where price pumped > X% in window |
| `minEntry5mPricePct` | `null` | Skip pools where price dumped > X% in window |

### Management

| Field | Default | Description |
|---|---|---|
| `deployAmountSol` | `0.5` | Base SOL per new position |
| `positionSizePct` | `0.35` | Fraction of deployable balance to use |
| `maxDeployAmount` | `50` | Maximum SOL cap per position |
| `gasReserve` | `0.2` | Minimum SOL to keep for gas |
| `minSolToOpen` | `0.55` | Minimum wallet SOL before opening |
| `outOfRangeWaitMinutes` | `30` | Minutes OOR (above range) before acting |
| `belowOORWaitMinutes` | `15` | Minutes OOR (below range) before closing — faster exit since position is 100% base token at max IL |
| `rebalanceOnOOR` | `true` | Close + redeploy in same pool when price pumps above range (Rule 4) |
| `stopLossPct` | `-50` | Close if PnL drops below this % |
| `takeProfitFeePct` | `5` | Close if PnL exceeds this % |
| `minFeePerTvl24h` | `7` | Exit if fee/TVL 24h drops below this % |
| `minFeeVelocityPct` | `20` | Exit if fee accumulation rate drops to < X% of position's peak rate |
| `feeVelocityMinAgeMin` | `120` | Minimum position age (minutes) before fee velocity check activates |
| `trailingTakeProfit` | `true` | Enable trailing take-profit |
| `trailingTriggerPct` | `3` | Activate trailing TP once PnL reaches X% |
| `trailingDropPct` | `1.5` | Exit when PnL drops X% from confirmed peak |

### Strategy

| Field | Default | Description |
|---|---|---|
| `binsAbove` | `0` | Bins above active bin (0 = single-sided SOL below price) |
| `strategy` | `bid_ask` | Default LP strategy (`bid_ask` or `spot`) |

### Schedule

| Field | Default | Description |
|---|---|---|
| `managementIntervalMin` | `10` | Management cycle frequency (minutes) |
| `screeningIntervalMin` | `30` | Screening cycle frequency (minutes) |

### Models

| Field | Default | Description |
|---|---|---|
| `managementModel` | `openrouter/healer-alpha` | LLM for management cycles |
| `screeningModel` | `openrouter/healer-alpha` | LLM for screening cycles |
| `generalModel` | `openrouter/healer-alpha` | LLM for REPL / chat |

> Override model at runtime: `node cli.js config set screeningModel anthropic/claude-opus-4-5`

---

## Telegram

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Add `TELEGRAM_BOT_TOKEN=<token>` to your `.env`
3. Set the chat ID and allowed user IDs in `.env`:

```env
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<your chat id>
TELEGRAM_ALLOWED_USER_IDS=<comma-separated Telegram user ids>
```

> If `TELEGRAM_ALLOWED_USER_IDS` is empty, inbound commands from group chats are ignored. Notifications still send.

### Notifications

- Management cycle reports (reasoning + decisions)
- Screening cycle reports (what it found, whether it deployed)
- OOR alerts when a position leaves range
- Deploy: pair, amount, position address, tx hash
- Close: pair and PnL

### Commands

| Command | Action |
|---|---|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set a note on a position |

You can also chat freely — same interface as the REPL.

---

## Hive Mind (optional)

Opt-in collective intelligence — share lessons and pool outcomes, receive crowd wisdom from other Meridian agents.

**What you get:** Pool consensus ("8 agents deployed here, 72% win rate"), strategy rankings, threshold medians.

**What you share:** Lessons, deploy outcomes, screening thresholds. No wallet addresses, private keys, or balances are ever sent.

### Setup

```bash
node -e "import('./hive-mind.js').then(m => m.register('https://meridian-hive-api-production.up.railway.app', 'YOUR_TOKEN'))"
```

### Disable

```json
{ "hiveMindUrl": "", "hiveMindApiKey": "" }
```

---

## Using a local model (LM Studio)

```env
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=your-local-model-name
```

Any OpenAI-compatible endpoint works.

---

## Architecture

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop: LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env
prompt.js           System prompt builder (SCREENER / MANAGER / GENERAL roles)
state.js            Position registry + fee velocity snapshots (state.json)
lessons.js          Learning engine: records performance, derives lessons, evolves thresholds
market-mode.js      Market mode preset system (bullish/bearish/sideways/volatile/conservative)
pool-memory.js      Per-pool deploy history + snapshots
strategy-library.js Saved LP strategies
telegram.js         Telegram bot: polling + notifications
hive-mind.js        Optional collective intelligence server sync
smart-wallets.js    KOL/alpha wallet tracker
token-blacklist.js  Permanent token blacklist
cli.js              Direct CLI — every tool as a subcommand with JSON output

tools/
  definitions.js    Tool schemas (OpenAI format)
  executor.js       Tool dispatch + safety checks
  dlmm.js           Meteora DLMM SDK wrapper (deploy with dynamic bins, close, rebalance)
  screening.js      Pool discovery + composite quality scoring
  wallet.js         SOL/token balances + Jupiter swap
  token.js          Token info, holders, narrative
  study.js          Top LPer study via LPAgent API

.claude/
  agents/
    screener.md     Claude Code screener sub-agent
    manager.md      Claude Code manager sub-agent
  commands/
    screen.md       /screen slash command
    manage.md       /manage slash command
    balance.md      /balance slash command
    positions.md    /positions slash command
    candidates.md   /candidates slash command
    study-pool.md   /study-pool slash command
    pool-ohlcv.md   /pool-ohlcv slash command
    pool-compare.md /pool-compare slash command
```

---

## Changelog

### Latest improvements

**Dynamic bins_below** — Range width is now calculated from pool volatility at deploy time instead of a fixed 69 bins. Low-volatility pools get tighter ranges (more time in range = more fees). High-volatility pools get wider buffers to avoid premature OOR.

**Composite pool scoring** — Every candidate pool receives a 0–100 quality score based on projected daily yield, fee-per-position (dilution signal), organic score, and smart money bonuses/risk penalties. Pools are sorted by score before the LLM sees them, so the best candidate is always presented first.

**Rebalance-on-OOR** — When price pumps above range (Rule 4), Meridian closes and immediately redeploys at the new active bin in the same pool. No screening cycle, no dead time. Capital stays deployed and earning fees continuously. Rule 4b (below range / token dump) always closes — never rebalances a falling token.

**Fee velocity exit** — Tracks per-position fee accumulation rate over a 3-hour rolling window. If the current rate drops below 20% of the position's peak rate, exits immediately. Detects dying pools 1–2 hours before the 24h fee/TVL metric catches up.

**Market mode presets** — One command switches all risk/timing parameters for current market conditions (bullish/bearish/sideways/volatile/conservative).

**evolveThresholds bug fix** — The automatic threshold learning system was silently failing due to incorrect config key names (`minFeeTvlRatio` → `minFeeActiveTvlRatio`). Fixed. Thresholds now actually evolve after 5 closed positions.

**Below-range OOR fast exit** — Added dedicated Rule 4b for when price drops below the position's lower bin. Exits faster (`belowOORWaitMinutes` default 15 min) than standard OOR, because the position is 100% base token at maximum impermanent loss.

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with `DRY_RUN=true` to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software.
