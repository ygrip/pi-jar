# Flame and mascot

Both are original, dependency-free and rendered as plain terminal text inside Pi components.

## Welcome flame (`src/flame.ts`)

### Simulation

One continuous flame on a 21 × 24 grid of intensities `0…9`. The width is odd so the flame has a true center column, which also lines up with the `π` beneath it.

1. **Profile.** The half width at a height `h` (0 = base, 1 = tip) is a circular bulb below the belly (`h < 0.3`, up to 5.6 columns) and a smooth taper above it. The base is rounded and narrower than the belly, never a flat bar.
2. **Motion.** Everything moves through smooth, seeded value noise rather than per-cell randomness: the flame's height breathes, the axis sways and wanders (more at the tip than at the base), and the edges ripple upward — barely at the base, strongly near the tip, so the top licks while the bottom stays calm.
3. **Heat.** Each cell's heat falls off from the axis toward the rim (`1 − d^1.8`) and cools with height, so the core low in the flame is pale gold and the rim and tip are orange-red. A slow noise texture keeps the interior shimmering.
4. **Wisps.** Occasionally a small piece breaks off the tip, rises and fades (at most two at a time).
5. **Particles.** At most eight live particles lift off the upper flame near its axis. Embers rise at 0.3–0.8 rows/frame with a small drift, living 8–20 frames (`•` → `∙` → `·`, fading down the palette). Sparks (≈8% per frame) are fast, bright `✦`/`*` and last 2–4 frames. Particles only draw over empty cells and never on the outer columns.

Randomness comes from a seeded PRNG (mulberry32), and the simulation warms up for 28 steps. So `flameFrame(frame, seed)` is a pure function: tests are deterministic, motion-off shows a still-lit frame, and **Refresh** simply picks a new seed.

### Rendering

Two simulated rows share one terminal row through half blocks: `▀` with the upper cell as foreground and the lower cell as background (`▄` when only the lower cell is lit). The output is 12 rows × 21 columns, fixed width.

Palette (index 0 is transparent):

| Heat | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Color | `#2B0A05` | `#5C1407` | `#8F2207` | `#C7400C` | `#E8601A` | `#F58A24` | `#FFB23A` | `#FFD56A` | `#FFF3C4` |

Without 24-bit color (`COLORTERM` is not `truecolor`/`24bit`), cells become `░▒▓█` shaded with the theme's `dim`, `error` and `warning` colors.

The welcome ticks every 90 ms only while it is visible and motion is on. On terminals narrower than 32 columns the flame is cropped around its center.

## Ember, the composer mascot (`src/mascot.ts`)

Ember is an original, shaded **11 × 10 pixel ember pet**, packed into **11 columns × 5 terminal rows** using `▀`/`▄` cells with independently colored upper/lower halves. Its round bulb body has a curled flame tuft, dark outline, orange shadow, golden face and pale highlight. The face sits low and wide for a cute read: small 1 × 2 bean eyes, pink blush and a one-pixel mouth (red and open when happy). Expressions fit within 3 × 2 eye patches. It sits above the composer without an `Ember` name label; the border retains only profile/session context.

A full pet appears at **60+ columns and 24+ terminal rows**. A fixed extra row above it holds mood sparks: `zzz` for sleep, `✦` for completion and `?` for waiting, blank otherwise. Happy, completed and poked moods squash, hop one terminal row into the spark row, and settle. The spark returns when grounded. Errors pout with puffed cheeks and a short grounded huff; thinking glances sideways. Every pose preserves the same six-row perch, so the editor never jumps. Smaller terminals use a compact five-column face/crown (also with sleepy `zzz`); below 40 columns the crown is omitted. Draft expansion reserves the six-row perch, and mouse coordinates subtract its actual height. Clicking anywhere in the pet pokes it. Turning the mascot off removes every layer.

`mascotPixels()` authors the raster and squash/pout poses; `mascotSprite()` packs it into terminal cells; `mascotSpark()` supplies the fixed-width mood marker; `mascotPerch()` owns the fixed-height hop layout. Truecolor terminals get the eight-color Ember palette; other terminals get corresponding ANSI 256-color cells. No image protocol, image assets, browser overlay, renderer dependency or extra animation loop is required.

### Pixel-pet research

[Pixel-pet](https://github.com/Namenomeaning/pixel-pet) (MIT) uses a real pixel raster—not decorative text faces. Its [`assets/slime.json`](https://github.com/Namenomeaning/pixel-pet/blob/main/plugins/pixel-pet/assets/slime.json) defines a 17 × 11 body, a layered color palette and eye/cheek anchors. [`hooks/pixels.ts`](https://github.com/Namenomeaning/pixel-pet/blob/main/plugins/pixel-pet/hooks/pixels.ts) stamps 3 × 3 expressions, props and companions onto a canvas; `encodeCells()` packs two pixels into each terminal half-block cell. Its SVG renderer is for Desktop.

The initial five-column glyph-only adaptation was rejected during visual review. The revised Ember uses the raster, shading, eye-overlay and half-cell approach with original warm flame artwork; no upstream sprites or code are copied. Reference GIFs and a side-by-side raster comparison were inspected, in addition to layout/state tests. Tool-specific props and companion trails are not included in this version.

Moods come from Pi's observed activity plus local timers:

| Mood | Full-sprite expression | Trigger |
| --- | --- | --- |
| idle / blink | single-pixel pupils / short horizontal eyelids | idle; 180 ms blink every 3–6 s |
| happy / thinking | smiling eyes and mouth / side-looking pupils | generating; alternates every few seconds |
| tool / waiting | inward-focused eyes / wide eyes and round mouth | running tool / dialog or question |
| sleepy / error | lowered eyelids / pursed mouth and puffed cheeks | idle for two minutes / failed run (3 s) |
| complete / poke | sparkling eyes and smile / surprised eyes and mouth | goal complete (4 s) / click (1.5 s) |

Active poses use 600 ms frames driven by Pi's existing render cadence, never a separate active timer. Transient completion, poke and error reactions schedule only their remaining pose frames, ending at the flash deadline. Idle is deliberately calm between exact blink and sleep deadlines. Sleepy idle stops scheduling. Motion-off stops timers and freezes the **entire raster** to idle, even while a tool or error flash is active. Tests cover every pixel frame's dimensions/colors, truecolor and 256-color cells, responsive fallback, draft-height reservation, mouse mapping and motion-off stability. These checks prove mechanics; visual comparison is a separate review.
