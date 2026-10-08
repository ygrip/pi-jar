# Efficiency Plan

## Status

Triaged against the 0.2.1 codebase and partly implemented in v0.2.2. Most of the original proposal was either already shipped by the long-session work ([LONG_SESSION_PERFORMANCE_PLAN.md](./LONG_SESSION_PERFORMANCE_PLAN.md), 0.1.9–0.2.1) or costs more in complexity and risk than it saves. Only items with a measurable win and no behavior change were taken.

## Goal

Keep long sessions fast and cheap without losing stored history or changing what the model sees unless the user opted in.

## Implemented in 0.2.2

### Adaptive context sampling (was item 8)

`ContextSampler` (`src/perf.ts`) now widens its mid-turn throttle from the measured cost of `getContextUsage()` instead of a fixed 750 ms: the window is `max(750 ms, 100 × median sample time)`, capped at 5 s. Mid-turn sampling therefore stays near a 1% duty cycle whatever the session size; cheap sessions keep the 750 ms cadence, and lifecycle boundaries (start, tree, compact, model, rename, settle) still refresh immediately. Measured cost is used rather than entry-count tiers because it is the quantity being bounded and needs no extra wiring. `/jar perf` shows the current window.

### Profile pin lookup without a copy (part of item 9)

`pinnedProfileId` walks the branch backwards in place instead of allocating `[...entries].reverse()`. `conversationStarted` already exits at the first user message, so it needed no change; neither runs per frame, so no incremental cache was added.

### Cache-stable workflow prompts (follow-up)

Plan and goal prompts used to be pruned to the newest copy on every call. Removing an earlier copy changes the conversation prefix, so each new turn (or goal round) re-sent the whole previous run uncached. `src/workflow-context.ts` now projects them so that every keep/drop decision depends only on earlier messages: identical plan/goal context is sent once, sent reminders and continuations stay in place, and leaving the mode drops them all once. It runs on Pi's message list before provider conversion, so it helps every provider that caches by prefix (Anthropic explicit breakpoints, OpenAI/DeepSeek/Gemini automatic prefix caching, Bedrock). Appending the context at the tail was rejected: pi-ai places the Anthropic cache breakpoint on the last message, so a moving tail would defeat the cache entirely.

### Unset side roles are visible (follow-up)

`askRole` notifies once per role when an unassigned role (advisor, commit, …) ran on the current main model, with the `/roles set` command to fix it. Behaviour is unchanged.

### Bounded synchronous subagent results (follow-up)

A synchronous `jar_delegate` result shares a 16k-character report budget across its runs (at least 2k each) instead of up to 12k per run. Truncated reports name `jar_subagent report <key>`, a new read-only action returning the full stored report. Event messages were already capped at 1.2k.

### Cheaper subagent subscriber (follow-up)

The footer's per-tick registry listener reads `DelegateRegistry.stateSignature()` straight from the map instead of `records()` (a second sweep, a sort and two arrays per 50 ms tick).

## Session cost reduction

Baseline: a 309-call, $6.34 session (`node scripts/session-cost.mjs 01a101ba-…`): 60% of cost was cache reads, average context 125k, 138 calls above 125k context costing $3.87; 109 reads (12 of one file, 7 of a `/tmp` plan), 65 `jar_shell` calls (33 start, 22 output, 8 wait), 19 subagent events (36 KB). Cost scales with calls × context, so every change cuts calls, context per call, or the fixed prompt.

| Change | Where | Effect |
| --- | --- | --- |
| Context budget (`suggest` by default at 120k; opt-in `compact` at a safe point) and average cost per call in the footer | `src/context-budget.ts` | Long sessions are compacted or split before every call re-sends 200k+ |
| Topic-switch and cold-cache hints | `src/context-budget.ts` | `/new` for unrelated work; `/compact` before re-sending a large expired context |
| `bash` for finite commands; `jar_shell start` `waitMs`; incremental `output` | `src/shells.ts` | Short jobs take one call instead of start → output → wait, and repeated reads don't resend old output |
| 400-line cap on whole reads of files over 50 KB; opt-in repeated-read stub; diet stubs superseded reads | `src/compact-tools.ts`, `src/context-diet.ts` | Smaller tool results and fewer duplicate reads in the context |
| Pool default 2 (opt-in Swarm profile: 4); delegate only for ≥2 chunks of ≥10 tool calls | `src/settings.ts`, `src/delegate.ts`, `src/profile-ui.ts` | Fewer moderation round-trips |
| Events: ≤400-char summary + changed files, one message per boundary, discussion mail inlined | `src/delegate.ts`, `src/discussion.ts` | Events shrink from ~1.9 KB to ~0.5 KB; no `list` call to read mail; no echoes of own messages |
| `/roles` warns when `scout`/`reviewer` run on the main model while a cheaper one is available | `src/model-roles.ts` | Subagent calls move to a cheaper model |
| Advisor gates off by default; loop threshold 4; re-reads, shell polls and test reruns are never loops | `src/advisor.ts` | No side calls from normal fix loops |
| Cache-break diagnostics: one notice per costly prompt-cache break, `/cache-breaks`, a per-session JSONL log | `src/cache-breaks.ts`, `src/cache-breaks-view.ts` | The tool list, system section or message that forced a rewrite is named instead of guessed |
| Rules moved into tool descriptions; `jar_plan_submit`/`jar_goal` active only in their mode | all tool modules, `src/tool-activation.ts` | Smaller fixed prompt (below) |

