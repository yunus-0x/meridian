const DATAPI_BASE = "https://datapi.jup.ag/v1";

/**
 * Get the narrative/story behind a token from Jupiter ChainInsight.
 * Useful for understanding if a token has a real community/theme vs nothing.
 */
export async function getTokenNarrative({ mint }) {
  const res = await fetch(`${DATAPI_BASE}/chaininsight/narrative/${mint}`);
  if (!res.ok) throw new Error(`Narrative API error: ${res.status}`);
  const data = await res.json();
  return {
    mint,
    narrative: data.narrative || null,
    status: data.status,
  };
}

/**
 * Search for token data by name, symbol, or mint address.
 * Returns condensed token info useful for confidence scoring.
 */
export async function getTokenInfo({ query }) {
  const url = `${DATAPI_BASE}/assets/search?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Token search API error: ${res.status}`);
  const data = await res.json();
  const tokens = Array.isArray(data) ? data : [data];
  if (!tokens.length) return { found: false, query };

  return {
    found: true,
    query,
    results: tokens.slice(0, 5).map((t) => ({
      mint: t.id,
      name: t.name,
      symbol: t.symbol,
      mcap: t.mcap,
      price: t.usdPrice,
      liquidity: t.liquidity,
      holders: t.holderCount,
      organic_score: t.organicScore,
      organic_label: t.organicScoreLabel,
      launchpad: t.launchpad,
      graduated: !!t.graduatedPool,
      // Global fees paid by traders (priority + jito tips) in SOL.
      // Low value = bundled txs or scam token. Minimum threshold: ~30 SOL.
      global_fees_sol: t.fees != null ? parseFloat(t.fees.toFixed(2)) : null,
      audit: t.audit ? {
        mint_disabled: t.audit.mintAuthorityDisabled,
        freeze_disabled: t.audit.freezeAuthorityDisabled,
        top_holders_pct: t.audit.topHoldersPercentage?.toFixed(2),
        bot_holders_pct: t.audit.botHoldersPercentage?.toFixed(2),
        dev_migrations: t.audit.devMigrations,
      } : null,
      stats_1h: t.stats1h ? {
        price_change: t.stats1h.priceChange?.toFixed(2),
        buy_vol: t.stats1h.buyVolume?.toFixed(0),
        sell_vol: t.stats1h.sellVolume?.toFixed(0),
        buyers: t.stats1h.numOrganicBuyers,
        net_buyers: t.stats1h.numNetBuyers,
      } : null,
      stats_24h: t.stats24h ? {
        price_change: t.stats24h.priceChange?.toFixed(2),
        buy_vol: t.stats24h.buyVolume?.toFixed(0),
        sell_vol: t.stats24h.sellVolume?.toFixed(0),
        buyers: t.stats24h.numOrganicBuyers,
        net_buyers: t.stats24h.numNetBuyers,
      } : null,
    })),
  };
}

/**
 * Get holder distribution for a token mint.
 * Fetches top 100 holders — caller decides how many to display.
 */
