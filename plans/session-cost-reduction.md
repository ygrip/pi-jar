# Session cost reduction (from a $6.61 fan-fighter session)

## Context

Session `01a101ba-49ea-7615-8fc4-5555b4893a0d` (fan-fighter, gpt-6.1-sol, 2026-10-03) cost **$6.61** for 8 user prompts.
Analysis of the session JSONL:

| Metric | Value |
|---|---|
| Model calls | 309 (275 of them had exactly **one** tool call) |
| Cost split | cache read **$3.81 (≈60%)**, output $1.30 (81k reasoning), uncached input $1.23 |
| Avg context per call | ~126k tokens; grew 17k → **258k** before the only compaction |
| Calls at >125k context | ~110 calls ≈ **$3.9** of $6.2 |
| Fixed baseline at turn 1 | 17.5k tokens (≈27k-char system prompt + ~80 tool schemas) |
| `read` | 109 calls, 450 KB returned; `cloud/src/pvp.ts` ×12, `/tmp/…-plan.md` ×7, 17 reads with no `limit` |
| `jar_shell` | 33 start + 22 output + 8 wait + 1 peek + 1 kill ≈ 65 calls, mostly short finite jobs |
| Subagent overhead | 8 `jar_delegate`, 18 `jar_subagent`, 27 `jar_discuss`, 19 events (36 KB) ≈ 70 parent calls |
| Cache misses | 11 calls with large uncached input = $0.50 (idle gaps 13:42 / 14:08 / 14:46, post-compaction) |
| Scope | One session did: implement PR #18 + bump 0.6.0, Turnstile setup Q&A, new quota guardrail feature, commit/push/tag |

**Root cause:** long, serial sessions in which each call re-sends a growing context. Compaction only fires near the
window limit (`reserveTokens: 16384`). pi-jar adds to this in three ways: too many moderation round-trips,
`jar_shell` used for short commands, and a large fixed prompt and tool surface.

Target: the same workload for **≤ $3**, with no loss of work quality.

## Approach

### 1. Context-budget guard (pi-jar, highest impact)
- Add a `contextBudget` setting to `pi-jar-settings.json` (default `{ softTokens: 120000, action: "suggest" }`).
- On `turn_end`, read the last assistant `usage` (`input + cacheRead`). When it exceeds `softTokens`:
  - `suggest`: footer chip turns amber and shows a one-time notice: "context 130k — `/compact` or `/new` for next task".
  - `compact`: call Pi's compaction at the next safe point, i.e. after a `jar_todo` item completes. Reuse the
    `update_plan` safe-point idea from SoL-Pi so the in-flight tool chain isn't cut.
- In the footer, show **average cost per call over the last 10 calls** next to total cost, so the growth is visible.
- Detect a topic switch (a new user prompt after all `jar_todo` items completed) and suggest `/new` with a carried-over
  summary instead of continuing in the same session.

### 2. Moderator overhead (pi-jar delegate / discussion)
- Default `maxSubagents` 4 → **2** in the default profile; keep 4 in an opt-in "swarm" profile.
- Add a delegation guard in the `jar_delegate` prompt and rules: delegate only when there are ≥2 independent chunks that
  each need ≥10 tool calls; otherwise the parent does the work itself.
- Coalesce subagent completion events. Today the 19 events average ~1.9 KB each. Instead, inject a ≤400-char summary plus
  changed-files list, with the full report available through `jar_subagent report`, and only on request.
- Cap `jar_discuss` chatter: batch unread items into a single message per parent turn, and drop broadcast echoes.
- Default the subagent / scout role to a cheaper model in `pi-jar-roles.json` (mini / haiku class). Warn in `/jar roles`
  when the scout or reviewer role uses the same premium model as the main model.

### 3. Shell usage (pi-jar shells)
- Update the rules text: use `bash` for finite commands expected to finish in under ~2 minutes (build, test, git). Use
  `jar_shell` only for services or long jobs.
- Add `jar_shell start` with `waitMs` (≤30 s), so a short job returns its exit code and tail in **one** call
  instead of start → output → wait.
- `output` returns only new lines since the last read by default, not the full trailing 40 lines again.

### 4. Read hygiene (pi-jar compact-tools / context-diet)
- In `compact-tools.ts`, track `(path, mtime, range)` for each read in the session. If the same unchanged range is read again,
  return a short stub ("unchanged since read #N, 312 lines; pass `force: true` to re-read") instead of the content.
- Auto-apply `limit: 400` for files over 50 KB when no limit is given, and say so in the result.
- Add a rule line saying to keep plans in `jar_todo` / `update_plan` instead of `/tmp/*.md`, which was re-read 7×.
- Investigate extending `context-diet.ts` (opt-in): when a later read or edit of the same file supersedes an older
  `read` result from a completed user turn, replace the older result with a stub. Use the same provider-safety rules as `trimCompletedThinking`.

### 5. Fixed prompt and tool surface
- Measure what pi-jar contributes to the turn-1 baseline (rules text + tool schemas) using `pi-token-burden`, and
  record it in `docs/EFFICIENCY_PLAN.md`.
- Shorten the pi-jar `<rules>` block (about 10 KB in this session). Move the detailed per-tool guidance into the tool descriptions,
  so only the tools that are active pay for it.
- Make `jar_council`, `jar_plan_submit` and `jar_goal` register only when their mode is active. (Check whether the
  Pi API supports this; otherwise shorten their descriptions.)
- Default `advisorGates` to off. Run the advisor only when the user asks or after two failures.

### 6. Cache-miss awareness
- When the session has been idle for more than about 5 minutes and the next request would re-send more than 100k context, show a notice
  that the cache has probably expired and suggest `/compact` first. Don't send keep-warm pings.

### 7. User-level setup recommendations (document only; apply after separate approval)
Write these in `docs/INTEGRATIONS.md` as recommendations:
- `~/.pi/agent/settings.json` → `"compaction": { "reserveTokens": 140000, "keepRecentTokens": 20000 }`.
- Enable `pi-mono-figma` (~20 tools) only in projects that use Figma.
- Load codebase-memory once: through the lazy `mcp` proxy **or** as direct tools, not both.
- Review rarely used packages (`i-have-adhd`, `pi-mono-loop`, `pi-mono-btw`) and enable them per project.

## Out of scope
- Changing Pi core's compaction algorithm, or the SoL-Pi reducer.
- Editing the user's `settings.json` or `~/.zshrc` automatically.

## Verification
- Unit tests: context-budget trigger and safe-point timing; repeated-read stub (same mtime → stub, changed mtime → content);
  `jar_shell start` with `waitMs` returning the exit code; subagent event summary capped at ≤400 chars.
- Replay check: a script (`scripts/session-cost.mjs`) that reads a session JSONL and reports calls, the cost split, context
  buckets, repeated reads and tool counts (the analysis above). Use it as a regression baseline.
- Field check: re-run a task similar to the fan-fighter PR with the new defaults. Target ≤ 150 calls, peak context ≤ 140k, cost ≤ $3.
- `npm test` and typecheck pass; no change to stored session format.

## Rollout
1. Analysis script + `pi-token-burden` baseline (no behavior change).
2. Shell `waitMs` + rules text tweaks (low risk).
3. Context-budget guard (`suggest` mode by default).
4. Subagent event summaries + `maxSubagents` default.
5. Repeated-read stub (opt-in first, then default after a release).
6. Docs for the user-level recommendations.
