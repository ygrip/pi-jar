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

Select:

```text
/settings
```

and choose `pi-jar-dark`, or a `pi-jar-dark-<accent>` variant (gray/pink/teal/azure/violet/amber). Accents are generated from `src/accent.ts` and `themes/pi-jar-dark.json` with `npm run themes:build`. The original dark accent values are documented in `../GDN/punakawan/web/panel/src/lib/accent.ts`; do not edit that reference to change pi-jar.

Pi hot-reloads custom theme files when they are loaded as normal custom themes. Package development may require `/reload` depending on how the package is loaded.

Check:

- user messages;
- tool pending/success/error states;
- diffs;
- Markdown;
- syntax highlighting;
- all thinking levels;
- bash mode;
- narrow and wide terminal widths.

## Extension testing

Useful commands:

```text
/jar
/jar settings
/jar status
/jar history
/jar hub
/jar welcome
/jar tasks
/jar tasks add Review docs
/jar ask How should we phrase this?
/jar composer on
/jar composer off
/jar accent
/jar accent violet
/jar accent default
/jar quota on
/jar quota off
/jar demo
/jar reset
/jar animations off
/jar animations on
/jar ui off
/jar ui on
```

For pointer interaction start `pi --tui-mode fullscreen` (or `pit --tui-mode fullscreen`). The welcome's `[ Settings ↗ ]` and the settings overlay use Pi's fullscreen mouse routing; regular mode keeps the terminal's native selection/scrollback and the `/jar settings` keyboard path. Tab switches pane sections; arrows, Space/Enter and Esc navigate. Footer visibility from the old `pi-jar-footer.json` is imported on the first settings load; afterward `pi-jar-settings.json` is the single source of truth, while the legacy file remains untouched. Later edits by a downgraded version are not imported again. Tests isolate `PI_CODING_AGENT_DIR` to avoid mutating a developer's preferences.

`/jar history` uses the public active-branch `getBranch()` snapshot, session-entry unions and `ctx.ui.custom` overlay APIs available in Pi 0.85.1 and 0.87.1; newer metadata types are skipped. Press p/o to page older/newer, / to search bounded previews on the current page, n/N to navigate matches, e to expand, d/u to scroll details, [/] for output chunks, and Esc to close. Input-mode shortcuts are captured by the search field; fullscreen mouse clicks/wheel use local overlay coordinates. The view never mutates the branch or transcript, copies at most a small preview of any output, and renders bounded rows. Test active-branch isolation, absent timestamps, sanitization, missing/unknown entries, huge outputs, width/height caps, chunk continuity, search capture, mouse resize and read-only behavior. Installed SoL-Pi, global settings and shell startup remain audit-only without separate approval.

`/jar demo` is a labeled preview, not a Team Mode integration. See [INTEGRATIONS.md](INTEGRATIONS.md) for the opt-in role status contract. Check 12-, 16-, 40-, 80- and 120-column terminals, animated/static smoke and flame above a separated large `π`, fullscreen clicks, regular keyboard settings, live effort levels and persisted visual choices, all seven theme choices, observed working-state messages and motion-off, task add/check/edit/filter/delete and branch/reload restoration, cancellation of pi-jar questions, default rounded composer and composer on/off with an existing editor and preserved draft, quota opt-in cancellation, manager presence/absence, `/jar ui off` restoring Pi's footer, and session cleanup. The extension supports the current `@earendil-works/*` Pi API (tested baseline 0.85.1); older `@mariozechner/*` is not supported.

## Startup audit

`pit` is a shell alias for `PI_TEAM_MATE_COORDINATOR=1 pi`; benchmark both with identical flags. An initial five-run warm PTY pilot measured median unsubmitted-input echo at 263 ms without extensions, 266 ms for pi-jar alone, 1209 ms for all installed packages, and 1189 ms for all packages with the coordinator flag (offline, ephemeral session, same repo). A second five-run warm sample after settings/art changes found 268 ms no-extension and 278 ms pi-jar-only, effectively tied; full-package readings varied (~1.2–1.7 s warm, with one unrepeatable slower first run). Neither sample provides a before-change interactive baseline, so do not claim an exact speedup. The old synchronous Git probes took ~150–220 ms locally but were measured separately. Prior `--help` samples (1170 ms all versus ~170 ms no extensions) isolate package import cost but do not measure TUI readiness. These numbers are local, not guarantees; repeat across warm runs and separately label first-run observations. The user-level shell and Pi package list are audit-only: do not disable plugins, change shell startup, or print credential files without explicit approval.

## Development rules

- keep idle CPU/repaint overhead negligible;
- avoid coupling to undocumented internals from other extensions;
- keep role rendering generic;
- do not add decorative animation that carries no state;
- preserve useful behavior with animations disabled.
