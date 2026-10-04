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
| 4. Strict utility roles | Side calls without a role use the current model by design (`askRole`); making them fail or go deterministic breaks advisor and commit messages for users without roles. Needs a product decision, e.g. a warning in `/roles` when a utility role is unset. |
| 10. Compact workflow history | Plan/goal context messages are already pruned from provider context on every call; compacting them would rewrite persisted session history, which this plan rules out. |

## Success criteria

- Mid-turn context sampling cost stays bounded (~1% duty cycle) as sessions grow; visible in `/jar perf`.
- No change to what the model receives or what the session stores.
