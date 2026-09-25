# Development

## Requirements

- Node.js 22.6+ (native TypeScript test runner)
- npm
- a current Pi installation

## Local setup

```bash
git clone https://github.com/ygrip/pi-jar.git
cd pi-jar
npm install
npm run check
npm test
```

## Load locally in Pi

Install the working copy as a local Pi package:

```bash
pi install "$(pwd)"
```

Or run against a temporary checkout without publishing it.

Use `pi list` to verify the package is loaded. Loading only `--extension ./extensions/index.ts` does not register bundled themes: either install the package and restart Pi, or also pass `--theme ./themes` for a standalone development run. Avoid loading the extension twice by combining a package install with `--extension`.

## Theme testing

Select a theme with `/settings`: `pi-jar-dark`, or a `pi-jar-dark-<accent>` variant (gray/pink/teal/azure/violet/amber). Accent themes are generated from `src/accent.ts` and `themes/pi-jar-dark.json` with `npm run themes:build`. Pi hot-reloads custom theme files; package development may need `/reload`.

Check user messages, tool pending/success/error states, diffs, markdown, syntax highlighting, every thinking level, bash mode, and narrow and wide terminals.

## Extension testing

Automated:

```bash
npm run check      # tsc --noEmit
npm test           # node:test suites in tests/
```

Tests isolate `PI_CODING_AGENT_DIR`, so they never touch your real preferences. Suites cover the flame simulation, welcome layout and hit-testing, composer framing/expansion/ghost text/mouse mapping, the mascot, plan mode (guards, submission, reminders, restore), the plan view, plan parsing, the goal loop, roles v2, suggestions and settings.

Manual smoke test (offline, throwaway agent directory, nothing sent to a model):

```bash
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
PI_CODING_AGENT_DIR="$(mktemp -d)" pi -e ./extensions
```

Then check:

- the welcome at 24, 40, 80 and 120+ columns; <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> refresh; motion off (`/jar animations off`) freezes the flame;
- the composer: typing `/pl` shows autocomplete below the frame; long drafts grow before scrolling; Ember changes mood while dialogs are open;
- `/jar settings`: Tab through Appearance → Footer → Pi, toggle mouse mode and check Pi's `settings.json` in the temporary agent dir;
- `/roles`: the split manager, `n` new role, `a` alias, `s` scope;
- `/plan`: the status shows `◆ PLAN · read-only` and a directory appears under `$TMPDIR/pi-jar/plans/`.

For pointer interaction start with `--tui-mode fullscreen` (or enable **Pi → Mouse clicks** and restart). Check that welcome actions fire once per press, that clicking composer text moves the cursor, that clicking Ember pokes it, that plan-view headings and actions respond to clicks and the wheel, and that selecting text anywhere still copies it.

With a logged-in model, run end to end:

1. `/plan add a hello command`: the agent writes `<slug>-plan.md`, submits it, the plan view opens; approve and watch `jar_todo` fill from the Approach steps.
2. `/goal add a hello command with a test`: edits are blocked until tasks exist; the loop continues while tasks are open, then runs an audit and completes with evidence.
3. After an ordinary request, a dim suggestion appears in the input; <kbd>Tab</kbd> accepts it.

`/jar history` uses the public active-branch `getBranch()` snapshot and `ctx.ui.custom` overlays: `p`/`o` page, `/` search, `n`/`N` matches, `e` expand, `d`/`u` scroll details, `[`/`]` output chunks, <kbd>Esc</kbd> closes. It never mutates the branch.

## Development rules

- keep idle CPU and repaint overhead negligible (unref timers, render only on change);
- use Pi's public extension API; do not couple to other extensions' internals;
- keep role rendering generic;
- no decorative animation that carries no state; preserve behavior with motion off;
- never swallow pointer drags in pi-jar views (selection and copy-on-select belong to Pi);
- tolerate hosts without optional APIs (`registerTool`, `registerShortcut`, mouse).

## Startup performance

pi-jar adds about 0.2 s to Pi's first render (mostly module import). To keep startup lean it never blocks `session_start`: the provider quota lookup, the welcome's recent-session scan and its `git` calls start 1.5 s after the session starts, and the card and footer fill in when they finish.

Most startup time in a full setup comes from extension loading, which Pi does one package at a time. Measure a package by launching it alone (`pi -ne -e <path>`) and compare with `pi --no-extensions`. Large packages and ones installed from git (loaded as TypeScript source) cost the most, and the first launch after `pi update` is slow while Pi rebuilds its transpile cache. Keep rarely used packages out of the global `packages` list (load them with `-e`, or in project settings).
