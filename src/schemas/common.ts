import { z } from "zod";
import { PublicKey } from "@solana/web3.js";

/**
 * Validates base58 Solana public key strings (32-44 characters).
 * Verifies validity via PublicKey construction.
 */
export const SolAddressSchema = z
  .string()
  .trim()
  .min(32, "Solana address too short")
  .max(44, "Solana address too long")
  .refine(
    (val) => {
      try {
        new PublicKey(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid Solana base58 public key" }
  );

/**
 * Coerces and validates positive finite numbers (> 0).
 */
export const PositiveNumberSchema = z.coerce.number().positive().finite();

/**
 * Coerces and validates non-negative finite numbers (>= 0).
 */
export const NonNegativeNumberSchema = z.coerce.number().min(0).finite();

/**
 * Tolerant numeric preprocessor: parses strings, numbers, null, undefined into finite numbers or null.
 * Handles API quirks (e.g. empty strings, "0.05", null).
 */
export const FlexibleNumberSchema = z.preprocess((val) => {
  if (val === "" || val == null) return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}, z.number().nullable());

/**
 * Coerces flexible inputs into non-negative finite number with a default of 0.
 */
export const TolerantNonNegativeNumberSchema = z.preprocess((val) => {
  if (val === "" || val == null) return 0;
  const num = Number(val);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}, z.number().min(0).default(0));

/**
 * ISO 8601 UTC timestamp string validation.
 */
export const IsoDateStringSchema = z.string().datetime({ offset: true });

/**
 * Sanitizes and truncates free-form text strings for persistence.
 */
export function sanitizeText(val: unknown, maxLen = 280): string | null {
  if (val == null) return null;
  const cleaned = String(val)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

export type SolAddress = z.infer<typeof SolAddressSchema>;
