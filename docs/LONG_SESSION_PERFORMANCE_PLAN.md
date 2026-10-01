# Long-Session Stability and Performance Plan

## Status

Proposed. This document captures the broader follow-up plan from the long-session Pi Jar audit. The current PR documents the work and retires the obsolete `pi-jar-footer.json` compatibility path; the runtime performance changes below should land as small, independently reviewable follow-up PRs.

A separate detailed design for replacing file-backed agent discussion lives in [DISCUSSION_BROKER_PLAN.md](./DISCUSSION_BROKER_PLAN.md).

## Problem

Pi Jar is responsive in short sessions but can become increasingly slow or unresponsive as a session accumulates history, retained agents, background activity, worktree recovery state and UI redraw pressure.

The audit found seven areas worth fixing:

1. retained Pi subagent processes create steady RAM pressure and may eventually push the host into swap,
2. whole-TUI redraw cost grows with session history and is multiplied by background `requestRender()` calls,
3. `getContextUsage()` is sampled on every `message_end`, potentially walking an increasingly large session for user, assistant and tool-result messages,
4. failed/conflicted worktree recovery records are intentionally retained but have no visible hard global bound,
5. background shells are individually bounded but can still retain significant aggregate output/process state,
6. `jar_discuss` uses a shared JSON paper plus filesystem locking,
7. quota/usage telemetry is mostly bounded already, but should remain explicitly cheap and observable.

The goal is not to remove useful Pi Jar features. It is to make their steady-state cost proportional to current work rather than total session age.

## Design principles

- Prefer event-driven state over polling.
- Bound every retained collection by count and/or bytes.
- Separate durable user state from reconstructable runtime state.
- Do not keep a full child process alive merely to preserve resumability if a session file/worktree is enough.
- Avoid work proportional to full session history on high-frequency events.
- Avoid whole-transcript redraws for background deltas that are not immediately useful.
- Never silently discard conflicted user changes.
- Add measurements before or alongside optimizations so regressions can be proven instead of guessed.

## Priority order

### P0

1. Retained subagent process hibernation.
2. Background render throttling/coalescing for long sessions.
3. Context-usage sampling reduction.

These are the most likely contributors to the reported "slow and unresponsive on a long session" behavior.

### P1

4. Bound unresolved worktree recovery state.
5. Add aggregate shell budgets and lifecycle diagnostics.
6. Replace discussion-paper locking with the parent-owned broker.

### P2

7. Tighten quota/telemetry scheduling and add diagnostics.

The lower priority does not mean "ignore"; it means the current implementation is already comparatively bounded.

---

# 1. Retained Pi subagent processes

## Current behavior

Retained scout/fork/worktree agents remain as live child Pi RPC processes after they settle so the moderator can later peek, steer, pause, resume or ask without rebuilding their context.

The retained pool is bounded by `maxSubagents`, but each slot is a full Pi process with its own runtime, model/session state and IPC resources. A configured pool of 8 or 16 can therefore be expensive even when most agents are idle.

## Risk

- steady RSS rises with retained children,
- inactive children retain runtime/context memory,
- host memory pressure can trigger swap,
- once swapping begins, both Pi and Pi Jar can appear globally unresponsive,
- keeping idle processes alive couples resumability to process lifetime unnecessarily.

## Plan: hibernate settled retained agents

Split "retained agent identity/state" from "live child process".

A retained record should keep only the data required to resume:

- agent key/name/role/model,
- task/status,
- child session directory/session file reference,
- worktree path when applicable,
- bounded latest report/todos/summary,
- timestamps and lifecycle state.

After a retained child reaches a safe settled/idle boundary:

1. persist/flush the child session state,
2. close the RPC child process,
3. keep a lightweight `hibernated` record,
4. preserve its worktree/session directory,
5. respawn Pi only when the moderator explicitly resumes, asks or steers that agent.

Scouts should be especially aggressive candidates for hibernation because their normal output is a report, not a continuously running service.

