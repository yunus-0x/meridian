import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { fetchJson, readRpc } from "./rpc.js";
import { TOKEN_PROGRAMS } from "./balances.js";
import { analyzePoolWithChronos } from "./chronos.js";
import {
  MeteoraPoolDiscoveryResponseSchema,
  MeteoraDlmmPoolSearchResponseSchema,
  JupiterAssetSearchResponseSchema,
  type MeteoraPoolDiscoveryItem,
  type JupiterAssetItem,
  type ChronosAnalysisResult,
} from "../src/schemas/api.js";
import type { Config } from "../src/schemas/config.js";

type ScreeningConfig = Config["screening"];

const number = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const DISCOVERY_ENDPOINT = "https://pool-discovery-api.datapi.meteora.ag/pools";

export async function poolDetail(
  address: string,
  timeframe: string = config.screening.timeframe
): Promise<MeteoraPoolDiscoveryItem> {
  const params = new URLSearchParams({
    page_size: "1",
    filter_by: `pool_address=${address}`,
    timeframe,
  });
  const raw: unknown = await fetchJson(`${DISCOVERY_ENDPOINT}?${params}`);
  const parsed = MeteoraPoolDiscoveryResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Pool data unavailable");
  }
  const pool = parsed.data.data.find((p) => p.pool_address === address);
  if (!pool) {
    throw new Error("Pool data unavailable");
  }
  return pool;
}

export function rejectToken(
  token: JupiterAssetItem | Partial<JupiterAssetItem> | null | undefined,
  mint: string,
  s: ScreeningConfig,
  now: number = Date.now()
): string | null {
  if (!token || token.id !== mint) return "Token mint mismatch";
  const updated = Date.parse(token.updatedAt ?? "");
  if (!Number.isFinite(updated) || now - updated > 240_000 || updated > now + 5000) {
    return "Token data is stale or has no timestamp";
  }
  const audit = token.audit;
  if (audit?.mintAuthorityDisabled !== true || audit?.freezeAuthorityDisabled !== true) {
    return "Mint/freeze authority is enabled or unknown";
  }

  const checkPairs: ReadonlyArray<readonly [keyof typeof audit, number]> = [
    ["topHoldersPercentage", s.maxTop10Pct],
    ["botHoldersPercentage", s.maxBotHoldersPct],
  ];
  for (const [key, limit] of checkPairs) {
    const n = number(audit[key]);
    if (n == null || n < 0 || n > limit) {
      return `${String(key)} failed (${n ?? "unknown"})`;
    }
  }

  if (number(token.fees) == null || (token.fees ?? 0) < s.minTokenFeesSol) {
    return "Token fees below threshold or unknown";
  }
  if (
    s.allowedLaunchpads.length &&
    (!token.launchpad || !s.allowedLaunchpads.includes(token.launchpad))
  ) {
    return "Launchpad is not allowed";
  }
  if (token.launchpad && s.blockedLaunchpads.includes(token.launchpad)) {
    return "Launchpad is blocked";
  }
  if (number(token.holderCount) == null || (token.holderCount ?? 0) < s.minHolders) {
    return "Insufficient holders";
  }
  if (
    number(token.mcap) == null ||
    (token.mcap ?? 0) < s.minMcap ||
    (token.mcap ?? 0) > s.maxMcap
  ) {
    return "Market cap outside limits";
  }
  if (number(token.organicScore) == null || (token.organicScore ?? 0) < s.minOrganic) {
    return "Organic activity below threshold";
  }

  const created = Date.parse(token.createdAt ?? "");
  const age = (now - created) / 3600_000;
  if (
    (s.minTokenAgeHours != null || s.maxTokenAgeHours != null) &&
    (!Number.isFinite(age) || age < 0)
  ) {
    return "Token age unknown";
  }
  if (s.minTokenAgeHours != null && age < s.minTokenAgeHours) return "Token too young";
  if (s.maxTokenAgeHours != null && age > s.maxTokenAgeHours) return "Token too old";
  return null;
}

