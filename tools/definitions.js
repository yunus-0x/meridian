export const tools = [
  // ═══════════════════════════════════════════
  //  SCREENING TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "discover_pools",
      description: `Fetch top DLMM pools from the Meteora Pool Discovery API.
Pools are pre-filtered for safety:
- No critical warnings on base/quote tokens
- No high single ownership on base token
- Base token market cap >= $150k
- Base token holders >= 100
- Volume >= $1k (in timeframe)
- Active TVL >= $10k
- Fee/Active TVL ratio >= 0.01 (in timeframe)
- Both tokens organic score >= 60

Returns condensed pool data: address, name, tokens, bin_step, fee_pct,
active_tvl, fee_window, volume_window, fee_tvl_ratio, volatility, organic_score,
holders, mcap, active_positions, price_change_pct, warning count.

Use this as the primary tool for finding new LP opportunities.`,
      parameters: {
        type: "object",
        properties: {
          page_size: {
            type: "number",
            description: "Number of pools to return. Default 50. Use 10-20 for quick scans."
          },
          timeframe: {
            type: "string",
            enum: ["1h", "4h", "12h", "24h"],
            description: "Timeframe for metrics. Use 24h for general screening, 1h for momentum."
          },
          category: {
            type: "string",
            enum: ["top", "new", "trending"],
            description: "Pool category. 'top' = highest fee/TVL, 'new' = recently created, 'trending' = gaining activity."
          }
        }
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_top_candidates",
      description: `Get the top pre-scored pool candidates ready for deployment.
All filtering, scoring, and rule-checking is done in code — no analysis needed.
Returns the top N eligible pools ranked by score (fee/TVL, organic, stability, volume).
Each pool includes a score (0-100) and has already passed all hard disqualifiers.
Use this instead of discover_pools for screening cycles. The active screening source is controlled by screeningSource:
- meteora: legacy Meteora pool-discovery flow
- gmgn: GMGN trending/security/holders/price-action first, then Meteora DLMM pool match.`,
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of top candidates to return. Default 3."
          }
        }
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_pool_detail",
      description: `Get detailed info for a specific DLMM pool by address.
Use this during management to check current pool health (volume, fees, organic score, price trend).
Default timeframe is 5m for real-time accuracy during position management.
Use a longer timeframe (1h, 4h) only when screening for new deployments.

IMPORTANT: Only call this with a real pool address from get_my_positions or get_top_candidates. Never guess or construct a pool address.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The on-chain pool address (base58 public key)"
          },
          timeframe: {
            type: "string",
            enum: ["5m", "15m", "30m", "1h", "2h", "4h", "12h", "24h"],
            description: "Data timeframe. Default 5m for management (most accurate). Use 4h+ for screening."
          }
        },
        required: ["pool_address"]
      }
    }
  },

  // ═══════════════════════════════════════════
  //  POSITION DEPLOYMENT TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "get_active_bin",
      description: `Get the current active bin and price for a DLMM pool.
This is an on-chain call via the SDK. Returns:
- binId: the current active bin number
- price: human-readable price (token X per token Y)
- pricePerLamport: raw price in lamports

