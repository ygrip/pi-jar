# pi-jar implementation plan

## Goal

Build a polished Pi package where multi-agent activity is visible at a glance and motion communicates useful state.

pi-jar should combine:

- a restrained Setara-influenced technical palette;
- Punakawan-style named role visibility;
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
- [ ] validate against current Pi with `npm run check`
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

## Phase 2 — Role-aware Team Mode integration

- [ ] discover Team Mode's stable public status/events
- [ ] map spawned teammate name, task, and lifecycle into `RoleStatus`
- [ ] show arbitrary teammates, not only Gareng/Petruk/Bagong
- [ ] keep Gareng/Petruk/Bagong as first-class default aliases
- [ ] support concurrent teammates
- [ ] display worktree/branch only in verbose mode
- [ ] stop role animation immediately on completion/failure
- [ ] hide stale teammates safely

Desired states:

```text
GAR ◈ analyze
PET ◐ implement
BAG ◇ waiting
```

Completion:

```text
GAR ✓   PET ✓   BAG ◐ review
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
GAR ✓ ─── PET ◐ ─── BAG ◇
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

## Non-goals

pi-jar should not:

- become an agent orchestrator;
- replace Team Mode;
- replace Advisor Flow;
- replace SoL-Pi;
- own task execution;
- maintain a second source of truth for agent state.

It is a **visual integration layer** for Pi.