export async function getTokenHolders({ mint, limit = 20 }) {
  // Fetch holders and total supply in parallel
  const [holdersRes, tokenRes] = await Promise.all([
    fetch(`${DATAPI_BASE}/holders/${mint}?limit=100`),
    fetch(`${DATAPI_BASE}/assets/search?query=${mint}`),
  ]);
  if (!holdersRes.ok) throw new Error(`Holders API error: ${holdersRes.status}`);
  const data = await holdersRes.json();
  const tokenData = tokenRes.ok ? await tokenRes.json() : null;
  const tokenInfo = Array.isArray(tokenData) ? tokenData[0] : tokenData;
  const totalSupply = tokenInfo?.totalSupply || tokenInfo?.circSupply || null;

  const holders = Array.isArray(data) ? data : (data.holders || data.data || []);

  const mapped = holders.slice(0, Math.min(limit, 100)).map((h) => {
    const tags = (h.tags || []).map((t) => t.name || t.id || t);
    const isPool = tags.some((t) => /pool|amm|liquidity|raydium|orca|meteora/i.test(t));
    const pct = totalSupply ? (Number(h.amount) / totalSupply) * 100 : (h.percentage ?? h.pct ?? null);
    return {
      address: h.address || h.wallet,
      amount: h.amount,
      pct: pct != null ? parseFloat(pct.toFixed(4)) : null,
      sol_balance: h.solBalanceDisplay ?? h.solBalance,
      tags: tags.length ? tags : undefined,
      is_pool: isPool || undefined,
      funding: h.addressInfo?.fundingAddress ? {
        address: h.addressInfo.fundingAddress,
        amount: h.addressInfo.fundingAmount,
        slot: h.addressInfo.fundingSlot,
      } : undefined,
    };
  });

  const realHolders = mapped.filter((h) => !h.is_pool);
  const top10Pct = realHolders.slice(0, 10).reduce((s, h) => s + (Number(h.pct) || 0), 0);

  // ─── Bundle / Cluster Analysis (OKX) ─────────────────────────
  let advancedData = null;
  let clusterList  = [];
  if (process.env.OKX_API_KEY) {
    const { getAdvancedInfo, getClusterList } = await import("./okx.js");
    [advancedData, clusterList] = await Promise.all([
      getAdvancedInfo(mint).catch(() => null),
      getClusterList(mint).catch(() => []),
    ]);
  }

  // ─── Smart Wallet / KOL Cross-reference ──────────────────────
  // Use targeted holders endpoint — only returns matching wallets, no noise
  const { listSmartWallets } = await import("../smart-wallets.js");
  const { wallets: smartWallets } = listSmartWallets();
  let smartWalletsHolding = [];

  if (smartWallets.length > 0) {
    const addresses = smartWallets.map((w) => w.address).join(",");
    const kwRes = await fetch(
      `${DATAPI_BASE}/holders/${mint}?addresses=${addresses}`
    ).catch(() => null);
    const kwData = kwRes?.ok ? await kwRes.json() : null;
    const kwHolders = Array.isArray(kwData) ? kwData : (kwData?.holders || kwData?.data || []);

    const smartWalletMap = new Map(smartWallets.map((w) => [w.address, w]));
    const matchedHolders = kwHolders
      .map((h) => ({ ...h, addr: h.address || h.wallet }))
      .filter((h) => smartWalletMap.has(h.addr));

    await Promise.all(matchedHolders.map(async (h) => {
      const wallet = smartWalletMap.get(h.addr);
      const pct = totalSupply ? parseFloat(((Number(h.amount) / totalSupply) * 100).toFixed(4)) : null;

      let pnl = null;
      try {
        const pnlRes = await fetch(`${DATAPI_BASE}/pnl-positions?address=${h.addr}&assetId=${mint}`);
        if (pnlRes.ok) {
          const pnlData = await pnlRes.json();
          const pos = pnlData?.[h.addr]?.tokenPositions?.[0];
          if (pos) pnl = {
            balance: pos.balance,
            balance_usd: pos.balanceValue,
            avg_cost: pos.averageCost,
            realized_pnl: pos.realizedPnl,
            unrealized_pnl: pos.unrealizedPnl,
            total_pnl: pos.totalPnl,
            total_pnl_pct: pos.totalPnlPercentage,
            buys: pos.totalBuys,
            sells: pos.totalSells,
            wins: pos.totalWins,
            bought_value: pos.boughtValue,
            sold_value: pos.soldValue,
            first_active: pos.firstActiveTime,
            last_active: pos.lastActiveTime,
            holding_days: pos.holdingPeriodInSeconds ? Math.round(pos.holdingPeriodInSeconds / 86400) : null,
          };
        }
      } catch { /* ignore */ }

      smartWalletsHolding.push({
        name: wallet.name,
        category: wallet.category,
        address: h.addr,
        pct,
        sol_balance: h.solBalanceDisplay ?? h.solBalance,
        pnl,
      });
    }));
  }

  return {
    mint,
    global_fees_sol: tokenInfo?.fees != null ? parseFloat(tokenInfo.fees.toFixed(2)) : null,
    total_fetched: holders.length,
    showing: mapped.length,
    top_10_real_holders_pct: top10Pct.toFixed(2),
    // OKX advanced info
    risk_level:     advancedData?.risk_level     ?? null,  // 1=low..5=high
    bundle_pct:     advancedData?.bundle_pct     ?? null,
    sniper_pct:     advancedData?.sniper_pct     ?? null,
    suspicious_pct: advancedData?.suspicious_pct ?? null,
    new_wallet_pct: advancedData?.new_wallet_pct ?? null,  // high = rug signal
    smart_wallets_holding: smartWalletsHolding,
    holders: mapped,
  };
}
