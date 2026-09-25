# Flame and mascot

Both are original, dependency-free and rendered as plain terminal text inside Pi components.

## Welcome flame (`src/flame.ts`)

### Simulation

A heat-spreading cellular automaton on a 21 × 24 grid of intensities `0…9`. The width is odd so the fire has a true center column, which also lines up with the `π` beneath it.

1. **Source row.** The bottom row is a narrow bed of coals: the center five cells are near-maximum heat (with a slight flicker), one more on each side is warm, and the rest is cold.
2. **Spread.** Every frame, each cell's heat rises one row and drifts horizontally by −1, 0 or +1 (straight up is twice as likely). It loses one heat step with probability `0.22`. The scan direction alternates per row and frame, because where spreads overlap the last write wins; a fixed direction would pull the fire toward one side.
3. **Tongues.** Five flame tongues (a tall center, two shoulders, two short outer licks) each have a rest height, a base width that tapers toward the tip, and an outward lean. Their roots start close to the center and fan out to full spacing by mid-height, so the flame is narrow at the base and fullest in its belly. Each one breathes on its own sine wave and sometimes licks 18% higher, so the silhouette keeps breaking into separate protruding spikes.
4. **Envelope.** A cell's heat is capped by a short body that swells from the base upward, plus the union of the tongues. Each tongue's core is also fed a little heat along its spine, so spikes stay lit to their dark-red tips while the spread feathers their edges.
5. **Wind.** Two slow sine waves combine into a gentle bias that bends the tongue tips and occasionally pushes rising heat sideways.
6. **Particles.** At most eight live particles, torn off the tongue tips. Embers rise at 0.3–0.8 rows/frame with a small drift, living 8–20 frames (`•` → `∙` → `·`, fading down the palette). Sparks (≈12% per frame) are fast, bright `✦`/`*` and last 2–4 frames. Particles only draw over empty cells and never on the outer columns.

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
