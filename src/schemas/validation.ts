import fs from "node:fs";
import { type ZodType } from "zod";

/**
 * Fetch and validate remote JSON payloads against a Zod schema.
 * Replaces raw `await res.json()` calls.
 */
export async function fetchValidatedJson<T>(
  url: string,
  schema: ZodType<T>,
  options: RequestInit = {}
): Promise<T> {
  const signal = options.signal ?? AbortSignal.timeout(10_000);
  const response = await fetch(url, { ...options, signal });

  if (!response.ok) {
    throw new Error(`Data request failed (HTTP ${response.status}) for ${url.split("?")[0]}`);
  }

  const raw: unknown = await response.json();
  const result = schema.safeParse(raw);

  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .slice(0, 5)
      .join("; ");
    throw new Error(`Schema validation failed for ${url.split("?")[0]}: ${formatted}`);
  }

  return result.data;
}

/**
 * Load and validate a local JSON database file.
 * Returns `fallback` if the file does not exist or validation fails, preventing crashes.
 */
export function loadValidatedJson<T>(filePath: string, schema: ZodType<T>, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const result = schema.safeParse(raw);
    if (!result.success) {
      console.error(`Schema validation failed for ${filePath}:`, result.error.format());
      return fallback;
    }
    return result.data;
  } catch (error) {
    console.error(`Failed to read or parse JSON file ${filePath}:`, error);
    return fallback;
  }
}

/**
 * Atomically save validated data to a local JSON file.
 * Validates data via `schema.parse` BEFORE writing to disk via a temporary file.
 */
export function saveValidatedJson<T>(
  filePath: string,
  schema: ZodType<T>,
  data: T,
  indent = 2
): void {
  // 1. Mandatory validation prior to disk mutation
  const validated = schema.parse(data);

  // 2. Atomic temp-file write with secure permissions
  const tmpFile = `${filePath}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(validated, null, indent), { mode: 0o600 });
  fs.renameSync(tmpFile, filePath);
}

/**
 * Validates in-memory unknown data structures (e.g. CLI inputs, Telegram payloads).
 */
export function parseValidated<T>(raw: unknown, schema: ZodType<T>, context = "Payload"): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .slice(0, 5)
      .join("; ");
    throw new Error(`Validation failed for ${context}: ${formatted}`);
  }
  return result.data;
}
