# Welcome, footer and composer polish — implementation plan

Status: implemented in the working tree; automated checks pass. Fullscreen pointer and theme appearance still need a live-terminal smoke test.

## Decisions

- Welcome art: a tapered, layered standalone flame above the π, with no chalice or vessel. Provide a compact variant on narrow screens.
- Settings: target clickable **fullscreen** TUI; retain `/jar settings` for keyboard access and regular mode (Pi does not route widget mouse events in regular mode).
- Composer: show **observed** idle, response-generation and tool-use phases, not an unverifiable hidden-reasoning state.
- Footer: use a middle-dot separator between model and the colored effort value, e.g. `model · high`, with no `effort` prefix.

## Audit and work order

1. **Reproduce Settings click via actual TUI routing.** `extensions/index.ts` already installs a welcome widget `handleMouse` that calls `welcomeSettingsHit()` in `src/welcome.ts`; `tests/ui.test.ts` invokes the widget directly, so it cannot prove a fullscreen click reaches it. Confirm fullscreen mode, inspect widget origin/event coordinates and 0-/1-based conventions, click within and outside the rendered label at narrow/medium/wide widths, then fix the responsible routing/hit-area mismatch. Derive hit detection from the rendered label/visible terminal columns, including ANSI styling and any layout changes below. Do not promise clicks in regular mode. Ensure a click opens settings once without submitting or dismissing the welcome as input.
2. **Redraw welcome art and recheck the hit area.** Replace rectangular `FLAMES` in `src/welcome.ts` with recognizable flickering layered tips and a tapered standalone flame above π; no vessel or blank gap. Keep consistent cell width and height across animation frames, with a readable narrow fallback. Respect `animations off`, avoid wide/emoji glyphs, and preserve the card's width bounds. Test Settings clicks again after layout changes.
3. **Simplify footer effort.** In `src/footer.ts`, change the left-hand composition so the colored effort value follows a single `·` separator (`model · high`, not `model · effort high` or doubled dots). Handle hidden model/effort and narrow truncation without orphan separators. Update `tests/footer.test.ts` across supported effort levels and terminal widths.
4. **Animate the composer identity.** `src/composer.ts` currently paints a static `pi-jar · compose` title. Replace this with a one-cell, phase-specific icon: idle static, generation pulse, tool-use spinner. Feed observed phases from `WorkingState` in `src/working.ts` using the existing `agent_start`/`turn_start`, tool start/end, prompt, and end/settled/shutdown hooks in `extensions/index.ts`. Invalidate/request a throttled editor redraw only when needed; stop timers on phase exit, interrupt/abort, shutdown, composer disable, and UI-off. With animations disabled, each phase uses a stable icon. Preserve editor ownership, draft, cursor, keyboard/autocomplete and wrapped mouse coordinates; do not imply actual model reasoning is observable.

## Verification / acceptance

- `npm run check` and `npm test` pass; update existing UI/composer/footer tests rather than relying only on snapshots.
- In fullscreen, click the Settings label and outside it at compact, medium and wide widths; confirm exactly one settings pane opens and `/jar settings` still works in regular mode.
- Compare standalone flame frames visually in supported themes and 12/16/24/40/80/120-column layouts: no clipping, shifting or unexpected two-cell glyphs. Verify welcome Settings hit area after art changes.
- Verify `model · <effort>` for every level, with model/effort visibility toggles and narrow widths.
- Observe idle → generation → tool → generation → idle composer transitions, including interruption, settings animation-off, composer off/on, session shutdown and editor with existing text. No lingering redraw interval or moving cursor.

Implemented discovery: Pi's fullscreen dispatcher only synthesizes `click` after the widget handles `press`; the Settings target now captures press and opens on click. Pi owns terminal mouse mode, so the extension never changes mouse-reporting sequences. Regular mode continues to use `/jar settings`.

Additional request: the activity line now uses a timed progression of the user's light-themed wording, actual tool names, elapsed time, configured effort, and **only reported** assistant output tokens after Pi emits usage. The pi-jar palette is brighter across all seven themes, with contrast assertions for muted/dim text.
