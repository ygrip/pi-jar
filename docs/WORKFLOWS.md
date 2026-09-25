# Workflows

pi-jar adds four agent workflows on top of Pi. Each is enforced with Pi's public extension API — active tool sets, `tool_call` guards, hidden context messages, the `agent_before_settle` continuation boundary, and session entries — rather than by prompting alone.

## Plan mode

### Lifecycle

```text
/plan ──▶ read-only tools + plan role ──▶ agent explores
            │                                  │
            │                  writes $TMPDIR/pi-jar/plans/<session>/<slug>-plan.md
            │                                  │
            │                   jar_plan_submit({ path }) ──▶ validate ──✗──▶ missing sections returned
            │                                  │ ✓
            ▼                                  ▼
   turn ended without submit          plan view (after the run settles)
   → hidden reminder (≤ 2/prompt)      approve │ compact+approve │ refine │ stop
                                               ▼
                         seed jar_todo, restore tools/model, optional role,
                         send <plan path="…">full text</plan> as the next prompt
```

### Enforcement

| Mechanism | Detail |
| --- | --- |
| Active tools | Current tools ∩ `read, bash, grep, find, ls, jar_ask`, plus `write`, `edit`, `jar_plan_submit`. The previous set is restored exactly on exit. |
| `tool_call` guard | Unknown tools fail closed. `bash` must pass the read-only allowlist (no redirection, substitution, globbing or mutating git/find flags). `write`/`edit` must target a `.md` file whose real path (after resolving symlinks on the nearest existing ancestor and on the file itself) is inside the session's plan directory. |
| Hidden context | Each run gets `[PI-JAR PLAN MODE · READ ONLY]` with the plan directory, the template and the rule to end with `jar_plan_submit`. It is filtered out of context once plan mode ends. |
| Submission | `jar_plan_submit` reads at most 64 KB, strips control sequences, requires one `#` title and `## Context`, `## Approach` (with numbered/bulleted steps or `###` step headings), `## Critical files` and `## Verification`. Success ends the turn (`terminate`). |
| Reminder | `agent_before_settle` appends a hidden reminder and continues once — at most twice per user prompt — when a completed turn did not submit. Never after an interrupt or error, and never on top of another extension's continuation. |

### Plan view

`openPlanView` renders a full-height overlay using the shared split frame:

- Left: table of contents from ATX headings (fenced code ignored). A single `#` title becomes the header; content before the first heading is an **Overview** entry; `###` entries are indented. Width is `clamp(round(w × 0.26), 18, 32)`; below 64 columns the sidebar collapses into a `‹ n/m heading ›` pager.
- Right: the selected section and its subsections rendered with Pi's markdown renderer, scrollable independently.
- Bottom: actions and the **continue with** role chip (cycles through assigned roles in `cycleOrder`).
- The view handles clicks and wheel only; press/drag/release fall through to Pi so text selection and copy-on-select keep working.

State (`pi-jar.plan` entries, v2: `enabled`, `steps`, `text`, `path`, `title`) follows the session branch; v1 entries still restore.

## Goal mode

### States

```text
            /goal <text>
                 │
                 ▼
   ┌──────── active ────────┐
   │   phase: implement      │◀─── auditor added tasks
   │     │ all tasks done    │
   │     ▼                   │
   │   phase: audit ─────────┼──▶ jar_goal complete (evidence) ──▶ complete
   └──┬──────────────────────┘
      │ Esc / error / plan mode / jar_goal block / round budget
      ▼
    paused ──/goal resume──▶ active
    /goal clear ──▶ (dropped)
```

### Rules

- **Round budget:** each automatic continuation is a round (`round n/max`, default 8). A real user message resets it. Reaching the limit pauses the goal.
- **Task gate:** with no open task, `write`/`edit` are blocked, and so are shell commands that are not on the read-only allowlist during the implement phase. During the audit, edits are blocked but verification commands are allowed.
- **Auditor role:** the audit round activates the `advisor` role temporarily (if assigned); the previous model and effort are restored when work returns to the implementor or the run settles.
- **Completion:** `jar_goal complete` requires the audit phase, no open tasks, and non-empty evidence. It ends the turn, records the evidence, and Ember shows `(★ᴗ★)`.
- **Context hygiene:** only the newest goal context and continuation messages are kept in the prompt.

Goal events (`pi-jar.goal`, v2: `set`, `status`, `round`) are append-only session entries; v1 `set`/`clear` still replay.

## Model roles

Resolution for a role name:

1. Merge global (`<agent dir>/pi-jar-roles.json`) and project (`<cwd>/.pi/pi-jar-roles.json`) roles; project wins per role.
2. If the spec is `@other[:effort]`, remember the effort (first one wins) and follow `other`; stop after five hops or on a cycle.
3. A `provider/model[:effort]` spec resolves through Pi's model registry; activation fails with a notice if the model is unknown or unauthenticated.
4. An unassigned role "follows the current model" (activating it only labels the footer).

`activateTemporary(role)` returns a restore function that puts back the previous model, effort and active role — used by plan mode (`plan`) and the goal audit (`advisor`).

## Next-prompt suggestions

- The `jar_suggest` tool is active only while the pi-jar composer and the suggestions setting are on.
- Its prompt guidelines ask the agent to call it once, last, when a request is finished; the result ends the turn, so it costs no extra model round.
- If a completed turn did not suggest, a single hidden reminder asks for one (never while plan or goal automation owns the next step, and never after an interrupt).
- The suggestion is sanitized to one line (≤ 160 characters) and kept in memory only. It is cleared by your next prompt, a new run, typing, or branch navigation.
