import { z } from "zod";
import { SolAddressSchema } from "./common.js";

// ─── 1. Stringifiable & BigInt Boundary Coercion Helpers ───────────────────

/**
 * Safely extracts a string from an unknown value if it is a string
 * or an object with a custom .toString() method (e.g. PublicKey or BN).
 */
export function extractStringProperty(val: unknown): string | null {
  if (typeof val === "string") return val;
  if (typeof val === "object" && val !== null && "toString" in val) {
    const fn = (val as { toString: unknown }).toString;
    if (typeof fn === "function") {
      const res = fn.call(val);
      if (typeof res === "string" && res !== "[object Object]") {
        return res;
      }
    }
  }
  return null;
}

/**
 * Coerces Solana addresses whether passed as raw base58 string,
 * PublicKey object, or mock test object with a .toString() method.
 */
export const StringifiableAddressSchema = z.preprocess((val) => {
  const str = extractStringProperty(val);
  return str ?? val;
}, z.string().trim().min(1));

/**
 * Safely extracts a bigint from unknown inputs (number, bigint, numeric string, BN).
 */
export function extractBigIntProperty(val: unknown): bigint | null {
  if (typeof val === "bigint") return val;
  if (typeof val === "number" && Number.isSafeInteger(val)) return BigInt(val);
  const str = extractStringProperty(val);
  if (str !== null && /^-?\d+$/.test(str.trim())) {
    try {
      return BigInt(str.trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Coerces token quantities into bigint from BN, string, or number.
 */
export const BigIntCoercibleSchema = z.preprocess((val) => {
  const bi = extractBigIntProperty(val);
  return bi ?? val;
}, z.bigint());

// ─── 2. Token & RPC Exact Schemas ──────────────────────────────────────────

export const ParsedTokenAmountSchema = z.object({
  amount: z.string(),
  decimals: z.number().int().nonnegative(),
  uiAmount: z.number().nullable(),
  uiAmountString: z.string().optional(),
});

export const SplTokenAccountInfoSchema = z.object({
  mint: SolAddressSchema,
  owner: SolAddressSchema,
  tokenAmount: ParsedTokenAmountSchema,
  delegate: SolAddressSchema.optional(),
  state: z.string(),
});

export const ParsedTokenAccountItemSchema = z.object({
  pubkey: SolAddressSchema,
  account: z.object({
    data: z.object({
      parsed: z.object({
        info: SplTokenAccountInfoSchema,
        type: z.string(),
      }),
      program: z.string(),
    }),
  }),
});

export const ParsedTokenAccountsResponseSchema = z.object({
  value: z.array(ParsedTokenAccountItemSchema),
});

export const MintExtensionSchema = z.object({
  extension: z.string(),
  state: z.unknown().optional(),
});

export const ParsedMintInfoSchema = z.object({
  mintAuthority: SolAddressSchema.nullable(),
  freezeAuthority: SolAddressSchema.nullable(),
  supply: z.string(),
  decimals: z.number().int().nonnegative(),
  isInitialized: z.boolean(),
  extensions: z.array(MintExtensionSchema).optional(),
});

export const ConfirmedSignatureInfoSchema = z.object({
  signature: z.string(),
  slot: z.number().int().nonnegative(),
  err: z.unknown().nullable(),
  memo: z.string().nullable(),
  blockTime: z.number().int().nullable(),
  confirmationStatus: z.string().optional(),
});

export const RpcLogsNotificationSchema = z.object({
  signature: z.string(),
  err: z.unknown().nullable(),
  logs: z.array(z.string()),
});

// ─── 3. Flexible Parsed Responses (Live RPC & Test Mocks) ──────────────────

export const ParsedTokenAmountFlexibleSchema = z.object({
  amount: z.string(),
  decimals: z.number().int().nonnegative(),
  uiAmount: z.number().nullable().optional(),
  uiAmountString: z.string().optional(),
}).passthrough();

export const TokenAccountInfoFlexibleSchema = z.object({
  mint: z.string().min(1),
  tokenAmount: ParsedTokenAmountFlexibleSchema,
  owner: z.string().optional(),
  delegate: z.string().optional(),
  state: z.string().optional(),
}).passthrough();

export const ParsedTokenAccountItemFlexibleSchema = z.object({
  pubkey: z.unknown().optional(),
  account: z.object({
    data: z.object({
      parsed: z.object({
        info: TokenAccountInfoFlexibleSchema,
        type: z.string().optional(),
      }).passthrough(),
      program: z.string().optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

export const ParsedTokenAccountsResponseFlexibleSchema = z.object({
  value: z.array(ParsedTokenAccountItemFlexibleSchema),
}).passthrough();

export const AggregateTokenAccountsInputSchema = z.array(
  ParsedTokenAccountsResponseFlexibleSchema
);

// ─── 4. Balance Domain Schemas ─────────────────────────────────────────────

export const AggregatedTokenBalanceSchema = z.object({
  mint: z.string().min(1),
  raw_balance: z.string(),
  decimals: z.number().int().nonnegative(),
  balance: z.number(),
});

export const NativeBalanceResultSchema = z.object({
  wallet: z.string().min(1),
  sol: z.number(),
});

export const TokenBalanceResultSchema = z.object({
  wallet: z.string().min(1),
  sol: z.number(),
  tokens: z.array(AggregatedTokenBalanceSchema),
});

export const PricedTokenBalanceSchema = AggregatedTokenBalanceSchema.extend({
  symbol: z.string(),
  usd: z.number().nullable(),
});

export const PricedBalancesResultSchema = z.object({
  wallet: z.string().min(1),
  sol: z.number(),
  tokens: z.array(PricedTokenBalanceSchema),
  sol_price: z.number().nullable(),
  sol_usd: z.number().nullable(),
  usdc: z.number(),
  total_usd: z.number().nullable(),
  prices_complete: z.boolean(),
});

// ─── 5. DLMM Anchor Event & Snapshot Schemas ───────────────────────────────

export const DlmmEventSchema = z.object({
  name: z.string(),
  data: z.unknown(),
});

export const DlmmAddLiquidityEventDataSchema = z.object({
  lbPair: StringifiableAddressSchema,
  from: StringifiableAddressSchema,
  position: StringifiableAddressSchema,
  amounts: z.array(BigIntCoercibleSchema).min(2),
  activeBinId: z.number().int().optional(),
}).passthrough();

export const DlmmRemoveLiquidityEventDataSchema = z.object({
  lbPair: StringifiableAddressSchema,
  from: StringifiableAddressSchema,
  position: StringifiableAddressSchema,
  amounts: z.array(BigIntCoercibleSchema).min(2),
  activeBinId: z.number().int().optional(),
}).passthrough();

export const DlmmClaimFeeEventDataSchema = z.object({
  lbPair: StringifiableAddressSchema,
  position: StringifiableAddressSchema,
  owner: StringifiableAddressSchema,
  feeX: BigIntCoercibleSchema,
  feeY: BigIntCoercibleSchema,
  activeBinId: z.number().int().optional(),
}).passthrough();

export const DlmmSwapEventDataSchema = z.object({
  lbPair: StringifiableAddressSchema,
  from: StringifiableAddressSchema,
  startBinId: z.number().int(),
  endBinId: z.number().int(),
  amountIn: BigIntCoercibleSchema,
  amountOut: BigIntCoercibleSchema,
  swapForY: z.boolean(),
  fee: BigIntCoercibleSchema,
  protocolFee: BigIntCoercibleSchema,
  feeBps: BigIntCoercibleSchema,
  hostFee: BigIntCoercibleSchema,
}).passthrough();

export const DlmmRebalancingEventDataSchema = z.object({
  lbPair: StringifiableAddressSchema,
  position: StringifiableAddressSchema,
  owner: StringifiableAddressSchema,
  activeBinId: z.number().int(),
  xWithdrawnAmount: BigIntCoercibleSchema,
  xAddedAmount: BigIntCoercibleSchema,
  yWithdrawnAmount: BigIntCoercibleSchema,
  yAddedAmount: BigIntCoercibleSchema,
  xFeeAmount: BigIntCoercibleSchema,
  yFeeAmount: BigIntCoercibleSchema,
  oldMinId: z.number().int(),
  oldMaxId: z.number().int(),
  newMinId: z.number().int(),
  newMaxId: z.number().int(),
  rewards: z.array(BigIntCoercibleSchema).optional(),
}).passthrough();

export const PositionSnapshotSchema = z.object({
  shares: z.string(),
  xMint: z.string().min(1),
  yMint: z.string().min(1),
  lower: z.number().int(),
  upper: z.number().int(),
  active: z.number().int(),
  inRange: z.boolean(),
});

// ─── 6. Inferred TypeScript Types ──────────────────────────────────────────

export type ParsedTokenAmount = z.infer<typeof ParsedTokenAmountSchema>;
export type SplTokenAccountInfo = z.infer<typeof SplTokenAccountInfoSchema>;
export type ParsedTokenAccountItem = z.infer<typeof ParsedTokenAccountItemSchema>;
export type ParsedTokenAccountsResponse = z.infer<typeof ParsedTokenAccountsResponseSchema>;
export type MintExtension = z.infer<typeof MintExtensionSchema>;
export type ParsedMintInfo = z.infer<typeof ParsedMintInfoSchema>;
export type ConfirmedSignatureInfo = z.infer<typeof ConfirmedSignatureInfoSchema>;
export type RpcLogsNotification = z.infer<typeof RpcLogsNotificationSchema>;

export type ParsedTokenAmountFlexible = z.infer<typeof ParsedTokenAmountFlexibleSchema>;
export type TokenAccountInfoFlexible = z.infer<typeof TokenAccountInfoFlexibleSchema>;
export type ParsedTokenAccountItemFlexible = z.infer<typeof ParsedTokenAccountItemFlexibleSchema>;
export type ParsedTokenAccountsResponseFlexible = z.infer<typeof ParsedTokenAccountsResponseFlexibleSchema>;

export type AggregatedTokenBalance = z.infer<typeof AggregatedTokenBalanceSchema>;
export type NativeBalanceResult = z.infer<typeof NativeBalanceResultSchema>;
export type TokenBalanceResult = z.infer<typeof TokenBalanceResultSchema>;
export type PricedTokenBalance = z.infer<typeof PricedTokenBalanceSchema>;
export type PricedBalancesResult = z.infer<typeof PricedBalancesResultSchema>;

export type DlmmEvent = z.infer<typeof DlmmEventSchema>;
export type DlmmAddLiquidityEventData = z.infer<typeof DlmmAddLiquidityEventDataSchema>;
export type DlmmRemoveLiquidityEventData = z.infer<typeof DlmmRemoveLiquidityEventDataSchema>;
export type DlmmClaimFeeEventData = z.infer<typeof DlmmClaimFeeEventDataSchema>;
export type DlmmSwapEventData = z.infer<typeof DlmmSwapEventDataSchema>;
export type DlmmRebalancingEventData = z.infer<typeof DlmmRebalancingEventDataSchema>;
export type PositionSnapshot = z.infer<typeof PositionSnapshotSchema>;
