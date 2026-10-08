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

Tests isolate `PI_CODING_AGENT_DIR`, so they never touch your real preferences. Suites cover the flame simulation, welcome layout and hit-testing, composer framing/expansion/ghost text/mouse mapping, the mascot, plan mode (guards, submission, reminders, restore), the plan view, plan parsing, the goal loop, roles v2, suggestions, settings and the cache-break diagnostic (payload fingerprints for Anthropic and OpenAI shapes, diff classification, usage correlation, the `/cache-breaks` tab). `tests/cache-payloads.ts` builds the provider payloads those suites share.

Manual smoke test (offline, throwaway agent directory, nothing sent to a model):

```bash
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
PI_CODING_AGENT_DIR="$(mktemp -d)" pi -e ./extensions
```

Then check:

- the welcome at 24, 40, 80 and 120+ columns; <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> refresh; motion off (`/jar animations off`) freezes the flame;
- the composer: typing `/pl` shows autocomplete below the frame; long drafts grow before scrolling; Ember changes mood while dialogs are open;
- `/jar settings`: Tab through Appearance → Footer → Pi; cycle Unicode/Nerd Font/ASCII icons and toggle mouse mode in the temporary agent dir;
- `/jar sessions`: search, move between rows, inspect the selected prompt/goal/plan, then resume; the footer session name or `sessions` indicator opens the same picker;
- `/jar activity`: select a subagent or background shell, scroll its live transcript/output, pause and resume follow, `Tab` into a subagent's transcript and expand/collapse entries, steer it with `s`, and stop/kill only the selected run;
- `/roles`: the split manager, `n` new role, `a` alias, `s` scope;
- `/plan`: the status shows `◆ PLAN · read-only` and a directory appears under `$TMPDIR/pi-jar/plans/`.
- `/cache-breaks`: a fresh session reports no breaks and `/usage` has a **Cache** tab; with a logged-in model, activate an extra tool (or edit an earlier message through an extension) mid-session and expect `cache break: …` after the next call, plus a line in `pi-jar-cache-breaks/<session id>.jsonl` under the temporary agent directory; **Pi → Cache diagnostics** off silences both.

For pointer interaction start with `--tui-mode fullscreen` (or enable **Pi → Mouse clicks** and restart). Check that welcome actions fire once per press, that footer activity rows open their matching details, that the footer session indicator opens search, that clicking composer text moves the cursor, that clicking Ember pokes it, that plan-view headings and actions respond to clicks and the wheel, and that selecting text anywhere still copies it. In regular mode use `/jar activity` and `/jar sessions` instead.

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

## Publishing

pi-jar is published to npm as `pi-jar`. The `pi-package` keyword lists it in the [Pi package gallery](https://pi.dev/packages), and `pi.image` in `package.json` supplies the gallery preview (the demo GIF, served from GitHub rather than shipped in the tarball).

1. `npm run check && npm test`
2. Bump `version` in `package.json`, commit and push.
3. `npm pack --dry-run` — the tarball holds `extensions/`, `src/`, `themes/`, `docs/*.md`, `README.md` and `LICENSE` only.
4. `npm login` (once), then `npm publish`.
