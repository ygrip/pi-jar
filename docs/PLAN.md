# pi-jar roadmap

## Goal

A polished Pi package where the agent's work is visible at a glance, motion communicates useful state, and the core workflows (planning, goals, roles) are enforced rather than merely suggested.

## Principles

1. **State first.** You should always know what is running, what is waiting on you, and what is done or failed.
2. **Motion has meaning.** Animate only active work or important events; everything works with motion off.
3. **Enforce through public APIs.** Tool sets, `tool_call` guards, hidden context, `agent_before_settle` continuations and session entries. Never scrape another extension's private data.
4. **Responsive by default.** Narrow terminals get compact layouts, never wrapped dashboards.
5. **Low overhead.** Idle pi-jar does not repaint continuously; timers are unref'd and stop with the session.

## Done

### Foundation and visuals

- [x] Pi package manifest; Pi core packages as `"*"` peer dependencies; tested against the latest Pi
- [x] dark theme with six accent variants; generated with `npm run themes:build`
- [x] responsive footer (model, effort, session, cwd, context, RAM, cost, quota, goal, roles, branch)
- [x] pixel-fire welcome flame with embers, sparks, wind and a deterministic frozen frame for motion-off
- [x] welcome card with workspace, workflow and role state, plus clickable actions (fullscreen) or keyboard hints (regular)
- [x] persisted visual settings with Appearance, Footer and Pi tabs

### Composer

- [x] rounded frame that keeps autocomplete below it and overflow counts in the borders
- [x] auto-expanding input (≈60% of the terminal) and click-to-place cursor in fullscreen
- [x] Ember mascot with moods for idle, blink, generating, tools, dialogs, sleepy, error, goal completion and poke
- [x] next-prompt suggestions as dim ghost text, accepted with Tab

### Workflows

- [x] plan mode: read-only gating, plan directory write guard, `jar_plan_submit` validation, reminders, split plan view, approve/compact/refine/stop, continue-with role
- [x] goal mode: task gate, implementor continuation, advisor audit, evidence-based completion, round budget, pause/resume
- [x] model roles v2: aliases, effort suffixes, custom roles, project overrides, cycle order, split manager
- [x] `jar_todo` branch-aware checklist and `/jar tasks`
- [x] `jar_ask` structured questions
- [x] `/jar history` read-only timeline
- [x] publisher-driven teammate roles and quota windows
- [x] change review (`/diff`): per-file baselines, split diff view, accept/revert
- [x] background shells (`jar_shell`) with watch patterns that wake the agent
- [x] parallel subagents (`jar_delegate`) on model roles, shown as live teammates
- [x] composer image chips and prompt history search
- [x] recent-session gallery on the welcome card and `/jar resume`

## Next

- [ ] screenshots/GIF of the welcome, composer and plan view
- [ ] plan view: inline notes per section fed into **Refine**; section delete with undo
- [ ] goal mode: optional token or time budget alongside the round budget
- [ ] roles: per-role fallback chains when a model is unavailable
- [ ] tasks: optional in-progress state, grouping and priorities
- [ ] presets (minimal / normal / verbose / focus) for the footer
- [ ] optional light theme, if it keeps the same identity
- [ ] terminal checks: iTerm2, Ghostty, WezTerm, VS Code, tmux
- [ ] changelog and release process

## Non-goals

pi-jar does not:

- become a multi-agent orchestrator or own other extensions' task execution;
- keep a second source of truth for another extension's state;
- change Pi's native transcript, keybindings or clipboard as a side effect (Pi settings change only when you toggle them in the Pi tab).
