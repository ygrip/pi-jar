# Showcase and media

pi-jar's README visual should demonstrate the real TUI rather than a polished mockup that quietly invents capabilities. The canonical demo asset is:

```text
docs/assets/pi-jar-demo.gif
```

## What the demo should show

The primary loop should make the product understandable without narration:

- the animated torch-style `π` and natural flame/ember motion;
- the hopeful welcome message and live workspace card;
- visible project, session, plan, goal, task and role state when available;
- the composer and Ember mascot so the welcome screen feels connected to the working UI.

## Capture guidelines

Keep the source capture in a dark terminal (a bundled pi-jar theme is preferred). Crop dead time before the UI appears, avoid showing secrets or unrelated desktop chrome, and prefer a short loop over a full recording. The README version should be optimized for quick loading; the original recording can remain outside the repository.

The visual is supporting evidence, not the documentation itself. Every demonstrated feature should still be explained in the README or the focused docs.

## Version 0.3.0 walkthrough

- **MP4:** [`pi-jar-demo.mp4`](https://github.com/ygrip/pi-jar/blob/main/docs/assets/pi-jar-demo.mp4), 76.5 seconds, 1920 × 1080, 24 fps, H.264 + AAC, web-optimized (`faststart`), approximately 9.3 MB.
- **README GIF:** [`pi-jar-demo.gif`](https://raw.githubusercontent.com/ygrip/pi-jar/main/docs/assets/pi-jar-demo.gif), a condensed 48-second loop at 1280 × 720 and 12 fps, 256 colors, approximately 11.4 MB. Silent, as GIFs are.
- **Film:** the actual flame-over-π pi-jar logo vectorized for the opening, warm/violet glow, eased reveals, terminal closeups, chapter captions and an original synthesized score. Both exports show profile switching, sending a prompt that dismisses the welcome, real `jar_ask` choices, the cute bean-eyed Ember, celebration hops, pouting, plan review, tasks, split diff, delegation activity and sleepy `zzz`. The MP4 also includes settings and unified diff.

Local exports are `docs/assets/pi-jar-demo.mp4` and `docs/assets/pi-jar-demo.gif`. README media uses hosted repository URLs so npm installations do not carry roughly 21 MB of video assets. Hosted links reflect the committed/uploaded repository version; local exports are the review source before publication.

### What is real, and what is a fixture

The recording runs the current extension in Pi and captures its actual terminal rendering, including the raster mascot, animated welcome, native settings/profile dialogs, `jar_ask`, plan view, task editor, split diff and activity view. The profile picker really selects Focus; `/profiles Swarm` switches again, and `/profiles Default` returns before the first prompt locks the session profile. Sending “Give me three tiny weekend project ideas and let me pick one.” dismisses the welcome through the normal lifecycle. fframes supplies the surrounding logo/title card, frame and progress bar.

A scripted localhost-only provider responds to the real prompt with a `jar_ask` tool call; the real tool presents options and consumes the recorded selection. Its replies are deterministic fixture data, not inference by an external model. Task and plan content, the small `ember.ts` change, completion/error reactions, idle age for the sleepy shot, and three completed agent records are also offline fixtures. The activity scene explicitly says no model or child agent was started. Footer roles come from the existing labeled `/jar demo` mode. This is a UI walkthrough, not a claim that an agent autonomously implemented or verified the illustrated change. Goal execution, real child-process execution, network quota lookups and every possible panel are not demonstrated.

### Isolation and rendering

Install the video skill in a fresh temporary directory, not the repository or personal agent directory:

```bash
mkdir -p /tmp/pi-jar-feature-demo
cd /tmp/pi-jar-feature-demo
npx --yes skills add https://fframes.studio --yes --agent pi
```

The capture used a separate project, `HOME`, `PI_CODING_AGENT_DIR` and session directory, with normal extension/skill/prompt/theme discovery disabled and only the recording driver loaded explicitly. The driver loads a snapshot of pi-jar and sends the recorded prompt only to a scripted provider bound to `127.0.0.1` on an ephemeral port. No external model/API requests occur. Pi and the local provider are terminated and reaped after capture. No personal auth, sessions or other extensions enter the recording. Only the exported MP4 and GIF belong in the repository; source capture, video project, Cargo build products and installed skills stay outside it.

The actual toolchain was asciicast → `agg` → FFmpeg terminal MP4 → fframes 1.2.0 Rust/SVG + Skia/Metal render → FFmpeg web MP4 and condensed GIF. The revised capture uses a 128 × 40 terminal, the smaller mascot and no name label. Original music is synthesized from oscillators, pulses and transition swells; no third-party audio is used. Encoded audio was measured at about −14.2 LUFS and −3.7 dBTP, without clipping. The terminal uses Pi's dark theme. fframes reads the terminal MP4 through a runtime `MediaDirectory`; video cannot be placed in its compile-time `include_media_dir!` folder, which holds the font.

In the prepared fframes project, inspect representative frames before rendering:

```bash
cargo run --release -- frame 1.5s,17s,23s,25s,28s,35s,39s,70s
cargo run --release -- render
ffmpeg -i out.mp4 -c copy -movflags +faststart pi-jar-demo.mp4
```

For a full-length GIF, use `fps=12,scale=1280:-1:flags=lanczos`, a 256-color `palettegen`, and `paletteuse=dither=none:diff_mode=rectangle` with `-an -loop 0`. The README's 48-second preview instead concatenates MP4 ranges **0.5–5.5, 13–20.5, 21.5–33, 34.5–42, 43–46, 49.5–52.5, 54–57, 63–65, 69.5–72.5 and 74–76.5 seconds** before applying that palette pipeline. Reset each trimmed range's timestamps before concatenating.

Pad the source terminal clip through the entire film's final frame; a shorter clip makes fframes return an empty SVG at the end. Avoid CSS color names such as `violet` as SVG IDs in fframes 1.2.0's compile-time macro; use a non-color identifier such as `violetGlow`.

The media was fully decoded. The logo, profile picker and switched profile labels, welcome before/after submission, `jar_ask`, mascot pose strip, and representative plan/diff/activity/sleep and final GIF frames were visually inspected. fframes inspected 307 frames without diagnostics. `ffprobe` verifies duration, dimensions and frame rates. No remote upload or publication is part of this workflow.
