# pi-jar implementation plan

## Goal

Build a polished Pi package where multi-agent activity is visible at a glance and motion communicates useful state.

pi-jar should combine:

- a restrained Setara-influenced technical palette;
- publisher-driven teammate visibility, with Punakawan-inspired visual identity;
- responsive telemetry for long coding sessions;
- animations that represent work, not decoration.

## Principles

1. **Role visibility first.** The user should know who is working, waiting, reviewing, done, or failed.
2. **Motion has meaning.** Animate only active work or important system events.
3. **Two moving elements max.** Avoid a terminal full of competing motion.
4. **Responsive by default.** Narrow terminals get compact role glyphs instead of wrapped dashboards.
5. **Integrate through public surfaces.** Prefer Pi extension events/statuses and documented APIs. Do not scrape another extension's private files unless no stable integration exists.
6. **Low overhead.** Idle pi-jar should not continuously repaint the TUI.

## Phase 0 — Foundation

Status: **started**

- [x] Pi package manifest
- [x] MIT license
- [x] dark theme
- [x] animated working indicator
- [x] responsive custom footer
- [x] role state model
- [x] demo mode
- [x] design/integration/development docs
- [x] validate against current Pi with `npm run check`
- [ ] add screenshot/GIF once visual baseline is stable

## Phase 1 — Visual system

- [ ] tune palette against real Pi surfaces
- [ ] verify all tool states, diffs, Markdown, thinking levels, and bash mode
- [ ] add optional light theme only if it can maintain the same identity
- [ ] define compact, normal, verbose, and focus presets
- [ ] add animation speed and animation-off settings
- [ ] persist configuration

Target commands:

```text
/jar minimal
/jar normal
/jar verbose
/jar focus
/jar animations on
/jar animations off
```

## Phase 2 — Publisher-driven roles; optional Team Mode bridge

- [x] render arbitrary teammate IDs, names and labels from the public `pi-jar.role.<id>` status contract
- [x] keep `/jar demo` explicitly synthetic, with generic Explorer/Builder/Reviewer examples
- [x] hide stale statuses and handle concurrent published teammates
- [ ] discover a stable public Team Mode publisher/API before claiming any Team Mode role integration
- [ ] map authoritative spawned teammate names, tasks and lifecycle only when that integration exists
- [ ] display published worktree/branch details only in verbose mode
- [ ] verify animation stops on completion/failure

Example **published** states (not automatic Team Mode data):

```text
EXP ◈ analyze
BLD ◐ implement
REV ◇ waiting
```

Completion:

```text
EXP ✓   BLD ✓   REV ◐ review
```

## Phase 3 — Advisor Flow and SoL-Pi

### Advisor Flow

- [ ] show idle/consulting/completed advisor state
- [ ] animate only while a consultation is active
- [ ] expose advisor model in verbose mode

### SoL-Pi

- [ ] show enabled/disabled state
- [ ] indicate compaction/reduction only while active
- [ ] avoid duplicating context/token telemetry already rendered by Pi

Example:

```text
TEAM 2  ADV ◈ consult  SOL ✓  ctx 58%
```

## Phase 4 — Activity rail

Add an optional workflow rail for sequential role work:

```text
EXP ✓ ─── BLD ◐ ─── REV ◇
```

Requirements:

- [ ] activity rail is optional
- [ ] no fake dependency inference
- [ ] support parallel work without implying sequential ordering
- [ ] collapse automatically on narrow terminals

## Phase 5 — Packaging and release

- [ ] automated typecheck
- [ ] compatibility matrix for supported Pi versions
- [ ] terminal checks: iTerm2, Ghostty, WezTerm, VS Code
- [ ] screenshot/GIF
- [ ] npm package metadata
- [ ] changelog/release process
- [ ] v0.1 release

## Interactive TUI progress and remaining roadmap

Base working-state, to-do and pi-jar question UI is implemented; refinements below remain planned. All interactive views must use supported `@earendil-works/*` Pi APIs and preserve Pi's native prompt editor and tool views.

### Phase 6 — Interactive input and question layout

- [x] Add themed question/answer and confirmation dialogs using `ctx.ui.custom()` and Pi's `Input` component for **pi-jar-owned** prompts, with question, options, selected answer and Escape/cancel path.
- [x] Add opt-in `/jar composer on|off`: wrap a prior editor factory when publicly available, otherwise keep Pi's default editor and decorate with a small widget. Restore only the editor pi-jar still owns and preserve the draft. Preserve Pi keybindings, multiline input, accessibility and the user's draft; do not intercept Pi or other extensions' question dialogs without a supported hook.
- Provide a non-TUI command fallback. Verify keyboard-only navigation, focus and narrow-terminal behavior.

### Phase 7 — Interactive status

- Add a drill-down view for public teammate statuses, Pi context and session cost, and available quota windows. Show each source, last-update/expiry, and an honest unavailable state.
- Link to `/tasks` and `/subagents-fleet` when installed; neither source becomes merged or inferred task/subagent state.

### Phase 8 — Collapse and expand

- Add keyboard-accessible, width-aware toggles for pi-jar's own status, help and task sections; preserve focus and state on resize/reload.
- Native tool output can use Pi's documented `ctx.ui.getToolsExpanded()` / `setToolsExpanded()`; do not intercept or replace arbitrary transcript rendering.

### Phase 9 — Copy on selection

- Respect Pi's built-in fullscreen selection: `fullscreenCopyOnSelect` is already on by default and copies a completed selection; when disabled, `Ctrl+X` copies the highlighted selection.
- In regular mode, the terminal owns selection/clipboard behavior. Avoid swallowing pointer drags in pi-jar views. Do not change the user's clipboard setting, invent a global selection hook, or promise auto-copy where the terminal does not support it.

### Phase 10 — First-party pi-jar to-do and task view

- [x] `/jar tasks` owns a separate session-scoped list with stable IDs, checkable open/done items, add/edit/filter and confirmed TUI deletion; includes keyboard-accessible actions, a compact widget and an interactive view.
- [x] Replay supported custom session entries on reload and branch navigation with malformed-entry safety and focused tests.
- [ ] Add optional in-progress state, grouping and priorities; keep manual to-do status distinct from agent execution. Distinguish manual to-dos from agent work: checking an item does not claim Team Mode completion.
- Keep Team Mode `/tasks` and pi-subagents `/subagents-fleet` available through `/jar hub`. Never import their private task state or imply bidirectional sync. Label each view by its actual owner. This is a task-tracking UI, not an agent orchestration or task-execution engine.

### Phase 11 — Expressive working-state presentation

- [x] Use Pi's public lifecycle events, `setWorkingMessage()` and `setWorkingIndicator()` for concise varied wording, colors and animated icons **only** for observed generation/tool execution. No hidden-reasoning claims or fake Claude state.
- [x] Keep text legible without color, limit frame rate and freeze motion with `/jar animations off`; no idle repaint. Further error-state polish and visual feedback remain future work.

## Non-goals

pi-jar should not:

- become an agent orchestrator or own task execution;
- replace Team Mode, Advisor Flow, or SoL-Pi;
- maintain a second source of truth for their agent or task state;
- modify native Pi editor, transcript or clipboard settings as a side effect.

The existing pi-jar UI remains a **visual integration layer**; the proposed first-party task list would own only its separately created tasks.
