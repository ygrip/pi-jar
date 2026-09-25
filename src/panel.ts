import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";

export type Paint = (color: string, text: string) => string;
export interface PanelTab { name: string; render(width: number, fg: Paint): string[] }

/** Tabbed, scrollable info panel (Usage / Context). Tab or click switches tabs; Esc closes. */
export async function openPanel(ctx: ExtensionContext, tabs: readonly PanelTab[], initial = 0): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let tab = Math.max(0, Math.min(tabs.length - 1, initial));
    let scroll = 0;
    let body: string[] = [];
    let rows = 10;
    let tabHits: { start: number; end: number }[] = [];
    const fg: Paint = (color, text) => theme.fg(color as never, text);
    const move = (delta: number) => { scroll = Math.max(0, Math.min(Math.max(0, body.length - rows), scroll + delta)); };
    const select = (index: number) => { tab = (index + tabs.length) % tabs.length; scroll = 0; };
    return {
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || data === "q") return done();
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || data === "l") select(tab + 1);
        else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left) || data === "h") select(tab - 1);
        else if (matchesKey(data, Key.down) || data === "j") move(1);
        else if (matchesKey(data, Key.up) || data === "k") move(-1);
        else if (matchesKey(data, Key.pageDown) || data === " ") move(rows - 1);
        else if (matchesKey(data, Key.pageUp)) move(1 - rows);
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === "wheel" && event.wheelDelta) { move(Math.sign(event.wheelDelta) * 3); tui.requestRender(); return { handled: true }; }
        if (event.type !== "click" || event.button !== "left" || event.y !== 1) return;
        const hit = tabHits.findIndex((item) => event.x >= item.start && event.x < item.end);
        if (hit >= 0) { select(hit); tui.requestRender(); return { handled: true }; }
      },
      render(available: number): string[] {
        const width = Math.max(30, available);
        const inner = width - 4;
        rows = Math.max(4, (process.stdout.rows ?? 24) - 6);
        body = tabs[tab]!.render(inner, fg);
        scroll = Math.min(scroll, Math.max(0, body.length - rows));
        const line = (text: string) => fg("dim", "│ ") + truncateToWidth(text, inner) + " ".repeat(Math.max(0, inner - visibleWidth(truncateToWidth(text, inner)))) + fg("dim", " │");
        tabHits = [];
        // Every tab label is name + 2 cells wide ("[name]" or " name "), separated by one space.
        let x = 2;
        const header = tabs.map((item, index) => {
          tabHits.push({ start: x, end: x + item.name.length + 2 });
          x += item.name.length + 3;
          return index === tab ? theme.bold(fg("accent", `[${item.name}]`)) : fg("muted", ` ${item.name} `);
        }).join(" ");
        const more = body.length > rows ? fg("dim", ` ${scroll + 1}–${Math.min(body.length, scroll + rows)}/${body.length}`) : "";
        return [
          fg("dim", "╭" + "─".repeat(width - 2) + "╮"),
          line(header),
          fg("dim", "├" + "─".repeat(width - 2) + "┤"),
          ...body.slice(scroll, scroll + rows).map(line),
          line(fg("dim", "Tab switch · ↑↓/PgUp/PgDn scroll · Esc close") + more),
          fg("dim", "╰" + "─".repeat(width - 2) + "╯")
        ];
      }
    };
  }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } });
}

export const tokens = (value: number): string => value < 1000 ? String(Math.round(value))
  : value < 1_000_000 ? (value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "") + "k"
  : (value / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";

export const money = (value: number): string => "$" + (value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2));

export function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return Math.max(0, Math.floor(ms / 1000)) + "s";
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** A proportional bar: filled cells in `color`, the rest dim. */
export function bar(fg: Paint, percent: number, width: number, color = "accent"): string {
  const cells = Math.max(4, width);
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
  return fg(color, "█".repeat(filled)) + fg("dim", "░".repeat(cells - filled));
}

/** `label` left, value right-aligned in `width`. */
export const row = (label: string, value: string, width: number): string =>
  label + " ".repeat(Math.max(1, width - visibleWidth(label) - visibleWidth(value))) + value;
