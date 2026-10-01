# Discussion Broker Improvement Plan

This is the detailed design for item 6 of the broader [Long-Session Stability and Performance Plan](./LONG_SESSION_PERFORMANCE_PLAN.md).

## Status

Implemented in v0.1.9. This document preserves the design and acceptance criteria for the parent-owned in-memory broker and authenticated session-local IPC that replaced the file-backed paper. The “current” paper behavior and imperative implementation phases describe the pre-0.1.9 baseline and original proposal.

## Problem

`jar_discuss` currently coordinates independent Pi processes through a shared temporary JSON paper. Every mutation must:

1. acquire a filesystem lock directory,
2. read and parse the whole paper,
3. validate against that snapshot,
4. mutate the in-memory copy,
5. serialize and rewrite the whole paper,
6. atomically rename the replacement, and
7. release the lock.

The paper is bounded, so this is not an unbounded-data bug, but it is the wrong synchronization primitive for a parent process that already owns the subagent lifecycle. Concurrent agents can spend time retrying the same lock, stale-lock recovery adds failure modes, every write performs filesystem work, and the file cannot efficiently provide targeted delivery.

The desired model is agent coordination, not durable shared storage.

## Goals

- Remove lock contention and filesystem polling from normal cross-agent communication.
- Keep the moderator as the authority for agent identity, lifecycle and routing.
- Preserve the useful `jar_discuss ask|answer|list` interaction model where practical.
- Deliver only relevant unread communication to each agent.
- Keep discussion state strictly bounded in memory.
- Avoid automatically waking LLM agents for ordinary messages.
- Make pending communication visible to the moderator and activity UI.
- Make cleanup deterministic on session replacement and shutdown.
- Keep protocol and transport simple enough to test without running model calls.

## Non-goals

- A durable chat history.
- A general message queue.
- Direct child-to-child sockets.
- Automatic agent debates or unbounded LLM ping-pong.
- Persisting discussion across parent-process crashes.
- Replacing Pi RPC used for normal subagent lifecycle/control.

## Proposed architecture

Pi Jar's parent process owns a session-local `DiscussionHub`. Child agents never mutate shared storage directly.

```text
                    Pi Jar parent
                 ┌─────────────────┐
                 │  DiscussionHub  │
                 │                 │
                 │ bounded state   │
                 │ routing         │
                 │ sequence IDs    │
                 │ unread cursors  │
                 └───────┬─────────┘
                         │
             ┌───────────┼───────────┐
             │           │           │
          scout-1     worker-2    reviewer-3
```

The hub is owned beside `DelegateRegistry`, because the registry already knows which retained agents exist and when they start, settle, pause, resume, stop or disappear.

Suggested ownership:

```ts
const subagents = new DelegateRegistry();
const discussions = new DiscussionHub();
```

Lifecycle integration:

```ts
discussions.register(record.key);
discussions.retire(record.key);
discussions.clear();
```

## Transport

Use a session-local IPC endpoint:

- Unix domain socket on macOS/Linux.
- Named pipe on Windows.
- Newline-delimited JSON request/response protocol.
- Children connect only when `jar_discuss` is invoked; no permanently open connection is required.
- No polling loop.
- No shared writable file.
- No lock file or lock directory.

The parent passes endpoint metadata to child processes through environment variables:

```text
PI_JAR_DISCUSSION_ENDPOINT=...
PI_JAR_DISCUSSION_TOKEN=...
PI_JAR_SUBAGENT_KEY=delegate-2-1
```

The child must not be allowed to choose an arbitrary sender identity. The parent authenticates the session token and maps the connection/request to a known subagent key.

On Unix, create the containing temporary directory with owner-only permissions. Treat the token as session-local capability data and never print it in tool output or logs.

## Message model

Use monotonic numeric sequence IDs owned by the parent.

```ts
interface DiscussionMessage {
  id: number;
  kind: "question" | "answer";
  from: string;
  to?: string;
  replyTo?: number;
  text: string;
  createdAt: number;
}
```

The parent is the only component allowed to:

- allocate IDs,
- validate `from`,
- validate target agent keys,
- validate answer references,
- mutate retention state, and
- advance per-agent read cursors.

This gives deterministic ordering without a filesystem lock.

## Mailboxes instead of a shared transcript

Treat the discussion as bounded per-agent mailboxes over one shared message store.

Each agent keeps a logical `lastSeenId`. A normal unread query returns only messages after that cursor that are relevant to the caller:

- questions addressed to that agent,
- broadcast questions when broadcasts are supported,
- answers to questions created by that agent.

Do not make every agent ingest the full discussion history.

Tool behavior:

- `jar_discuss ask`: append one question and return its ID.
- `jar_discuss answer`: append one answer to a known question and return its ID.
- `jar_discuss list`: return unread relevant messages and advance the caller cursor.
- `jar_discuss thread <id>`: return one question and its bounded answers without advancing unrelated unread state.
- `jar_discuss pending`: compact unanswered/unread summary for moderator diagnostics.

The existing `since` compatibility behavior can remain during migration, but the normal path should be cursor-based.

## Delivery policy

Communication should be event-driven but not model-trigger-happy.

When a new message is routed:

