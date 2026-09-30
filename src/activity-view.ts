import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { duration, leafTodos, type DelegateRegistry, type DelegateRun, type SubagentRecord, type TranscriptEntry } from "./delegate.ts";
import { safeLine } from "./diff-view.ts";
import { icon, withIcon } from "./icons.ts";
import { describe, elapsed, type ShellJob, type ShellManager } from "./shells.ts";
import { contentRows, optionList, sidebarWidth, splitFrame } from "./split-view.ts";
import { ACTIVE_STATES, cleanText } from "./status.ts";
import type { Todo } from "./tasks.ts";

/** What to select when the view opens. */
export type ActivityTarget = { kind: "subagent" | "shell"; id: string };
/** A teammate another extension publishes through the role-status contract; listed read-only. */
export interface ActivityRole { id: string; name: string; state: string; task?: string }
export interface ActivitySources {
  subagents: DelegateRegistry;
  shells?: ShellManager;
  roles?: () => ActivityRole[];
}

/** Doubles as the icon key for the row glyph. */
type Status = "running" | "pending" | "success" | "error" | "stopped";
type Fg = (color: string, text: string) => string;
type Entry =
  | { kind: "subagent"; id: string; status: Status; label: string; record: SubagentRecord }
  | { kind: "shell"; id: string; status: Status; label: string; job: Omit<ShellJob, "lines"> }
  | { kind: "role"; id: string; status: Status; label: string; role: ActivityRole };
type Item = Entry | { kind: "header"; label: string };
type Focus = "list" | "transcript" | "input";

const COLOR: Record<Status, string> = { running: "accent", pending: "dim", success: "success", error: "error", stopped: "dim" };
const ACTIONS = [{ key: "x" }, { key: "f" }] as const;
const SHELL_TAIL = 400;
const MAX_TASK_CHARS = 8000;
/** Expanded tool output shows at most this many wrapped rows; the rest is summarized. */
const MAX_OUTPUT_ROWS = 80;
const MAX_ARGS_ROWS = 12;
const LIVE_ROWS = 4;
const MAX_DRAFT = 2000;
const SPINNER = ["◐", "◓", "◑", "◒"];

/** Left-pane rows: a header per non-empty section, then its entries. */
function collect(sources: ActivitySources): Item[] {
  const items: Item[] = [];
  const records = sources.subagents.records();
  if (records.length) items.push({ kind: "header", label: withIcon("subagents", "SUBAGENTS") });
  for (const record of records) {
    const { run } = record;
    const status: Status = run.state === "working" ? "running" : run.state === "queued" || run.state === "idle" ? "pending"
      : run.state === "paused" || run.state === "stopped" ? "stopped" : run.state === "done" ? "success" : "error";
    items.push({ kind: "subagent", id: record.key, status, label: run.name, record });
  }
  const jobs = sources.shells?.summaries() ?? [];
  if (jobs.length) items.push({ kind: "header", label: withIcon("shell", "SHELLS") });
  for (const job of jobs) {
    const status: Status = job.status === "running" ? "running" : job.status === "exited" && job.exitCode === 0 ? "success" : job.status === "killed" ? "stopped" : "error";
    items.push({ kind: "shell", id: job.id, status, label: `${job.id} ${job.name}`, job });
  }
  let roles: ActivityRole[] = [];
  try { roles = sources.roles?.() ?? []; } catch { /* teammates are decoration */ }
  // jar_delegate publishes each run as a role status under its record key: list those once, as subagents.
  roles = roles.filter((role) => !sources.subagents.get(role.id));
  if (roles.length) items.push({ kind: "header", label: withIcon("roles", "ROLES") });
  for (const role of roles) {
    const status: Status = (ACTIVE_STATES as ReadonlySet<string>).has(role.state) ? "running" : role.state === "done" ? "success" : role.state === "failed" ? "error" : "pending";
    items.push({ kind: "role", id: role.id, status, label: cleanText(role.name, 32) || role.id, role });
  }
  return items;
}

