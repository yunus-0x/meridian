/**
 * Shared test fixtures for Meridian unit tests.
 * Matches the schemas of state.json, decision-log.json, lessons.json, user-config.json.
 */

export const samplePositionData = {
  address: "abc123def456ghi789",
  pool: "pool_address_xyz",
  pool_name: "SOL-USDC",
  base_mint: "mint_address_base",
  strategy: "spot",
  bin_range: { min: -100, max: 0, bins_below: 69, bins_above: 0 },
  bin_step: 100,
  volatility: 5.5,
  fee_tvl_ratio: 4.2,
  organic_score: 75,
  amount_sol: 0.5,
  deployed_at: new Date().toISOString(),
  instruction: null,
  out_of_range_since: null,
};

export const samplePositionWithInstruction = {
  ...samplePositionData,
  address: "pos_with_inst_001",
  instruction: "do not close this position",
};

export const sampleDecisionEntry = {
  id: "dec_1712345678901_abc123",
  ts: new Date().toISOString(),
  type: "deploy",
  actor: "SCREENER",
  pool: "pool_address_xyz",
  pool_name: "SOL-USDC",
  position: "pos_address_001",
  summary: "Deployed 0.5 SOL into SOL-USDC spot position",
  reason: "High fee/TVL ratio (4.2), strong organic score (75), good volatility",
  risks: ["Impermanent loss possible", "Low trading volume"],
  metrics: { fee_tvl_ratio: 4.2, organic_score: 75, volatility: 5.5 },
  rejected: ["Considered BONK-SOL but lower organic score"],
};

export const samplePerformanceRecordWin = {
  position: "pos_win_001",
  pool: "pool_win_pool",
  pool_name: "ASTEROID-SOL",
  base_mint: "mint_asteroid",
  strategy: "spot",
  bin_range: { min: -507, max: -438, bins_below: 69, bins_above: 0 },
  bin_step: 100,
  volatility: 5.5288,
  fee_tvl_ratio: 5.0399,
  organic_score: 84,
  amount_sol: 0.4,
  fees_earned_usd: 0.65,
  final_value_usd: 38.57,
  initial_value_usd: 38.64,
  minutes_in_range: 22,
  minutes_held: 22,
  close_reason: "take profit: good return",
  pnl_usd: 0.57,
  pnl_pct: 1.46,
  range_efficiency: 100,
  recorded_at: new Date().toISOString(),
};

export const samplePerformanceRecordLoss = {
  position: "pos_loss_001",
  pool: "pool_loss_pool",
  pool_name: "RKC-SOL",
  base_mint: "mint_rkc",
  strategy: "spot",
  bin_range: { min: -448, max: -379, bins_below: 69, bins_above: 0 },
  bin_step: 100,
  volatility: 7.3485,
  fee_tvl_ratio: 6.5812,
  organic_score: 75,
  amount_sol: 0.4,
  fees_earned_usd: 0,
  final_value_usd: 35.12,
  initial_value_usd: 38.89,
  minutes_in_range: 13,
  minutes_held: 13,
  close_reason: "stop loss: PnL -3.22% <= -3%",
  pnl_usd: -3.78,
  pnl_pct: -9.71,
  range_efficiency: 100,
  recorded_at: new Date().toISOString(),
};

export const samplePerformanceHistory = [
  samplePerformanceRecordWin,
  samplePerformanceRecordLoss,
  {
    ...samplePerformanceRecordLoss,
    position: "pos_loss_002",
    pnl_usd: -0.8,
    pnl_pct: -2.04,
    fees_earned_usd: 0.54,
    close_reason: "Stop loss triggered: PnL -3.47% <= -3% threshold",
  },
  {
    ...samplePerformanceRecordWin,
    position: "pos_win_002",
    pnl_usd: 0.33,
    pnl_pct: 0.86,
    fees_earned_usd: 0.46,
    close_reason: "Out of range",
    range_efficiency: 75,
  },
  {
    ...samplePerformanceRecordWin,
    position: "pos_win_003",
    pnl_usd: 0.06,
    pnl_pct: 0.16,
    fees_earned_usd: 0.07,
    close_reason: "User requested close",
  },
];

export const sampleLesson = {
  id: 1712345678000,
  rule: "PREFER: high fee_tvl_ratio pools with strategy=spot",
  tags: ["efficient", "spot"],
  outcome: "good",
  sourceType: "performance",
  confidence: 0.85,
  created_at: new Date().toISOString(),
};

export const sampleUserConfig = {
  preset: "degen",
  deployAmountSol: 2,
  maxDeployAmount: 50,
  managementIntervalMin: 10,
  screeningIntervalMin: 30,
  minFeeActiveTvlRatio: 0.14,
  minTvl: 10000,
  maxTvl: 150000,
  minVolume: 500,
  minOrganic: 60,
  minHolders: 500,
  minMcap: 150000,
  maxMcap: 10000000,
  minBinStep: 80,
  maxBinStep: 125,
  minBundlersPct: 30,
  maxTop10Pct: 60,
  outOfRangeWaitMinutes: 30,
  stopLossPct: -15,
  gasReserve: 0.2,
  minSolToOpen: 0.55,
  managementModel: "openai/gpt-oss-20b:free",
  screeningModel: "openai/gpt-oss-20b:free",
  generalModel: "openai/gpt-oss-20b:free",
};

export const sampleState = {
  positions: {},
  recentEvents: [],
  lastUpdated: null,
};

export const sampleEmptyDecisionLog = { decisions: [] };

export const sampleEmptyLessons = { lessons: [], performance: [] };
