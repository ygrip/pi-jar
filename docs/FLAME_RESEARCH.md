# Welcome flame: reusable asset review

Reviewed 2026-09-25. A welcome illustration must fit a fixed 23-column cell, loop cleanly at 120 ms, stay anchored above the π, render without a separate terminal renderer, and remain legible on narrow terminals and with animation disabled.

| Candidate | License | Assessment |
| --- | --- | --- |
| [cli-spinners](https://github.com/sindresorhus/cli-spinners) (`spinners.json`) | MIT ([license](https://github.com/sindresorhus/cli-spinners/blob/main/license)) | No `fire`/`flame` spinner; `weather` and `orangePulse` are small single-line indicators, not a torch illustration. |
| [TerminalFire](https://github.com/DouglasFreshHabian/TerminalFire/blob/main/fire.py) | MIT ([license](https://github.com/DouglasFreshHabian/TerminalFire/blob/main/LICENSE)) | Curses-based, random, full-viewport Doom-style fire simulation; cannot be reused as a small, deterministic, anchored frame set without replacing its rendering model. |
| [term-blaze](https://github.com/DevCode01/term-blaze/blob/main/main.go) | MIT ([license](https://github.com/DevCode01/term-blaze/blob/main/LICENSE)) | Go full-terminal heat-field simulation with cursor positioning, stochastic fuel and per-cell ANSI output; unsuitable inside a Pi TUI component. |

No reviewed animation supplies a suitable fixed-size flame asset. The implementation therefore uses original, small, hand-authored looping frames rather than copying third-party code or adding a dependency. No third-party flame asset is distributed, so no asset attribution is required. If a compatible licensed sprite set is found later, replace only the frame data and preserve the layout contract and tests.