export function rejectPool(
  p: MeteoraPoolDiscoveryItem | Partial<MeteoraPoolDiscoveryItem>,
  mint: string,
  s: ScreeningConfig
): string | null {
  if (
    p.token_x?.address !== mint ||
    p.token_y?.address !== config.tokens.SOL ||
    p.pool_type !== "dlmm"
  ) {
    return "Requires an exact-mint DLMM token/SOL pool";
  }
  if (p.is_blacklisted !== false) return "Pool blacklist status unsafe or unknown";
  if (!Array.isArray(p.token_x.warnings) || !Array.isArray(p.token_y.warnings)) {
    return "Pool token warnings unavailable";
  }
  if (
    [...p.token_x.warnings, ...p.token_y.warnings].some((w) =>
      w?.severity && ["critical", "danger", "warning"].includes(w.severity)
    )
  ) {
    return "Pool token warning";
  }

  const limitChecks: ReadonlyArray<readonly [string, unknown, number, number | null]> = [
    ["TVL", p.tvl, s.minTvl, s.maxTvl],
    ["active TVL", p.active_tvl, s.minTvl, null],
    ["volume", p.volume, s.minVolume, null],
    ["fee/active TVL", p.fee_active_tvl_ratio, s.minFeeActiveTvlRatio, null],
    ["bin step", p.dlmm_params?.bin_step, s.minBinStep, s.maxBinStep],
    ["quote organic", p.token_y.organic_score, s.minQuoteOrganic, null],
  ];

  for (const [label, raw, min, max] of limitChecks) {
    const n = number(raw);
    if (n == null || n < min || (max != null && n > max)) {
      return `${label} outside limits or unknown`;
    }
  }

  const vol = number(p.volatility);
  const price = number(p.pool_price);
  if (vol == null || vol <= 0 || price == null || price <= 0) {
    return "Volatility or price unavailable";
  }
  return null;
}

