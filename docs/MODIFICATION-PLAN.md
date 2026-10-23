# Modification plan (fork of yunus-0x/meridian)

Goal: a risk-controlled LP agent. Token age (e.g. 5-36h) is one screening dimension, not the strategy.

## PR 1 (this branch): entry policy and permissions
- risk/entry-policy.js: strict numeric parsing, token age window, candidate evaluation. Missing, malformed or stale data never passes a required check.
- risk/permissions.js: operator-only config keys and forbidden agent tools.
- test/test-entry-policy.js: offline tests (no wallet, no network). Run: node test/test-entry-policy.js

Not yet done in PR 1: wiring these helpers into tools/executor.js (deploy validation, update_config, self_update) and tools/screening.js. That needs a reviewed diff against the full files.

## Next
- PR 2: operation locks and transaction state (no blind retries after timeouts).
- PR 3: durable state (SQLite), on-chain reconciliation, PnL accounting.
- PR 4: unified deterministic exit engine and degraded-mode handling.
- PR 5: multi-factor ranking, portfolio sizing, range planner.
- PR 6: paper/replay tooling and reports.
- PR 7: bounded self-tuning, only after out-of-sample evidence.

Rules: keep dry-run default, no live trading from this branch, no secrets in the repo, referral fee and HiveMind sharing off by default in the operator profile.