/** `head` stays pinned above the scrolling `body`, so following a transcript never hides who is running and how. */
interface Details {
  head: string[];
  body: readonly string[];
  /** Styles one body line; applied to the visible window only, so a 400-line shell tail costs a screenful. */
  format?: (line: string) => string;
}

/**
 * One collapsible piece of a subagent's details. `key` is stable across renders (the transcript entry
 * itself, or a per-run object), so expansion state and cached rows survive live updates.
 */
interface Block {
  key: object;
  /** Changes whenever the block's content does. */
  rev: string;
  expandable: boolean;
  /** Expanded unless the user toggled it. */
  open: boolean;
  /** Rows for the given state, without the two-column gutter. */
  rows(expanded: boolean, width: number): string[];
}

const wrap = (text: string, width: number) => {
  const rows: string[] = [];
  for (const raw of text.split("\n")) for (const line of wrapTextWithAnsi(safeLine(raw), Math.max(1, width))) rows.push(line);
  return rows;
};
const firstLine = (text: string) => { const end = text.indexOf("\n"); return end < 0 ? text : text.slice(0, end); };
const lineCount = (text: string) => { let count = 1; for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) count++; return count; };
const clipped = (rows: string[], limit: number, fg: Fg) => rows.length <= limit ? rows : [...rows.slice(0, limit), fg("dim", `… ${rows.length - limit} more lines`)];

function todoRows(todos: readonly Todo[], width: number, fg: Fg): string[] {
  const counts = new Map<string, { done: number; total: number }>();
  for (const todo of todos) if (todo.parentId) {
    const count = counts.get(todo.parentId) ?? { done: 0, total: 0 };
    count.total++;
    if (todo.done) count.done++;
    counts.set(todo.parentId, count);
  }
  return todos.map((todo) => {
    const indent = todo.parentId ? "    " : "  ";
    const count = counts.get(todo.id);
    const suffix = count ? fg("dim", ` (${count.done}/${count.total})`) : "";
    const room = Math.max(1, width - indent.length - 2 - (count ? `${count.done}/${count.total}`.length + 3 : 0));
    const title = truncateToWidth(safeLine(todo.title), room);
    if (todo.status === "completed") return fg("success", `${indent}✔ `) + fg("dim", "\x1b[9m" + title + "\x1b[29m") + suffix;
    if (todo.status === "in_progress") return fg("accent", `${indent}◼ ${title}`) + suffix;
    return fg("muted", `${indent}☐ ${title}`) + suffix;
  });
}

/** Per-run keys for the blocks that are not transcript entries. */
const runKeys = new WeakMap<DelegateRun, { task: object; todos: object; live: object; report: object }>();
const keysOf = (run: DelegateRun) => {
  let keys = runKeys.get(run);
  if (!keys) { keys = { task: {}, todos: {}, live: {}, report: {} }; runKeys.set(run, keys); }
  return keys;
};

