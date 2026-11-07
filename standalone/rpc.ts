import { Connection } from "@solana/web3.js";
import { config } from "../config.js";

export type RpcKind = "balance" | "monitor";

export async function fetchJson(url: string, options: RequestInit = {}): Promise<unknown> {
  const signal = options.signal ?? AbortSignal.timeout(10_000);
  const response = await fetch(url, { ...options, signal });
  if (!response.ok) {
    throw new Error(`Data request failed (HTTP ${response.status})`);
  }
  const data: unknown = await response.json();
  return data;
}

export function connection(url: string, wsEndpoint?: string): Connection {
  if (!url) {
    throw new Error("Configure RPC_URL (and optionally MONITOR_RPC_URL/BALANCE_RPC_URL)");
  }
  return new Connection(url, {
    commitment: "confirmed",
    ...(wsEndpoint ? { wsEndpoint } : {}),
    disableRetryOnRateLimit: true,
    fetch: (input, init) => {
      const signal = init?.signal ?? AbortSignal.timeout(15_000);
      return fetch(input, { ...init, signal });
    },
  });
}

const connections = new Map<string, Connection>();

export async function readRpc<T>(
  kind: RpcKind,
  fn: (conn: Connection) => Promise<T> | T
): Promise<T> {
  const primary = kind === "balance" ? config.standalone.balanceRpcUrl : config.standalone.monitorRpcUrl;
  const fallback = config.standalone.fallbackRpcUrl;
  const candidates = [primary, fallback].filter((u): u is string => typeof u === "string" && u.length > 0);
  const urls = [...new Set(candidates)];
  if (!urls.length) {
    throw new Error("RPC_URL is required");
  }

  let lastError: unknown;
  for (const url of urls) {
    try {
      let conn = connections.get(url);
      if (!conn) {
        conn = connection(url);
        connections.set(url, conn);
      }
      return await fn(conn);
    } catch (e: unknown) {
      lastError = e;
    }
  }

  const errorName = lastError instanceof Error ? lastError.name : "Error";
  // Provider errors may contain authenticated URLs. Keep them out of persisted state.
  throw new Error(`RPC ${kind} read failed (${errorName})`);
}
