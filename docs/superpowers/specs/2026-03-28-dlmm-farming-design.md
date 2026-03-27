# Meridian DLMM Farming Design

## Goal

Turn Meridian into a practical DLMM farming bot for a small Solana wallet. The bot should protect capital first, farm fees second, and move from `dry-run` to `semi-auto` to `full-auto` without changing the core architecture.

## Operating Profile

- Wallet size: small
- Max active positions: `3`
- Pool universe: broad, not limited to SOL pairs
- Primary objective: avoid bad pools and preserve capital
- Secondary objective: capture fee yield from pools that pass strict filters

This profile favors fewer, higher-quality deployments over frequent rotation.

## Rollout Strategy

### Phase 1: Dry Run

Run the complete screening and management loops with live data and simulated write actions.

Purpose:
- verify candidate ranking
- verify deploy and close decisions
- validate logs, Telegram alerts, and state transitions
- tune thresholds without risking capital

Rules:
- no on-chain write is allowed
- write tools must return a clear simulated result
- every rejected candidate should have an explicit reason in logs

Exit criteria:
- several cycles complete without crashes
- deploy decisions look sane on manual review
- close decisions are explainable and consistent

### Phase 2: Semi Auto

Run the same logic, but require explicit approval before any write action.

Purpose:
- validate that the final safety gates are correct
- confirm that recommended actions match operator judgment
- catch edge cases before funds are deployed automatically

Rules:
- read tools remain fully automatic
- deploy, close, claim, swap, and config mutation actions require operator confirmation
- Telegram or terminal output must show the exact proposed action and its rationale

Exit criteria:
- repeated operator approval aligns with bot recommendations
- no recurring false positives in deploy or close suggestions

### Phase 3: Full Auto

Allow write actions to execute automatically once dry-run and semi-auto have shown stable behavior.

Rules:
- write actions remain subject to executor safety checks
- all deploy and close actions must be logged with machine-readable reasons
- the bot must fail closed when required market or wallet data is unavailable

## Required Operational Safeguards

### Capital Controls

- Keep `maxPositions` at `3`
- Keep position sizing conservative for a small wallet
- Enforce a non-trivial SOL gas reserve before any deploy
- Reject deploys that would over-concentrate capital in one token or one pool

### Screening Controls

The screener should continue to search broadly, but only surface pools that pass strict minimum quality gates:

- fee to active TVL ratio
- liquidity bounds
- minimum volume
- minimum organic score
- minimum holder count
- market cap bounds
- bundler concentration limit
- top holder concentration limit
- blocked launchpad filter
- acceptable bin step range

The LLM should not see obviously unsafe pools if deterministic filtering can remove them first.

### Management Controls

The manager should favor fast risk reduction over optimistic holding.

Close bias should increase when:
- a position stays out of range too long
- fee generation stalls
- pool quality deteriorates
- new token risk signals worsen
- the position thesis is no longer valid

Claiming fees and swapping back to SOL should remain supported, but should not hide the reason a position was closed.

## Required Code Changes

### 1. Introduce an explicit operating mode

Add a config-backed operating mode with three values:

- `dry-run`
- `semi-auto`
- `full-auto`

This mode should be enforced centrally in `tools/executor.js`, not scattered across individual tools.

Expected behavior:
- `dry-run`: block all write actions and return simulated responses
- `semi-auto`: block write actions unless an explicit approval path is provided
- `full-auto`: allow write actions after existing safety checks pass

This creates one clear control plane for deployment safety.

### 2. Fix lessons threshold evolution

`lessons.js` currently evolves keys that do not match the active config shape. This breaks adaptive threshold tuning.

Required correction:
- replace `minFeeTvlRatio` references with `minFeeActiveTvlRatio`
- stop evolving `maxVolatility` unless that key is formally added to `config.js`

The learning system must only evolve keys that exist and are actually consumed.

### 3. Make decision logging reviewable

Each important decision should leave a clear record:

- why a candidate was rejected
- why a deploy was selected
- why a position was held, claimed, or closed
- which deterministic safety checks fired
- whether the action was simulated, approval-gated, or live

These logs should support manual review after each dry-run cycle.

### 4. Tighten default small-wallet config

Defaults should be tuned for small-capital safety:

- conservative deploy amount
- adequate gas reserve
- low max active positions
- stricter screening thresholds than the generic defaults

The operator should be able to loosen settings later, but the starting point should be defensive.

## Component Impact

### `config.js`

- add the operating mode field
- validate accepted values
- expose safe defaults for small-wallet farming

### `tools/executor.js`

- enforce operating mode on every write tool
- keep current deploy safety checks
- emit clear reason codes for blocked actions

### `lessons.js`

- fix threshold key mapping
- ensure adaptive updates persist only valid config fields

### `index.js`

- surface the current operating mode in startup output and cycle logs
- make dry-run and semi-auto status obvious to the operator

### `telegram.js`

- include operating mode and action status in notifications
- make approval-gated recommendations readable in semi-auto mode

## Failure Handling

The bot should fail safely.

Rules:
- missing wallet or market data should block write actions
- stale or partial candidate data should block deploy actions
- failed close follow-ups, such as swap-back to SOL, should be logged separately from the close itself
- any mode-enforcement failure should default to blocking the write action

## Verification Plan

Before live capital is used:

1. Start the app in `dry-run` mode and confirm startup succeeds.
2. Run screening cycles and inspect candidate filtering plus simulated deploy output.
3. Run management cycles and inspect hold, claim, and close recommendations.
4. Verify logs and Telegram messages clearly show rationale and mode.
5. Switch to `semi-auto` and verify write actions are blocked pending approval.
6. Only after stable operator review should `full-auto` be enabled.

## Non Goals

- aggressive high-turnover farming
- broad strategy expansion beyond the current DLMM architecture
- adding new external intelligence sources before the safety path is reliable
- optimizing for maximum APY at the expense of capital protection

## Recommended First Implementation Slice

Implement in this order:

1. operating mode enforcement
2. lessons key fix
3. decision logging improvements
4. safer small-wallet defaults

This sequence improves safety first, then restores learning, then improves reviewability.
