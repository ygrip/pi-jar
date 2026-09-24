# pi-jar

A role-aware, animated theme and TUI extension for [Pi](https://github.com/earendil-works/pi), inspired by the visual language of Setara and the multi-agent character of Punakawan.

> **Status:** themed footer and public-status adapter for `@earendil-works/*` Pi 0.85.1. Team Mode, Advisor Flow and SoL-Pi do not yet publish a pi-jar role contract here.

## What pi-jar is

pi-jar is not just a color theme. It is a Pi package that combines:

- a Setara teal × Punakawan navy dark theme with six optional Punakawan-inspired accent presets;
- observed Pi working states with steady, theme-colored wording and animated icons (static when motion is off);
- publisher-driven teammate names and labels (including Gareng, Petruk or Bagong if a publisher uses them);
- a responsive, softly rounded footer for model, colorized live thinking effort, session name, CWD, context percentage, process RAM (RSS), session cost, quota, branch and extension statuses; configure fields through `/jar settings` or `/jar footer`;
- a welcome that remains until the first interactive prompt, then dissolves away (or hides immediately with motion off), with a taller torch-shaped `π`, warm truecolor flame layers, drifting/fading embers, randomized hopeful copy, and a Settings action that opens the settings view from both regular and fullscreen TUI modes;
- a first-party, branch-aware native task tool that the agent is instructed to maintain automatically for multi-step work, plus a human-friendly `/jar tasks` view;
- first-class `/plan` mode with real read-only tool gating, a dedicated plan review TUI, and explicit **implement now**, **compact then implement**, or **stop** actions;
- a first-class `jar_ask` model tool for described numbered choices, multi-select checkboxes, custom pasted/multiline answers, and a **Chat about this** escape hatch;
- a branch-aware `/goal` that stays visible in the footer and is injected into the agent context so `jar_todo` follows the active outcome automatically;
- configurable `/roles` model assignments (`default`, `smol`, `slow`, `plan`, `commit`, `task`, `advisor`) with provider/model and optional thinking effort; the `plan` role is applied automatically while `/plan` is active;
- a rounded composer with a tiny expressive terminal pet whose silhouette, ears/arms and eyes react to activity, plus a human session title; when Pi has no title, pi-jar derives a stable readable alias instead of exposing the raw thread id;
- a centralized full-screen visual settings view with keyboard controls and clickable controls when Pi receives mouse events;
- compact-by-default rendering for Pi's default read/shell/edit/write tools, with the real output or diff still available through click or Ctrl+E (Pi's native Ctrl+O also works);
- a separate read-only `/jar history` conversation timeline for the active session branch.

The design rule is simple: **role visibility first, useful telemetry second, decoration last.**

## Install

Install directly from GitHub:

```bash
pi install git:github.com/ygrip/pi-jar
```

Then select the theme from Pi settings:

```text
/settings
```

Choose `pi-jar-dark` (Setara teal), or a `pi-jar-dark-<accent>` theme (`gray`, `pink`, `teal`, `azure`, `violet`, `amber`). For the closest dark-surface match, set your terminal background to `#0B1018`—Pi themes cannot change the terminal emulator background. If you load only `extensions/index.ts` using `--extension`, Pi does **not** discover the adjacent `themes/` directory: install the package with `pi install /absolute/path/to/pi-jar` and restart Pi, or start Pi with both `--extension /absolute/path/to/pi-jar/extensions/index.ts --theme /absolute/path/to/pi-jar/themes`. Do not load the extension twice (via both package and `--extension`).

The extension is loaded by the package automatically. Use:

```text
/jar
/jar settings
/jar status
/jar history
/jar hub
/jar tasks
/jar tasks add Ship the UI
/plan
/plan Audit this repository before changing it
/goal Ship the first-class workflow UX
/roles
/roles plan
/jar ask What should we name this?
/jar composer on
/jar composer off
/jar accent violet
/jar accent default
/jar quota on
/jar demo
/jar reset
```

