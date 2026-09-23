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
| base background | `#101516` |
| surface | `#171D1F` |
| Setara cyan | `#6AB8B5` |
| technical blue | `#719CD6` |
| Punakawan amber | `#CBA66B` |
| muted green | `#8EA58B` |
| text | `#D3D9D8` |
| muted text | `#727E7D` |
| error | `#C96D72` |

## Role language

Default role accents:

- **Gareng:** cyan, analysis and exploration
- **Petruk:** amber, implementation and forward motion
- **Bagong:** green, review and verification

State color overrides:

- done → success
- failed → error
- waiting/idle → dim

## Animation language

Animations communicate state.

| State | Frames |
| --- | --- |
| idle | `◇` |
| thinking | `◇ ◈ ◇ ◆` |
| working | `◐ ◓ ◑ ◒` |
| waiting | `· ◇ · ◇` |
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
pi-jar    Claude Sonnet · medium                    feature/auth  ctx 58%
GAR ◈ analyze     PET ◐ implement     BAG ◇ waiting
```

### Medium: 52–99 columns

```text
pi-jar  Claude Sonnet     ctx 58%
GAR ◈   PET ◐   BAG ◇
```

### Narrow: below 52 columns

Only the primary footer line is shown. Role state can later collapse into a compact status segment rather than wrapping.

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
