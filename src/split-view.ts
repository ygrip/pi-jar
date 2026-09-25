import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

const pad = (text: string, width: number) => {
  const value = truncateToWidth(text, Math.max(0, width));
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
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
  const heading = " " + title + " ";
  const top = theme.fg("accent", "╭─" + truncateToWidth(heading, Math.max(0, w - 6)) + "─".repeat(Math.max(0, w - 4 - visibleWidth(truncateToWidth(heading, Math.max(0, w - 6))))) + "×╮");
  const lines = [top];
  const split = leftWidth > 0;
  const bodyWidth = split ? w - leftWidth - 6 : w - 4;
  for (let row = 0; row < rows; row++) {
    const body = pad(right[row] ?? "", bodyWidth);
    lines.push(split
      ? dim("│ ") + pad(left[row] ?? "", leftWidth) + dim("│ ") + body + dim(" │")
      : dim("│ ") + body + dim(" │"));
  }
  lines.push(dim("├" + (split ? "─".repeat(leftWidth + 1) + "┴" + "─".repeat(Math.max(0, w - leftWidth - 4)) : "─".repeat(w - 2)) + "┤"));
  const footerTop = lines.length;
  for (const line of footer) lines.push(dim("│ ") + pad(line, w - 4) + dim(" │"));
  lines.push(dim("╰" + "─".repeat(w - 2) + "╯"));
  return {
    lines: lines.map((line) => truncateToWidth(line, w)),
    layout: { top: 1, rows, leftWidth: split ? leftWidth : 0, bodyX: split ? leftWidth + 4 : 2, footerTop }
  };
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
