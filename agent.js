import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "swap_token", "get_position_pnl", "get_my_positions", "get_wallet_balance"]);
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "get_wallet_balance", "get_my_positions"]);
const GENERAL_INTENT_ONLY_TOOLS = new Set([
  "self_update",
  "update_config",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  deploy:      new Set(["deploy_position", "get_top_candidates", "get_active_bin", "get_pool_memory", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_wallet_balance", "get_my_positions", "add_pool_note"]),
  close:       new Set(["close_position", "get_my_positions", "get_position_pnl", "get_wallet_balance", "swap_token"]),
  claim:       new Set(["claim_fees", "get_my_positions", "get_position_pnl", "get_wallet_balance"]),
  swap:        new Set(["swap_token", "get_wallet_balance"]),
  config:      new Set(["update_config"]),
  blocklist:   new Set(["add_to_blacklist", "remove_from_blacklist", "list_blacklist", "block_deployer", "unblock_deployer", "list_blocked_deployers"]),
  selfupdate:  new Set(["self_update"]),
  balance:     new Set(["get_wallet_balance", "get_my_positions", "get_wallet_positions"]),
  positions:   new Set(["get_my_positions", "get_position_pnl", "get_wallet_balance", "set_position_note", "get_wallet_positions"]),
  strategy:    new Set(["list_strategies", "get_strategy", "add_strategy", "remove_strategy", "set_active_strategy"]),
  screen:      new Set(["get_top_candidates", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "check_smart_wallets_on_pool", "get_pool_detail", "get_my_positions", "discover_pools"]),
  memory:      new Set(["get_pool_memory", "add_pool_note", "list_blacklist", "add_to_blacklist", "remove_from_blacklist"]),
  smartwallet: new Set(["add_smart_wallet", "remove_smart_wallet", "list_smart_wallets", "check_smart_wallets_on_pool"]),
  study:       new Set(["study_top_lpers", "get_top_lpers", "get_pool_detail", "search_pools", "get_token_info", "discover_pools", "add_smart_wallet", "list_smart_wallets"]),
  performance: new Set(["get_performance_history", "get_my_positions", "get_position_pnl"]),
  lessons:     new Set(["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"]),
};

const INTENT_PATTERNS = [
  { intent: "deploy",      re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
  { intent: "close",       re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
  { intent: "claim",       re: /\b(claim|harvest|collect)\b.*\bfee/i },
  { intent: "swap",        re: /\b(swap|convert|sell|exchange)\b/i },
  { intent: "selfupdate",  re: /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i },
  { intent: "blocklist",   re: /\b(blacklist|block|unblock|blocklist|blocked deployer|rugger|block dev|block deployer)\b/i },
  { intent: "config",      re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance",     re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "positions",   re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
  { intent: "strategy",    re: /\b(strategy|strategies)\b/i },
  { intent: "screen",      re: /\b(screen|candidate|find pool|search|research|token)\b/i },
  { intent: "memory",      re: /\b(memory|pool history|note|remember)\b/i },
  { intent: "smartwallet", re: /\b(smart wallet|kol|whale|watch.?list|add wallet|remove wallet|list wallet|tracked wallet|check pool|who.?s in|wallets in|add to (smart|watch|kol))\b/i },
  { intent: "study",       re: /\b(study top|top lpers?|best lpers?|who.?s lping|lp behavior|lpers?)\b/i },
  { intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
  { intent: "lessons",     re: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i },
];

function getToolsForRole(agentType, goal = "") {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));

  // GENERAL: match intent from goal, combine matched tool sets
  const matched = new Set();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(goal)) {
      for (const t of INTENT_TOOLS[intent]) matched.add(t);
    }
  }

  // Fall back to all tools if no intent matched
  if (matched.size === 0) return tools.filter(t => !GENERAL_INTENT_ONLY_TOOLS.has(t.function.name));
  return tools.filter(t => matched.has(t.function.name));
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";

// Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio)
// To use LM Studio: set LLM_BASE_URL=http://localhost:1234/v1 and LLM_API_KEY=lm-studio in .env
const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: 5 * 60 * 1000,
});

const DEFAULT_MODEL = process.env.LLM_MODEL || "openrouter/healer-alpha";

const TOOL_REQUIRED_INTENTS = /\b(deploy|open position|open|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|self.?update|pull latest|git pull|update yourself|config|setting|threshold|set |change|update |balance|wallet|position|portfolio|pnl|yield|range|screen|candidate|find pool|search|research|token|smart wallet|whale|watch.?list|tracked wallet|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|lesson|learned|teach|pin|unpin)\b/i;

function shouldRequireRealToolUse(goal, agentType, requireTool) {
  if (requireTool) return true;
  if (agentType === "MANAGER") return false;
  return TOOL_REQUIRED_INTENTS.test(goal);
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function isSystemRoleError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

function isToolChoiceRequiredError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /tool_choice/i.test(message) && /required/i.test(message);
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const { requireTool = false, interactive = false, onToolStart = null, onToolFinish = null } = options;
  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary);

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
  const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
  // These lock after first attempt regardless of success — retrying them is always wrong
  const NO_RETRY_TOOLS = new Set(["deploy_position"]);
  const firedOnce = new Set();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, requireTool);
  let sawToolCall = false;
  let noToolRetryCount = 0;

  let emptyStreak = 0;
  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || DEFAULT_MODEL;

      // Retry up to 3 times on transient provider errors (502, 503, 529)
      const FALLBACK_MODEL = "stepfun/step-3.5-flash:free";
      let response;
      let usedModel = activeModel;
      // Force a tool call on step 0 for action intents — prevents the model from inventing deploy/close outcomes
      const ACTION_INTENTS = /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      let toolChoice = (step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) ? "required" : "auto";

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await client.chat.completions.create({
            model: usedModel,
            messages,
            tools: getToolsForRole(agentType, goal),
            tool_choice: toolChoice,
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          });
        } catch (error) {
          if (providerMode === "system" && isSystemRoleError(error)) {
            providerMode = "user_embedded";
            messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
            log("agent", "Provider rejected system role — retrying with embedded system instructions");
            attempt -= 1;
            continue;
          }
          if (toolChoice === "required" && isToolChoiceRequiredError(error)) {
            toolChoice = "auto";
            log("agent", "Provider rejected tool_choice=required — retrying with tool_choice=auto");
            attempt -= 1;
            continue;
          }
          throw error;
        }
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529) {
          const wait = (attempt + 1) * 5000;
          if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
            usedModel = FALLBACK_MODEL;
            log("agent", `Switching to fallback model ${FALLBACK_MODEL}`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
          }
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }
      const msg = response.choices[0].message;
      // Repair malformed tool call JSON before pushing to history —
      // the API rejects the next request if history contains invalid JSON args
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                log("error", `Could not repair JSON args for ${tc.function.name} — cleared to {}`);
              }
            }
          }
        }
      }
      messages.push(msg);

      // If the model didn't call any tools, it's done — unless it wrote tool calls as text
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes sometimes returns null content — pop the empty message and retry once
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          log("agent", "Empty response, retrying...");
          continue;
        }

        // ─── Rescue text tool calls ──────────────────────────────
        // Some models (DeepSeek, local models, free-tier providers) output tool calls as
        // plain text (JSON blocks, <tool_call> tags, bare JSON) instead of using function
        // calling. Parse and execute them directly instead of losing the action.
        const rescued = rescueTextToolCalls(msg.content)
        if (rescued.length > 0) {
          log('agent', `RESCUED ${ rescued.length } tool call(s) from text output — executing directly`)
          sawToolCall = true
          const toolResults = []
          for (const { name, args } of rescued) {
            if (ONCE_PER_SESSION.has(name) && firedOnce.has(name)) {
              log('agent', `  Blocked duplicate rescued ${ name } — forcing session end`)
              return { content: `Session complete. ${ name } already executed this session.`, userMessage: goal }
            }
            if (name === 'close_position' && !args.position_address) continue
            if (name === 'deploy_position' && (!args.pool_address || !args.amount_y)) continue
            if (NO_RETRY_TOOLS.has(name)) firedOnce.add(name)
            await onToolStart?.({ name, args, step })
            log('agent', `  Executing rescued: ${ name }(${ JSON.stringify(args).slice(0, 100) })`)
            const result = await executeTool(name, args)
            await onToolFinish?.({ name, args, result, success: result?.success === true, step })
            if (ONCE_PER_SESSION.has(name) && !NO_RETRY_TOOLS.has(name) && result.success === true) firedOnce.add(name)
            toolResults.push({
              role: 'tool',
              tool_call_id: `rescued-${ name }-${ Date.now() }`,
              content: JSON.stringify(result),
            })
          }
          const executedSummary = toolResults.map(r => {
            try {
              const d = JSON.parse(r.content)
              if (d.success) return `EXECUTED: ${ d.pool_name || d.position?.slice(0, 8) || 'action' } — success`
              if (d.blocked) return `BLOCKED: ${ d.reason }`
              return `RESULT: ${ r.content.slice(0, 100) }`
            } catch { return r.content.slice(0, 100) }
          }).join('\n')
          messages.push({
            role: providerMode === 'system' ? 'user' : 'user',
            content: `These actions were ALREADY EXECUTED (do not re-analyze or contradict):\n${ executedSummary }`,
          })
          continue
        }

        if (mustUseRealTool && !sawToolCall) {
          noToolRetryCount += 1;
          messages.pop();
          log("agent", `Rejected no-tool final answer (${noToolRetryCount}/2) for tool-required request`);
          if (noToolRetryCount >= 2) {
            return {
              content: "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
              userMessage: goal,
            };
          }
          messages.push({
            role: providerMode === "system" ? "system" : "user",
            content: providerMode === "system"
              ? "You have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result."
              : "[SYSTEM REMINDER]\nYou have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.",
          });
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }
      sawToolCall = true;

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs;

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName}`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
            functionArgs = {};
          }
        }

        // Block once-per-session tools from firing a second time
        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result: { blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` },
            success: false,
            step,
          });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` }),
          };
        }

        await onToolStart?.({ name: functionName, args: functionArgs, step });
        const result = await executeTool(functionName, functionArgs);
        await onToolFinish?.({
          name: functionName,
          args: functionArgs,
          result,
          success: result?.success !== false && !result?.error && !result?.blocked,
          step,
        });

        // Lock deploy_position after first attempt regardless of outcome — retrying is never right
        // For close/swap: only lock on success so genuine failures can be retried
        if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse tool calls that the model wrote as text instead of using function calling.
 * Handles multiple formats that various models produce:
 *   1. <tool_call>{"name":"close_position","arguments":{"position_address":"..."}}</tool_call>
 *   2. tool_call_begin + function + tool_sep + close_position + json block
 *   3. ```json\n{"position_address":"..."}\n``` near a tool name mention
 *   4. Bare JSON objects with known parameter names near tool name keywords
 *   5. Bare {"pool_address":"..."} near "deploy_position" or "DEPLOY"
 *   6. OpenAI schema text dumps with tool names
 *   7. Last-resort base58 address near CLOSE keywords
 *
 * Returns array of { name, args } objects ready for executeTool().
 */
const KNOWN_TOOLS = new Set([
  'close_position', 'deploy_position', 'claim_fees', 'swap_token',
  'get_position_pnl', 'get_my_positions', 'get_top_candidates',
  'get_pool_detail', 'get_active_bin', 'update_config', 'get_wallet_balance',
])

function rescueTextToolCalls(text) {
  const results = []
  let match

  // Pattern 1: <tool_call>{"name":"...", "arguments":{...}}</tool_call>
  const xmlPattern = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g
  while ((match = xmlPattern.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      if (parsed.name && KNOWN_TOOLS.has(parsed.name)) {
        results.push({ name: parsed.name, args: parsed.arguments || parsed.params || {} })
      }
    } catch { /* skip malformed */ }
  }
  if (results.length > 0) return results

  // Pattern 2: tool_call_begin + function + tool_sep + tool_name + json
  const meridianPattern = /tool_call_begin[^]*?function[^]*?tool_sep\s*(\w+)\s*```?j?s?o?n?\s*(\{[\s\S]*?\})\s*```?/g
  while ((match = meridianPattern.exec(text)) !== null) {
    const name = match[1].trim()
    if (KNOWN_TOOLS.has(name)) {
      try { results.push({ name, args: JSON.parse(match[2]) }) } catch { /* skip */ }
    }
  }
  if (results.length > 0) return results

  // Pattern 3: ```json blocks near tool name mentions
  const jsonBlockPattern = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g
  const toolMentionPattern = new RegExp(`\\b(${ [...KNOWN_TOOLS].join('|') })\\b`)
  const blocks = []
  while ((match = jsonBlockPattern.exec(text)) !== null) {
    try { blocks.push({ json: JSON.parse(match[1]), pos: match.index }) }
    catch { /* skip */ }
  }
  for (const block of blocks) {
    const contextBefore = text.slice(Math.max(0, block.pos - 200), block.pos)
    const toolMatch = contextBefore.match(toolMentionPattern)
    if (toolMatch && KNOWN_TOOLS.has(toolMatch[1])) {
      results.push({ name: toolMatch[1], args: block.json })
    }
  }
  if (results.length > 0) return results

  // Pattern 4: Bare {"position_address":"..."} near "close_position" or "CLOSE"
  const bareJsonPattern = /\{[^{}]*"position_address"\s*:\s*"([A-Za-z0-9]{32,50})"[^{}]*\}/g
  while ((match = bareJsonPattern.exec(text)) !== null) {
    const context = text.slice(Math.max(0, match.index - 300), match.index + match[0].length + 100)
    if (/close_position|CLOSE/i.test(context)) {
      try { results.push({ name: 'close_position', args: JSON.parse(match[0]) }) } catch { /* skip */ }
    }
  }

  // Pattern 5: Bare {"pool_address":"..."} near "deploy_position" or "DEPLOY"
  const deployJsonPattern = /\{[^{}]*"pool_address"\s*:\s*"([A-Za-z0-9]{32,50})"[^{}]*\}/g
  while ((match = deployJsonPattern.exec(text)) !== null) {
    const context = text.slice(Math.max(0, match.index - 300), match.index + match[0].length + 100)
    if (/deploy_position|DEPLOY/i.test(context)) {
      try { results.push({ name: 'deploy_position', args: JSON.parse(match[0]) }) } catch { /* skip */ }
    }
  }

  // Pattern 6: OpenAI tool schema dumped as text
  const schemaPattern = /"name"\s*:\s*"(\w+)"[^]*?"parameters"/g
  while ((match = schemaPattern.exec(text)) !== null) {
    const toolName = match[1]
    if (!KNOWN_TOOLS.has(toolName)) continue
    if (toolName === 'close_position') {
      const addrMatch = text.match(/\| CLOSE[\s\S]{0,500}?\b([A-Za-z1-9]{32,50})\b/)
        || text.match(/\*\*CLOSE\*\*[\s\S]{0,500}?\b([A-Za-z1-9]{32,50})\b/)
        || text.match(/close_position[\s\S]{0,200}?"position_address"\s*:\s*"([A-Za-z0-9]{32,50})"/)
      if (addrMatch) results.push({ name: 'close_position', args: { position_address: addrMatch[1] } })
    }
  }

  // Pattern 7: Last resort — any Solana address near "| CLOSE" or "→ CLOSE"
  if (results.length === 0 && /\bCLOSE\b/.test(text)) {
    const closeBlocks = text.split(/\bCLOSE\b/)
    for (let i = 0; i < closeBlocks.length - 1; i++) {
      const before = closeBlocks[i].slice(-300)
      const addrMatch = before.match(/\b([A-HJ-NP-Za-km-z1-9]{32,50})\b/g)
      if (addrMatch) {
        const addr = addrMatch[addrMatch.length - 1]
        if (addr.length >= 32 && !/^[0-9]+$/.test(addr) && !/SOL|USD|PnL/i.test(addr)) {
          results.push({ name: 'close_position', args: { position_address: addr } })
        }
      }
    }
  }

  return results
}