## Lifecycle states

Prefer explicit states instead of overloading `idle`:

```text
starting -> running -> idle -> hibernated
                    \-> paused
running/idle/paused/hibernated -> stopping -> stopped
```

A hibernated record counts against retained-agent capacity but consumes no Pi child process.

## Important implementation caveat

Current cleanup logic removes private session directories when child handles close. Hibernation must separate:

- "child process closed" from
- "agent record permanently discarded".

Do not delete the fork/session/worktree backing state during hibernation.

## Tests

- settled retained agent transitions to hibernated without losing session metadata,
- resume creates a new RPC child and continues the same child session,
- worktree contents survive hibernation,
- stop/discard removes the retained backing state,
- session shutdown terminates all live children and removes all discardable temporary state,
- pool accounting includes hibernated records,
- repeated hibernate/resume cycles do not leak handles/listeners/directories.

## Acceptance criteria

- an idle retained agent consumes no child Pi process,
- retained-agent behavior remains functionally equivalent after resume,
- process count falls after agents settle,
- parent + child RSS plateaus in a synthetic long-session test instead of growing with every retained settled agent.

---

# 2. Long-session TUI redraw amplification

## Current behavior

Pi's regular TUI redraw cost grows with transcript/session size. Pi Jar already acknowledges this with a large-session warning and avoids some timer-driven repaint behavior.

However, several background sources can still request renders:

- subagent streaming/status updates,
- shell status/output changes,
- footer changes,
- activity state,
- other extension state transitions.

Subagent live updates can happen frequently, while the parent footer repaint is currently coalesced to roughly a few redraws per second.

That rate is tolerable for a small transcript but increasingly expensive when each frame must walk/render a large history.

## Risk

The underlying cost is multiplicative:

```text
cost per full render × background render frequency
```

As transcript size increases, a previously harmless 250 ms repaint cadence becomes expensive.

## Plan: adaptive rendering budget

Introduce a central background render scheduler rather than letting independent sources effectively define cadence.

The scheduler should distinguish:

- foreground/user-visible state transitions,
- background progress deltas,
- streaming text deltas,
- timer-only elapsed-time changes.

Suggested behavior:

```text
small session     background minimum interval ~250 ms
medium session    background minimum interval ~500 ms
large session     background minimum interval ~1000 ms
very large        state transitions only unless an activity view is focused
```

Use measured branch/session entry count as one input, not the only one.

## Separate mutation from repaint

Registry/shell state may update often without requiring an immediate whole-TUI repaint.

Prefer:

```text
state changed
  -> mark dirty
  -> one scheduled background render
```

instead of:

```text
state changed
  -> requestRender()
  -> state changed
  -> requestRender()
  -> ...
```

When the dedicated Activity view is open, it may consume a higher-frequency lightweight update path because that is the screen the user explicitly chose to watch.

## Streaming policy

For retained subagents:

- store live tail updates at the current bounded size,
- update Activity view responsively,
- do not repaint the main transcript/footer for every partial text delta,
- main view should update on coarse progress/state changes or the adaptive budget.

## Instrumentation

Count:

- requested renders,
- coalesced renders,
- actual renders requested from Pi,
- source of each request,
- current branch entry count.

Expose the counters through diagnostics, not the normal footer.

## Tests

- bursts of 100 subagent updates coalesce to the expected number of background requests,
- long-session mode uses the larger minimum interval,
- foreground state changes can still render promptly,
- timer-only activity does not cause excessive main-view repainting,
- scheduler is disposed on session shutdown.

## Acceptance criteria

- background updates cannot cause unbounded render frequency,
- actual main-view render requests decrease as session size crosses configured thresholds,
- focused Activity view remains useful,
- no visible loss of final state when updates are coalesced.

---

# 3. Context usage recomputation

## Current behavior

Pi Jar samples `ctx.getContextUsage()` on `message_end`.