function entryBlock(entry: TranscriptEntry, fg: Fg): Block {
  if (entry.kind === "tool") {
    const glyph = entry.status === "running" ? fg("accent", "●") : entry.status === "error" ? fg("error", "✖") : fg("success", "✔");
    const took = entry.endedAt !== undefined ? fg("dim", ` · ${duration(entry.endedAt - entry.startedAt)}`) : fg("dim", " · running");
    return {
      key: entry, rev: `${entry.rev}`, expandable: true, open: false,
      rows(expanded, width) {
        const head = fg("dim", expanded ? "▾ " : "▸ ") + glyph + " " + fg("accent", entry.name) + (entry.hint ? " " + fg("muted", safeLine(entry.hint)) : "") + took;
        if (!expanded) return [truncateToWidth(head, width)];
        const rows = [truncateToWidth(head, width)];
        if (entry.args && entry.args !== JSON.stringify(entry.hint)) rows.push(...clipped(wrap(entry.args, width - 4).map((line) => fg("dim", "    " + line)), MAX_ARGS_ROWS, fg));
        if (entry.output) rows.push(...clipped(wrap(entry.output, width - 4).map((line) => fg(entry.status === "error" ? "error" : "muted", "    " + line)), MAX_OUTPUT_ROWS, fg));
        else rows.push(fg("dim", entry.status === "running" ? "    (running…)" : "    (no output)"));
        return rows;
      }
    };
  }
  const multi = entry.text.length > 60 || entry.text.includes("\n");
  const [mark, tone] = entry.kind === "steer" ? ["› you: ", "accent"] : entry.kind === "note" ? ["! ", "warning"] : ["◆ ", "text"];
  return {
    key: entry, rev: `${entry.rev}`, expandable: multi, open: false,
    rows(expanded, width) {
      const chevron = multi ? fg("dim", expanded ? "▾ " : "▸ ") : "  ";
      if (!expanded || !multi) {
        const more = lineCount(entry.text) > 1 ? fg("dim", ` +${lineCount(entry.text) - 1} lines`) : "";
        return [truncateToWidth(chevron + fg(tone, mark + safeLine(firstLine(entry.text))), Math.max(1, width - visibleWidth(more))) + more];
      }
      return [chevron + fg(tone, mark.trimEnd()), ...wrap(entry.text, width - 4).map((line) => fg(tone === "text" ? "text" : tone, "    " + line))];
    }
  };
}

/** Everything under a subagent's pinned head: its task, checklist, transcript, live text and report. */
function subagentBlocks(run: DelegateRun, fg: Fg): Block[] {
  const keys = keysOf(run);
  const blocks: Block[] = [{
    key: keys.task, rev: "task", expandable: true, open: false,
    rows(expanded, width) {
      if (!expanded) return [truncateToWidth(fg("dim", "▸ TASK  ") + fg("text", safeLine(firstLine(run.task))), width)];
      return [fg("dim", "▾ TASK"), ...wrap(run.task.slice(0, MAX_TASK_CHARS), width - 4).map((line) => fg("text", "    " + line))];
    }
  }];
  if (run.todos.length) {
    const leaves = leafTodos(run.todos);
    const done = leaves.filter((todo) => todo.done).length;
    blocks.push({
      key: keys.todos, rev: run.todos.map((todo) => todo.id + todo.status).join(), expandable: true, open: true,
      rows(expanded, width) {
        const head = fg("dim", (expanded ? "▾ " : "▸ ") + "TASKS ") + fg(done === leaves.length ? "success" : "accent", `${done}/${leaves.length} done`);
        return expanded ? [head, ...todoRows(run.todos, width - 2, fg).map((row) => "  " + row)] : [head];
      }
    });
  }
  if (!run.transcript.length && !run.live) blocks.push({ key: keys.live, rev: "empty", expandable: false, open: true, rows: () => [fg("dim", "  (nothing yet)")] });
  // Once finished, the last message is the report shown below: list it once.
  const reported = !!run.output && run.state !== "working" && run.state !== "queued";
  let last = -1;
  if (reported) for (let index = run.transcript.length - 1; index >= 0 && last < 0; index--) if (run.transcript[index]!.kind === "text") last = index;
  for (let index = 0; index < run.transcript.length; index++) if (index !== last) blocks.push(entryBlock(run.transcript[index]!, fg));
  if (run.live) {
    const live = run.live;
    blocks.push({
      // The text itself is the revision (it is capped, so its length stops changing); only a tail is wrapped.
      key: keys.live, rev: live, expandable: false, open: true,
      rows: (_expanded, width) => [fg("accent", "  ✎ writing…"),
        ...wrap(live.slice(-Math.max(200, width * (LIVE_ROWS + 1))), width - 4).slice(-LIVE_ROWS).map((line) => fg("muted", "    " + line))]
    });
  }
  if (reported) {
    blocks.push({
      key: keys.report, rev: run.output, expandable: true, open: true,
      rows(expanded, width) {
        const head = fg("dim", (expanded ? "▾ " : "▸ ") + "REPORT");
        return expanded ? [head, ...wrap(run.output, width - 4).map((line) => fg("text", "    " + line))] : [head];
      }
    });
  }
  return blocks;
}

