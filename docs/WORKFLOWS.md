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
- **Roles per round:** implement rounds run on the `implement` role and the audit round on `advisor` (each only if assigned). The previous model and effort are restored when the run settles.
- **Completion:** `jar_goal complete` requires the audit phase, no open tasks, and non-empty evidence. It ends the turn, records the evidence, and Ember shows `(★ᴗ★)`.
- **Context hygiene:** only the newest goal context and continuation messages are kept in the prompt.

Goal events (`pi-jar.goal`, v2: `set`, `status`, `round`) are append-only session entries; v1 `set`/`clear` still replay.

## Model roles

Resolution for a role name:

1. Merge global (`<agent dir>/pi-jar-roles.json`) and project (`<cwd>/.pi/pi-jar-roles.json`) roles; project wins per role.
2. If the spec is `@other[:effort]`, remember the effort (first one wins) and follow `other`; stop after five hops or on a cycle.
3. A `provider/model[:effort]` spec resolves through Pi's model registry.
4. For an assigned role, activation tries the primary then that role's configured fallback specs in order. Delegated agents also choose the first currently available candidate. An explicit empty project fallback list disables the inherited global list.
5. An unassigned role "follows the current model" (activating it only labels the footer).

`activateTemporary(role)` returns a restore function that puts back the previous model, effort and active role — used by plan mode (`plan`), approved-plan execution (`implement`), goal rounds (`implement` / `advisor`).

Manual choices win: a model or effort you select yourself (model picker, cycling, `/thinking`) while a temporary role is applied cancels that role's restore, so leaving plan mode or finishing a goal round never overrides it. pi-jar's own switches are not counted as manual.

## Advisor

- Context sent: the newest conversation (≈24k characters; tool results truncated to 1.2k each) plus `git status --short --branch` and `git diff --stat HEAD` (≤4k). No tools run on the advisor's side.
- `jar_advisor` returns the advice as the tool result. `/advisor [focus]` and the failure gate deliver a visible `pi-jar.advisor` message (steered into a running turn, or queued for the next one when idle).
- Loop gate: the same tool and input three times within the last eight calls blocks that call and returns the advice as the block reason. Failure gate: three failing tool results in a row. Both share a budget of two consultations per user prompt and are reset by your next message.
- The advisor model comes from the `advisor` role; unassigned, it is the current model with a fresh context.

## Commit

`/jar commit [note]` reads the staged diff (≤60k characters) and the last eight commit subjects, asks the `commit` role (or the current model) for a message in the same style, and opens it in an editor. Saving commits with `git commit -F`; an empty message cancels. With nothing staged it offers `git add -A`. It never pushes.

## Usage and context panel

- Usage totals come from the assistant messages on the active branch plus pi-jar's side calls (advisor, commit) for this session. Limit bars use the quota lookup that feeds the footer.
- Context parts are estimated at ~4 characters per token (images ≈1.6k tokens) and scaled to the provider-reported total when known. The autocompact buffer is Pi's compaction reserve (`compaction.reserveTokens`), or 0 when compaction is off. Context files and skills are the ones the last prompt used.

## Next-prompt suggestions

- The `jar_suggest` tool is active only while the pi-jar composer and the suggestions setting are on.
- Its prompt guidelines ask the agent to call it once, last, when a request is finished; the result ends the turn, so it costs no extra model round.
- If a completed turn did not suggest, a single hidden reminder asks for one (never while plan or goal automation owns the next step, and never after an interrupt).
- The suggestion is sanitized to one line (≤ 160 characters) and kept in memory only. It is cleared by your next prompt, a new run, typing, or branch navigation.

## Task tracking discipline

- `jar_todo write` is the normal way to establish the checklist for a new multi-step request. It represents the complete current plan, so completed work from an earlier request is naturally dropped.
- `update` changes one stable task id while preserving omitted fields and subtasks. `remove` deletes one task tree.
- `append` is for genuinely new work introduced while an existing checklist is still active, especially user steering or an added requirement. When the current checklist is already fully completed, start a fresh list with `write` instead of appending.
- `start` and `done` deliberately return/render only the single task they changed. Their structured result still carries the bounded checklist (the full list inside subagents) so parent/subagent progress mirroring remains accurate.
- Exactly one leaf task may be `in_progress`; starting another leaf parks the previous one. Parent status is derived from its subtasks.

## Change review

