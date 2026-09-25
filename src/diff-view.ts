import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { diffRows, lineDiff, type ChangeTracker, type DiffRow, type FileChange } from "./changes.ts";
import { contentRows, sidebarWidth, splitFrame } from "./split-view.ts";

const STATUS_MARK = { added: "A", modified: "M", deleted: "D" } as const;

/** Keep indentation but drop escape sequences and control characters that would break layout. */
export const safeLine = (text: string) => text.slice(0, 4000).replace(/\t/g, "  ")
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b./g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, "·");

/** Styled diff rows for one file, with a gutter of old/new line numbers. */
export function renderDiff(change: FileChange, width: number, fg: (color: string, text: string) => string): string[] {
  const ops = lineDiff(change.before, change.after);
  if (!ops) return [fg("warning", `Too large for an inline diff: +${change.added} −${change.removed} lines.`)];
  const rows: DiffRow[] = diffRows(ops);
  if (!rows.length) return [fg("dim", "No textual changes.")];
  const gutter = Math.max(3, String(Math.max(...rows.map((row) => Math.max(row.oldLine ?? 0, row.newLine ?? 0)))).length);
  const num = (value?: number) => (value ? String(value) : "").padStart(gutter);
  return rows.map((row) => {
    if (row.kind === "hunk") return fg("accent", row.text);
    const text = truncateToWidth(safeLine(row.text), Math.max(1, width - gutter * 2 - 4));
    const prefix = fg("dim", `${num(row.oldLine)} ${num(row.newLine)} `);
    if (row.kind === "add") return prefix + fg("success", "+" + text);
    if (row.kind === "remove") return prefix + fg("error", "-" + text);
    return prefix + fg("muted", " " + text);
  });
}

/**
 * Review what the agent changed: files on the left, the selected diff on the right.
 * `a` accepts (stops tracking) and `r` then `y` reverts a file; `A`/`R` apply to all.
 */