Only call this if you need the current price to calculate a specific bin range (e.g. user requested a % range). Do NOT call before every deploy — deploy_position fetches the active bin internally.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The DLMM pool address"
          }
        },
        required: ["pool_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "deploy_position",
      description: `Open a new DLMM liquidity position.

PRIORITY ORDER for strategy and bins:
1. User explicitly specifies → always follow exactly (user override is absolute)
2. No user spec → use active strategy's lp_strategy and choose bins based on volatility

HARD RULES:
- Never use 'curve'.
- Bin Step: Only deploy in pools with bin_step between 80 and 125.
- For single-side SOL deploys (amount_y only, amount_x=0), do not request upside exposure:
  use bins_below only, keep bins_above=0, and the upper bin will be pinned to the current active bin.

Guidelines (only when user hasn't specified):
- Strategy: use the active strategy's lp_strategy field (bid_ask or spot)
- Bins: choose 35–69 for standard volatility; up to 350 for wide-range strategies. Max 1400 total.
- Deposit: Can be single-sided (SOL only or Base only) or dual-sided.

WARNING: This executes a real on-chain transaction. Check DRY_RUN mode.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The DLMM pool address to LP in"
          },
          amount_y: {
            type: "number",
            description: "Amount of quote token (usually SOL) to deposit."
          },
          amount_x: {
            type: "number",
            description: "Amount of base token to deposit (if doing dual-sided)."
          },
          amount_sol: {
            type: "number",
            description: "Alias for amount_y. For backward compatibility."
          },
          strategy: {
            type: "string",
            enum: ["bid_ask", "spot"],
            description: "DLMM strategy type. If user specifies, use exactly what they said. Otherwise use the active strategy's lp_strategy field."
          },
          bins_below: {
            type: "number",
            description: "Number of bins below the current active bin. For single-side SOL deploys, this is the main range input: lower bin = active bin - bins_below, upper bin = active bin."
          },
          bins_above: {
            type: "number",
            description: "Number of bins above the current active bin. Keep this at 0 for single-side SOL deploys. Only use this for dual-sided or explicit upside-exposure deploys."
          },
          downside_pct: {
            type: "number",
            description: "Optional human-friendly downside range in percent below the current active price. Converted to bins internally via the Meteora SDK."
          },
          upside_pct: {
            type: "number",
            description: "Optional human-friendly upside range in percent above the current active price. Do not use this for single-side SOL deploys."
          },
          pool_name: { type: "string", description: "Human-readable pool name for record-keeping" },
          base_mint: { type: "string", description: "Base token mint address — used to prevent duplicate token exposure across pools" },
          bin_step: { type: "number", description: "Pool bin step (from discover_pools)" },
          base_fee: { type: "number", description: "Pool base fee percentage (from discover_pools)" },
          volatility: { type: "number", description: "Pool volatility at deploy time" },
          fee_tvl_ratio: { type: "number", description: "fee/TVL ratio at deploy time" },
          organic_score: { type: "number", description: "Base token organic score at deploy time" },
          initial_value_usd: { type: "number", description: "Estimated USD value being deployed" },
          entry_reason: { type: "string", description: "Full deploy report. Use this exact format (plain text, no markdown):\n\nMARKET\nFee/TVL: X%\nVolume: $X\nTVL: $X\nVolatility: X\nOrganic: X\nMcap: $X\nAge: Xh\n\nAUDIT\nTop10: X%\nBots: X%\nFees paid: X SOL\nSmart wallets: names or none\n\nRISK\nOKX: Risk level X, Bundle X%, Sniper X%, Rugpull YES/NO, Wash YES/NO\n\nWHY THIS WON\n3-5 sentences referencing specific thresholds cleared, standout metrics, pool memory, and primary risk." }
        },
        required: ["pool_address"]
      }
    }
  },

  // ═══════════════════════════════════════════
  //  POSITION MANAGEMENT TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "get_position_pnl",
      description: `Get detailed PnL and real-time Fee/TVL metrics for an open position.
Use this during management to check if yield has dropped significantly.
Returns current feePerTvl24h which indicates the current APY of the pool.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: { type: "string", description: "The pool address" },
          position_address: { type: "string", description: "The position public key" }
        },
        required: ["pool_address", "position_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_my_positions",
      description: `List all open DLMM positions for the agent wallet.
Returns positions grouped by pool, each with:
- position address
- pool address and token pair
- bin range (min/max bin IDs)
- whether currently in range
- unclaimed fees (in USD)
- total deposited value vs current value
- time since last rebalance

Use this at the start of every management cycle.`,
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },

  {
    type: "function",
    function: {
      name: "claim_fees",
      description: `Claim accumulated swap fees from a specific position.
Only call when unclaimed fees > $5 to justify transaction costs.
Returns the transaction hash and amounts claimed.

WARNING: This executes a real on-chain transaction.`,
      parameters: {
        type: "object",
        properties: {
          position_address: {
            type: "string",
            description: "The position public key to claim fees from"
          }
        },
        required: ["position_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "close_position",
      description: `Remove all liquidity and close a position.
This withdraws all tokens back to the wallet and closes the position account.
Use when:
- Position has been out of range for > 30 minutes
- IL exceeds accumulated fees
- Token shows danger signals (organic score drop, volume crash)
- Rebalancing (close old + open new)

WARNING: This executes a real on-chain transaction. Cannot be undone.`,
      parameters: {
        type: "object",
        properties: {
          position_address: {
            type: "string",
            description: "The position public key to close"
          },
          skip_swap: {
            type: "boolean",
            description: "Set to true if user explicitly wants to hold/keep the base token after closing. Default: false (auto-swaps base token back to SOL)."
          },
          reason: {
            type: "string",
            description: "Why this position is being closed. Write a descriptive 1-2 sentence explanation: which rule triggered it, the specific values (e.g. 'OOR for 32m, limit is 30m'), and any additional context like token conditions. This text appears directly in the Telegram close notification."
          }
        },
        required: ["position_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_wallet_positions",
      description: `Get all open DLMM positions for any Solana wallet address.
Use this when the user asks about another wallet's positions, wants to monitor a wallet,
or wants to copy/compare positions.

Returns the same structure as get_my_positions but for the given wallet:
position address, pool, bin range, in-range status, unclaimed fees, PnL, age.`,
      parameters: {
        type: "object",
        properties: {
          wallet_address: {
            type: "string",
            description: "The Solana wallet address (base58 public key) to check"
          }
        },
        required: ["wallet_address"]
      }
    }
  },

  // ═══════════════════════════════════════════
  //  WALLET TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "get_wallet_balance",
      description: `Get current wallet balances for SOL, USDC, and all other token holdings.
Returns:
- SOL balance (native)
- USDC balance
- Other SPL token balances with USD values
- Total portfolio value in USD

Use to check available capital before deploying positions.`,
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },

  {
    type: "function",
    function: {
      name: "swap_token",
      description: `Swap tokens via Jupiter aggregator.
Use when you need to rebalance wallet holdings, e.g.:
- Convert claimed fee tokens back to SOL/USDC
- Prepare token pair before deploying a position

WARNING: This executes a real on-chain transaction.`,
      parameters: {
        type: "object",
        properties: {
          input_mint: {
            type: "string",
            description: "Mint address of the token to sell"
          },
          output_mint: {
            type: "string",
            description: "Mint address of the token to buy"
          },
          amount: {
            type: "number",
            description: "Amount of input token to swap (in human-readable units, not lamports)"
          },
        },
        required: ["input_mint", "output_mint", "amount"]
      }
    }
  },

  // ═══════════════════════════════════════════
  //  LEARNING TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "update_config",
      description: `Update any of your operating parameters at runtime.
Changes persist to user-config.json and take effect immediately — no restart needed.

VALID KEYS (use EXACTLY these key names, nothing else):
Screening: screeningSource, minFeeActiveTvlRatio, minTvl, maxTvl, minVolume, minOrganic, minQuoteOrganic, minHolders, minMcap, maxMcap, minBinStep, maxBinStep, timeframe, category, minTokenFeesSol, excludeHighSupplyConcentration, allowedLaunchpads, blockedLaunchpads
GMGN (persisted to gmgn-config.json): gmgnApiKey, gmgnBaseUrl, gmgnInterval, gmgnOrderBy, gmgnDirection, gmgnLimit, gmgnEnrichLimit, gmgnRequestDelayMs, gmgnMaxRetries, gmgnFilters, gmgnPlatforms, gmgnMinMcap, gmgnMaxMcap, gmgnMinVolume, gmgnMinHolders, gmgnMinTokenAgeHours, gmgnMaxTokenAgeHours, gmgnAthFilterPct, gmgnMaxBundlerRate, gmgnMaxFreshWalletRate, gmgnMaxDevTeamHoldRate, gmgnPreferredKolNames, gmgnPreferredKolMinHoldPct, gmgnRequireKol, gmgnMinKolCount, gmgnMinSmartDegenCount, gmgnMinTotalFeeSol
Management: minClaimAmount, outOfRangeBinsToClose, outOfRangeWaitMinutes, oorCooldownTriggerCount, oorCooldownHours, repeatDeployCooldownEnabled, repeatDeployCooldownTriggerCount, repeatDeployCooldownHours, repeatDeployCooldownScope, repeatDeployCooldownMinFeeEarnedPct, minVolumeToRebalance, stopLossPct, takeProfitPct, minSolToOpen, deployAmountSol, gasReserve, positionSizePct
Risk: maxPositions, maxDeployAmount
Schedule: managementIntervalMin, screeningIntervalMin
Models: managementModel, screeningModel, generalModel, claudeModel
Strategy: strategy, minBinsBelow, maxBinsBelow

Reason is optional but helpful — logged as a lesson when provided.`,
      parameters: {
        type: "object",
        properties: {
          changes: {
            type: "object",
            description: "Key-value pairs of settings to update. e.g. { \"takeProfitPct\": 8 }"
          },
          reason: {
            type: "string",
            description: "Why you are making this change — what you observed that justified it"
          }
        },
        required: ["changes"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "self_update",
      description: `Pull the latest code from git and restart the agent.
Use when the user says "update", "pull latest", "update yourself", etc.
Responds with what changed before restarting in 3 seconds.`,
      parameters: { type: "object", properties: {} }
    }
  },

  {
    type: "function",
    function: {
      name: "get_recent_decisions",
      description: `Get the recent structured decision log for deployments, closes, skips, and no-deploy outcomes.
Use this when the user asks explanatory questions like:
- why did you deploy that position?
- why did you close that pool?
- why didn't you deploy anything?

This is the preferred tool for answering "why did you..." questions because it returns the agent's recorded reasoning without requiring unrelated live trading actions.`,
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "How many recent decisions to return. Default 6."
          }
        }
      }
    }
  },

  // ═══════════════════════════════════════════
  //  SMART WALLET TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "add_smart_wallet",
      description: `Add a wallet to the smart wallet tracker.
Use when the user says "add smart wallet", "track this wallet", "add to smart wallets", etc.
- type "lp": wallet is tracked for LP positions (checked before deploying). Use for LPers/whales.
- type "holder": wallet is only checked for token holdings (never fetches positions). Use for KOLs/traders who don't LP.`,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Label for this wallet (e.g. 'alpha-1', 'whale-sol')" },
          address: { type: "string", description: "Solana wallet address (base58)" },
          category: { type: "string", enum: ["alpha", "smart", "fast", "multi"], description: "Wallet category (default: alpha)" },
          type: { type: "string", enum: ["lp", "holder"], description: "lp = tracks LP positions, holder = tracks token holdings only (default: lp)" }
        },
        required: ["name", "address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "remove_smart_wallet",
      description: "Remove a wallet from the smart wallet tracker.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "Wallet address to remove" }
        },
        required: ["address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "list_smart_wallets",
      description: "List all currently tracked smart wallets.",
      parameters: { type: "object", properties: {} }
    }
  },

  {
    type: "function",
    function: {
      name: "check_smart_wallets_on_pool",
      description: `Check if any tracked smart wallets have an active position in a given pool.
Use this before deploying to gauge confidence — if smart wallets are in the pool it's a strong signal.
If no smart wallets are present, rely on fundamentals (fees, volume, organic score) as usual.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: { type: "string", description: "Pool address to check" }
        },
        required: ["pool_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_token_info",
      description: `Get token data from Jupiter (organic score, holders, audit, price stats, mcap).
Use this to research a token before deploying or when the user asks about a token.
Accepts token name, symbol, or mint address as query.

Returns: organic score, holder count, mcap, liquidity, audit flags (mint/freeze disabled, bot holders %), 1h and 24h stats.`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Token name, symbol, or mint address" }
        },
        required: ["query"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_token_holders",
      description: `Get holder distribution for a token by mint address.
Fetches top 100 holders — use limit to control how many to display (default 20).
Each holder includes: address, amount, % of supply, SOL balance, tags (Pool/AMM/etc), and funding info (who funded this wallet, amount, slot).
is_pool=true means it's a liquidity pool address, not a real holder — filter these out when analyzing concentration.

Also returns global_fees_sol — total priority/jito tips paid by ALL traders on this token (NOT Meteora LP fees).
This is a key signal: low global_fees_sol means transactions are bundled or the token is a scam.
HARD GATE: if global_fees_sol < config.screening.minTokenFeesSol (default 30), do NOT deploy.

NOTE: Requires mint address. If you only have a symbol/name, call get_token_info first to resolve the mint.`,
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string", description: "Token mint address (base58). Use get_token_info first if you only have a symbol." },
          limit: { type: "number", description: "How many holders to return (default 20, max 100)" }
        },
        required: ["mint"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_token_narrative",
      description: `Get the narrative or story behind a token from Jupiter ChainInsight.
Returns a plain-text description of what the token is about — its origin, theme, community, and activity.
Use during token evaluation to understand if there is a real catalyst driving attention and volume.

GOOD narrative signals (proceed with more confidence):
- Specific origin story: tied to a real-world event, viral moment, person, animal, place, or cultural reference
- Active community: mentions contests, donations, real-world actions, organized activities
- Trending catalyst: references something currently viral on X/CT (KOL call, news event, meme wave)
- Named entities: real identifiable subjects (a specific animal, person, project, game, etc.)

BAD narrative signals (caution or skip):
- Empty or null — no story at all
- Pure hype/financial language only: "next 100x", "to the moon", "fair launch gem" with no substance
- Completely generic: "community-driven token", "meme coin" with zero specific context
- Copy-paste of another token's narrative`,
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string", description: "Token mint address (base58)" }
        },
        required: ["mint"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "search_pools",
      description: `Search for DLMM pools by token symbol, ticker, or contract address (CA).
Use this when the user asks to deploy into a specific token or pool by name/CA,
or when you want to find pools for a specific token outside of the normal screening flow.

Examples: "find pools for ROSIE", "search BONK pools", "look up pool for CA abc123..."

Returns pool address, name, bin_step, fee %, TVL, volume, and token mints.`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Token symbol, ticker name, or contract address to search for"
          },
          limit: {
            type: "number",
            description: "Max results to return (default 10)"
          }
        },
        required: ["query"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_top_lpers",
      description: `Get the top open LPers for a pool by address — quick read-only lookup.
Use this when the user asks "who are the top LPers in this pool?" or wants to
know how others are performing in a specific pool without saving lessons.

Returns: aggregate LPAgent-backed top-LPer patterns from the Agent Meridian
\`/top-lp/:pool\` endpoint. Data is cached server-side and refreshed on a 30m cadence.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The pool address to look up top LPers for"
          },
          limit: {
            type: "number",
            description: "Number of top LPers to return. Default 5."
          }
        },
        required: ["pool_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "study_top_lpers",
      description: `Fetch and analyze top open LPers for a pool to learn from their behaviour.
Returns LPAgent-backed owner aggregates and historical style/range samples from
the Agent Meridian \`/study-top-lp/:pool\` endpoint.

Use this before deploying into a new pool to:
- See if top performers are scalpers (< 1h holds) or long-term holders.
- Match your strategy and range to what is actually working for others right now.
- Avoid pools where even the best open LPs are poorly placed or losing.

Server note: study data is cached and refreshed every 30 minutes.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "Pool address to study top LPers for"
          },
          limit: {
            type: "number",
            description: "Number of top LPers to study. Default 4."
          }
        },
        required: ["pool_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "clear_lessons",
      description: `Remove lessons from memory. Use when the user asks to erase lessons, or when lessons contain bad data (e.g. bug-caused -100% PnL records).

Modes:
- keyword: remove all lessons whose text contains the keyword (e.g. "-100%", "FAILED", "WhiteHouse")
- all: wipe every lesson
- performance: wipe all closed position performance records (the raw data lessons are derived from)`,
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["keyword", "all", "performance"],
            description: "What to clear"
          },
          keyword: {
            type: "string",
            description: "Required when mode=keyword. Case-insensitive substring match against lesson text."
          }
        },
        required: ["mode"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "set_position_note",
      description: `Save a persistent instruction for a position that ALL future management cycles will respect.
Use this immediately whenever the user gives a specific instruction about a position:
- "hold until 5% profit"
- "don't close before fees hit $10"
- "close if it goes out of range"
- "hold for at least 2 hours"

The instruction is stored in state.json and injected into every management cycle prompt.
Pass null or empty string to clear an existing instruction.`,
      parameters: {
        type: "object",
        properties: {
          position_address: {
            type: "string",
            description: "The position address to attach the instruction to"
          },
          instruction: {
            type: "string",
            description: "The instruction to persist (e.g. 'hold until PnL >= 5%'). Pass empty string to clear."
          }
        },
        required: ["position_address", "instruction"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "add_lesson",
      description: `Save a lesson to the agent's permanent memory.
Use after studying top LPers or observing a pattern worth remembering.
Lessons are injected into the system prompt on every future cycle.
Write concrete, actionable rules — not vague observations.

Use 'role' to target a specific agent type so it only appears in the right context.
Use 'pinned: true' for critical rules that must always be present regardless of memory cap.

Examples:
- rule: "PREFER: pools where top LPers hold < 30 min", tags: ["scalping"], role: "SCREENER"
- rule: "AVOID: closing when OOR < 30min — price often recovers", tags: ["oor"], role: "MANAGER", pinned: true`,
      parameters: {
        type: "object",
        properties: {
          rule: {
            type: "string",
            description: "The lesson rule — specific and actionable"
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags e.g. ['narrative', 'screening', 'oor', 'fees', 'management']"
          },
          role: {
            type: "string",
            enum: ["SCREENER", "MANAGER", "GENERAL"],
            description: "Which agent role this lesson applies to. Omit for all roles."
          },
          pinned: {
            type: "boolean",
            description: "Pin this lesson so it's always injected regardless of memory cap. Use for critical rules."
          }
        },
        required: ["rule"]
      }
    }
  },

  // ─── Strategy Library ──────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "add_strategy",
      description: `Save a new LP strategy to the strategy library.
Use when the user pastes a tweet or description of a strategy.
Parse the text and extract structured criteria, then call this tool to store it.
The strategy will be available for selection before future deployments.`,
      parameters: {
        type: "object",
        properties: {
          id:           { type: "string", description: "Short slug e.g. 'overnight_classic_bid_ask', 'panda_strat'" },
          name:         { type: "string", description: "Human-readable name" },
          author:       { type: "string", description: "Strategy author/creator" },
          lp_strategy:  { type: "string", enum: ["bid_ask", "spot", "curve"], description: "LP strategy type" },
          token_criteria: {
            type: "object",
            description: "Token selection criteria",
            properties: {
              min_mcap:      { type: "number", description: "Minimum market cap in USD" },
              min_age_days:  { type: "number", description: "Minimum token age in days" },
              requires_kol:  { type: "boolean", description: "Requires KOL presence" },
              notes:         { type: "string", description: "Additional token selection notes" }
            }
          },
          entry: {
            type: "object",
            description: "Entry conditions",
            properties: {
              condition:                    { type: "string", description: "Entry condition description" },
              price_change_threshold_pct:   { type: "number", description: "Price change % that triggers entry (e.g. -30 for -30% from ATH)" },
              single_side:                  { type: "string", description: "sol or token" }
            }
          },
          range: {
            type: "object",
            description: "Bin range configuration",
            properties: {
              type:           { type: "string", enum: ["tight", "default", "wide", "panda"], description: "Range type (tight 10-30%, default 40-57%, wide 60%+, panda 85-90%)" },
              bins_below_pct: { type: "number", description: "How far below entry price the range covers (%)" },
              notes:          { type: "string" }
            }
          },
          exit: {
            type: "object",
            properties: {
              take_profit_pct: { type: "number", description: "Take profit threshold %" },
              notes:           { type: "string" }
            }
          },
          best_for: { type: "string", description: "Short description of ideal market conditions for this strategy" },
          raw:      { type: "string", description: "Original tweet or text the strategy was parsed from" }
        },
        required: ["id", "name"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "list_strategies",
      description: "List all saved strategies in the library with a summary of each. Shows which one is currently active.",
      parameters: { type: "object", properties: {} }
    }
  },

  {
    type: "function",
    function: {
      name: "get_strategy",
      description: "Get full details of a specific strategy including all criteria, range settings, and original raw text.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Strategy ID from list_strategies" }
        },
        required: ["id"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "set_active_strategy",
      description: `Set which strategy to use for the next screening/deployment cycle.
The active strategy's token criteria, entry conditions, range, and exit rules will be applied.
Call list_strategies first to see available options.`,
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Strategy ID to activate" }
        },
        required: ["id"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "remove_strategy",
      description: "Remove a strategy from the library.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Strategy ID to remove" }
        },
        required: ["id"]
      }
    }
  },

  // ─── Lesson Management ─────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "list_lessons",
      description: `Browse saved lessons with optional filters.
Use to find a lesson ID before pinning/unpinning, or to audit what the agent currently knows.`,
      parameters: {
        type: "object",
        properties: {
          role:   { type: "string", enum: ["SCREENER", "MANAGER", "GENERAL"], description: "Filter by role" },
          pinned: { type: "boolean", description: "Filter to only pinned (true) or unpinned (false) lessons" },
          tag:    { type: "string", description: "Filter by a specific tag" },
          limit:  { type: "number", description: "Max lessons to return (default 30)" }
        }
      }
    }
  },

  {
    type: "function",
    function: {
      name: "pin_lesson",
      description: `Pin a lesson by ID so it's always injected into the prompt regardless of memory cap.
Use for critical rules that must never be forgotten — e.g. narrative criteria, hard risk rules.
Call list_lessons first to find the lesson ID.`,
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "Lesson ID (from list_lessons)" }
        },
        required: ["id"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "unpin_lesson",
      description: "Unpin a previously pinned lesson. It will re-enter the normal rotation.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "Lesson ID to unpin" }
        },
        required: ["id"]
      }
    }
  },

  // ─── Performance History ────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "get_performance_history",
      description: `Retrieve closed position records filtered by time window.
Use when the user asks about recent performance, last 24h positions, how you've been doing, P&L history, etc.
Returns individual closed positions with PnL, fees, strategy, hold time, and close reason.`,
      parameters: {
        type: "object",
        properties: {
          hours: {
            type: "number",
            description: "How many hours back to look (default 24). Use 168 for last 7 days."
          },
          limit: {
            type: "number",
            description: "Max records to return (default 50)"
          }
        }
      }
    }
  },

  // ─── Pool Memory ────────────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "get_pool_memory",
      description: `Check deploy history for a pool before deploying. Returns past deploys, PnL, win rate, and notes.

IMPORTANT: pool_address must be a plain base58 string with no extra fields, quotes, or nesting.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "Pool address as a plain base58 string, e.g. \"AbCd1234...\""
          }
        },
        required: ["pool_address"],
        additionalProperties: false
      }
    }
  },

  {
    type: "function",
    function: {
      name: "add_pool_note",
      description: `Annotate a pool with a freeform note that persists across sessions.
Use when you observe something worth remembering about a specific pool:
- "volume dried up after 2h — avoid during off-hours"
- "consistently good during Asian session"
- "rugged base token — monitor closely"`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "Pool address to annotate"
          },
          note: {
            type: "string",
            description: "The note to save"
          }
        },
        required: ["pool_address", "note"]
      }
    }
  },

  // ─── Token Blacklist ────────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "add_to_blacklist",
      description: `Permanently blacklist a base token mint so it's never deployed into again.
Use when a token rugs, shows wash trading, or is otherwise unsafe.
Blacklisted tokens are filtered BEFORE the LLM even sees pool candidates.`,
      parameters: {
        type: "object",
        properties: {
          mint: {
            type: "string",
            description: "The base token mint address to blacklist"
          },
          symbol: {
            type: "string",
            description: "Token symbol (for readability)"
          },
          reason: {
            type: "string",
            description: "Why this token is being blacklisted"
          }
        },
        required: ["mint", "reason"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "remove_from_blacklist",
      description: "Remove a token mint from the blacklist (e.g. if it was added by mistake).",
      parameters: {
        type: "object",
        properties: {
          mint: {
            type: "string",
            description: "The mint address to remove from the blacklist"
          }
        },
        required: ["mint"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "list_blacklist",
      description: "List all blacklisted token mints with their reasons and timestamps.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "block_deployer",
      description: "Block a deployer wallet address. Any token deployed by this wallet will be hard-filtered from screening before the LLM ever sees it.",
      parameters: {
        type: "object",
        properties: {
          wallet:  { type: "string", description: "Deployer wallet address (base58)" },
          label:   { type: "string", description: "Human-readable label (e.g. 'known rugger')" },
          reason:  { type: "string", description: "Why this deployer is being blocked" },
        },
        required: ["wallet"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "unblock_deployer",
      description: "Remove a deployer wallet from the blocklist.",
      parameters: {
        type: "object",
        properties: {
          wallet: { type: "string", description: "Deployer wallet address to unblock" },
        },
        required: ["wallet"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_blocked_deployers",
      description: "List all blocked deployer wallets.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
];
