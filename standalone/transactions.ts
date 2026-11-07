// standalone/transactions.ts — Serialized wallet mutation mutex and Solana transaction utilities
// Oracle System Strict Mode: Zero any, Zero unsafe assertions, Domain Purity, DRY z.infer schemas.

import { z } from "zod";

// ─── Zod Boundary Schemas: Solana Transaction External Data ───────────────

/**
 * Single prioritization fee item returned from Solana RPC getRecentPrioritizationFees
 */
export const PrioritizationFeeItemSchema = z.object({
  slot: z.number().int().nonnegative(),
  prioritizationFee: z.number().nonnegative(),
});
export type PrioritizationFeeItem = z.infer<typeof PrioritizationFeeItemSchema>;

export const PrioritizationFeesResponseSchema = z.array(PrioritizationFeeItemSchema);
export type PrioritizationFeesResponse = z.infer<typeof PrioritizationFeesResponseSchema>;

/**
 * Result of simulateTransaction RPC call
 */
export const SimulationResultSchema = z.object({
  err: z.unknown().nullable(),
  logs: z.array(z.string()).nullable(),
  unitsConsumed: z.number().nonnegative().optional(),
  returnData: z.unknown().optional(),
});
export type SimulationResult = z.infer<typeof SimulationResultSchema>;

export const RpcSimulationResponseSchema = z.object({
  context: z.object({ slot: z.number().int().nonnegative() }).optional(),
  value: SimulationResultSchema,
});

/**
 * Latest blockhash query response
 */
export const BlockhashResultSchema = z.object({
  blockhash: z.string().min(32),
  lastValidBlockHeight: z.number().int().nonnegative(),
});
export type BlockhashResult = z.infer<typeof BlockhashResultSchema>;

export const RpcBlockhashResponseSchema = z.object({
  context: z.object({ slot: z.number().int().nonnegative() }).optional(),
  value: BlockhashResultSchema,
});

/**
 * Transaction signature confirmation status from getSignatureStatuses
 */
export const SignatureStatusSchema = z.object({
  slot: z.number().int().nonnegative(),
  confirmations: z.number().int().nullable(),
  err: z.unknown().nullable(),
  confirmationStatus: z.enum(["processed", "confirmed", "finalized"]).optional(),
});
export type SignatureStatus = z.infer<typeof SignatureStatusSchema>;

export const SignatureStatusesResponseSchema = z.object({
  context: z.object({ slot: z.number().int().nonnegative() }).optional(),
  value: z.array(SignatureStatusSchema.nullable()),
});

// ─── Priority Queue & Mutex Types ──────────────────────────────────────────

export interface WalletLockOptions {
  priority?: number;
  timeoutMs?: number;
}

interface QueueItem {
  run: () => Promise<void>;
  priority: number;
  timeoutMs?: number;
  timer?: ReturnType<typeof setTimeout> | null;
  abort: (err: Error) => void;
}

// ─── In-Memory Mutex State ─────────────────────────────────────────────────

let active = false;
const queue: QueueItem[] = [];

/**
 * Serialize wallet mutations while allowing monitoring and screening to continue.
 * Exit work (priority = 10) jumps ahead of queued entries (priority = 0).
 * In-flight submission is NEVER interrupted or pre-empted.
 *
 * @param fn Asynchronous or synchronous wallet action to execute under mutex lock
 * @param priorityOrOptions Numeric priority or options bag { priority, timeoutMs }
 */
export function withWalletLock<T>(
  fn: () => Promise<T> | T,
  priorityOrOptions: number | WalletLockOptions = 0
): Promise<T> {
  const priority =
    typeof priorityOrOptions === "number"
      ? priorityOrOptions
      : (priorityOrOptions.priority ?? 0);
  const timeoutMs =
    typeof priorityOrOptions === "object"
      ? priorityOrOptions.timeoutMs
      : undefined;

  return new Promise<T>((resolve, reject) => {
    const item: QueueItem = {
      priority,
      timeoutMs,
      timer: null,
      abort: (err: Error) => {
        reject(err);
      },
      run: async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (e: unknown) {
          reject(e);
        }
      },
    };

    if (timeoutMs != null && timeoutMs > 0) {
      item.timer = setTimeout(() => {
        const idx = queue.indexOf(item);
        if (idx !== -1) {
          queue.splice(idx, 1);
          reject(
            new Error(`Wallet lock acquisition timed out after ${timeoutMs}ms`)
          );
        }
      }, timeoutMs);
    }

    queue.push(item);
    queue.sort((a, b) => b.priority - a.priority);
    void drain();
  });
}

