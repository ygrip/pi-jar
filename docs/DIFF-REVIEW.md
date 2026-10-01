# Diff review

`/diff` is pi-jar's post-edit review UI: it inspects captured before/after content, then lets you accept (stop tracking) or explicitly confirm a revert. It is inspired by the split-pane, hunk-navigation and bounded-rendering ideas in [pi-show-diffs](https://github.com/xRyul/pi-show-diffs), but does not copy its code or change the tool pre-approval flow.

- Type `/` in the file list to filter by absolute/relative path or change status (content search is intentionally omitted to keep keystrokes bounded over large retained snapshots). Press Enter to keep the filter, Escape to clear it, and `n`/`N` to move through matching files.
- The right pane starts with the selected file's absolute path and change summary.
- Normal previews render a viewport of unified Git-style hunks. `PgUp`/`PgDn`, `g`/`G`, or the mouse wheel move through the preview; `n`/`p` jump hunks. `t` toggles unified and side-by-side Original/Updated columns. Rendering windows the requested rows instead of constructing a rendered row for every file line.
- Changes over 256 KiB or 1,500 combined lines initially show summary counts. Press `v` to explicitly review a bounded preview or return to summary. Previews are capped at 100,000 combined lines per file. When exact LCS diff exceeds its existing CPU/memory budget, the full-review choice uses a clearly marked coarse replacement hunk that preserves common prefix/suffix and line order.
- Safe revert tracking remains capped at 1 MiB per file and 8 MiB of retained baselines. Binary, oversized, or otherwise untracked files cannot be reverted from this UI. The summary does not imply content beyond those safety caps is reviewable.

The implementation uses the pi-tui custom component and windowed split-frame renderer already used by pi-jar. Upstream visual reference: [xRyul/pi-show-diffs README](https://github.com/xRyul/pi-show-diffs#diff-review-ux), MIT-licensed. No upstream source was copied.