`message_end` is not just "one user turn ended"; it can occur for user, assistant and tool-result messages. In a tool-heavy long session this can therefore call context-usage computation many times per turn.

If the underlying computation walks session/context state, its cost grows with session size.

## Risk

This creates a classic hidden long-session tax:

```text
increasing session size × many message_end events
```

The footer value does not need tool-result-level freshness.

## Plan

Move context usage to a lower-frequency event policy.

Always refresh on:

- session start,
- session tree change,
- session compact,
- model selection,
- session info change.

During an active turn:

- mark context usage dirty on message changes,
- debounce/throttle recomputation,
- prefer final assistant/agent-settled boundaries,
- cap active-turn recomputation to at most once per configurable short interval if the UI actually needs it.

A default of roughly 500-1000 ms during active work is sufficient; zero recomputations between meaningful render opportunities is even better.

## Cache behavior

Keep the last sampled value and timestamp.

The footer should display a slightly stale cached context percentage rather than synchronously forcing a full recomputation for every message event.

## Instrumentation

Measure:

- `getContextUsage()` invocation count,
- total/median/max duration,
- last sample age.

## Tests

- multiple tool-result `message_end` events inside a burst do not each recompute,
- session compact/tree/model events force an immediate refresh,
- cached value remains available between samples,
- shutdown clears timers.

## Acceptance criteria

- context usage recomputation is no longer proportional to tool-result count,
- invocation count for a synthetic tool-heavy turn drops substantially,
- context display remains correct after compact/tree/model transitions.

---

# 4. Failed/conflicted worktree recovery records

## Current behavior

Finished delegate records are normally swept, but records with a retained worktree recovery workspace are excluded because unresolved/conflicted changes are valuable recovery state.

That protects user work, but repeated failed/conflicted worktrees can accumulate beyond the normal finished-record cap.

## Risk

Each unresolved recovery item may retain:

- registry record,
- bounded transcript/report data,
- worktree metadata,
- filesystem worktree contents,
- other reconciliation state.

The correct behavior is not to delete these automatically, but "never delete" is not the same as "allow unlimited accumulation".

## Plan: explicit recovery inventory and admission bound

Create an explicit `RecoveryRecord` concept separate from normal finished subagent history.

Keep only the metadata needed to recover/reconcile:

- agent key/name,
- worktree path,
- base/head refs where relevant,
- conflicting/changed files summary,
- created/failed timestamp,
- concise error/reason,
- state: unresolved/resolved/discarded.

Release bulky runtime/transcript state once a failed agent becomes a recovery record.

Set a small hard maximum unresolved recovery count, for example 4 or 8.

When the limit is reached:

- do not silently delete the oldest workspace,
- refuse to start another worktree delegate that could require recovery,
- show which recovery records must be resolved/discarded first.

## User operations

Expose clear actions through existing subagent/activity controls:

- inspect recovery,
- retry apply/reconcile,
- discard recovery,
- optionally open/show path.

## Cleanup

Resolved/discarded records must:

- remove their temporary worktree,
- unregister listeners/state,
- disappear from the recovery inventory.

## Tests

- failed worktree is converted to lightweight recovery state,
- normal finished transcript sweep can proceed independently,
- unresolved count never exceeds the configured maximum,
- new worktree delegation is blocked at the limit without deleting existing changes,
- resolving/discarding frees capacity and removes filesystem state,
- session shutdown behavior is explicit and does not silently destroy unresolved user changes.

## Acceptance criteria

- unresolved user changes remain safe,
- JS memory associated with a failed child is reduced after conversion to recovery state,
- recovery-state count is bounded,
- worktree creation cannot grow recovery state indefinitely.

---

# 5. Shell buffers and background processes

## Current behavior

`jar_shell` already has useful bounds:

- max concurrent shell jobs,
- per-job line/character limits,
- approximately bounded retained text per job,
- pruning of finished shell records,
- process-group termination on supported platforms.