Fixed prompt that pi-jar contributes, measured from Pi's built system message in RPC mode (same project, same Pi 1.0.4): the `rules` section went from 7,584 to 1,675 characters and `tools` from 1,773 to 1,476; two schemas (~900 characters) are no longer sent outside their mode. Tool descriptions and schemas grew by ~1.1k characters because the guidance moved there. Net: ~5k characters (~1.3k tokens) less on every call. That is modest next to context growth, so the context budget and shell/read changes carry most of the saving.

Cache breaks: an audit of a $30 session found ~68% of the cost was cache rewrites caused by prompt-prefix changes: tools activated mid-session (the cache read fell to 0 and ~230k tokens were rewritten per call), an extension replacing old tool results with placeholders (the read stuck at a mid-history offset), and one unexplained break at a user-turn boundary. Pi reports *that* a call missed the cache, not why. `src/cache-breaks.ts` fingerprints each provider payload (model, tools, system-prompt sections, messages; hashes and sizes only), finds the first segment where the previous request stopped being a prefix of this one, and joins that with the call's usage; a call whose cache read falls more than 4,096 tokens short of the previous prompt is a costly break. It only observes, and is on by default (`cacheDiagnostics`).

Not done: Pi's compaction thresholds and the user's own settings are left alone; recommendations are in [INTEGRATIONS.md](./INTEGRATIONS.md#keeping-sessions-cheap-recommendations). The ≤ $3 field target needs a real re-run of a similar task with the new defaults.

## Already covered — dropped

| Item | Why |
| --- | --- |
| 5. Tier subagent events | Already tiered: tool `onUpdate` ≤ 1 s, footer status only on state change, key/state changes are `transition` and everything else `background` in `RenderScheduler` (250 ms–1 s by session size, transitions-only beyond), Activity view coalesces at 100–500 ms. The 50 ms stream tick only feeds that scheduler. |
| 6. Footer snapshot | `renderFooterLayout` already memoizes on a key of width/theme/view; repaints between changes are cache hits. A versioned snapshot would need change notifications from every source for a microsecond saving. |
| 7. Bounded advisor fingerprints | `callKey` already keeps a 200-char prefix plus a SHA-1 of large inputs, so the loop window never pins large payloads. Prefix/suffix-only hashing would let distinct writes collide and trigger false loop alerts. |

## Deferred

| Item | Why |
| --- | --- |
| 1. Single Context Projector | The four `context` hooks (child automation filter, diet, plan, goal) are each one `customType` scan that allocates only when something is stale — negligible next to request serialization. Merging them couples independent modules for no measurable gain. Revisit only if `/jar perf` shows context hooks in a profile. |
| 2. Context Diet v2 (`stripper` model, `DietSnapshot`) | A model-written summary replaces exact history with a lossy one, adds a side call per compression and duplicates Pi's own compaction. Needs its own design (fidelity, resumability, cache-hit impact) before code. |
| 3. Diet-aware delegation | Depends on item 2. Today `scout` already starts fresh and `fork` is an explicit mode; changing the defaults alters subagent results. |
| 4. Strict utility roles | Side calls without a role use the current model by design (`askRole`); making them fail or go deterministic breaks advisor and commit messages for users without roles. Addressed instead by the one-time notice above. |
| 10. Compact workflow history | Rewriting persisted session history is ruled out; provider context is handled by the cache-stable projection above. |

## Success criteria

- Mid-turn context sampling cost stays bounded (~1% duty cycle) as sessions grow; visible in `/jar perf`.
- Plan/goal sessions keep prefix-cache hits across turns and rounds on every provider.
- Stored session history is unchanged.
