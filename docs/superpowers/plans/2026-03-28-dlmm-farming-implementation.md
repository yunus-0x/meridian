# DLMM Farming Safety Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a config-driven operating mode, fix lessons threshold evolution, improve decision reviewability, and tighten small-wallet defaults so Meridian can roll out from dry-run to semi-auto to full-auto safely.

**Architecture:** The implementation keeps the current agent loop and tool model intact, but moves all execution gating into `tools/executor.js` so one control plane decides whether write tools simulate, block pending approval, or execute live. Config and startup output expose the current operating mode, the learning engine only evolves valid keys, and logging plus Telegram notifications make every blocked, simulated, and live decision reviewable.

**Tech Stack:** Node.js 18+, ES modules, existing JSON config files, existing logger/Telegram integrations, repo test scripts plus direct `node` smoke runs.

---

## File Map

- Modify: `config.js`
  - Add `management.operatingMode` with validated defaults and runtime reload support.
- Modify: `tools/executor.js`
  - Enforce operating mode for write tools, return structured simulated or blocked responses, and log decision reasons consistently.
- Modify: `lessons.js`
  - Stop evolving non-existent keys and map evolution to `minFeeActiveTvlRatio`.
- Modify: `index.js`
  - Surface operating mode clearly in startup and cycle logs.
- Modify: `telegram.js`
  - Include operating mode and action status in deploy/close/swap notifications.
- Modify: `user-config.example.json`
  - Document the new operating mode and safer small-wallet defaults.
- Optionally modify: `user-config.json`
  - Set the local environment to `dry-run` or `semi-auto` during manual validation without changing example defaults.

---

### Task 1: Add config-backed operating mode

**Files:**
- Modify: `config.js`
- Modify: `user-config.example.json`

- [ ] **Step 1: Inspect the current config surface before editing**

Run:

```bash
sed -n '1,220p' config.js
sed -n '1,220p' user-config.example.json
```

Expected:
- `config.js` reads flat keys from `user-config.json`
- management defaults currently include deploy sizing and gas reserve but no operating mode

- [ ] **Step 2: Add a normalized operating mode helper in `config.js`**

Insert near the top of `config.js` after `u` is loaded:

```js
const VALID_OPERATING_MODES = new Set(["dry-run", "semi-auto", "full-auto"]);

function normalizeOperatingMode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (VALID_OPERATING_MODES.has(raw)) return raw;
  if (process.env.DRY_RUN === "true") return "dry-run";
  return "full-auto";
}
```

Purpose:
- support legacy `DRY_RUN=true`
- reject unknown values by normalizing to a safe mode

- [ ] **Step 3: Add `operatingMode` to the management config block**

Update the `management` section in `config.js` to include:

```js
  management: {
    operatingMode:        normalizeOperatingMode(u.operatingMode),
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    emergencyPriceDropPct: u.emergencyPriceDropPct ?? -50,
    takeProfitFeePct:      u.takeProfitFeePct      ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minSolToOpen:          u.minSolToOpen          ?? 0.75,
    deployAmountSol:       u.deployAmountSol       ?? 0.35,
    gasReserve:            u.gasReserve            ?? 0.35,
    positionSizePct:       u.positionSizePct       ?? 0.25,
  },
```

Notes:
- this task introduces safer defaults for small wallets immediately
- `operatingMode` lives under `management` to avoid a new top-level section

- [ ] **Step 4: Keep runtime reload support aligned**

Extend `reloadScreeningThresholds()` only if needed for values this function already manages. Do not broaden it for management values. Instead, add a small exported helper below it:

```js
export function getOperatingMode() {
  return normalizeOperatingMode(config.management.operatingMode);
}
```

Purpose:
- give executor and notification code one stable accessor

- [ ] **Step 5: Document the mode in `user-config.example.json`**

Add or update these example keys:

```json
{
  "operatingMode": "dry-run",
  "deployAmountSol": 0.35,
  "gasReserve": 0.35,
  "positionSizePct": 0.25,
  "maxPositions": 3
}
```

Expected:
- example config makes the default rollout path obvious