- A `tool_call` hook records a file's content right before the agent's **first** `edit` or `write` to it (project files only, up to 200 files, 1 MB each, text only). Later edits keep that baseline, so the review always shows everything since the agent started on the file.
- `/diff` (or <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd>) compares the baseline with the file on disk using a line diff with 3 lines of context. Files that are back to their baseline drop out.
- **Accept** forgets the baseline. **Revert** writes the baseline back (or removes a file the agent created) after a second key press to confirm. Errors are reported and the file stays listed.
- Baselines live in memory for the session; changes made through `bash` or by you are not tracked.
- **Subagent edits** join the same review in two ways. Retained `worktree` writers remain isolated while working, idle or paused. Only `jar_subagent stop` finalizes them: pi-jar verifies that each parent target still equals the private baseline snapshot, copies reviewable safe results back, then captures/marks those parent files in the normal `ChangeTracker`. The deprecated one-shot `write: true` shared-workspace mode keeps its older `PI_JAR_BASELINE_DIR` bridge for compatibility.

## Background shells

```text
jar_shell start {command, watch: "ready|error"}  →  s1 running
      ↓ output (ANSI stripped, last 2000 lines)
watch matches  or  process exits  →  pi-jar.shell message  →  agent wakes (or it is queued)
```

- Each shell runs `/bin/sh -c` in its own process group; `kill` sends SIGTERM to the group, then SIGKILL after 3 s. At most 8 run at once; the 20 most recent are kept.
- A watch fires once per shell. With `notify: false` nothing wakes the agent; it can still read `output`.
- In goal mode, starting a shell with a non-read-only command counts as a change and needs an open task, like `bash`.

## Subagents

- The main agent is the **moderator** while a retained fleet exists. A hidden bounded context lists the fleet and tells the parent to decompose, route, peek, steer, resolve disagreements and synthesize instead of duplicating a worker's task. The optional `moderator` role gives this purpose a configurable model without forcing a model switch.
- `jar_delegate` creates up to four retained agents per session. `scout` runs `pi --mode rpc --no-session`, is read-only and defaults to the `scout` role. `fork` uses `--fork <parent-session>`, is read-only and defaults to `reviewer`. `worktree` uses the same real context fork, defaults to `worker`, and runs in a detached disposable Git worktree. Explicit `task.role` overrides those defaults; each role uses its primary/fallback candidates before falling back to the parent's current model.
- Retained children do not exit on `agent_settled`. They become `idle`, keeping the same RPC process and model context. `jar_subagent pause` sends `clear_queue` + `abort` and leaves the agent `paused`; `resume` sends a new prompt to that same child. `steer` redirects a working child. `ask` injects a compact BTW question and waits for the next assistant answer, deliberately skipping an assistant response already streaming when the question was sent.
- `jar_subagent peek` is the moderator's cheap status surface: task, state, model/role/mode, checklist progress, current activity, changed files, remaining checklist leaves, workspace and last report. `stop` is destructive/final: abort an active operation if necessary, close the child, return a handoff (workspace, changed/applied files, remaining work, last report), and finalize safe worktree changes.
- Worktree setup snapshots the exact starting workspace: `HEAD` plus tracked dirty changes and non-ignored untracked files are committed only inside the detached worktree. The worktree persists across idle/pause/resume. On stop, the parent target must still byte/mode-match the snapshot and the change must be trackable by `/diff`; otherwise nothing is overwritten and the workspace/error is reported. The path guard rejects lexical and symlink escapes. Worktree children receive only `read,edit,write,grep,find,ls,jar_todo,jar_discuss`; shell tools are absent. This is filesystem-write isolation, not a network/process sandbox.
- `jar_discuss` gives moderator and children a session-scoped structured paper. `ask` appends a question with stable id/from/to fields, `answer` references the question id, and `list` reads recent entries. Text is capped at 1600 characters per entry, at most 64 entries are retained, and the JSON paper is bounded around 64 KB with atomic rewrites. It is intentionally for terse inter-agent Q/A rather than another transcript.
- Fork/worktree children inherit the parent model conversation but reset pi-jar goal/plan/todo automation. All child modes inherit explicit extension flags, set `PI_JAR_CHILD=1` to prevent recursive delegation, and share the discussion-paper path/name through environment variables.
- Progress (current tool, streaming text, tools used, turns, cost) stays in the activity view. Retained `idle` and `paused` agents remain visible in the footer/activity fleet; the newest eight retired agents remain for review. `s` in the activity view still steers a working subagent and `x` stops the selected agent through the same registry.
- The deprecated `write: true` mode remains a one-shot shared-workspace compatibility path. New delegated implementation should use `mode: "worktree"`.

## Sessions and prompt history

- The welcome loads the three most recent sessions for the project (excluding the current one and empty ones) in the background, reading each file (up to 8 MB) for its latest pi-jar goal and plan title.
- Clicking a recent row stages `/jar resume N` in the composer (switching sessions needs a command); `/jar resume` alone opens the searchable picker.
- <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>H</kbd> collects every user prompt in the current session file (all branches, newest first) plus the opening prompt of up to 50 recent sessions, deduplicated, and fuzzy-filters as you type.