1. update the target mailbox state,
2. update a cheap pending-count signal in the parent,
3. request only the necessary Pi Jar UI/status update, and
4. do not automatically wake an idle model.

At the target agent's next natural turn, Pi Jar may inject a tiny notice such as:

```text
You have 1 unread discussion message. Use jar_discuss list when relevant.
```

The moderator can explicitly resume/steer a retained agent when a question is urgent. Ordinary agent-generated messages must not be able to create an automatic wake/answer/wake loop.

## Retention

Discussion state remains bounded.

Initial limits:

- at most 128 messages,
- at most 1,600 characters per message,
- at most 128 KiB total encoded message text/metadata,
- at most a small fixed mailbox/cursor record per registered agent.

Eviction priority:

1. answered question/answer groups already acknowledged by relevant agents,
2. acknowledged broadcast messages,
3. oldest acknowledged messages,
4. never silently evict an unanswered targeted question while disposable acknowledged entries exist.

If the hard bound cannot be maintained without removing an unresolved question, surface a compact capacity error and require progress rather than growing memory indefinitely.

## Context discipline

The broker stores coordination state. The model receives only the slice it needs.

Normal tool results should not echo:

- the caller's own submitted text,
- old acknowledged messages,
- unrelated agent chatter,
- the full mailbox,
- the full discussion graph.

This protects both response latency and model context in long sessions.

## Failure behavior

The broker is ephemeral by design.

If the parent process exits, discussion state is lost. That is acceptable because:

- the parent owns the child processes,
- discussion is coordination state rather than user-authored durable data,
- durable task/plan/session artifacts already live elsewhere.

Do not add per-message snapshots merely to reconstruct transient chatter after a crash. If later evidence shows recovery is valuable, add an optional atomic snapshot at coarse lifecycle boundaries, not a lock-based primary transport.

If the IPC endpoint is unavailable, `jar_discuss` should return a clear broker-unavailable error. Do not silently fall back to the old shared-file implementation, because maintaining two synchronization models would preserve the complexity this change is intended to remove.

## Observability

Expose lightweight broker information to Pi Jar diagnostics/activity state:

- registered agents,
- unread count per agent,
- unanswered question count,
- retained message count/bytes,
- oldest/newest sequence ID,
- IPC endpoint status,
- request/error counters.

Do not expose message bodies in generic telemetry.

## Implementation phases

### Phase 1: DiscussionHub

Add a pure in-memory `DiscussionHub` with no sockets and unit-test:

- registration/retirement,
- monotonic IDs,
- ask/answer validation,
- targeted routing,
- cursor semantics,
- thread reads,
- retention/eviction,
- cleanup.

### Phase 2: local IPC

Add the local server/client transport and authenticate children using session-local capability data.

Test:

- concurrent asks receive unique ordered IDs,
- concurrent answers do not require retries,
- invalid sender/target/reply IDs are rejected,
- malformed requests cannot crash the parent,
- endpoint cleanup happens on shutdown.

### Phase 3: jar_discuss adapter

Keep the public tool concise while switching its storage implementation to the broker.

Preserve useful response limits from the current implementation, but remove:

- `paper.json`,
- `paper.json.lock/`,
- lock retries,
- stale lock recovery,
- whole-paper reads and rewrites.

### Phase 4: DelegateRegistry/activity integration

Show pending counts in moderator/activity state and add a small unread notice at natural agent boundaries.

Do not auto-resume agents for normal messages.

### Phase 5: delete compatibility code

After the broker tests cover existing semantics:

- remove `createDiscussionPaper`,
- remove `disposeDiscussionPaper`,
- remove file-path environment variables,
- remove filesystem discussion tests,
- remove lock-specific code and stale-lock handling.

## Acceptance criteria

The implementation is complete when:

- two or more child agents can ask/answer concurrently with no filesystem lock,
- discussion operations perform no shared-paper read/write in the steady state,
- no polling timer is required for message delivery,
- ordering is deterministic,
- each agent sees only relevant unread messages by default,
- memory remains bounded under a stress test,
- idle agents are not automatically woken by normal discussion traffic,
- session replacement/shutdown removes IPC resources and in-memory state,
- existing subagent pause/resume/stop behavior remains unchanged,
- tests cover concurrency and lifecycle cleanup.

## Performance validation

Add a synthetic test/benchmark that compares the current file-backed design with the broker for concurrent local operations. The target is not an arbitrary microbenchmark trophy; it is removal of contention and variance.

Measure:

- median and p95 ask/answer latency,
- number of filesystem operations,
- number of retry waits,
- parent CPU time,
- retained heap after a fixed message workload.

Expected steady-state broker behavior is zero discussion filesystem operations and zero lock retries.

## Related cleanup: legacy footer settings

Pi Jar previously supported `$AGENT_DIR/pi-jar-footer.json` and migrated it into `pi-jar-settings.json`.

That compatibility path is retired alongside this plan PR:

- `pi-jar-settings.json` is the sole visual/footer settings source,
- Pi Jar no longer reads, writes or migrates `pi-jar-footer.json`,
- an existing legacy file is ignored and left untouched,
- footer field definitions remain reusable code, but have no independent persistence layer,
- regression tests verify the legacy file cannot influence current settings.

This keeps configuration ownership singular before more parent-owned coordination state is introduced.
