# pi-jar

A role-aware, animated theme and TUI extension for [Pi](https://github.com/earendil-works/pi), inspired by the visual language of Setara and the multi-agent character of Punakawan.

> **Status:** themed footer and public-status adapter for `@earendil-works/*` Pi 0.85.1. Team Mode, Advisor Flow and SoL-Pi do not yet publish a pi-jar role contract here.

## What pi-jar is

pi-jar is not just a color theme. It is a Pi package that combines:

- a Setara teal × Punakawan navy dark theme with six optional Punakawan-inspired accent presets;
- observed Pi working states with steady, theme-colored wording and animated icons (static when motion is off);
- publisher-driven teammate names and labels (including Gareng, Petruk or Bagong if a publisher uses them);
- a responsive, softly rounded footer for model, session name, CWD, context percentage, session cost, optional 5-hour/weekly quota, branch, and extension statuses; all fields can be toggled in `/jar footer`;
- a welcome that remains until the first interactive prompt, then dissolves away (or hides immediately with motion off), with rising smoke, animated fire, a gap and a large static pixel `π`;
- a first-party session-scoped to-do list and themed pi-jar question dialogs, separate from Team Mode;
- a rounded composer with a steady focus accent that uses Pi's editor keybindings, plus a truthful fallback when external integration state is unavailable.

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
/jar hub
/jar tasks
/jar tasks add Ship the UI
/jar ask What should we name this?
/jar composer on
/jar composer off
/jar accent violet
/jar accent default
/jar quota on
/jar demo
/jar reset
```

`/jar accent` lists the presets **Pi has loaded**; `/jar accent <gray|pink|teal|azure|violet|amber|default>` switches only loaded bundled color themes and keeps success/warning/error meanings intact. In a source checkout, `npm run themes:build` regenerates the accent themes from the base JSON and the dark Punakawan presets. `/jar tasks` is pi-jar's **own** to-do list, persisted in Pi session entries; it does not display or synchronize Team Mode's `/tasks`. In the task view: `a` add, Space/Enter check, `e` edit, `d` delete with confirmation, `f` filter, Esc close. Headless commands include `/jar tasks list|add TITLE|done ID|open ID|edit ID TITLE|delete ID`. `/jar hub` still opens installed `/tasks` or `/subagents-fleet` managers, which retain their own state and controls. `/jar ask QUESTION` opens a pi-jar-owned answer dialog and inserts the answer into the editor without submitting it. Pi Jar enables a rounded composer with a steady focus accent at session start using Pi's `CustomEditor` (native application keybindings); `/jar composer off` restores the previous editor. `/jar composer on` re-enables it. `/jar quota on` allows **session-local, read-only** quota requests for the active Codex/Anthropic OAuth provider, only when no valid public quota status is published. Requests use Pi's resolved OAuth credentials, a 5-second timeout and a 5-minute cache; unsupported/unavailable quotas are hidden. `/jar quota off` clears the cache and stops requests. Provider quota endpoints are not stable public APIs. Live role IDs, names, labels, tasks and states come from published `pi-jar.role.<id>` statuses—not from a fixed list or Team Mode internals. Without a publisher no live role appears. `/jar demo` previews **generic sample roles** and is explicitly labeled `DEMO`; it does not report live agent activity. `/jar animations off` disables role, working-indicator and welcome motion. `/jar welcome` replays the nonblocking smoke, flame and large-π welcome and session overview until the next interactive prompt; `/jar ui off` restores Pi's built-in footer (`/jar ui on` re-enables pi-jar). The native tool views remain untouched; composer styling is enabled by default and restores the prior editor on disable.

## Current preview

```text
 jar DEMO  claude-sonnet                          ctx 58%
 EXP ◈ analyze  ·  BLD ◐ implement  ·  REV ◇ waiting
```

The footer adapts to terminal width, truncates long names and paths, and prioritizes an active/failed role and context on narrow screens. `/jar footer` opens a visibility menu for all footer fields; choices are saved across sessions in `~/.pi/agent/pi-jar-footer.json` (or Pi's configured agent directory). Session cost uses Pi-reported assistant costs on the current session branch (it may be zero for subscription usage). With no published role signals, no role is invented. Other extensions' published status texts remain visible when space allows.

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