const ParsedAccountDataSchema = z
  .object({
    parsed: z
      .object({
        info: z
          .object({
            mintAuthority: z.unknown().nullable(),
            freezeAuthority: z.unknown().nullable(),
            extensions: z
              .array(z.object({ extension: z.string().optional() }).passthrough())
              .optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export async function checkMintOnChain(mint: string): Promise<void> {
  const result = await readRpc("monitor", (c) =>
    c.getParsedAccountInfo(new PublicKey(mint), "confirmed")
  );
  const account = result.value;
  if (!account) throw new Error("On-chain mint authority check failed");

  const ownerStr = account.owner.toString();
  const isKnownTokenProgram = TOKEN_PROGRAMS.some((p) => p === ownerStr);
  if (!isKnownTokenProgram) throw new Error("On-chain mint authority check failed");

  const parsedAccount = ParsedAccountDataSchema.safeParse(account.data);
  if (!parsedAccount.success) throw new Error("On-chain mint authority check failed");

  const info = parsedAccount.data.parsed.info;
  if (info.mintAuthority !== null || info.freezeAuthority !== null) {
    throw new Error("On-chain mint authority check failed");
  }

  const allowedExtensions = new Set(["metadataPointer", "tokenMetadata"]);
  if (ownerStr === TOKEN_PROGRAMS[1]) {
    if (!Array.isArray(info.extensions)) {
      throw new Error("Token-2022 extensions unavailable");
    }
    for (const extension of info.extensions) {
      const extName = extension.extension ?? "";
      if (!allowedExtensions.has(extName)) {
        throw new Error(`Unsupported Token-2022 extension: ${extName}`);
      }
    }
  }
}

export interface ScreenMintOptions {
  poolAddress?: string | null;
}

export type ScreenMintResult =
  | {
      pass: true;
      pool: MeteoraPoolDiscoveryItem;
      token: JupiterAssetItem;
      fetchedAt: number;
    }
  | {
      pass: false;
      reason: string;
      terminal?: boolean;
    };

export async function screenMint(
  mint: string,
  options: ScreenMintOptions = {}
): Promise<ScreenMintResult> {
  if (isBlacklisted(mint) || isBaseMintOnCooldown(mint)) {
    return { pass: false, terminal: true, reason: "Token is blocked or on cooldown" };
  }

  const rawAssets: unknown = await fetchJson(`https://datapi.jup.ag/v1/assets/search?query=${mint}`);
  const parsedAssets = JupiterAssetSearchResponseSchema.safeParse(rawAssets);
  const assets = parsedAssets.success ? parsedAssets.data : [];
  const token = assets.find((t) => t.id === mint);

  const reason = rejectToken(token, mint, config.screening);
  if (reason) return { pass: false, reason };

  if (token && (token.dev ? isDevBlocked(token.dev) : Object.keys(getBlockedDevs()).length > 0)) {
    return { pass: false, terminal: true, reason: "Deployer blocked or unavailable" };
  }

  await checkMintOnChain(mint);

  let addresses: string[];
  if (options.poolAddress) {
    addresses = [options.poolAddress];
  } else {
    const params = new URLSearchParams({ query: mint, page_size: "50", sort_by: "tvl:desc" });
    const rawPools: unknown = await fetchJson(`https://dlmm.datapi.meteora.ag/pools?${params}`);
    const parsedPools = MeteoraDlmmPoolSearchResponseSchema.safeParse(rawPools);
    if (!parsedPools.success) {
      throw new Error("Invalid pool search response");
    }
    addresses = parsedPools.data.data
      .filter((p) => p.token_x?.address === mint && p.token_y?.address === config.tokens.SOL)
      .map((p) => p.address)
      .slice(0, 10);
  }

  const candidates: MeteoraPoolDiscoveryItem[] = [];
  const rejected: string[] = [];

  for (const address of addresses) {
    if (isPoolOnCooldown(address)) {
      rejected.push("Pool cooldown");
      continue;
    }
    try {
      const p = await poolDetail(address);
      const minutes: Record<string, number> = {
        "5m": 5,
        "30m": 30,
        "1h": 60,
        "2h": 120,
        "4h": 240,
        "12h": 720,
        "24h": 1440,
      };
      const configuredMinutes = minutes[config.screening.timeframe] ?? 5;
      if (configuredMinutes < 30) {
        p.volatility = (await poolDetail(address, "30m")).volatility;
      }
      if (!((number(p.volatility) ?? 0) > 0)) {
        p.volatility = (await poolDetail(address, "1h")).volatility;
      }
      const why = rejectPool(p, mint, config.screening);
      if (why) {
        rejected.push(why);
        continue;
      }
      candidates.push(p);
    } catch (e: unknown) {
      rejected.push(e instanceof Error ? e.message : String(e));
    }
  }

  candidates.sort((a, b) => {
    const diffFee = Number(b.fee_active_tvl_ratio ?? 0) - Number(a.fee_active_tvl_ratio ?? 0);
    if (diffFee !== 0) return diffFee;
    const diffActive = Number(b.active_tvl ?? 0) - Number(a.active_tvl ?? 0);
    if (diffActive !== 0) return diffActive;
    return a.pool_address.localeCompare(b.pool_address);
  });

  if (candidates.length > 1) {
    const topSlice = candidates.slice(0, 3);
    const chronosMap = new Map<string, ChronosAnalysisResult>();

    await Promise.all(
      topSlice.map(async (c) => {
        const ch = await analyzePoolWithChronos(c.pool_address, {
          binStep: c.dlmm_params?.bin_step ?? 100,
          activePrice: c.pool_price,
        }).catch(() => null);
        if (ch) chronosMap.set(c.pool_address, ch);
      })
    );

    const firstCandidate = candidates[0];
    const refChronos = firstCandidate ? chronosMap.get(firstCandidate.pool_address) : undefined;
    const defaultSpreadPct = Number(refChronos?.tactical_signals?.spread_pct ?? 20);

    const scoreCandidate = (p: MeteoraPoolDiscoveryItem): number => {
      const base = Number(p.fee_active_tvl_ratio ?? 0);
      const step = Number(p.dlmm_params?.bin_step ?? 100);
      const ch = chronosMap.get(p.pool_address);
      const spreadPct = Number(ch?.tactical_signals?.spread_pct ?? defaultSpreadPct);
      const gatePenalty = ch?.gate?.action === "DEFER" ? 0.15 : 1.0;
      const stepMult =
        spreadPct > 35 && step >= 100
          ? 1.25
          : spreadPct <= 24 && step <= 100
            ? 1.2
            : spreadPct <= 24 && step >= 150
              ? 0.8
              : 1.0;
      return base * stepMult * gatePenalty;
    };

    candidates.sort((a, b) => {
      const diffScore = scoreCandidate(b) - scoreCandidate(a);
      if (diffScore !== 0) return diffScore;
      const diffActive = Number(b.active_tvl ?? 0) - Number(a.active_tvl ?? 0);
      if (diffActive !== 0) return diffActive;
      return a.pool_address.localeCompare(b.pool_address);
    });
  }

  const selectedPool = candidates[0];
  if (selectedPool && token) {
    return {
      pass: true,
      pool: selectedPool,
      token,
      fetchedAt: Date.now(),
    };
  }

  return {
    pass: false,
    reason: rejected.slice(0, 3).join("; ") || "No eligible token/SOL pool",
  };
}