This is substantially safer than an unbounded log collector.

## Remaining risk

Aggregate memory can still be meaningful if many retained/finished jobs each hold their maximum buffer. Long-running service jobs also legitimately keep OS processes alive.

A user may therefore have:

- several live process trees,
- retained logs across many finished jobs,
- extra footer/activity update pressure.

## Plan

### Global retained-output budget

Add a manager-level byte/character budget in addition to per-job caps.

When total retained output exceeds the global budget:

1. trim oldest finished-job output first,
2. then oldest noncritical retained output,
3. preserve a tail for each live job,
4. never kill a process merely to satisfy a log-memory budget.

### Finished-job compaction

Once a job result has been surfaced, replace old full output with:

- exit status,
- command,
- timestamps/duration,
- bounded tail,
- matched watch reason if any.

### Service classification

Allow long-lived service/watch jobs to be marked clearly so diagnostics can distinguish expected live processes from accidental leftovers.

### Diagnostics

Expose:

- live shell count,
- finished retained count,
- total retained output chars/bytes,
- per-job retained size,
- PIDs/process groups,
- oldest live job.

## Tests

- global log budget is enforced across jobs,
- live jobs retain useful tails,
- pruning output never alters process lifecycle,
- process-group kill still cleans descendants,
- finished jobs compact after result consumption,
- shutdown leaves no managed live shell processes.

## Acceptance criteria

- total shell log memory is globally bounded,
- many completed jobs cannot accumulate near-per-job maximum indefinitely,
- live services remain functional and observable.

---

# 6. Discussion-paper locking

The current shared `paper.json` + `.lock/` mechanism should be replaced, not tuned.

See [DISCUSSION_BROKER_PLAN.md](./DISCUSSION_BROKER_PLAN.md) for the detailed design.

## Summary

Move discussion ownership into the parent process:

- in-memory `DiscussionHub`,
- session-local IPC,
- parent-assigned sequence IDs,
- authenticated child identity,
- per-agent mailboxes/cursors,
- targeted unread delivery,
- bounded retention,
- no polling,
- no shared file lock,
- no whole-paper rewrite per message.

## Acceptance criteria

- zero steady-state filesystem operations for discussion,
- zero lock retries/stale-lock recovery,
- deterministic concurrent message ordering,
- bounded state,
- no automatic LLM ping-pong.

---

# 7. Quota and telemetry overhead

## Current behavior

The audit did not find a general external telemetry upload loop.

Current usage-related work is mostly bounded:

- process RSS is sampled lazily,
- side-model usage records have a cap,
- quota requests are cached for several minutes,
- one pending quota request per provider is allowed,
- network requests have a timeout,
- session cost is incrementally updated for normal assistant messages and fully recomputed on major session events.

This area is therefore lower risk than retained child processes or render/context scans.

## Plan

Keep it boring and cheap.

### Central sampling policy

Avoid independent UI code deciding when to perform expensive samples.

Maintain cached facts with explicit timestamps:

- RSS,
- context usage,
- quota,
- session cost,
- side-call totals.

Renderers read cached values only.

### Quota

Keep quota:

- opt-in/feature-controlled as today,
- one in-flight request per provider,
- cached for minutes,
- never triggered by every render,
- delayed away from startup critical path.

If a cached quota value is stale, render the stale value/unknown state and refresh asynchronously rather than blocking TUI work.

### Usage records

Continue to cap side-model usage history. If detailed historic calls are not needed by UI, consider retaining aggregate totals plus a smaller recent-call ring instead of hundreds of full records.

### No generic event log

Do not introduce a high-frequency telemetry file just to diagnose performance. Use in-memory counters and an explicit diagnostic snapshot.

## Tests

- repeated footer renders do not cause repeated network quota requests,
- provider requests deduplicate while one is pending,
- failed quota calls obey TTL/backoff and cannot hot-loop,
- side-usage history remains bounded,
- session start clears session-scoped counters.

