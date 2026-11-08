// test/setup.ts — Vitest Global Test Setup & Environment Isolation Harness
// Strictly adheres to Oracle TypeScript Standards: Zero any, Zero unsafe assertions, Domain Purity.

import fs from "node:fs";
import { beforeAll, afterAll, afterEach, vi } from "vitest";
import { repoPath } from "../repo-root.js";
import { stopChronosKeepalive } from "../standalone/chronos.js";
import { invalidateBalances } from "../standalone/balances.js";
import { resetWalletLockForTests } from "../standalone/transactions.js";
import { snapshotStateFiles, restoreStateFiles } from "./helpers/state-isolation.js";

/** Store original native fetch for clean teardown and allowed local loopback. */
const originalFetch: typeof globalThis.fetch = globalThis.fetch;

/**
 * Known unauthorized live network patterns.
 * External network calls to these domains must be intercepted and immediately rejected.
 */
const BLOCKED_HOST_PATTERNS: readonly (string | RegExp)[] = [
  "api.telegram.org",
  /api\.mainnet-beta\.solana\.com/,
  /api\.devnet\.solana\.com/,
  /api\.testnet\.solana\.com/,
  /solana\.com/,
  /helius/,
  /meteora\.ag/,
  /jup\.ag/,
  /geckoterminal\.com/,
  /coinglass\.com/,
  /dexscreener\.com/,
  /birdeye\.so/,
];

/**
 * Safely extracts a string URL from fetch input without any unsafe casting.
 */
export function extractUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  if (
    typeof input === "object" &&
    input !== null &&
    "url" in input &&
    typeof input.url === "string"
  ) {
    return input.url;
  }
  return String(input);
}

/**
 * Determines whether a URL targets a local mock/loopback server.
 */
export function isLocalUrl(url: string): boolean {
  if (url.startsWith("/")) {
    return true;
  }
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1" ||
      parsed.hostname === "0.0.0.0"
    );
  } catch {
    return false;
  }
}

/**
 * Determines whether a URL targets an unauthorized live external network endpoint.
 */
export function isUnauthorizedEndpoint(url: string): boolean {
  if (url.includes("api.telegram.org")) {
    return true;
  }
  return BLOCKED_HOST_PATTERNS.some((pattern) => {
    if (typeof pattern === "string") {
      return url.includes(pattern);
    }
    return pattern.test(url);
  });
}

/**
 * Enforces hermetic test environment variables.
 * Sets NODE_ENV to 'test', DISABLE_TELEGRAM to 'true', and unsets sensitive live tokens.
 */
export function configureTestEnvironment(): void {
  process.env.NODE_ENV = "test";
  process.env.DISABLE_TELEGRAM = "true";
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.LLM_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
}

/**
 * Installs global fetch interceptor to block unauthorized outbound requests.
 */
export function installFetchInterceptor(): void {
  globalThis.fetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1]
  ): Promise<Response> => {
    const url = extractUrl(input);

    if (url.includes("api.telegram.org")) {
      throw new Error(`CRITICAL LEAK DETECTED: HTTP dispatch to ${url}`);
    }

    if (isUnauthorizedEndpoint(url) || !isLocalUrl(url)) {
      throw new Error(`CRITICAL LEAK DETECTED: Unauthorized outbound network request blocked: ${url}`);
    }

    if (typeof originalFetch === "function") {
      return originalFetch(input, init);
    }

    throw new Error(`No native fetch implementation available for: ${url}`);
  };
}

/**
 * Safely cleans up dangling standalone.lock file left behind by interrupted tests.
 */
export function removeDanglingLock(): void {
  try {
    const lockPath = repoPath("standalone.lock");
    if (fs.existsSync(lockPath)) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[test/setup.ts] Failed to clean up standalone.lock: ${msg}`);
  }
}

/**
 * Cleans up active background timers and balance caches.
 */
export function cleanupActiveTimers(): void {
  try {
    resetWalletLockForTests();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[test/setup.ts] Failed to reset wallet lock: ${msg}`);
  }

  try {
    stopChronosKeepalive();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[test/setup.ts] Failed to stop chronos keepalive: ${msg}`);
  }

  try {
    invalidateBalances();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[test/setup.ts] Failed to invalidate balances: ${msg}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-Level Execution (Evaluated immediately on setup file load)
// ─────────────────────────────────────────────────────────────────────────────
configureTestEnvironment();
installFetchInterceptor();

// ─────────────────────────────────────────────────────────────────────────────
// Vitest Global Lifecycle Hooks
// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  configureTestEnvironment();
  installFetchInterceptor();
  await snapshotStateFiles();
});

afterEach(() => {
  cleanupActiveTimers();
  removeDanglingLock();

  vi.clearAllTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();

  configureTestEnvironment();
  installFetchInterceptor();
});

afterAll(async () => {
  try {
    await restoreStateFiles();
  } finally {
    removeDanglingLock();
    if (typeof originalFetch === "function") {
      globalThis.fetch = originalFetch;
    }
  }
});
