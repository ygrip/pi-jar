# Flame and mascot

Both are original, dependency-free and rendered as plain terminal text inside Pi components.

## Welcome flame (`src/flame.ts`)

### Simulation

A heat-spreading cellular automaton on a 22 × 24 grid of intensities `0…9`:

1. **Source row.** The bottom row is a torch-shaped heat source: the center seven cells are near-maximum heat (with a slight flicker), the next two on each side are warm, and the edges are cold.
2. **Spread.** Every frame, each cell's heat rises one row and drifts horizontally by −1, 0 or +1 (straight up is twice as likely). It loses one heat step with probability `0.4`.
3. **Wind.** Two slow sine waves combine into a gentle bias that occasionally pushes rising heat sideways, so the tip sways instead of jittering.
4. **Envelope.** A teardrop envelope caps each cell's heat by its distance from the center relative to a half-width that narrows with height. The fire therefore always reads as one torch, never a wall.
5. **Particles.** At most six live particles. Embers spawn at the top of the hot region and rise at 0.3–0.8 rows/frame with a small drift, living 8–20 frames (`•` → `∙` → `·`, fading down the palette). Sparks are rare (≈7% per frame), fast, bright `✦`/`*` and last 2–4 frames. Particles only draw over empty cells.

Randomness comes from a seeded PRNG (mulberry32), and the simulation warms up for 28 steps. So `flameFrame(frame, seed)` is a pure function: tests are deterministic, motion-off shows a still-lit frame, and **Refresh** simply picks a new seed.

### Rendering

Two simulated rows share one terminal row through half blocks: `▀` with the upper cell as foreground and the lower cell as background (`▄` when only the lower cell is lit). The output is 12 rows × 22 columns, fixed width.

Palette (index 0 is transparent):

| Heat | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Color | `#2B0A05` | `#5C1407` | `#8F2207` | `#C7400C` | `#E8601A` | `#F58A24` | `#FFB23A` | `#FFD56A` | `#FFF3C4` |

Without 24-bit color (`COLORTERM` is not `truecolor`/`24bit`), cells become `░▒▓█` shaded with the theme's `dim`, `error` and `warning` colors.

The welcome ticks every 90 ms only while it is visible and motion is on. On terminals narrower than 32 columns the flame is cropped around its center.

## Ember, the composer mascot (`src/mascot.ts`)

Ember is two layers:

- a **face** in the composer's top border — always `( + three glyphs + )`, five columns wide in every mood, so the title never shifts;
- **flame tips** on the row above the frame, five columns wide, aligned over the face.

Moods come from Pi's observed activity plus local timers:

| Mood | Face | Tips | Trigger |
| --- | --- | --- | --- |
| idle | `(•ᴗ•)` | swaying `▴▲▴` | nothing happening |
| blink | `(-ᴗ-)` | still | 180 ms, every 3–6 s at random |
| happy / thinking | `(^ᴗ^)` / `(°ᴗ°)` | bouncing / orbiting `∙` | generating (alternates every few seconds) |
| tool | `(>ᴗ<)` | sparks `*` `·` | a tool is running |
| waiting | `(•o•)` | `?` | a dialog or question is open |
| sleepy | `(-ω-)` | dimmed, rising `z` | idle for two minutes |
| error | `(×_×)` | drooping `ˇ` | a run failed (3 s) |
| complete | `(★ᴗ★)` | star and sparks | a goal was completed (4 s) |
| poke | `(^o^)` | bounce | you clicked the face (1.5 s) |

Faces and tips are painted from the flame palette (pale-gold eyes, orange shell, redder when upset) or theme colors without 24-bit color. One unref'd 240 ms timer drives expressions, and it requests a render **only when the sprite actually changes**. Motion-off stops the timer and shows a calm face; turning the mascot off removes both layers. Below 40 columns the tips row is dropped.
