# Design

## Identity

pi-jar takes visual cues from Setara and Punakawan without copying either product literally.

The theme should feel:

- technical, calm, and readable;
- warm enough not to look like another generic neon-blue terminal;
- distinctly role-aware;
- useful during long-running multi-agent sessions.

## Palette

| Purpose | Color |
| --- | --- |
| suggested terminal background | `#0B1018` |
| surface | `#111927` |
| Setara dark teal (default accent) | `#00C2B8` |
| Punakawan technical blue | `#7FA8EE` |
| Punakawan warning amber | `#E5A940` |
| Punakawan success green | `#35C79A` |
| text | `#F3F6FA` |
| muted text | `#98A5B6` |
| Punakawan danger terracotta | `#EE7A5E` |

Setara's dark UI uses deep navy and teal; Punakawan's dark panel uses navy surfaces, blue, amber and green status cues. `pi-jar-dark` uses Setara teal with Punakawan dark surfaces and semantic status colors. Six complete alternate themes mirror Punakawan's **dark accent presets**: gray, pink, teal, azure, violet and amber. `/jar accent <preset>` switches a bundled theme; `default` restores Setara teal. Accent choices change accents/selection only, never success/warning/error. Native Pi themes cannot change the terminal emulator's actual background; match the suggested canvas in terminal settings for the closest appearance.

## Role language

Live names and labels are publisher-supplied: `pi-jar.role.<id>` can describe any teammate. The Punakawan names inspire the visual identity but are neither reserved IDs nor fixed roles. The synthetic `/jar demo` uses clearly labeled generic Explorer, Builder and Reviewer examples; it never claims live activity. Without published state, no teammate is shown.

State colors:

- thinking/working → accent
- reviewing → warning
- done → success
- failed → error
- waiting/idle → dim

## Animation language

Animations communicate state.

| State | Frames |
| --- | --- |
| idle | `◇` |
| thinking | `◈ ◆` |
| working | `◐ ◓ ◑ ◒` |
| waiting | `◇` |
| reviewing | `◔ ◑ ◕ ●` |
| done | `✓` |
| failed | `×` |

Rules:

1. labels do not move;
2. completed and failed roles are static;
3. idle UI does not continuously repaint;
4. at most two visually prominent animations should compete at once;
5. animations must be optional.

## Responsive layout

### Wide: 100+ columns

```text
claude-sonnet effort high                               ctx 58%
EXP ◈ analyze  ·  BLD ◐ implement  ·  REV ◇  ·  git feature/auth
```

### Medium: 52–99 columns

```text
claude-sonnet effort medium          ctx 58%
EXP ◈  ·  BLD ◐  ·  REV ◇
```

### Narrow: below 52 columns

```text
model effort low       EXP ◈ ctx 58%
```

Roles only appear when explicitly published or in the labeled demo. Optional detail is trimmed at the right; glyphs and text remain meaningful without color. The footer omits the decorative `jar` prefix; `DEMO` remains explicit when sample roles are enabled. Live model effort comes from Pi's thinking level, repaints when it changes and uses the semantic `thinkingOff`…`thinkingMax` colors. The footer keeps context visible at every width, adds Pi-reported session cost when space allows, and shows 5-hour/weekly usage only when a valid public quota or opt-in read-only OAuth fallback resolves it. At medium widths, quota may occupy a third line. The transient welcome shows eight restrained fixed-width frames of shaded amber/terracotta fire above a **centered, balanced, static multi-row mathematical π**. The flame tapers, bends asymmetrically and uses a small number of spark pixels so it reads as fire instead of a rectangular meter. The landing card prioritizes a short welcome, active role/task state, project, installed managers, git state and quick actions; duplicate model/context/cost telemetry stays in the footer. Advisor state is intentionally omitted when unavailable instead of turning absence into a prominent warning. The Settings action opens on pointer press in Pi fullscreen mode, with `/jar settings` and `Ctrl+Alt+S` as keyboard paths. A responsive full-screen settings view groups persisted pi-jar visual choices while keeping quota consent session-only. A smaller multi-row π remains on narrow terminals; motion-off freezes the flame without hiding the symbol. Working messages use Pi's observed generation/tool events: themed words and icons can animate only while active; motion-off is static and idle has no repaint timer. `/jar hub` navigates to existing Team Mode and subagent managers; `/jar tasks` is a visibly separate pi-jar-owned to-do list. Pi-jar's question cards are custom only for its own prompts, while the rounded composer uses Pi's `CustomEditor` to preserve application keybindings, shows Pi's session title when available, derives a stable readable alias when it is not, and restores the prior editor via `/jar composer off`.

## Separate conversation timeline

`/jar history` is an overlay, not an altered native transcript. Pi's public `sessionManager.getBranch()` provides a snapshot of the active branch when opened; only visible message, compaction and branch-summary entries get timeline rows. The marker, turn number, author, optional timestamp, compact sanitized excerpt and selected-entry details follow a chronological card/gutter pattern. Reasoning blocks, hidden custom messages and image bytes are excluded; tool arguments expose only a short command/path hint. The UI indexes visible entries without copying tool output, pages 80 rows, lazily extracts 2 KiB / 30-line contiguous chunks, and bounds render height and width. Search is deliberately page-local and limited to the first 1024 characters per entry. It cannot and does not change Pi's stored session, native message styling or scrollback; fullscreen mouse routing is optional.

## Presets

Planned presets:

- **minimal:** model + context
- **normal:** model + branch + roles + context
- **verbose:** role tasks + integrations + tokens/cost
- **focus:** active role + model + branch only

## Accessibility

- role state must never rely on color alone;
- every active state includes a glyph;
- animation-off mode must preserve all information;
- avoid low-contrast tool diffs;
- Nerd Font glyphs may enhance the display later, but core rendering must work with ordinary Unicode.