## Acceptance criteria

- telemetry/quota work remains effectively constant with session age,
- no render path performs blocking network I/O,
- no diagnostic collection itself becomes a source of long-session growth.

---

# Diagnostics: /jar perf

Before or alongside the P0 changes, add a compact diagnostic command so future regressions can be measured.

Suggested output:

```text
session
  branch entries       1,142
  context              78%
  parent rss            612 MiB

subagents
  retained              4
  live children         2
  hibernated            2
  child rss             ...
  recovery worktrees    1 / 4

render
  requested             ...
  coalesced             ...
  actual                ...
  background rate       ...
  last sources          ...

context sampling
  calls                 ...
  total time            ...
  max time              ...
  last sample age       ...

shells
  live                  2
  retained finished     8
  output retained       2.4 MiB

discussion
  transport             broker
  messages              31 / 128
  bytes                 ...
  unanswered            2

quota
  provider cache age    ...
  pending               no
```

Diagnostics should be calculated on demand where possible and should not create another permanent polling loop. Nature has enough irony already.

# Delivery plan

Keep implementation PRs small and root-cause focused.

## PR A: measurement and context sampling

- add `/jar perf` counters/snapshot,
- cache and throttle `getContextUsage()`,
- add tests for message bursts and lifecycle cleanup.

This gives a baseline before the larger lifecycle changes.

## PR B: adaptive background rendering

- central background render scheduler,
- source-aware coalescing,
- adaptive cadence by session size,
- focused Activity-view behavior,
- render counters.

## PR C: retained subagent hibernation

- explicit hibernated lifecycle state,
- respawn/resume from retained session metadata,
- separate child close from permanent cleanup,
- process/RSS validation.

This is likely the highest-memory-impact change and deserves its own PR.

## PR D: recovery-state bound

- lightweight `RecoveryRecord`,
- hard unresolved-worktree admission limit,
- resolve/discard flows,
- release bulky finished-agent state.

## PR E: shell aggregate bounds

- global output budget,
- finished-output compaction,
- diagnostics.

## PR F: discussion broker

Implement [DISCUSSION_BROKER_PLAN.md](./DISCUSSION_BROKER_PLAN.md) in its own focused PR.

## PR G: telemetry cleanup if measurements justify it

Only optimize quota/side-usage paths further if `/jar perf` data shows meaningful overhead. Do not churn already-cheap code for decorative optimization.

# End-to-end validation

Create a deterministic long-session stress harness that does not require real model calls where possible.

Exercise:

- hundreds/thousands of synthetic session entries,
- tool-result bursts,
- repeated background subagent updates,
- retained agents settling/resuming,
- several shell jobs,
- failed worktree recovery,
- concurrent discussion operations.

Measure before and after:

- parent RSS,
- child process count,
- total child RSS where available,
- event-loop responsiveness,
- actual render requests/minute,
- `getContextUsage()` calls and duration,
- shell retained bytes,
- registry/recovery counts,
- discussion operation latency.

## Success criteria

For a fixed workload:

- memory reaches a stable plateau after bounded caches fill,
- settled retained agents do not require live Pi processes,
- background render rate decreases for large sessions,
- context-usage calls are not proportional to tool-result count,
- unresolved recovery state cannot grow beyond its configured bound,
- shell retained output cannot exceed the global budget,
- discussion has no lock contention,
- quota requests remain cache-bound rather than render-bound,
- session shutdown leaves no live managed child/shell processes or repaint timers.

# Related cleanup already included in this PR

`$AGENT_DIR/pi-jar-footer.json` support is retired now:

- `pi-jar-settings.json` is the sole visual/footer settings source,
- legacy footer files are no longer read, written or migrated,
- existing legacy files are ignored and left untouched,
- obsolete persistence APIs/tests are removed,
- regression tests verify the legacy file cannot influence current settings.

This reduces configuration compatibility surface before the larger runtime lifecycle work begins.