`/jar` and `/jar settings` open visual preferences in interactive mode; `/jar status` prints the status summary. Click `[ ⚙ Settings ↗ ]` on the welcome in either regular or fullscreen mode. In regular mode pi-jar temporarily enables click-only mouse reporting while the welcome is visible, then restores the terminal as soon as the welcome closes. In the pane, Tab switches Appearance/Footer, arrows move, Enter/Space or click changes a value, and Esc closes. Visual preferences (accent, motion, composer, UI and footer fields) are saved in `~/.pi/agent/pi-jar-settings.json` (or Pi's configured agent directory). Existing `pi-jar-footer.json` choices are imported when the new file is absent; that legacy file remains unchanged afterward. Later edits by a downgraded version will not sync back. Quota requests are enabled by default for supported OAuth providers and remain session-only; `/jar quota off` disables them for the session.

`Ctrl+Alt+S` opens pi-jar settings directly in interactive TUI mode.


## First-class workflows

### Plan mode

`/plan` enters a real read-only planning mode. Pi-jar snapshots the current active tool set, keeps only recognized read/query tools, restricts `bash` to a conservative inspection allowlist, and adds a second `tool_call` guard so an unsafe call is blocked even if another extension exposes it. Unknown third-party tools fail closed while plan mode is active.

Use `/plan REQUEST` to enter plan mode and immediately send the planning request. The agent must finish with a numbered `Plan:` section. Pi-jar then opens a dedicated review surface with three explicit paths:

1. **Implement now** — restore the prior tools/model and execute with the current context.
2. **Compact, then implement** — preserve the approved plan through Pi compaction, restore execution access, then continue.
3. **Stop here** — leave plan mode without starting implementation.

Approved plan steps are seeded into the same branch-aware `jar_todo` store, so execution progress is visible instead of evaporating into prose. `/plan stop` also exits without implementation. If a `plan` model role is assigned, pi-jar switches to it only for planning and restores the previous model and effort afterward.

### Structured questions

Pi-jar registers `jar_ask` as a first-class model tool. The agent can present one or more questions using numbered options with descriptions, single-select radio choices, multi-select checkboxes, and clear visual badges/chips. Every question can expose **Type your own answer** and **Chat about this**. Free-form answers use Pi's multiline editor, so normal terminal paste and the external-editor workflow remain available.

`Chat about this` deliberately returns control to the model without pretending a choice was made; after discussing the ambiguity, the agent can ask again with a refined set of options.

### Goal

`/goal OUTCOME` stores an active goal in the current Pi session branch and displays `◎ goal · …` in the pi-jar footer. On every agent run, pi-jar injects the current goal plus guidance to keep `jar_todo` synchronized with concrete work toward it. Branch navigation and compaction restore the matching goal state instead of leaking it into another thread.

Run `/goal` to edit/view it interactively, or `/goal clear` to remove it.

### Model roles

`/roles` opens role assignment. Each role can follow the current model or be pinned to any authenticated model exposed by Pi's model registry, with an optional thinking effort. Assignments are stored in `~/.pi/agent/pi-jar-roles.json` (or Pi's configured agent directory).

Roles: `default`, `smol`, `slow`, `plan`, `commit`, `task`, and `advisor`. Use `/roles ROLE` to activate one immediately. Headless configuration is also available:

```text
/roles set plan anthropic/claude-sonnet-5 high
/roles set smol openai-codex/gpt-5.6-codex-mini low
/roles clear advisor
```


`/jar history` opens a **separate** read-only conversation timeline; Pi's native transcript is not restyled or changed. It snapshots the active branch on open (reopen after branching or new replies), pages through 80 visible entries at a time (`p` older, `o` newer), and shows user/assistant turns, tool calls/results, compactions and branch summaries; hidden custom entries, reasoning text and image payloads stay hidden. Arrows/j/k and PgUp/PgDn navigate; `e`/Enter expands details, `d`/`u` scroll details, `[`/`]` step through contiguous output segments of at most 2 KiB/30 lines, `/` searches up to the first 1024 characters of each entry **on the current page**, `n`/`N` advances through matches, Esc closes. Fullscreen supports click/wheel; regular mode is keyboard-only. The view sanitizes terminal control sequences but still shows ordinary session text, which may contain sensitive material; it never writes or logs that content.

