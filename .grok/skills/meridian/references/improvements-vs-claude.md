# Improvements vs `.claude` skills

| Area | Claude (old) | Grok Meridian skills |
|------|----------------|----------------------|
| Deploy model | Two-sided ratios, SOL→token swaps, amount_x layers | Matches **live safety**: SOL-only, amount_x=0, bins_above=0 |
| Min bins | Allowed 20–40 “sweet spot” | Enforces **≥ 35** (`MIN_SAFE_BINS_BELOW`) |
| Exits | Simple OOR / −25% / +10% TP | Full stack: trailing dynamic drop, breakeven, fee decay, max hold, hard TP gated by trailing |
| Ranking | fee/TVL + OKX | fee/vol edge, degen score, pool memory, momentum, circuit breaker |
| Swaps | Free-form Jupiter | Allowlist token→SOL / SOL→stable |
| OKX/onchainos | Required in flow | **Optional** — skip if missing |
| Fast path | Manual multi-step only | Prefer `node cli.js screen` / `manage` engines |
| Secrets | Not emphasized | Explicit: never read `.env` |
| Format | Claude `!`cmd`` / agents yaml | Grok `SKILL.md` frontmatter + references |
| Hub | Scattered commands | `/meridian` router + shared references |

Claude command files under `.claude/commands` remain for Claude Code compatibility; Grok should prefer `.grok/skills/meridian-*`.
