import { getLanguageFromPath, highlightCode, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { popup } from "./popup.ts";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { coarseLineDiff, diffHunkOffsets, diffLineCount, diffRowCount, diffRowsWindow, diffSplitHunkOffsets, diffSplitRowCount, diffSplitRowsWindow,
  lineDiff, MAX_REVIEW_DIFF_LINES, type ChangeTracker, type DiffOp, type FileChange } from "./changes.ts";
import { emphasize, inlineChanges } from "./diff-inline.ts";
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

/** Optional styling hooks; tests and plain output omit them. */
export interface DiffPaint {
  /** Syntax colours (foreground SGR only) for one display line, or undefined to use diff colours. */
  syntax?: (text: string) => string | undefined;
  /** SGR background sequence that tints a changed line's text. */
  tint?: (kind: "add" | "remove") => string;
}

/** Context sizes cycled by ←/→ (and [/]); Infinity shows whole files. */
export const CONTEXT_STEPS = [0, 1, 3, 5, 10, 25, Infinity] as const;
/** Split columns narrower than this fall back to unified rows. */
export const MIN_SPLIT_WIDTH = 70;

export interface DiffRenderOptions {
  fullReview?: boolean; scroll?: number; rows?: number; unified?: boolean; ops?: readonly DiffOp[]; coarse?: boolean;
  context?: number; wrap?: boolean; paint?: DiffPaint;
}
/** Rendered page plus how many logical rows it consumed (wrapping can show fewer than `rows`). */
export interface DiffWindow { lines: string[]; shown: number; total: number }

type Kind = "add" | "remove" | "context";
const RESET = "\x1b[0m";
const KIND_COLOR = { add: "success", remove: "error", context: "muted" } as const;
const SIGN = { add: "+", remove: "-", context: " " } as const;

/** Styled diff rows for one file, with a gutter of old/new line numbers. */
export function renderDiff(change: FileChange, width: number, fg: (color: string, text: string) => string, options: DiffRenderOptions = {}): string[] {
  return renderDiffWindow(change, width, fg, options).lines;
}

export function renderDiffWindow(change: FileChange, width: number, fg: (color: string, text: string) => string, options: DiffRenderOptions = {}): DiffWindow {
  const large = fullReviewRequired(change);
  if (large && (!options.fullReview || !fullReviewSupported(change))) return { shown: 0, total: 0, lines: [
    fg("warning", `Summary preview · +${change.added} −${change.removed} · ${(Buffer.byteLength(change.before) + Buffer.byteLength(change.after)) / 1024 | 0} KiB`),
    fg("dim", fullReviewSupported(change) ? "Press v for a windowed full review, or keep this summary." : "Full review unavailable: preview is bounded to 100,000 combined lines."),
    fg("dim", "Older/binary/over-1 MiB files are not tracked for safe revert.")
  ] };
  const exact = options.ops ? change.diff : (change.diff === null ? undefined : (change.diff ?? lineDiff(change.before, change.after)));
  const ops = options.ops ?? exact ?? coarseLineDiff(change.before, change.after);
  const rows = Math.max(1, Math.min(options.rows ?? PREVIEW_WINDOW, PREVIEW_WINDOW));
  const scroll = Math.max(0, options.scroll ?? 0);
  const context = options.context ?? 3;
  const unified = options.unified !== false;
  const wrap = options.wrap === true;
  const paint = options.paint ?? {};
  const total = unified ? diffRowCount(ops, context) : diffSplitRowCount(ops, context);
  const unifiedRows = unified ? diffRowsWindow(ops, context, scroll, rows) : [];
  const splitRows = unified ? [] : diffSplitRowsWindow(ops, context, scroll, rows);
  if (!unifiedRows.length && !splitRows.length) return { lines: [fg("dim", scroll ? "End of diff." : "No textual changes.")], shown: 0, total };
  const bounded = options.coarse ?? (change.diff === null || (!options.ops && exact === undefined));
  let widest = 0;
  for (const row of unifiedRows) widest = Math.max(widest, row.oldLine ?? 0, row.newLine ?? 0);
  for (const row of splitRows) if (row.kind === "pair") widest = Math.max(widest, row.left?.line ?? 0, row.right?.line ?? 0);
  const gutter = Math.max(3, String(widest).length);
  const num = (value?: number) => (value ? String(value) : "").padStart(gutter);

  // Coarse replacement groups pair unrelated lines, so intraline emphasis would mislead there.
  const style = (text: string, kind: Kind, pair: string | undefined) => {
    const display = safeLine(text);
    const styled = paint.syntax?.(display) ?? fg(KIND_COLOR[kind], display);
    if (bounded || kind === "context" || pair === undefined) return styled;
    const changes = kind === "remove" ? inlineChanges(display, safeLine(pair)) : inlineChanges(safeLine(pair), display);
    return changes ? emphasize(styled, kind === "remove" ? changes.before : changes.after) : styled;
  };
  // Rail, numbers and sign, then text truncated or wrapped into the cell; continuation lines keep
  // the rail only. Truncation emits full resets, so a tint is re-applied after each one.
  const cell = (kind: Kind, lead: string, text: string, width: number, pair?: string): string[] => {
    const leadWidth = visibleWidth(lead);
    const textWidth = Math.max(1, width - leadWidth - 2);
    const rail = kind === "context" ? " " : fg(KIND_COLOR[kind], "▌");
    const tint = kind === "context" ? undefined : paint.tint?.(kind);
    const styled = style(text, kind, pair);
    return (wrap ? wrapTextWithAnsi(styled, textWidth) : [truncateToWidth(styled, textWidth, "…")]).map((body, index) => {
      const prefix = index ? " ".repeat(leadWidth + 1) : fg("dim", lead) + fg(KIND_COLOR[kind], SIGN[kind]);
      const content = body + " ".repeat(Math.max(0, textWidth - visibleWidth(body)));
      return rail + prefix + (tint ? tint + content.replaceAll(RESET, RESET + tint) : content) + RESET;
    });
  };
  const hunkLine = (text: string, hidden: number | undefined) => truncateToWidth(
    (hidden ? fg("dim", `┄ ${hidden} unchanged line${hidden === 1 ? "" : "s"} ┄ `) : "") + fg("accent", text), width, "…");

  const blocks: string[][] = unified
    ? unifiedRows.map(row => row.kind === "hunk" ? [hunkLine(row.text, row.hidden)]
      : cell(row.kind === "add" ? "add" : row.kind === "remove" ? "remove" : "context", `${num(row.oldLine)} ${num(row.newLine)} `, row.text, width, row.pair))
    : splitRows.map(row => {
      if (row.kind === "hunk") return [hunkLine(row.text, row.hidden)];
      const column = Math.max(8, Math.floor((width - 3) / 2));
      const replaced = row.left?.changed && row.right?.changed;
      const left = row.left ? cell(row.left.changed ? "remove" : "context", num(row.left.line) + " ", row.left.text, column, replaced ? row.right!.text : undefined) : [];
      const right = row.right ? cell(row.right.changed ? "add" : "context", num(row.right.line) + " ", row.right.text, column, replaced ? row.left!.text : undefined) : [];
      return Array.from({ length: Math.max(left.length, right.length) }, (_, index) =>
        (left[index] ?? " ".repeat(column)) + fg("dim", " │ ") + (right[index] ?? ""));
    });
  const lines: string[] = [];
  if (bounded) lines.push(fg("warning", unified ? "Coarse preview: LCS budget exceeded; full review preserves file order but replacement groups are approximate."
    : "Coarse preview: replacement groups are approximate."));
  if (!unified) {
    const column = Math.max(8, Math.floor((width - 3) / 2));
    lines.push(truncateToWidth(fg("accent", "Original"), column, "…", true) + fg("dim", " │ ") + fg("accent", "Updated"));
  }
  // Fill the viewport with whole logical rows; a first row taller than the viewport is clipped.
  let used = 0, shown = 0;
  for (const block of blocks) {
    if (shown && used + block.length > rows) break;
    const visible = block.slice(0, rows - used);
    lines.push(...visible);
    used += visible.length;
    shown++;
    if (used >= rows) break;
  }
  if (scroll > 0 || scroll + shown < total) lines.push(fg("dim", `Windowed preview · rows ${scroll + 1}–${scroll + shown} of ${total} · PgUp/PgDn`));
  return { lines, shown, total };
}

/**
 * Review what the agent changed: files on the left, the selected diff on the right.
 * `a` accepts (stops tracking) and `r` then `y` reverts a file; `A`/`R` apply to all.
 */
export async function openDiffView(ctx: ExtensionContext, tracker: ChangeTracker): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  let changes = tracker.changes();
  if (!changes.length) { ctx.ui.notify("pi-jar: no agent changes to review", "info"); return; }
  await popup<void>(ctx, (tui, theme, _keys, done) => {
    let selected = 0;
    let scroll = 0;
    let listScroll = 0;
    let query = "";
    let searchMode = false;
    let fullReview = false;
    let unified = true;
    let contextIndex = CONTEXT_STEPS.indexOf(3);
    let wrap = false;
    let bodyRows = 0;
    let bodyWidth = 80;
    let viewportRows = 1;
    let width = 80;
    let armed: "one" | "all" | undefined;
    let message = "";
    let layout = { top: 1, rows: 0, leftWidth: 0, bodyX: 2, footerTop: 0 };
    let cache: { key: string; lines: string[]; shown: number } | undefined;
    let opCache: { key: string; ops: readonly DiffOp[]; coarse: boolean } | undefined;
    let paintCache: { path: string; paint: DiffPaint } | undefined;
    const fg = (color: string, text: string) => theme.fg(color as never, text);
    const context = () => CONTEXT_STEPS[contextIndex]!;
    const contextLabel = () => Number.isFinite(context()) ? `${context()} line${context() === 1 ? "" : "s"}` : "whole file";
    // Split columns need room; narrower panes keep the unified layout instead of unreadable halves.
    const splitMode = () => !unified && bodyWidth >= MIN_SPLIT_WIDTH;
    const rowLayout = () => {
      if (!opCache) return { hunks: [] as number[], rows: 0 };
      return splitMode()
        ? { hunks: diffSplitHunkOffsets(opCache.ops, context()), rows: diffSplitRowCount(opCache.ops, context()) }
        : { hunks: diffHunkOffsets(opCache.ops, context()), rows: diffRowCount(opCache.ops, context()) };
    };
    // Row offsets change with context and split mode; keep the hunk at the top of the viewport.
    const relayout = (change: () => void) => {
      const before = rowLayout().hunks;
      let hunk = -1;
      for (let index = 0; index < before.length && before[index]! <= scroll; index++) hunk = index;
      change();
      scroll = hunk >= 0 ? rowLayout().hunks[hunk] ?? 0 : 0;
      cache = undefined;
    };
    const paintFor = (change: FileChange): DiffPaint => {
      if (paintCache?.path !== change.path) {
        const language = getLanguageFromPath(change.path);
        const bg = (theme as { getBgAnsi?: (color: "toolSuccessBg" | "toolErrorBg") => string }).getBgAnsi?.bind(theme);
        paintCache = { path: change.path, paint: {
          // Per-line highlighting is bounded; very long lines, or a host without Pi's highlighter
          // theme initialised, keep plain diff colours instead of failing the review.
          ...(language ? { syntax: (text: string) => {
            if (text.length > 1000) return undefined;
            try { return highlightCode(text, language)[0]; } catch { return undefined; }
          } } : {}),
          ...(bg ? { tint: (kind: "add" | "remove") => bg(kind === "add" ? "toolSuccessBg" : "toolErrorBg") } : {})
        } };
      }
      return paintCache.paint;
    };
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
    const windowAt = (change: FileChange, at: number) => renderDiffWindow(change, bodyWidth, fg, { fullReview, scroll: at, rows: viewportRows,
      ops: opCache?.ops, coarse: opCache?.coarse, unified: !splitMode(), context: context(), wrap, paint: paintFor(change) });
    // Wrapped rows vary in height: the last page starts at the first row whose tail fits the
    // viewport. Measured only when scrolling past the cheap bound, at most one viewport of renders.
    const lastScroll = () => {
      const total = rowLayout().rows;
      let at = Math.max(0, total - viewportRows);
      const current = currentChange();
      if (!wrap || !current) return at;
      while (at < total - 1 && at + windowAt(current, at).shown < total) at++;
      return at;
    };
    const scrollBody = (delta: number) => {
      const target = scroll + delta;
      const cheap = Math.max(0, rowLayout().rows - viewportRows);
      scroll = Math.max(0, target <= cheap ? target : Math.min(target, lastScroll())); cache = undefined;
    };
    const page = () => Math.max(1, (wrap ? cache?.shown ?? 1 : viewportRows) - 1);
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
        else if (data === "t") {
          relayout(() => { unified = !unified; });
          message = unified ? "Unified diff" : bodyWidth >= MIN_SPLIT_WIDTH ? "Side-by-side diff" : `Side-by-side needs ${MIN_SPLIT_WIDTH} columns; showing unified`;
        }
        else if (matchesKey(data, Key.left) || data === "[") {
          relayout(() => { contextIndex = Math.max(0, contextIndex - 1); }); message = `Context: ${contextLabel()}`;
        }
        else if (matchesKey(data, Key.right) || data === "]") {
          relayout(() => { contextIndex = Math.min(CONTEXT_STEPS.length - 1, contextIndex + 1); }); message = `Context: ${contextLabel()}`;
        }
        else if (data === "w") { wrap = !wrap; cache = undefined; message = wrap ? "Wrapping long lines" : "Truncating long lines"; }
        else if (data === "v" && current && fullReviewRequired(current) && fullReviewSupported(current)) {
          fullReview = !fullReview; scroll = 0; cache = undefined; opCache = undefined; message = fullReview ? "Full windowed review · LCS budget may label a coarse replacement" : "Summary preview";
        }
        else if (data === "a" && current) run(`accepted ${current.rel}`, () => tracker.accept(current.path));
        else if (data === "A" && current) run(`accepted ${changes.length} file(s)`, () => tracker.acceptAll());
        else if (data === "r" && current) { armed = "one"; message = `revert ${current.rel}? press r or y to confirm`; }
        else if (data === "R" && current) { armed = "all"; message = `revert all ${changes.length} files? press R or y to confirm`; }
        else if (matchesKey(data, Key.up) || data === "k") select(selected - 1);
        else if (matchesKey(data, Key.down) || data === "j") select(selected + 1);
        else if (matchesKey(data, Key.pageDown) || data === " ") scrollBody(page());
        else if (matchesKey(data, Key.pageUp)) scrollBody(-page());
        else if (data === "n" && !query && rowLayout().hunks.length) {
          const hunks = rowLayout().hunks;
          scroll = hunks.find(offset => offset > scroll) ?? hunks[0]!; cache = undefined;
        }
        else if (data === "p" && rowLayout().hunks.length) {
          const hunks = rowLayout().hunks;
          scroll = [...hunks].reverse().find(offset => offset < scroll) ?? hunks.at(-1)!; cache = undefined;
        }
        else if (data === "g" || matchesKey(data, Key.home)) scrollBody(-Infinity);
        else if (data === "G" || matchesKey(data, Key.end)) scrollBody(Infinity);
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
        bodyWidth = listWidth ? width - listWidth - 6 : width - 4;
        const filtered = visibleChanges();
        const current = filtered[selected];
        if (!current) return [fg("dim", `No files match /${safeLine(query)}`), fg("dim", "Press / to edit the filter or Esc to clear it.")];
        const opKey = `${current.path}:${current.before.length}:${current.after.length}`;
        if (opCache?.key !== opKey && (!fullReviewRequired(current) || fullReview)) {
          const exact = current.diff === null ? undefined : (current.diff ?? lineDiff(current.before, current.after));
          opCache = { key: opKey, ops: exact ?? coarseLineDiff(current.before, current.after), coarse: exact === undefined };
        }
        const pathLines = wrapPath(current.path.replace(/[\x00-\x1f\x7f-\x9f]/g, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`), bodyWidth);
        // Reserve wrapped path, metadata, split/coarse headers and the optional window footer.
        viewportRows = Math.max(1, bodyRows - pathLines.length - 1 - (splitMode() ? 1 : 0) - (opCache?.coarse ? 1 : 0) - 1);
        scroll = Math.min(scroll, Math.max(0, rowLayout().rows - (wrap ? 1 : viewportRows)));
        const key = `${current.path}:${bodyWidth}:${bodyRows}:${viewportRows}:${splitMode()}:${fullReview}:${scroll}:${contextIndex}:${wrap}`;
        if (cache?.key !== key) {
          const page = windowAt(current, scroll);
          cache = { key, lines: page.lines, shown: page.shown };
        }
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
          fg(searchMode ? "accent" : "dim", searchMode ? `/${query} · Enter apply · Esc clear`
            : query ? `/${query} · n/N next match · / new search`
            : `${SEARCH_HINT} · n/p hunk · t split · ←/→ context (${contextLabel()}) · w wrap${wrap ? " on" : ""} · v full`),
          message ? fg(armed ? "warning" : "dim", message) : fg("dim", "↑↓ file · PgUp/PgDn/Home/End scroll · a accept · r revert · Esc close")
        ];
        const split = splitFrame(theme, width, title, list, content.slice(0, bodyRows), footer, bodyRows, listWidth);
        layout = split.layout;
        return split.lines;
      }
    };
    return component;
  }, { filter: false });
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