async function drain(): Promise<void> {
  if (active || queue.length === 0) return;
  active = true;

  const item = queue.shift();
  if (!item) {
    active = false;
    return;
  }

  if (item.timer) {
    clearTimeout(item.timer);
    item.timer = null;
  }

  try {
    await item.run();
  } finally {
    active = false;
    void drain();
  }
}

// ─── Mutex Diagnostics & Test Helpers ──────────────────────────────────────

export function isWalletLocked(): boolean {
  return active;
}

export function getWalletLockQueueLength(): number {
  return queue.length;
}

export function resetWalletLockForTests(): void {
  for (const item of queue) {
    if (item.timer) clearTimeout(item.timer);
    item.abort(new Error("Wallet lock reset for testing"));
  }
  queue.length = 0;
  active = false;
}

// ─── Priority Fee Calculation ──────────────────────────────────────────────

export interface PriorityFeeCalculationOptions {
  percentile?: number; // default: 75th percentile
  minMicroLamports?: number; // default: 1_000
  maxMicroLamports?: number; // default: 1_000_000
  fallbackMicroLamports?: number; // default: 10_000
}

/**
 * Calculates recommended micro-lamports priority fee from untrusted RPC response.
 * Validates external input using Zod before any computation.
 */
export function calculatePriorityFee(
  rawFees: unknown,
  options: PriorityFeeCalculationOptions = {}
): number {
  const {
    percentile = 75,
    minMicroLamports = 1_000,
    maxMicroLamports = 1_000_000,
    fallbackMicroLamports = 10_000,
  } = options;

  const parsed = PrioritizationFeesResponseSchema.safeParse(rawFees);
  if (!parsed.success || parsed.data.length === 0) {
    return fallbackMicroLamports;
  }

  const positiveFees = parsed.data
    .map((item) => item.prioritizationFee)
    .filter((fee) => fee > 0)
    .sort((a, b) => a - b);

  if (positiveFees.length === 0) {
    return minMicroLamports;
  }

  const pIndex = Math.min(
    positiveFees.length - 1,
    Math.max(0, Math.floor((percentile / 100) * positiveFees.length))
  );

  const selected = positiveFees[pIndex] ?? fallbackMicroLamports;
  return Math.min(maxMicroLamports, Math.max(minMicroLamports, selected));
}

// ─── Simulation Result Validation ──────────────────────────────────────────

/**
 * Validates untrusted RPC simulation response.
 * Returns strictly typed SimulationResult or throws descriptive error.
 */
export function validateSimulation(rawResponse: unknown): SimulationResult {
  // Handles both wrapped { context, value } and direct SimulationResult
  const wrapped = RpcSimulationResponseSchema.safeParse(rawResponse);
  if (wrapped.success) {
    return wrapped.data.value;
  }

  const direct = SimulationResultSchema.safeParse(rawResponse);
  if (direct.success) {
    return direct.data;
  }

  throw new Error("Invalid simulation response structure from RPC");
}

// ─── Blockhash Caching ─────────────────────────────────────────────────────

export interface CachedBlockhash extends BlockhashResult {
  fetchedAt: number;
}

export class BlockhashCache {
  private cached: CachedBlockhash | null = null;
  private readonly ttlMs: number;

  constructor(ttlMs = 15_000) {
    this.ttlMs = ttlMs;
  }

  getValidBlockhash(now = Date.now()): string | null {
    if (!this.cached) return null;
    if (now - this.cached.fetchedAt > this.ttlMs) {
      this.cached = null;
      return null;
    }
    return this.cached.blockhash;
  }

  setBlockhash(raw: unknown, now = Date.now()): BlockhashResult {
    // Validate both wrapped { value } and direct { blockhash, lastValidBlockHeight }
    let validated: BlockhashResult;
    const wrapped = RpcBlockhashResponseSchema.safeParse(raw);
    if (wrapped.success) {
      validated = wrapped.data.value;
    } else {
      validated = BlockhashResultSchema.parse(raw);
    }

    this.cached = {
      ...validated,
      fetchedAt: now,
    };
    return validated;
  }

  clear(): void {
    this.cached = null;
  }
}

// ─── Confirmation Status Validation ────────────────────────────────────────

/**
 * Validates untrusted signature status query from Solana RPC.
 */
export function validateSignatureStatus(
  rawStatus: unknown
): SignatureStatus | null {
  const wrapped = SignatureStatusesResponseSchema.safeParse(rawStatus);
  if (wrapped.success) {
    return wrapped.data.value[0] ?? null;
  }

  const direct = SignatureStatusSchema.safeParse(rawStatus);
  if (direct.success) {
    return direct.data;
  }

  return null;
}