function subagentHead(run: DelegateRun, status: Status, width: number, fg: Fg): string[] {
  const facts = [
    run.startedAt !== undefined ? elapsed({ startedAt: run.startedAt, endedAt: run.endedAt }) : "",
    `${run.tools} tool${run.tools === 1 ? "" : "s"}`, `${run.turns} turn${run.turns === 1 ? "" : "s"}`, `$${run.cost.toFixed(3)}`,
    run.filesEdited.length ? `${run.filesEdited.length} edited` : "", run.steered ? `steered ${run.steered}×` : ""
  ].filter(Boolean);
  const head = [
    fg("accent", [run.name, run.role, run.model].filter(Boolean).join(" · ")),
    fg(COLOR[status], withIcon(status, run.state === "paused" ? "paused" : status === "stopped" ? "stopped" : run.state)) + fg("dim", " · " + facts.join(" · "))
  ];
  // A turning glyph on the 1 s tick: a long tool call or a slow model still looks alive.
  if (run.activity) head.push(fg("muted", (run.state === "working" ? SPINNER[Math.floor(Date.now() / 1000) % SPINNER.length] + " " : "") + run.activity));
  if (run.error && status !== "stopped") for (const line of wrapTextWithAnsi(safeLine(run.error), width).slice(0, 2)) head.push(fg("error", line));
  return head;
}

function shellDetails(job: Omit<ShellJob, "lines">, output: readonly string[], width: number, fg: Fg): Details {
  const head = [fg("accent", safeLine(describe(job))), fg("muted", "$ " + cleanText(job.command, 400)), fg("dim", withIcon("folder", safeLine(job.cwd)))];
  if (!output.length) return { head, body: ["", fg("dim", "(no output yet)")] };
  return { head, body: ["", ...output], format: (line) => line && fg("muted", truncateToWidth(safeLine(line), width)) };
}

function roleDetails(role: ActivityRole, status: Status, width: number, fg: Fg): Details {
  const head = [fg("accent", cleanText(role.name, 60) || role.id), fg(COLOR[status], withIcon(status, cleanText(role.state, 24))) + fg("dim", " · read-only")];
  const body = role.task ? ["", fg("dim", "TASK"), ...wrapTextWithAnsi(cleanText(role.task, 400), width).map((line) => fg("text", line))] : [];
  return { head, body };
}

/**
 * Overlay: subagents, shells and other extensions' teammates on the left; the selected one's live
 * details on the right, following new output until scrolled up. For subagents the details are
 * collapsible blocks (task, checklist, each tool call, text, report) and `s` steers the run.
 */