- [ ] **Step 6: Sanity-check config loading**

Run:

```bash
node --input-type=module -e "import { config, getOperatingMode } from './config.js'; console.log(JSON.stringify({ mode: getOperatingMode(), management: config.management }, null, 2));"
```

Expected:
- prints a valid management config object
- `mode` is one of `dry-run`, `semi-auto`, or `full-auto`

- [ ] **Step 7: Commit**

Run:

```bash
git add config.js user-config.example.json
git commit -m "feat: add operating mode config defaults"
```

---

### Task 2: Enforce operating mode centrally in the executor

**Files:**
- Modify: `tools/executor.js`
- Modify: `config.js`

- [ ] **Step 1: Add the config hook imports**

Update the `config.js` import in `tools/executor.js` to:

```js
import { config, reloadScreeningThresholds, getOperatingMode } from "../config.js";
```

- [ ] **Step 2: Add structured mode helpers before `executeTool()`**

Insert helper code above `executeTool()`:

```js
function isWriteTool(name) {
  return WRITE_TOOLS.has(name);
}

function buildModeDecision(name, args) {
  const mode = getOperatingMode();

  if (!isWriteTool(name)) {
    return { mode, action: "allow" };
  }

  if (mode === "dry-run") {
    return {
      mode,
      action: "simulate",
      reason: `Blocked live execution for ${name} because operatingMode=dry-run.`,
    };
  }

  if (mode === "semi-auto") {
    const approved = args?.approved === true || args?.approval_token === "manual";
    if (!approved) {
      return {
        mode,
        action: "block",
        reason: `Blocked ${name} because operatingMode=semi-auto and no explicit approval was provided.`,
      };
    }
  }

  return { mode, action: "allow" };
}

function buildSimulatedResult(name, args, reason) {
  return {
    success: true,
    simulated: true,
    tool: name,
    mode: getOperatingMode(),
    reason,
    args,
  };
}
```

Purpose:
- define one path for allow, simulate, and block behavior

- [ ] **Step 3: Apply mode decisions at the top of `executeTool()`**

Add this block after the unknown-tool check and before `runSafetyChecks()`:

```js
  const modeDecision = buildModeDecision(name, args);
  if (modeDecision.action === "simulate") {
    const simulated = buildSimulatedResult(name, args, modeDecision.reason);
    log("mode_simulation", `${name} simulated: ${modeDecision.reason}`);
    logAction({
      tool: name,
      args,
      result: summarizeResult(simulated),
      duration_ms: Date.now() - startTime,
      success: true,
    });
    return simulated;
  }

  if (modeDecision.action === "block") {
    log("mode_block", `${name} blocked: ${modeDecision.reason}`);
    return {
      blocked: true,
      mode: modeDecision.mode,
      reason: modeDecision.reason,
      requires_approval: true,
      tool: name,
    };
  }
```

Expected:
- dry-run never reaches live write tools
- semi-auto returns approval-gated responses instead of executing

- [ ] **Step 4: Include mode metadata in safety blocks and success logs**

Update the safety block return to:

```js
      return {
        blocked: true,
        mode: getOperatingMode(),
        reason: safetyCheck.reason,
        tool: name,
      };
```

Update the success path to add `mode: getOperatingMode()` where notifications or structured results are returned or logged.

- [ ] **Step 5: Add `operatingMode` to `update_config`**

Extend the `CONFIG_MAP` in `tools/executor.js` with:

```js
      operatingMode: ["management", "operatingMode"],
```

This lets the agent or operator switch from `dry-run` to `semi-auto` to `full-auto` using the existing config mutation tool.

- [ ] **Step 6: Fix the duplicate `minBinStep` mapping bug while touching `CONFIG_MAP`**

Change the strategy mapping block from:

```js
      minBinStep: ["strategy", "minBinStep"],
      binsBelow: ["strategy", "binsBelow"],
```

To:

```js
      strategy: ["strategy", "strategy"],
      binsBelow: ["strategy", "binsBelow"],
```

Purpose:
- avoid shadowing the earlier real `screening.minBinStep`
- align config mutation with the actual strategy object in `config.js`