`/jar accent` lists the presets **Pi has loaded**; `/jar accent <gray|pink|teal|azure|violet|amber|default>` switches only loaded bundled color themes and keeps success/warning/error meanings intact. In a source checkout, `npm run themes:build` regenerates the accent themes from the base JSON and the dark Punakawan presets. Pi-jar registers a native `jar_todo` model tool and instructs the agent to use it proactively for requests with two or more substantive steps: it lists existing branch tasks first, adds missing outcomes, and marks them done as work completes. The state is persisted as Pi session entries and follows the active branch through navigation/compaction. `/jar tasks` is the human view/editor for the same list; it is no longer something the user must trigger to make tracking happen. It remains separate from Team Mode's `/tasks`. In the task view: `a` add, Space/Enter check, `e` edit, `d` delete with confirmation, `f` filter, Esc close. Headless commands include `/jar tasks list|add TITLE|done ID|open ID|edit ID TITLE|delete ID`. `/jar hub` still opens installed `/tasks` or `/subagents-fleet` managers, which retain their own state and controls. `/jar ask QUESTION` opens a pi-jar-owned answer dialog and inserts the answer into the editor without submitting it. Pi Jar enables a rounded composer with a steady focus accent at session start using Pi's `CustomEditor` (native application keybindings). Its title carries a small expressive pet sprite plus Pi's session title (or a stable readable alias such as `silver-lantern`), so parallel sessions are distinguishable without exposing a raw thread id; `/jar composer off` restores the previous editor and `/jar composer on` re-enables it. `/jar quota on` re-enables **session-local, read-only** quota requests for the active Codex/Anthropic OAuth provider, only when no valid public quota status is published. Requests use Pi's resolved OAuth credentials, a 5-second timeout and a 5-minute cache; unsupported/unavailable quotas are hidden. `/jar quota off` clears the cache and stops requests. Provider quota endpoints are not stable public APIs. Live role IDs, names, labels, tasks and states come from published `pi-jar.role.<id>` statuses—not from a fixed list or Team Mode internals. Without a publisher no live role appears. `/jar demo` previews **generic sample roles** and is explicitly labeled `DEMO`; it does not report live agent activity. `/jar animations off` disables role, working-indicator and welcome motion. `/jar welcome` replays the nonblocking animated flame and large-π welcome with the session overview until the next interactive prompt; `/jar ui off` restores Pi's built-in footer (`/jar ui on` re-enables pi-jar). Pi-jar only re-renders Pi's default read/bash/edit/write cards; third-party and MCP tool views remain untouched. Composer styling is enabled by default and restores the prior editor on disable.

## Current preview

```text
 DEMO  claude-sonnet effort high                 ctx 58%
 EXP ◈ analyze  ·  BLD ◐ implement  ·  REV ◇ waiting
```

The footer adapts to terminal width, truncates long names and paths, and prioritizes an active/failed role and context on narrow screens. The old `jar` prefix was branding, not a mode, so it is removed; `DEMO` still marks synthetic roles. Live model effort (`off` through `max`) uses the theme's distinct thinking colors. `/jar footer` remains a compatibility menu; its choices now save in `pi-jar-settings.json`. Session cost uses Pi-reported assistant costs on the current session branch (it may be zero for subscription usage). With no published role signals, no role is invented. Other extensions' published status texts remain visible when space allows.

## Design direction

**Setara influence**

- clean technical surfaces;
- cyan/blue precision accents;
- readable hierarchy;
- low-noise information density.

**Punakawan influence**

- warm amber/green secondary palette;
- visible named roles;
- orchestration state as part of the UI;
- distinct role motion rather than generic spinners.

The result should feel like one coherent terminal interface, not two products taped together.

## Repository structure

```text
pi-jar/
├── extensions/          Pi extension entry point
├── src/                 UI state and animation primitives
├── themes/              Native Pi themes
└── docs/
    ├── PLAN.md
    ├── DESIGN.md
    ├── INTEGRATIONS.md
    └── DEVELOPMENT.md
```

## Roadmap

The implementation plan lives in [docs/PLAN.md](docs/PLAN.md). The major milestones are:

1. foundation and theme;
2. responsive role-aware footer;
3. optional adapters when Team Mode publishes supported role events/statuses;
4. optional Advisor Flow and SoL-Pi status adapters when public signals exist;
5. configurable presets and packaging polish.

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