export async function openActivityView(ctx: ExtensionContext, sources: ActivitySources, initial?: ActivityTarget): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  const opening = collect(sources);
  if (!opening.some((item) => item.kind !== "header")) {
    ctx.ui.notify("pi-jar: nothing running (subagents come from jar_delegate, shells from jar_shell)", "info");
    return;
  }
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let items = opening;
    let at = initial ? items.findIndex((item) => item.kind !== "header" && item.kind === initial.kind && item.id === initial.id) : -1;
    if (at < 0) at = items.findIndex((item) => item.kind !== "header" && item.status === "running");
    if (at < 0) at = items.findIndex((item) => item.kind !== "header");
    let follow = true;
    let scroll = 0;
    let maxScroll = 0;
    let bodyRows = 0;
    let listTop = 0;
    let width = 80;
    let layout = { top: 1, rows: 0, leftWidth: 0, bodyX: 2, footerTop: 0 };
    let pinnedRows = 0;
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    let focus: Focus = "list";
    let draft = "";
    let inputRow = -1;
    // Subagent body layout of the last render: which block starts at which body row.
    let blocks: Block[] = [];
    let offsets: number[] = [];
    const cursors = new Map<string, object>();
    const toggled = new WeakMap<object, boolean>();
    const rowCache = new WeakMap<object, { sig: string; rows: string[] }>();
    const fg: Fg = (color, text) => theme.fg(color as never, text);
    const shells = sources.shells;
    const previous = shells?.onChange;
    // Live streams notify far faster than a transcript view needs to repaint; ~10 frames a second reads as live.
    let repaint: NodeJS.Timeout | undefined;
    const repaintSoon = () => {
      if (repaint || closed) return;
      repaint = setTimeout(() => { repaint = undefined; if (!closed) tui.requestRender(); }, 100);
      repaint.unref?.();
    };
    const unsubscribe = sources.subagents.subscribe(repaintSoon);
    if (shells) shells.onChange = () => { previous?.(); repaintSoon(); };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      timer = undefined;
      clearTimeout(repaint);
      repaint = undefined;
      unsubscribe();
      if (shells) shells.onChange = previous;
    };
    const close = () => { cleanup(); done(); };
    const selected = (): Entry | undefined => { const item = items[at]; return item && item.kind !== "header" ? item : undefined; };
    const steerable = () => { const item = selected(); return item?.kind === "subagent" && item.record.run.state === "working"; };
    const isOpen = (block: Block) => block.expandable ? toggled.get(block.key) ?? block.open : true;
    /** Rows of one block, rebuilt only when its content, state or width changed. */
    const rowsOf = (block: Block, bodyWidth: number) => {
      const expanded = isOpen(block);
      const sig = `${block.rev}|${expanded}|${bodyWidth}`;
      const cached = rowCache.get(block.key);
      if (cached?.sig === sig) return cached.rows;
      const rows = block.rows(expanded, bodyWidth);
      rowCache.set(block.key, { sig, rows });
      return rows;
    };
    // Rows reorder live (finished subagents sink, old ones drop off): keep the selection by identity.
    const refresh = () => {
      const current = items[at];
      items = collect(sources);
      const same = current && current.kind !== "header" ? items.findIndex((item) => item.kind !== "header" && item.kind === current.kind && item.id === current.id) : -1;
      if (same >= 0) { at = same; return; }
      const from = Math.max(0, Math.min(at, items.length - 1));
      at = -1;
      for (let index = from; index < items.length && at < 0; index++) if (items[index]!.kind !== "header") at = index;
      for (let index = from - 1; index >= 0 && at < 0; index--) if (items[index]!.kind !== "header") at = index;
    };
    const move = (delta: number) => {
      for (let index = at + delta; index >= 0 && index < items.length; index += delta) {
        if (items[index]!.kind === "header") continue;
        at = index; follow = true; scroll = 0;
        if (focus === "input") focus = "list";
        return;
      }
    };
    const scrollBy = (delta: number) => {
      if (!maxScroll) return;
      scroll = Math.max(0, Math.min(maxScroll, scroll + delta));
      // Scrolling up pauses follow; scrolling back down to the end resumes it.
      follow = delta > 0 && scroll >= maxScroll;
    };
    const cursorIndex = () => {
      const item = selected();
      const key = item?.kind === "subagent" ? cursors.get(item.id) : undefined;
      const index = key ? blocks.findIndex((block) => block.key === key) : -1;
      return index >= 0 ? index : blocks.length - 1;
    };
    const setCursor = (index: number) => {
      const item = selected();
      if (item?.kind !== "subagent" || !blocks.length) return;
      const target = Math.max(0, Math.min(blocks.length - 1, index));
      cursors.set(item.id, blocks[target]!.key);
      follow = false;
      // Keep the block's first row in view.
      const row = offsets[target] ?? 0;
      if (row < scroll) scroll = row;
      else if (row >= scroll + bodyRows) scroll = Math.min(maxScroll, row - bodyRows + 1);
    };
    const toggle = (index: number) => {
      const block = blocks[index];
      if (!block?.expandable) return;
      toggled.set(block.key, !isOpen(block));
      setCursor(index);
    };
    const stopSelected = () => {
      const item = selected();
      if (!item || item.kind === "role") return;
      const subagentLive = item.kind === "subagent" && !["done", "failed", "stopped"].includes(item.record.run.state);
      const shellLive = item.kind === "shell" && item.status === "running";
      if (!subagentLive && !shellLive) return;
      try {
        if (item.kind === "subagent") void sources.subagents.stop(item.id).catch((error: unknown) => {
ctx.ui.notify("pi-jar: " + (error instanceof Error ? error.message : String(error)), "error");
});
        else shells?.kill(item.id);
      } catch (error) { ctx.ui.notify("pi-jar: " + (error instanceof Error ? error.message : String(error)), "error"); }
    };
    const send = () => {
      const item = selected();
      const text = draft.trim();
      if (!text || item?.kind !== "subagent") return;
      if (sources.subagents.steer(item.id, text)) { draft = ""; focus = "transcript"; follow = true; cursors.delete(item.id); }
      else ctx.ui.notify("pi-jar: that subagent is not taking messages (it is not working)", "warning");
    };
    const input = (data: string) => {
      if (matchesKey(data, Key.escape)) { focus = "transcript"; return; }
      if (matchesKey(data, Key.enter)) { send(); return; }
      if (matchesKey(data, Key.backspace) || data === "\x7f" || data === "\b") { draft = draft.slice(0, -1); return; }
      // Typed or pasted text: drop terminal sequences and control characters; line breaks become spaces.
      const text = stripTerminalSequences(data).replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
      if (text) draft = (draft + text).slice(0, MAX_DRAFT);
    };
    const component = {
      invalidate() {},
      dispose: cleanup,
      handleInput(data: string) {
        if (focus === "input") { input(data); tui.requestRender(); return; }
        const item = selected();
        const subagent = item?.kind === "subagent";
        if (focus === "transcript") {
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab) || matchesKey(data, Key.left) || data === "h") focus = "list";
          else if (data === "q") return close();
          else if (matchesKey(data, Key.up) || data === "k") setCursor(cursorIndex() - 1);
          else if (matchesKey(data, Key.down) || data === "j") setCursor(cursorIndex() + 1);
          else if (matchesKey(data, Key.enter) || data === " ") toggle(cursorIndex());
          else if (matchesKey(data, Key.pageUp)) scrollBy(-Math.max(1, bodyRows - 2));
          else if (matchesKey(data, Key.pageDown)) scrollBy(Math.max(1, bodyRows - 2));
          else if (data === "f" || data === "G") follow = true;
          else if (data === "s" && steerable()) focus = "input";
          else if (data === "x") stopSelected();
          else return;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.escape) || data === "q") return close();
        if (matchesKey(data, Key.up) || data === "k") move(-1);
        else if (matchesKey(data, Key.down) || data === "j") move(1);
        else if (subagent && (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || data === "l" || matchesKey(data, Key.enter))) focus = "transcript";
        else if (matchesKey(data, Key.pageUp)) scrollBy(-Math.max(1, bodyRows - 2));
        else if (matchesKey(data, Key.pageDown)) scrollBy(Math.max(1, bodyRows - 2));
        else if (data === "f" || data === "G") follow = true;
        else if (matchesKey(data, Key.enter)) follow = !follow;
        else if (data === "s" && steerable()) focus = "input";
        else if (data === "x") stopSelected();
        else return;
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === "wheel" && event.wheelDelta) { scrollBy(Math.sign(event.wheelDelta) * 3); tui.requestRender(); return { handled: true }; }
        if (event.type !== "click" || event.button !== "left") return;
        if (event.y === 0 && event.x >= width - 3) { close(); return { handled: true }; }
        const row = event.y - layout.top;
        if (layout.leftWidth && row >= 0 && row < layout.rows && event.x < layout.leftWidth + 3) {
          const index = listTop + row;
          if (!items[index] || items[index].kind === "header") return;
          if (index !== at) { at = index; follow = true; scroll = 0; }
          focus = "list";
          tui.requestRender();
          return { handled: true, focus: true };
        }
        if (row >= pinnedRows && row < layout.rows && blocks.length && selected()?.kind === "subagent") {
          // A click on a block's first row expands or collapses it; any other row just points the cursor at it.
          const line = scroll + row - pinnedRows;
          let index = -1;
          for (let block = 0; block < offsets.length && offsets[block]! <= line; block++) index = block;
          if (index < 0) return;
          focus = "transcript";
          if (offsets[index] === line) toggle(index); else setCursor(index);
          tui.requestRender();
          return { handled: true, focus: true };
        }
        if (inputRow >= 0 && event.y === inputRow && steerable()) { focus = "input"; tui.requestRender(); return { handled: true, focus: true }; }
        const action = ACTIONS[event.y - layout.footerTop];
        if (action) { const previousFocus = focus; focus = "list"; component.handleInput(action.key); focus = previousFocus; return { handled: true }; }
      },
      render(available: number): string[] {
        width = Math.max(24, available);
        refresh();
        const item = selected();
        const subagent = item?.kind === "subagent" ? item : undefined;
        if (!subagent && focus !== "list") focus = "list";
        if (focus === "input" && !steerable()) focus = "transcript";
        const listWidth = sidebarWidth(width, 20, 34);
        const bodyWidth = listWidth ? width - listWidth - 6 : width - 4;
        const entries = items.filter((entry): entry is Entry => entry.kind !== "header");
        // Footer: the two actions, the steering input for subagents, then key hints.
        const actions = optionList(theme, [item?.kind === "shell" ? "Kill the selected shell" : item?.kind === "role" ? "Stop (teammates from other extensions are read-only)" : "Stop the selected subagent",
          "Follow the latest output"], -1, ACTIONS.map((action) => action.key));
        const stoppable = item?.kind === "subagent" ? !["done", "failed", "stopped"].includes(item.record.run.state)
          : item?.kind === "shell" && item.status === "running";
        if (!stoppable) actions[0] = fg("dim", stripTerminalSequences(actions[0]!));
        const footer = [...actions];
        if (subagent) {
          const room = Math.max(4, width - 16);
          footer.push(focus === "input"
            ? fg("accent", "› steer: ") + fg("text", truncateToWidth(draft.length > room ? "…" + draft.slice(-room + 1) : draft, room)) + fg("accent", "█")
            : fg("dim", steerable() ? "› s  steer this subagent (type a message, Enter sends)" : "› steering works while a subagent is running"));
        }
        footer.push(fg("dim", focus === "input" ? `type a message · ${withIcon("enter", "send")} · ${withIcon("esc", "cancel")}`
          : focus === "transcript" ? `↑↓ step · ${withIcon("enter", "expand")} · tab list · s steer · ${withIcon("esc", "back")}`
          : `↑↓ select · ${subagent ? "tab transcript" : "PgUp/PgDn scroll"} · ${withIcon("enter", subagent ? "open" : "follow")} · ${withIcon("esc", "close")}`));
        const rows = contentRows(3 + footer.length, 6);
        const details: Details | undefined = !item || item.kind === "subagent" ? undefined
          : item.kind === "shell" ? shellDetails(item.job, shells?.output(item.id, SHELL_TAIL) ?? [], bodyWidth, fg)
          : roleDetails(item.role, item.status, bodyWidth, fg);
        const head = !item ? [fg("dim", "Nothing to show.")] : item.kind === "subagent" ? subagentHead(item.record.run, item.status, bodyWidth, fg) : details!.head;
        // Narrow terminals drop the list: a pager row above the pinned facts says what is selected.
        const pinned = [...(!listWidth && item ? [fg("accent", `‹ ${entries.indexOf(item) + 1}/${entries.length} ${withIcon(item.status, item.label)} ›`)] : []),
          ...head].slice(0, rows - 1);
        pinnedRows = pinned.length;
        bodyRows = rows - pinned.length;
        let body: string[];
        if (subagent) {
          blocks = subagentBlocks(subagent.record.run, fg);
          const blockRows = blocks.map((block) => rowsOf(block, bodyWidth - 2));
          offsets = [];
          let total = 0;
          for (const block of blockRows) { offsets.push(total); total += block.length; }
          // A blank row separates the pinned head from the blocks.
          offsets = offsets.map((offset) => offset + 1);
          total += 1;
          maxScroll = Math.max(0, total - bodyRows);
          scroll = follow ? maxScroll : Math.min(scroll, maxScroll);
          // Only the visible window gets its gutter: long transcripts cost nothing off-screen.
          const cursor = focus === "transcript" ? cursorIndex() : -1;
          body = scroll === 0 ? [""] : [];
          for (let index = 0; index < blocks.length && body.length < bodyRows; index++) {
            const start = offsets[index]!;
            const rowsInBlock = blockRows[index]!;
            if (start + rowsInBlock.length <= scroll) continue;
            for (let line = Math.max(0, scroll - start); line < rowsInBlock.length && body.length < bodyRows; line++) {
              body.push((line === 0 && index === cursor ? fg("accent", "❯ ") : "  ") + rowsInBlock[line]!);
            }
          }
        } else {
          blocks = [];
          offsets = [];
          const lines = details?.body ?? [];
          maxScroll = Math.max(0, lines.length - bodyRows);
          scroll = follow ? maxScroll : Math.min(scroll, maxScroll);
          body = lines.slice(scroll, scroll + bodyRows);
          if (details?.format) body = body.map(details.format);
        }
        if (at >= 0 && at < listTop) listTop = items[at - 1]?.kind === "header" ? at - 1 : at;
        if (at >= listTop + rows) listTop = at - rows + 1;
        listTop = Math.max(0, Math.min(listTop, items.length - rows));
        const list = listWidth ? items.slice(listTop, listTop + rows).map((entry, offset) => {
          if (entry.kind === "header") return fg("dim", truncateToWidth(entry.label, listWidth));
          const active = listTop + offset === at;
          const glyph = icon(entry.status);
          return fg(active ? "accent" : "muted", active ? (focus === "list" ? "▌" : "▏") : " ") + fg(COLOR[entry.status], glyph + " ")
            + fg(active ? "accent" : "muted", truncateToWidth(entry.label, Math.max(1, listWidth - 2 - visibleWidth(glyph))));
        }) : [];
        const running = entries.filter((entry) => entry.status === "running").length;
        const split = splitFrame(theme, width, `ACTIVITY · ${running} running${follow ? "" : " · paused"}`, list, [...pinned, ...body], footer, rows, listWidth);
        layout = split.layout;
        inputRow = subagent ? layout.footerTop + ACTIONS.length : -1;
        // Subagent events and shell exits repaint through the listeners; elapsed times and shell output
        // advance on a 1s tick that exists only while something runs.
        if (running && !timer && !closed) { timer = setInterval(() => tui.requestRender(), 1000); timer.unref?.(); }
        else if (!running && timer) { clearInterval(timer); timer = undefined; }
        return available < width ? split.lines.map((line) => truncateToWidth(line, Math.max(0, available))) : split.lines;
      }
    };
    return component;
  }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } });
}