- [ ] **Step 7: Add a smoke test for mode gating**

Run:

```bash
node --input-type=module -e "import { executeTool } from './tools/executor.js'; const result = await executeTool('swap_token', { input_mint: 'A', output_mint: 'SOL', amount: 1 }); console.log(JSON.stringify(result, null, 2));"
```

Expected:
- in `dry-run`, output contains `"simulated": true`
- in `semi-auto`, output contains `"requires_approval": true` unless approval args are passed

- [ ] **Step 8: Commit**

Run:

```bash
git add tools/executor.js config.js
git commit -m "feat: enforce operating mode in executor"
```

---

### Task 3: Fix lessons threshold evolution

**Files:**
- Modify: `lessons.js`
- Modify: `config.js`

- [ ] **Step 1: Locate the broken key references**

Run:

```bash
rg -n "maxVolatility|minFeeTvlRatio|minFeeActiveTvlRatio" lessons.js config.js
```

Expected:
- `lessons.js` references `maxVolatility` and `minFeeTvlRatio`
- `config.js` only exposes `minFeeActiveTvlRatio`

- [ ] **Step 2: Remove the `maxVolatility` evolution branch**

Delete the entire `// ── 1. maxVolatility` block from `evolveThresholds()` and renumber the remaining comment headings.

Rationale:
- the spec explicitly says not to evolve keys that do not exist
- no compensating config addition is needed for this rollout slice

- [ ] **Step 3: Rename the fee/TVL evolution to the active config key**

Change the fee evolution block in `lessons.js` from:

```js
    const current    = config.screening.minFeeTvlRatio;
```

To:

```js
    const current    = config.screening.minFeeActiveTvlRatio;
```

And change all writes and rationale keys from `minFeeTvlRatio` to `minFeeActiveTvlRatio`.

Final shape should look like:

```js
          changes.minFeeActiveTvlRatio = rounded;
          rationale.minFeeActiveTvlRatio = `Lowest winner fee_tvl=${minWinnerFee.toFixed(2)} — raised floor from ${current} → ${rounded}`;
```

- [ ] **Step 4: Verify persistence still writes the correct flat user-config key**

Keep the existing persistence code:

```js
  Object.assign(userConfig, changes);
```

Because the `changes` object now contains the correct user-config field name.

- [ ] **Step 5: Run a direct evolution smoke check**

Run:

```bash
node --input-type=module -e "import { evolveThresholds } from './lessons.js'; const config = { screening: { minFeeActiveTvlRatio: 0.05, minOrganic: 60 } }; const perf = [{ pnl_pct: 6, fee_tvl_ratio: 0.2, organic_score: 78, volatility: 2 }, { pnl_pct: 7, fee_tvl_ratio: 0.22, organic_score: 80, volatility: 2.2 }, { pnl_pct: 8, fee_tvl_ratio: 0.21, organic_score: 82, volatility: 2.4 }, { pnl_pct: -8, fee_tvl_ratio: 0.07, organic_score: 62, volatility: 4 }, { pnl_pct: -9, fee_tvl_ratio: 0.08, organic_score: 60, volatility: 4.2 }]; console.log(JSON.stringify(evolveThresholds(perf, config), null, 2));"
```

Expected:
- result contains `changes.minFeeActiveTvlRatio`
- result does not contain `maxVolatility`

- [ ] **Step 6: Commit**

Run:

```bash
git add lessons.js
git commit -m "fix: evolve valid screening thresholds only"
```

---

### Task 4: Make startup, logs, and Telegram notifications mode-aware

**Files:**
- Modify: `index.js`
- Modify: `telegram.js`
- Modify: `tools/executor.js`

- [ ] **Step 1: Surface operating mode at startup**

In `index.js`, replace:

```js
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
```

With:

```js
log("startup", `Operating mode: ${config.management.operatingMode}`);
log("startup", `Legacy DRY_RUN env: ${process.env.DRY_RUN === "true" ? "true" : "false"}`);
```

Purpose:
- stop conflating legacy env state with the new runtime mode

- [ ] **Step 2: Add mode to cycle logs**

