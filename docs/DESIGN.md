# Design

## Identity

pi-jar should feel technical, calm and readable, warm enough not to look like another neon-blue terminal, clearly aware of who (or which role) is doing what, and useful during long sessions.

Rule of thumb: **state first, useful telemetry second, decoration last.** Every animation carries meaning, and everything still works with motion off.

## Palette

| Purpose | Color |
| --- | --- |
| suggested terminal background | `#0B1018` |
| surface | `#111927` |
| default accent (teal) | `#00C2B8` |
| technical blue | `#7FA8EE` |
| warning amber | `#E5A940` |
| success green | `#35C79A` |
| text | `#F3F6FA` |
| muted text | `#98A5B6` |
| danger terracotta | `#EE7A5E` |

`pi-jar-dark` uses the teal accent on deep navy surfaces with semantic status colors. Six alternate themes change only the accent and selection: gray, pink, teal, azure, violet and amber. Success, warning and error never change. `/jar accent <preset>` switches between loaded bundled themes; `default` restores teal. The fire palette used by the flame and mascot is documented in [FLAME.md](FLAME.md).

## Role language

Live teammate names and labels come from publishers (`pi-jar.role.<id>`, see [INTEGRATIONS.md](INTEGRATIONS.md)); pi-jar never invents them. `/jar demo` shows clearly labeled generic samples. Model roles (`/roles`) are a separate concept: they choose which model runs a workflow. The active one shows as `role:<name>` in the footer and on the welcome card.

State colors: thinking/working → accent · reviewing → warning · done → success · failed → error · waiting/idle → dim.

## Motion language

| Surface | Motion | Stops when |
| --- | --- | --- |
| Welcome flame | pixel fire, embers, sparks (90 ms) | the welcome closes, or motion is off (frozen frame) |
| Ember mascot | blinks, mood changes, tip flicker (repaints only on change) | motion off (calm face) or mascot off |
| Working indicator | `✢ ✣ ✤` while generating, `◐ ◓ ◑ ◒` for tools | the run settles |
| Footer roles | `◈ ◆`, `◐ ◓ ◑ ◒`, `◔ ◑ ◕ ●` | the role is idle, done or failed |

Rules:

1. labels never move; only glyphs animate;
2. completed and failed states are static;
3. idle UI does not repaint continuously;
4. at most two prominent animations compete at once;
5. motion is optional and never the only carrier of information.

## Layout

### Welcome

- **Wide (≥ 72 columns):** flame and large `π` in a 28-column art column, with the card on the right, vertically centered.
- **Medium (32–71):** a slightly cropped flame and compact `π` stacked above the card.
- **Narrow (< 32):** cropped flame, compact `π` and a single Settings action.

Card sections, top to bottom: header (version · model · effort · role), the **message hero**, workspace (project · git · session), workflow (plan · goal · tasks · roles · team), actions. The hero is the focal point: bold, painted in the flame's gold-to-orange ramp and set in double-width (fullwidth) letters when it fits in three lines, otherwise bold at normal width, with a dim "— welcome to pi-jar —" byline. **Refresh** picks a new message and flame. Long values truncate at the right. Actions are bracketed chips in fullscreen and plain keyboard hints in regular mode. A button is never advertised where it cannot be clicked.

### Composer

The Ember tip row sits above a rounded frame. The top border carries the face, the session title and the `↑ N more` overflow label; the bottom border carries `↓ N more` and dim key hints (hidden below 60 columns). Autocomplete menus render below the frame, aligned with the text. Ghost suggestions are dim and followed by `⇥ tab`.

### Split views (plan view, roles)

A shared frame (`src/split-view.ts`): title bar with a clickable `×`, a sidebar of `clamp(round(w × 0.26), 18, 32)` columns, a `│` divider, a body pane, a divider row, footer rows, and a closing border. Below 64 columns the sidebar collapses into a header pager.

### Footer

- **Wide (100+):** model · effort · session · cwd · context · RAM · cost, then roles and branch, with quota on a third line if needed.
- **Medium (52–99):** fewer extras; context is always visible.
- **Narrow (< 52):** model, effort, the active or failed role, context.

The goal line shows `◎ goal · <progress>` when a goal exists.

## Conversation timeline

`/jar history` is an overlay built from a snapshot of the active branch. It is not a restyled transcript. Visible messages, compactions and branch summaries become rows; reasoning, hidden custom messages and image bytes are excluded. Paging (80 rows), 2 KiB / 30-line chunks and page-local search keep it bounded.

## Accessibility

- state never relies on color alone: every active state has a glyph or word;
- motion-off preserves all information;
- keyboard paths exist for every pointer action;
- core rendering uses ordinary Unicode and works without 24-bit color.
