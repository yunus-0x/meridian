# Meridian Acceptance & E2E Testing Infrastructure (TEST_INFRA.md)

## 1. Testing Philosophy & Principles

The Meridian Testing Infrastructure operates on four core engineering tenets aligned with the **Oracle System** and the **Dual Track E2E Testing Protocol**:

1. **Requirement-Driven & Opaque-Box**: Tests are derived strictly from authoritative specifications (`ORIGINAL_REQUEST.md` and `PROJECT.md` Feature Inventory 1–27). Tests exercise public module APIs, CLI entrypoints, and boundary contracts without coupling to private internal state.
2. **Progressive Testability & Continuity**: The test suite executes seamlessly against the active codebase and remains strictly valid across the progressive 100% TypeScript migration (M1–M5). Tests require zero modification during or after TS refactoring.
3. **Hermetic State Isolation**: Tests never mutate or pollute production state (`state.json`, `user-config.json`, `smart-wallets.json`, `decision-log.json`, `token-blacklist.json`). All file mutations are redirected to isolated temporary files or sandbox directories with automatic cleanup.
4. **Zero Flakiness & Determinism**: Tests run without live network calls, external RPC dependencies, or paid APIs. Network boundaries (fetch, Solana RPC) are stubbed with deterministic fixture contracts.

---

## 2. Test Architecture & Runner Setup

- **Runner**: Node.js native test runner (`node:test`) paired with `node:assert/strict`.
- **Module Format**: Native ECMAScript Modules (`type: "module"`).
- **Execution Command**:
  ```bash
  node --test test/acceptance.test.js
  ```
- **Integrated Test Command**:
  ```bash
  npm test
  # Runs: npm run test:syntax && npm run test:standalone && node --test test/cleanup.test.js && node --test test/acceptance.test.js
  ```

---