Update management and screening cycle start logs in `index.js`:

```js
  log("cron", `Starting management cycle [mode: ${config.management.operatingMode}] [model: ${config.llm.managementModel}]`);
```

```js
  log("cron", `Starting screening cycle [mode: ${config.management.operatingMode}] [model: ${config.llm.screeningModel}]`);
```

- [ ] **Step 3: Pass mode and status into Telegram notification helpers**

Change executor notification calls from:

```js
notifyDeploy({ pair: ..., amountSol: ..., position: ..., tx: ..., priceRange: ..., binStep: ..., baseFee: ... })
```

To:

```js
notifyDeploy({
  pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8),
  amountSol: args.amount_y ?? args.amount_sol ?? 0,
  position: result.position,
  tx: result.txs?.[0] ?? result.tx,
  priceRange: result.price_range,
  binStep: result.bin_step,
  baseFee: result.base_fee,
  mode: getOperatingMode(),
  status: result.simulated ? "simulated" : "executed",
});
```

Apply the same pattern to `notifyClose()` and `notifySwap()`.

- [ ] **Step 4: Update the Telegram helper signatures**

In `telegram.js`, update the helper signatures:

```js
export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, binStep, baseFee, mode, status = "executed" }) {
```

```js
export async function notifyClose({ pair, pnlUsd, pnlPct, mode, status = "executed", reason }) {
```

```js
export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx, mode, status = "executed" }) {
```

- [ ] **Step 5: Include mode and status in the actual messages**

Use message shapes like:

```js
  await sendHTML(
    `✅ <b>${status === "simulated" ? "Simulated Deploy" : "Deployed"}</b> ${pair}\n` +
    `Mode: <code>${mode ?? "unknown"}</code>\n` +
    `Amount: ${amountSol} SOL\n` +
    priceStr +
    poolStr +
    `Position: <code>${position?.slice(0, 8)}...</code>\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
```

And for close:

```js
  await sendHTML(
    `🔒 <b>${status === "simulated" ? "Simulated Close" : "Closed"}</b> ${pair}\n` +
    `Mode: <code>${mode ?? "unknown"}</code>\n` +
    `PnL: ${sign}$${(pnlUsd ?? 0).toFixed(2)} (${sign}${(pnlPct ?? 0).toFixed(2)}%)` +
    (reason ? `\nReason: ${reason}` : "")
  );
