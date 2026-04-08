/**
 * Portfolio-level circuit breaker — tracks SOL balance, not USD.
 *
 * Records starting SOL value at boot. Every management cycle,
 * checks drawdown and returns a graduated tier:
 *   GREEN  (0-5%):   Normal operations
 *   YELLOW (5-10%):  Reduce new deploys
 *   ORANGE (10-15%): Close worst performer, halt screening
 *   RED    (15%+):   Close all positions, exit process
 *
 * LLM-proof: no tool definition, no config key, one-shot init, env-only threshold.
 * Tier thresholds are hardcoded — not configurable by LLM.
 */

import { log } from './logger.js'

// Frozen at module load — LLM cannot mutate
const MAX_DRAWDOWN_PCT = parseFloat(process.env.MAX_DRAWDOWN_PCT || '30')

const TIERS = [
  { name: 'GREEN',  minDrawdown: 0,  action: 'normal' },
  { name: 'YELLOW', minDrawdown: 5,  action: 'reduce_new_deploys' },
  { name: 'ORANGE', minDrawdown: 10, action: 'close_worst_and_halt_screening' },
  { name: 'RED',    minDrawdown: 15, action: 'close_all_and_exit' },
]

const STATE = Object.seal({
  startingSol: null,
  recordedAt: null,
  tripped: false,
})

export function getCircuitBreakerState() {
  return {
    startingSol: STATE.startingSol,
    recordedAt: STATE.recordedAt,
    maxDrawdownPct: MAX_DRAWDOWN_PCT,
    tripped: STATE.tripped,
  }
}

/**
 * Record initial SOL balance. One-shot — refuses to overwrite.
 */
export function recordStartingValue(solValue) {
  if (STATE.startingSol !== null) {
    log('circuit_breaker', `Ignoring attempt to reset starting value (already ${ STATE.startingSol.toFixed(4) } SOL)`)
    return false
  }
  STATE.startingSol = solValue
  STATE.recordedAt = new Date().toISOString()
  log('circuit_breaker', `Starting portfolio: ${ solValue.toFixed(4) } SOL | Max drawdown: ${ MAX_DRAWDOWN_PCT }%`)
  return true
}

/**
 * Check drawdown and return graduated tier.
 * Keeps `breached` field for backward compat (true when tier === RED).
 */
export function checkDrawdown(currentSol) {
  if (STATE.startingSol === null) {
    return { tier: 'GREEN', action: 'normal', breached: false, reason: 'starting value not yet recorded' }
  }
  const rawDrawdown = ((STATE.startingSol - currentSol) / STATE.startingSol) * 100
  const drawdownPct = Math.max(0, rawDrawdown)

  let tier = TIERS[0]
  for (const t of TIERS) {
    if (drawdownPct >= t.minDrawdown) tier = t
  }

  if (tier.name === 'RED') STATE.tripped = true

  return {
    tier: tier.name,
    action: tier.action,
    breached: tier.name === 'RED',
    startingSol: STATE.startingSol,
    currentSol,
    drawdownPct: Math.round(drawdownPct * 100) / 100,
    threshold: MAX_DRAWDOWN_PCT,
  }
}