## 3. Four-Tier Test Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                   Tier 4: Real-World E2E Scenarios                     │
│  - Multi-wallet convergence → signal → screening → track → exit → log   │
│  - Full position lifecycle (deploy, OOR, TP/SL, settlement, lessons)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────┴────────────────────────────────────┐
│              Tier 3: Cross-Feature Integration Contracts               │
│  - Mutex lock with exit priority queueing                               │
│  - Chronos tactical signals & conviction scaling into sizing & exits   │
│  - Store event aggregation & deduplication feeding execution engine     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────┴────────────────────────────────────┐
│               Tier 2: Boundary, Corner & Adversarial Cases              │
│  - Corrupted/malformed JSON handling & safety error propagation        │
│  - Missing environment variables, empty registries, dust filtering     │
│  - Invalid Solana base58 keys, protocol mismatch, bounds violation     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────┴────────────────────────────────────┐
│               Tier 1: Feature Baseline & Happy Path                    │
│  - Module resolution, entrypoint invocations, CLI 17 subcommands       │
│  - Config loading, computeDeployAmount calculation, CRUD persistence   │
└────────────────────────────────────────────────────────────────────────┘
```

### Tier 1: Feature Coverage (Baseline & Happy Paths)
- Module resolution and clean import without unhandled side-effects.
- CLI subcommand execution and help message accuracy across all 17 commands.
- Core utility functions (`repoPath`, `log`, `logAction`, `appendDecision`, `envryptEncrypt`/`envryptDecrypt`).
- CRUD registry operations for smart wallets, token blacklists, and developer blocklists.
- Configuration loading, default merging, and `computeDeployAmount` compounding calculations.

### Tier 2: Boundary, Corner & Adversarial Integrity
- Unreadable/malformed JSON files in safety critical paths throwing explicit errors.
- Invalid Solana public keys (length, base58 character set) rejected at boundary.
- Non-HTTP/HTTPS RPC URLs rejected during configuration setup.
- Empty registries, null/undefined inputs, and zero-length arrays handled gracefully.
- Dust deposits below minimum threshold filtered out.
- High-byte XOR encryption/decryption roundtrip fidelity.

### Tier 3: Cross-Feature Integration Contracts
- Transaction mutex (`withWalletLock`) prioritizing exit transactions over regular operations.
- Solana DLMM CPI event decoding into structured entry records.
- Event aggregation in `MonitorStore` enforcing window expiration, distinct wallet thresholds, and operator group deduplication.
- Chronos forecasting quantiles and tactical signal alignment driving conviction multipliers.
- Deterministic exit rules evaluating PnL, OOR durations, fee velocity, and structural breakdown conditions.

### Tier 4: Real-World Scenarios & Convergence Lifecycle
- Full simulated multi-wallet convergence event triggering signal generation.
- Position tracking lifecycle: deployment tracking -> mark out-of-range -> peak PnL confirmation -> exit evaluation -> close logging -> performance metrics recording.
- Post-claim settlement window guard preventing phantom PnL spikes during indexer latency.
- Telegram admin control menu hierarchy rendering all sections and interactive settings.

---

## 4. Feature Inventory Mapping Matrix (Features 1–27)

| Feature # | Feature Name | Tier | Test Name / Suite Section | Verification Criteria |
|---|---|---|---|---|
| **F1** | TypeScript Tooling & Config | Tier 1 | `T1: Tooling & Module Syntax` | Strict module loading, syntax checks pass via `node --check` |
| **F2** | Zod Schema Framework | Tier 2 | `T2: Boundary & Schema Validation` | Boundary validation on inputs, rejects untrusted types |
| **F3** | Core Storage & Utils | Tier 1 | `T1: Core Utilities (repo-root, logger, decision-log, envcrypt)` | `repoPath` resolves, `log`/`logAction` writes, decisions persist |
| **F4** | Alpha Wallets & Blacklist | Tier 1, 2 | `T1: Registry CRUD`, `T2: Unreadable Safety Blacklist` | Add/remove/list wallets, blacklist rejects corrupted JSON |
| **F5** | Config Management | Tier 1, 2 | `T1: Config & computeDeployAmount`, `T2: Config Boundaries` | Default fallback, clamping, conviction mult, invalid RPC URL |
| **F6** | Deterministic Exit Engine | Tier 3 | `T3: Deterministic Exit Rules` | SL (-35%), TP (+15%), OOR 240m, knife rescue, fee velocity |
| **F7** | Position State Machine | Tier 3, 4 | `T3: State Tracking & Settling`, `T4: Full Lifecycle` | OOR timestamps, peak confirmation, 60s post-claim settling |
| **F8** | Performance & Memory | Tier 1, 4 | `T1: Performance Metrics`, `T4: Full Lifecycle` | Record win/loss, compute win rate, PnL summaries |
| **F9** | Solana RPC Client | Tier 2 | `T2: RPC Client Error Boundary` | Missing RPC_URL throws, URL protocol validation |
| **F10** | Balance Aggregation | Tier 2 | `T2: Balance Aggregation Boundaries` | Merges SPL & Token-2022, drops zeros, rejects conflicting decimals |
| **F11** | Mutex Concurrency | Tier 3 | `T3: Wallet Mutex Lock Priority` | Priority exit executions bypass waiting standard executions |
| **F12** | Event CPI Decoding | Tier 3 | `T3: DLMM Event Decoding` | Extracts CPI logs, filters non-DLMM program IDs, handles null blockTime |
| **F13** | Monitor State Store | Tier 3 | `T3: MonitorStore Aggregation & Dedup` | Aggregation, window cutoff, operator groups, signal cooldown |
| **F14** | Wallet Balance & Swap | Tier 1, 2 | `T1: Wallet Normalize Mint`, `T2: Negative Swap Amount` | Mint normalization, negative amount rejection |
| **F15** | PnL Calculation Engine | Tier 1 | `T1: PnL Suspicious Spike Guard` | Missing data marks suspicious PnL, prevents phantom closing |
| **F16** | Meteora DLMM Wrapper | Tier 1 | `T1: DLMM Position Formatting` | Formats on-chain position metrics, calculates bin ranges |
| **F17** | Tool Executor Dispatch | Tier 2, 3 | `T2: Unknown Tool Rejection`, `T3: Write Lock Dispatch` | Validates write tools, enforces wallet lock, rejects bad tools |
| **F18** | Token & Pool Screening | Tier 2 | `T2: Screening Rejection Guards` | Rejects missing data, mint mismatch, disabled mint authority, high TVL |
| **F19** | Chronos Forecasting | Tier 3 | `T3: Chronos Quantiles & Tactical Signals` | Quantiles monotonic, curve strategy on tight spread, tactical signals |
| **F20** | Wallet Monitor Loop | Tier 4 | `T4: Smart Wallet Convergence to Signal` | 2 distinct wallets within window trigger signal, dust ignored |
| **F21** | Telegram Notification | Tier 1 | `T1: Telegram Dispatcher Formatting` | Formats deploy/close/swap messages cleanly |
| **F22** | Telegram Admin UI | Tier 1 | `T1: Telegram Admin UI Complete Schema` | All 6 sections render, keyboards validated, types validated |
| **F23** | Standalone Runtime Loop | Tier 1, 4 | `T1: Runtime Manage Once`, `T4: Full Lifecycle` | Runs manage cycle without throwing in dry-run |
| **F24** | CLI & 17 Subcommands | Tier 1, 2 | `T1: CLI 17 Subcommands Help & Args`, `T2: CLI Flag Validation` | All 17 commands advertised, missing required flags throw error |
| **F25** | Daemon Entrypoint & PM2 | Tier 1 | `T1: Daemon & Ecosystem Config` | ecosystem.config.cjs parses, index.js exports clean entrypoint |
| **F26** | Setup & Utility Scripts | Tier 1 | `T1: Setup & Envrypt Script Invocations` | setup.js syntax valid, scripts/envrypt encrypt/decrypt CLI works |
| **F27** | Test Suite Integrity | Tier 1-4 | `T1-T4 Acceptance Suite Integration` | 100% pass across syntax, standalone, cleanup, and acceptance |
