import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { RowCache } from "./row-cache.ts";

export interface SplitTheme { fg(color: string, text: string): string }

export interface SplitLayout {
  /** First content row (0-based, local to the component). */
  top: number;
  /** Number of content rows. */
  rows: number;
  /** Width of the left pane content; 0 when collapsed to a single column. */
  leftWidth: number;
  /** Column where right-pane content starts. */
  bodyX: number;
  /** First footer row. */
  footerTop: number;
}

/** Padded pane rows: scrolling or one live row re-pads only what changed. */
const padded = { left: new RowCache(), right: new RowCache(), footer: new RowCache() };

/** The last frame: overlays repaint on every Pi render (including each streamed token) with unchanged rows. */
let previous: { key: string; left: string[]; right: string[]; footer: string[]; lines: string[]; layout: SplitLayout } | undefined;
const sameRows = (a: readonly string[], b: readonly string[], rows: number) => {
  for (let row = 0; row < rows; row++) if ((a[row] ?? "") !== (b[row] ?? "")) return false;
  return true;
};

/** Sidebar width for a split view, or 0 when the terminal is too narrow for two panes. */
export function sidebarWidth(width: number, min = 18, max = 32): number {
  if (width < 64) return 0;
  return Math.max(min, Math.min(max, Math.round(width * 0.26)));
}

/**
 * Frame a two-pane view: `left` and `right` are already-windowed, styled rows.
 * Left pane is omitted when `leftWidth` is 0. Every line fits `width` exactly.
 */
export function splitFrame(theme: SplitTheme, width: number, title: string, left: readonly string[], right: readonly string[],
  footer: readonly string[], rows: number, leftWidth = sidebarWidth(width)): { lines: string[]; layout: SplitLayout } {
  const w = Math.max(12, width);
  const dim = (text: string) => theme.fg("dim", text);
  const key = `${w}\0${title}\0${rows}\0${leftWidth}\0${dim("│")}${theme.fg("accent", "╭")}`;
  if (previous?.key === key && footer.length === previous.footer.length && sameRows(footer, previous.footer, footer.length)
    && sameRows(left, previous.left, rows) && sameRows(right, previous.right, rows)) {
    return { lines: previous.lines.slice(), layout: { ...previous.layout } };
  }
  const heading = truncateToWidth(" " + title + " ", Math.max(0, w - 6));
  const top = theme.fg("accent", "╭─" + heading + "─".repeat(Math.max(0, w - 4 - visibleWidth(heading))) + "×╮");
  const lines = [top];
  const split = leftWidth > 0;
  const bodyWidth = split ? w - leftWidth - 6 : w - 4;
  padded.left.begin(String(leftWidth));
  padded.right.begin(String(bodyWidth));
  padded.footer.begin(String(w - 4));
  // truncateToWidth pads in the pass that measures, so each new row is scanned once.
  const pad = (cache: RowCache, text: string, cells: number) => cache.get(text, (value) => truncateToWidth(value, Math.max(0, cells), "...", true));
  for (let row = 0; row < rows; row++) {
    const body = pad(padded.right, right[row] ?? "", bodyWidth);
    lines.push(split
      ? dim("│ ") + pad(padded.left, left[row] ?? "", leftWidth) + dim("│ ") + body + dim(" │")
      : dim("│ ") + body + dim(" │"));
  }
  lines.push(dim("├" + (split ? "─".repeat(leftWidth + 1) + "┴" + "─".repeat(Math.max(0, w - leftWidth - 4)) : "─".repeat(w - 2)) + "┤"));
  const footerTop = lines.length;
  for (const line of footer) lines.push(dim("│ ") + pad(padded.footer, line, w - 4) + dim(" │"));
  lines.push(dim("╰" + "─".repeat(w - 2) + "╯"));
  // Every row is assembled from exact-width parts; only a sidebar too wide for the frame can overflow.
  const fitted = bodyWidth < 0 ? lines.map((line) => truncateToWidth(line, w)) : lines;
  const layout = { top: 1, rows, leftWidth: split ? leftWidth : 0, bodyX: split ? leftWidth + 4 : 2, footerTop };
  previous = { key, left: left.slice(0, rows), right: right.slice(0, rows), footer: footer.slice(), lines: fitted, layout };
  return { lines: fitted.slice(), layout: { ...layout } };
}

/** Available content rows for a full-height overlay with `chrome` fixed rows. */
export function contentRows(chrome: number, min = 4): number {
  return Math.max(min, (process.stdout.rows ?? 24) - chrome);
}

/**
 * Numbered options, one per row: `❯ 1  label` for the selected one (or none when `selected` is -1).
 * Use for any set of choices so they read as a list rather than a crowded single line.
 */
export function optionList(theme: SplitTheme & { bold?: (text: string) => string }, labels: readonly string[], selected: number, keys?: readonly string[]): string[] {
  return labels.map((label, index) => {
    const active = index === selected;
    const key = keys?.[index] ?? String(index + 1);
    const text = `${active ? "❯" : " "} ${key.padEnd(2)} ${label}`;
    return theme.fg(active ? "accent" : "muted", active ? theme.bold?.(text) ?? text : text);
  });
}
