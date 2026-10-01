import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { coarseLineDiff, diffHunkOffsets, diffLineCount, diffRowCount, diffRowsWindow, lineDiff, MAX_REVIEW_DIFF_LINES, type ChangeTracker, type DiffOp, type DiffRow, type FileChange } from "./changes.ts";
import { CHILD_BASELINE_ENV, writeChildBaseline } from "./child-baselines.ts";
import { contentRows, optionList, sidebarWidth, splitFrame } from "./split-view.ts";

const ACTIONS = [
  { key: "a", label: "Accept this file (keep it, stop tracking)" },
  { key: "r", label: "Revert this file (asks to confirm)" },
  { key: "A", label: "Accept all files" },
  { key: "R", label: "Revert all files (asks to confirm)" }
] as const;

const STATUS_MARK = { added: "A", modified: "M", deleted: "D" } as const;
const PREVIEW_WINDOW = 1500;
const SUMMARY_AFTER_BYTES = 256 * 1024;
const SEARCH_HINT = "/ filter · Enter apply · Esc clear";

function wrapPath(path: string, width: number): string[] {
  const points = Array.from(path);
  const lines: string[] = [];
  let line = "";
  for (const point of points) {
    if (line && visibleWidth(line + point) > width) { lines.push(line); line = ""; }
    line += point;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

export interface DiffSearchResult { files: FileChange[]; selected: number }
export function filterChanges(changes: readonly FileChange[], query: string): DiffSearchResult {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return { files: [...changes], selected: 0 };
  return { files: changes.filter(change => `${change.path}\n${change.rel}\n${change.status}`.toLocaleLowerCase().includes(needle)), selected: 0 };
}

export function fullReviewRequired(change: FileChange): boolean {
  return change.diff === null || Buffer.byteLength(change.before) + Buffer.byteLength(change.after) > SUMMARY_AFTER_BYTES
    || diffLineCount(change.before) + diffLineCount(change.after) > PREVIEW_WINDOW;
}

export function fullReviewSupported(change: FileChange): boolean {
  return diffLineCount(change.before) + diffLineCount(change.after) <= MAX_REVIEW_DIFF_LINES;
}

/** Keep indentation but drop escape sequences and control characters that would break layout. */
export const safeLine = (text: string) => text.slice(0, 4000).replace(/\t/g, "  ")
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b./g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, "·");

/** Styled diff rows for one file, with a gutter of old/new line numbers. */
export function renderDiff(change: FileChange, width: number, fg: (color: string, text: string) => string,
  options: { fullReview?: boolean; scroll?: number; rows?: number; unified?: boolean; ops?: readonly DiffOp[]; coarse?: boolean } = {}): string[] {
  const large = fullReviewRequired(change);
  if (large && (!options.fullReview || !fullReviewSupported(change))) return [
    fg("warning", `Summary preview · +${change.added} −${change.removed} · ${(Buffer.byteLength(change.before) + Buffer.byteLength(change.after)) / 1024 | 0} KiB`),
    fg("dim", fullReviewSupported(change) ? "Press v for a windowed full review, or keep this summary." : "Full review unavailable: preview is bounded to 100,000 combined lines."),
    fg("dim", "Older/binary/over-1 MiB files are not tracked for safe revert.")
  ];
  const exact = options.ops ? change.diff : (change.diff === null ? undefined : (change.diff ?? lineDiff(change.before, change.after)));
  const ops = options.ops ?? exact ?? coarseLineDiff(change.before, change.after);
  const rows = Math.min(options.rows ?? PREVIEW_WINDOW, PREVIEW_WINDOW);
  const scroll = Math.max(0, options.scroll ?? 0);
  const visible = diffRowsWindow(ops, 3, scroll, rows);
  if (!visible.length) return [fg("dim", scroll ? "End of diff." : "No textual changes.")];
  const bounded = options.coarse ?? (change.diff === null || (!options.ops && exact === undefined));
  const gutter = Math.max(3, String(Math.max(...visible.map((row) => Math.max(row.oldLine ?? 0, row.newLine ?? 0)))).length);
  const num = (value?: number) => (value ? String(value) : "").padStart(gutter);
  if (options.unified === false) {
    const column = Math.max(8, Math.floor((width - 3) / 2));
    return [
      truncateToWidth(fg("accent", "Original"), column, "…", true) + fg("dim", " │ ") + fg("accent", "Updated"),
      ...(bounded ? [fg("warning", "Coarse preview: replacement groups are approximate.")] : []),
      ...visible.map(row => {
        if (row.kind === "hunk") return fg("accent", row.text);
        const oldText = row.kind === "add" ? "" : `${num(row.oldLine)} ${row.kind === "remove" ? "-" : " "}${safeLine(row.text)}`;
        const newText = row.kind === "remove" ? "" : `${num(row.newLine)} ${row.kind === "add" ? "+" : " "}${safeLine(row.text)}`;
        const left = truncateToWidth(oldText, column, "…", true);
        const right = truncateToWidth(newText, column, "…", true);
        return (row.kind === "remove" ? fg("error", left) : fg("muted", left)) + fg("dim", " │ ")
          + (row.kind === "add" ? fg("success", right) : fg("muted", right));
      })
    ];
  }
  const rendered = visible.map((row) => {
    if (row.kind === "hunk") return fg("accent", row.text);
    const text = truncateToWidth(safeLine(row.text), Math.max(1, width - gutter * 2 - 4));
    const prefix = fg("dim", `${num(row.oldLine)} ${num(row.newLine)} `);
    if (row.kind === "add") return prefix + fg("success", "+" + text);
    if (row.kind === "remove") return prefix + fg("error", "-" + text);
    return prefix + fg("muted", " " + text);
  });
  if (bounded) rendered.unshift(fg("warning", "Coarse preview: LCS budget exceeded; full review preserves file order but replacement groups are approximate."));
  if (change.added + change.removed > rows) rendered.push(fg("dim", `Windowed preview at row ${scroll + 1} · PgUp/PgDn or j/k`));
  return rendered;
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
    let query = "";
    let searchMode = false;
    let fullReview = false;
    let unified = true;
    let bodyRows = 0;
    let viewportRows = 1;
    let width = 80;
    let armed: "one" | "all" | undefined;
    let message = "";
    let layout = { top: 1, rows: 0, leftWidth: 0, bodyX: 2, footerTop: 0 };
    let cache: { key: string; lines: string[] } | undefined;
    let opCache: { key: string; ops: readonly DiffOp[]; hunks: number[]; rows: number; coarse: boolean } | undefined;
    const fg = (color: string, text: string) => theme.fg(color as never, text);
    const refresh = () => {
      changes = tracker.changes();
      cache = undefined;
      opCache = undefined;
      selected = Math.min(selected, Math.max(0, visibleChanges().length - 1));
      scroll = 0;
      if (!changes.length) done();
    };
    const run = (label: string, action: () => void) => {
      try { action(); message = label; }
      catch (error) { message = "failed: " + (error instanceof Error ? error.message : String(error)); ctx.ui.notify("pi-jar: " + message, "error"); }
      refresh();
    };
    const visibleChanges = () => filterChanges(changes, query).files;
    const currentChange = () => visibleChanges()[selected];
    const select = (index: number) => { selected = Math.max(0, Math.min(visibleChanges().length - 1, index)); scroll = 0; fullReview = false; cache = undefined; opCache = undefined; };
    const scrollBody = (delta: number) => {
      const max = Math.max(0, (opCache?.rows ?? 0) - viewportRows);
      scroll = Math.max(0, Math.min(max, scroll + delta)); cache = undefined;
    };
    const component = {
      invalidate() { cache = undefined; },
      handleInput(data: string) {
        if (searchMode) {
          if (matchesKey(data, Key.escape)) { searchMode = false; query = ""; selected = 0; listScroll = 0; }
          else if (matchesKey(data, Key.ctrl("u"))) query = "";
          else if (matchesKey(data, Key.enter)) searchMode = false;
          else if (matchesKey(data, Key.backspace)) query = query.slice(0, -1);
          else if (data.length === 1 && data >= " " && data <= "~") query += data;
          selected = Math.min(selected, Math.max(0, visibleChanges().length - 1));
          listScroll = 0; scroll = 0; cache = undefined; opCache = undefined; tui.requestRender(); return;
        }
        const current = currentChange();
        if (armed && (data === "y" || (armed === "one" && data === "r") || (armed === "all" && data === "R"))) {
          const scope = armed; armed = undefined;
          if (scope === "all") run(`reverted ${changes.length} file(s)`, () => { for (const change of changes) tracker.revert(change.path); });
          else if (current) run(`reverted ${current.rel}`, () => tracker.revert(current.path));
          tui.requestRender(); return;
        }
        armed = undefined;
        if (matchesKey(data, Key.escape) && query) {
          query = ""; selected = 0; listScroll = 0; scroll = 0; fullReview = false; cache = undefined; opCache = undefined;
          tui.requestRender(); return;
        }
        if (matchesKey(data, Key.escape) || data === "q") return done();
        if (data === "/") { searchMode = true; query = ""; }
        else if (data === "n" && query) select(selected + 1);
        else if (data === "N" && query) select(selected - 1);
        else if (data === "t") { unified = !unified; cache = undefined; message = unified ? "Unified diff" : "Side-by-side diff"; }
        else if (data === "v" && current && fullReviewRequired(current) && fullReviewSupported(current)) {
          fullReview = !fullReview; scroll = 0; cache = undefined; opCache = undefined; message = fullReview ? "Full windowed review · LCS budget may label a coarse replacement" : "Summary preview";
        }
        else if (data === "a" && current) run(`accepted ${current.rel}`, () => tracker.accept(current.path));
        else if (data === "A" && current) run(`accepted ${changes.length} file(s)`, () => tracker.acceptAll());
        else if (data === "r" && current) { armed = "one"; message = `revert ${current.rel}? press r or y to confirm`; }
        else if (data === "R" && current) { armed = "all"; message = `revert all ${changes.length} files? press R or y to confirm`; }
        else if (matchesKey(data, Key.up) || data === "k") select(selected - 1);
        else if (matchesKey(data, Key.down) || data === "j") select(selected + 1);
        else if (matchesKey(data, Key.pageDown) || data === " ") scrollBody(Math.max(1, bodyRows - 2));
        else if (matchesKey(data, Key.pageUp)) scrollBody(-Math.max(1, bodyRows - 2));
        else if (data === "n" && !query && opCache?.hunks.length) {
          scroll = opCache.hunks.find(offset => offset > scroll) ?? opCache.hunks[0]!; cache = undefined;
        }
        else if (data === "p" && opCache?.hunks.length) {
          scroll = [...opCache.hunks].reverse().find(offset => offset < scroll) ?? opCache.hunks.at(-1)!; cache = undefined;
        }
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
        if (inContent && inList && listScroll + row < visibleChanges().length) { select(listScroll + row); tui.requestRender(); return { handled: true, focus: true }; }
        const action = ACTIONS[event.y - layout.footerTop];
        if (action) { component.handleInput(action.key); return { handled: true }; }
      },
      render(available: number): string[] {
        width = Math.max(24, available);
        bodyRows = contentRows(7 + ACTIONS.length, 6);
        const listWidth = sidebarWidth(width, 20, 36);
        const bodyWidth = listWidth ? width - listWidth - 6 : width - 4;
        const filtered = visibleChanges();
        const current = filtered[selected];
        if (!current) return [fg("dim", `No files match /${safeLine(query)}`), fg("dim", "Press / to edit the filter or Esc to clear it.")];
        const opKey = `${current.path}:${current.before.length}:${current.after.length}`;
        if (opCache?.key !== opKey && (!fullReviewRequired(current) || fullReview)) {
          const exact = current.diff === null ? undefined : (current.diff ?? lineDiff(current.before, current.after));
          const coarse = exact === undefined;
          const ops = exact ?? coarseLineDiff(current.before, current.after);
          opCache = { key: opKey, ops, hunks: diffHunkOffsets(ops), rows: diffRowCount(ops), coarse };
        }
        const pathLines = wrapPath(current.path.replace(/[\x00-\x1f\x7f-\x9f]/g, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`), bodyWidth);
        // Reserve wrapped path, metadata, split/coarse headers and the optional window footer.
        viewportRows = Math.max(1, bodyRows - pathLines.length - 1 - (unified ? 0 : 1) - (opCache?.coarse ? 1 : 0) - 1);
        scroll = Math.min(scroll, Math.max(0, (opCache?.rows ?? 0) - viewportRows));
        const key = `${current.path}:${bodyWidth}:${bodyRows}:${viewportRows}:${unified}:${fullReview}:${scroll}`;
        if (cache?.key !== key) cache = { key, lines: renderDiff(current, bodyWidth, fg, { fullReview, scroll, rows: viewportRows, ops: opCache?.ops, coarse: opCache?.coarse, unified }) };
        // The absolute path is intentionally the first row of the right pane, even in split mode.
        const content = [...pathLines.map(path => fg("accent", path)),
          fg("dim", `${selected + 1}/${filtered.length} · ${current.status} · +${current.added} −${current.removed}`), ...cache.lines];
        if (selected < listScroll) listScroll = selected;
        if (selected >= listScroll + bodyRows) listScroll = selected - bodyRows + 1;
        const list = filtered.slice(listScroll, listScroll + bodyRows).map((change, index) => {
          const active = listScroll + index === selected;
          const counts = fg("success", `+${change.added}`) + fg("error", ` −${change.removed}`);
          const name = truncateToWidth((active ? "▌" : " ") + STATUS_MARK[change.status] + " " + change.rel, Math.max(4, listWidth - String(change.added).length - String(change.removed).length - 4));
          return fg(active ? "accent" : "muted", name) + " " + counts;
        });
        const totals = filtered.reduce((sum, change) => [sum[0]! + change.added, sum[1]! + change.removed], [0, 0]);
        const title = `± CHANGES · ${filtered.length}/${changes.length} files · +${totals[0]} −${totals[1]}`;
        const footer = [
          ...optionList(theme, ACTIONS.map((item) => item.label), -1, ACTIONS.map((item) => item.key)),
          fg(searchMode ? "accent" : "dim", searchMode ? `/${query} · Enter apply · Esc clear` : query ? `/${query} · n/N next match · / new search` : `${SEARCH_HINT} · n/p hunk · t split/unified · v full preview`),
          message ? fg(armed ? "warning" : "dim", message) : fg("dim", "↑↓ file · PgUp/PgDn scroll · a accept · r revert · Esc close")
        ];
        const split = splitFrame(theme, width, title, list, content.slice(0, bodyRows), footer, bodyRows, listWidth);
        layout = split.layout;
        return split.lines;
      }
    };
    return component;
  }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } });
}

/** Track edit/write targets before they run, and expose `/diff` plus ctrl+alt+d. */
export function registerChangeReview(pi: ExtensionAPI, tracker: () => ChangeTracker | undefined, changed: () => void): void {
  // Keep the path that belonged to each in-flight edit/write so tool completion dirties only
  // that file. Older Pi builds may omit toolCallId here, hence the small FIFO fallback.
  const pending = new Map<string, string>();
  const fallback: string[] = [];
  // Subagent side: hand each first-edit baseline to the parent so its /diff covers our edits.
  const reported = new Set<string>();
  pi.on("tool_call", (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const path = (event.input as { path?: unknown }).path;
    const current = tracker();
    if (typeof path !== "string" || !path.trim() || !current?.capture(path)) return;
    const dir = process.env[CHILD_BASELINE_ENV];
    const abs = current.absolute(path);
    const before = current.baseline(abs);
    // A failed write is reported once and not retried: a later retry would share a newer baseline.
    if (dir && before !== undefined && !reported.has(abs)) {
      try { writeChildBaseline(dir, abs, before); }
      catch (error) { reported.add(abs); console.error(`pi-jar: cannot share baseline for ${abs}: ${String(error)}`); }
    }
    const id = (event as { toolCallId?: unknown }).toolCallId;
    if (typeof id === "string" && id) pending.set(id, path);
    fallback.push(path);
  });
  pi.on("tool_result", (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const id = (event as { toolCallId?: unknown }).toolCallId;
    let path: string | undefined;
    if (typeof id === "string" && id) {
      path = pending.get(id);
      pending.delete(id);
      if (path) {
        const index = fallback.indexOf(path);
        if (index >= 0) fallback.splice(index, 1);
      }
    }
    if (!path) path = fallback.shift();
    const failed = (event as { isError?: unknown }).isError === true;
    if (path && !failed && tracker()?.markDirty(path)) changed();
  });
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