export async function openDiffView(ctx: ExtensionContext, tracker: ChangeTracker): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  let changes = tracker.changes();
  if (!changes.length) { ctx.ui.notify("pi-jar: no agent changes to review", "info"); return; }
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let selected = 0;
    let scroll = 0;
    let listScroll = 0;
    let bodyRows = 0;
    let width = 80;
    let armed: "one" | "all" | undefined;
    let message = "";
    let layout = { top: 1, rows: 0, leftWidth: 0, bodyX: 2, footerTop: 0 };
    let cache: { key: string; lines: string[] } | undefined;
    const fg = (color: string, text: string) => theme.fg(color as never, text);
    const refresh = () => {
      changes = tracker.changes();
      cache = undefined;
      selected = Math.min(selected, Math.max(0, changes.length - 1));
      scroll = 0;
      if (!changes.length) done();
    };
    const run = (label: string, action: () => void) => {
      try { action(); message = label; }
      catch (error) { message = "failed: " + (error instanceof Error ? error.message : String(error)); ctx.ui.notify("pi-jar: " + message, "error"); }
      refresh();
    };
    const select = (index: number) => { selected = Math.max(0, Math.min(changes.length - 1, index)); scroll = 0; };
    const scrollBody = (delta: number) => { scroll = Math.max(0, Math.min(Math.max(0, (cache?.lines.length ?? 0) - bodyRows), scroll + delta)); };
    return {
      invalidate() { cache = undefined; },
      handleInput(data: string) {
        const current = changes[selected];
        if (armed && (data === "y" || (armed === "one" && data === "r") || (armed === "all" && data === "R"))) {
          const scope = armed; armed = undefined;
          if (scope === "all") run(`reverted ${changes.length} file(s)`, () => { for (const change of changes) tracker.revert(change.path); });
          else if (current) run(`reverted ${current.rel}`, () => tracker.revert(current.path));
          tui.requestRender(); return;
        }
        armed = undefined;
        if (matchesKey(data, Key.escape) || data === "q") return done();
        if (data === "a" && current) run(`accepted ${current.rel}`, () => tracker.accept(current.path));
        else if (data === "A") run(`accepted ${changes.length} file(s)`, () => tracker.acceptAll());
        else if (data === "r" && current) { armed = "one"; message = `revert ${current.rel}? press r or y to confirm`; }
        else if (data === "R") { armed = "all"; message = `revert all ${changes.length} files? press R or y to confirm`; }
        else if (matchesKey(data, Key.up) || data === "k") select(selected - 1);
        else if (matchesKey(data, Key.down) || data === "j") select(selected + 1);
        else if (matchesKey(data, Key.pageDown) || data === " ") scrollBody(Math.max(1, bodyRows - 2));
        else if (matchesKey(data, Key.pageUp)) scrollBody(-Math.max(1, bodyRows - 2));
        else if (data === "g") scrollBody(-Infinity);
        else if (data === "G") scrollBody(Infinity);
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        const row = event.y - layout.top;
        const inContent = row >= 0 && row < layout.rows;
        const inList = layout.leftWidth > 0 && event.x < layout.leftWidth + 3;
        if (event.type === "wheel" && event.wheelDelta) {
          if (inContent && inList) select(selected + Math.sign(event.wheelDelta)); else scrollBody(Math.sign(event.wheelDelta) * 3);
          tui.requestRender(); return { handled: true };
        }
        if (event.type !== "click" || event.button !== "left") return;
        if (event.y === 0 && event.x >= width - 3) { done(); return { handled: true }; }
        if (inContent && inList && listScroll + row < changes.length) { select(listScroll + row); tui.requestRender(); return { handled: true, focus: true }; }
      },
      render(available: number): string[] {
        width = Math.max(24, available);
        bodyRows = contentRows(6, 6);
        const listWidth = sidebarWidth(width, 20, 36);
        const bodyWidth = listWidth ? width - listWidth - 6 : width - 4;
        const current = changes[selected];
        if (!current) return [];
        const key = `${selected}:${bodyWidth}:${current.after.length}`;
        if (cache?.key !== key) cache = { key, lines: renderDiff(current, bodyWidth, fg) };
        const header = listWidth ? [] : [fg("accent", `‹ ${selected + 1}/${changes.length} ${current.rel} ›`), ""];
        const content = [...header, ...cache.lines];
        scroll = Math.max(0, Math.min(scroll, Math.max(0, content.length - bodyRows)));
        if (selected < listScroll) listScroll = selected;
        if (selected >= listScroll + bodyRows) listScroll = selected - bodyRows + 1;
        const list = changes.slice(listScroll, listScroll + bodyRows).map((change, index) => {
          const active = listScroll + index === selected;
          const counts = fg("success", `+${change.added}`) + fg("error", ` −${change.removed}`);
          const name = truncateToWidth((active ? "▌" : " ") + STATUS_MARK[change.status] + " " + change.rel, Math.max(4, listWidth - String(change.added).length - String(change.removed).length - 4));
          return fg(active ? "accent" : "muted", name) + " " + counts;
        });
        const totals = changes.reduce((sum, change) => [sum[0]! + change.added, sum[1]! + change.removed], [0, 0]);
        const title = `± CHANGES · ${changes.length} file${changes.length === 1 ? "" : "s"} · +${totals[0]} −${totals[1]}`;
        const footer = [
          fg("muted", "[ a accept ] [ r revert ] [ A accept all ] [ R revert all ]") + fg("dim", "  ↑↓ file · PgUp/PgDn scroll · Esc close"),
          message ? fg(armed ? "warning" : "dim", message) : fg("dim", "Accepting keeps the file as is; reverting restores it to before the agent's first edit.")
        ];
        const split = splitFrame(theme, width, title, list, content.slice(scroll, scroll + bodyRows), footer, bodyRows, listWidth);
        layout = split.layout;
        return split.lines;
      }
    };
  }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } });
}

/** Track edit/write targets before they run, and expose `/diff` plus ctrl+alt+d. */
export function registerChangeReview(pi: ExtensionAPI, tracker: () => ChangeTracker | undefined, changed: () => void): void {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const path = (event.input as { path?: unknown }).path;
    if (typeof path === "string" && path.trim()) tracker()?.capture(path);
  });
  pi.on("tool_result", (event) => { if (event.toolName === "edit" || event.toolName === "write") changed(); });
  const open = async (ctx: ExtensionContext) => {
    const current = tracker();
    if (!current) return;
    try { await openDiffView(ctx, current); }
    catch (error) { ctx.ui.notify("pi-jar: " + String(error), "error"); }
    changed();
  };
  pi.registerCommand("diff", { description: "Review, accept or revert the files the agent changed", handler: async (_args, ctx) => open(ctx) });
  pi.registerShortcut?.(Key.ctrlAlt("d"), { description: "Review agent changes (pi-jar)", handler: async (ctx) => open(ctx) });
}