```

- [ ] **Step 6: Verify notifications still render**

Run:

```bash
node --input-type=module -e "import { notifyDeploy } from './telegram.js'; await notifyDeploy({ pair: 'TEST-SOL', amountSol: 0.35, position: 'ABCDEFGH1234', tx: '1234567890abcdef', mode: 'dry-run', status: 'simulated' }); console.log('telegram helper ok');"
```

Expected:
- no exception is thrown
- if Telegram is configured, the message includes mode and status

- [ ] **Step 7: Commit**

Run:

```bash
git add index.js telegram.js tools/executor.js
git commit -m "feat: surface operating mode in logs and alerts"
```

---

### Task 5: Improve reviewability of blocked and simulated decisions

**Files:**
- Modify: `tools/executor.js`
- Modify: `logger.js` only if current log shape cannot carry the new fields

- [ ] **Step 1: Add explicit reason codes for safety blocks**

Refactor the `deploy_position` safety checks to return both a code and a message. Replace patterns like:

```js
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
```

With:

```js
        return {
          pass: false,
          code: "MAX_POSITIONS_REACHED",
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
```

Apply the same shape to the other deploy checks:
- `BIN_STEP_OUT_OF_RANGE`
- `DUPLICATE_POOL`
- `DUPLICATE_BASE_TOKEN`
- `MISSING_DEPLOY_AMOUNT`
- `DEPLOY_AMOUNT_TOO_SMALL`
- `DEPLOY_AMOUNT_TOO_LARGE`
- `INSUFFICIENT_SOL`

- [ ] **Step 2: Preserve codes in blocked responses**

Update the safety block return inside `executeTool()` to:

```js
      return {
        blocked: true,
        mode: getOperatingMode(),
        code: safetyCheck.code ?? "SAFETY_BLOCK",
        reason: safetyCheck.reason,
        tool: name,
      };
```

- [ ] **Step 3: Log simulated and blocked decisions as structured action events**

Add `logAction()` calls for both mode blocks and mode simulations:

```js
    logAction({
      tool: name,
      args,
      result: summarizeResult(simulated),
      duration_ms: Date.now() - startTime,
      success: true,
      mode: modeDecision.mode,
    });
```

And:

```js
    logAction({
      tool: name,
      args,
      result: summarizeResult({
        blocked: true,
        reason: modeDecision.reason,
        requires_approval: true,
      }),
      duration_ms: Date.now() - startTime,
      success: false,
      mode: modeDecision.mode,
    });
```

- [ ] **Step 4: Verify action logs contain mode context**

Run:

```bash
node --input-type=module -e "import { executeTool } from './tools/executor.js'; const result = await executeTool('deploy_position', { pool_address: 'pool', amount_y: 0.35, bin_step: 90 }); console.log(JSON.stringify(result, null, 2));"
tail -n 5 logs/*.log 2>/dev/null
```

Expected:
- returned payload contains `mode`
- recent logs show either `mode_simulation`, `mode_block`, or `safety_block`

- [ ] **Step 5: Commit**

Run:

```bash
git add tools/executor.js logger.js
git commit -m "feat: log reviewable safety and mode decisions"
```

Note:
- if `logger.js` does not require edits, omit it from `git add`

---

### Task 6: Run end-to-end verification for the rollout path

**Files:**
- No code changes required unless verification uncovers defects

- [ ] **Step 1: Verify the repo test scripts still start**

Run:

```bash
npm run test:screen
```

Expected:
- script completes without syntax or import failures

- [ ] **Step 2: Verify agent path still starts in dry-run**

Run:

```bash
npm run dev
```

Expected:
- startup logs include `Operating mode: dry-run`
- no immediate crash in config, executor, or startup logging

- [ ] **Step 3: Verify semi-auto blocking manually**

Temporarily set:

```json
{
  "operatingMode": "semi-auto"
}
```

Then run:

```bash
node --input-type=module -e "import { executeTool } from './tools/executor.js'; const result = await executeTool('close_position', { position_address: 'test' }); console.log(JSON.stringify(result, null, 2));"
```

Expected:
- response contains `"requires_approval": true`
- no on-chain action is attempted

- [ ] **Step 4: Verify full-auto path preserves safety checks**

Temporarily set:

```json
{
  "operatingMode": "full-auto"
}
```

Then run:

```bash
node --input-type=module -e "import { executeTool } from './tools/executor.js'; const result = await executeTool('deploy_position', { pool_address: 'pool', amount_y: 0.01, bin_step: 90 }); console.log(JSON.stringify(result, null, 2));"
```

Expected:
- response is still blocked by deploy minimum or balance safety checks
- mode gating does not bypass deterministic safeguards

- [ ] **Step 5: Restore the intended local operating mode**

Set `user-config.json` back to:

```json
{
  "operatingMode": "dry-run"
}
```

So the next human run starts safely.

- [ ] **Step 6: Final status review**

Run:

```bash
git status --short
git log --oneline -5
```

Expected:
- only intended files are modified
- commit history reflects the rollout sequence clearly

---

## Self-Review

### Spec coverage

- Operating mode rollout: covered by Tasks 1, 2, 4, and 6.
- Lessons key fix: covered by Task 3.
- Reviewable decision logging: covered by Tasks 4 and 5.
- Safer small-wallet defaults: covered by Task 1.
- Verification before live capital: covered by Task 6.

No spec gaps remain for the first implementation slice.

### Placeholder scan

- No `TODO`, `TBD`, or deferred implementation placeholders remain.
- Each task names exact files, concrete edits, exact commands, and expected results.

### Type consistency

- The plan uses `config.management.operatingMode` consistently.
- The plan uses `minFeeActiveTvlRatio` consistently for lessons evolution.
- The executor gating contract consistently returns `mode`, `blocked` or `simulated`, and optional `requires_approval`.
