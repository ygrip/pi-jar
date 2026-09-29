import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { DelegateRegistry, DelegateRun, SubagentRecord } from "./delegate.ts";
import { safeLine } from "./diff-view.ts";
import { icon, withIcon } from "./icons.ts";
import { describe, elapsed, type ShellJob, type ShellManager } from "./shells.ts";
import { contentRows, optionList, sidebarWidth, splitFrame } from "./split-view.ts";
import { ACTIVE_STATES, cleanText } from "./status.ts";

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

const COLOR: Record<Status, string> = { running: "accent", pending: "dim", success: "success", error: "error", stopped: "dim" };
const ACTIONS = [{ key: "x" }, { key: "f" }] as const;
const SHELL_TAIL = 400;
const MAX_TASK_CHARS = 8000;

/** Left-pane rows: a header per non-empty section, then its entries. */
function collect(sources: ActivitySources): Item[] {
  const items: Item[] = [];
  const records = sources.subagents.records();
  if (records.length) items.push({ kind: "header", label: withIcon("subagents", "SUBAGENTS") });
  for (const record of records) {
    const { run } = record;
    const status: Status = run.state === "working" ? "running" : run.state === "queued" ? "pending" : run.state === "done" ? "success" : run.error === "stopped" ? "stopped" : "error";
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
interface Details { head: string[]; body: string[] }

function subagentDetails(run: DelegateRun, status: Status, width: number, fg: Fg): Details {
  const facts = [
    run.startedAt !== undefined ? elapsed({ startedAt: run.startedAt, endedAt: run.endedAt }) : "",
    `${run.tools} tool${run.tools === 1 ? "" : "s"}`, `${run.turns} turn${run.turns === 1 ? "" : "s"}`, `$${run.cost.toFixed(3)}`
  ].filter(Boolean);
  const head = [
    fg("accent", [run.name, run.role, run.model].filter(Boolean).join(" · ")),
    fg(COLOR[status], withIcon(status, status === "stopped" ? "stopped" : run.state)) + fg("dim", " · " + facts.join(" · "))
  ];
  if (run.activity) head.push(fg("muted", run.activity));
  if (run.error && status !== "stopped") for (const line of wrapTextWithAnsi(safeLine(run.error), width).slice(0, 2)) head.push(fg("error", line));
  const body = ["", fg("dim", "TASK")];
  for (const raw of run.task.slice(0, MAX_TASK_CHARS).split("\n")) for (const line of wrapTextWithAnsi(safeLine(raw), width)) body.push(fg("text", line));
  body.push("", fg("dim", "── transcript ──"));
  if (!run.log.length) body.push(fg("dim", "(nothing yet)"));
  for (const entry of run.log) {
    const tone = entry.startsWith("▸ ") ? "accent" : "muted";
    for (const line of wrapTextWithAnsi(entry, width)) body.push(fg(tone, line));
  }
  if (run.output) {
    body.push("", fg("dim", "── report ──"));
    for (const raw of run.output.split("\n")) for (const line of wrapTextWithAnsi(safeLine(raw), width)) body.push(fg("text", line));
  }
  return { head, body };
}

function shellDetails(job: Omit<ShellJob, "lines">, output: readonly string[], width: number, fg: Fg): Details {
  const head = [fg("accent", safeLine(describe(job))), fg("muted", "$ " + cleanText(job.command, 400)), fg("dim", withIcon("folder", safeLine(job.cwd)))];
  const body = ["", ...output.map((line) => fg("muted", truncateToWidth(safeLine(line), width)))];
  if (!output.length) body.push(fg("dim", "(no output yet)"));
  return { head, body };
}

function roleDetails(role: ActivityRole, status: Status, width: number, fg: Fg): Details {
  const head = [fg("accent", cleanText(role.name, 60) || role.id), fg(COLOR[status], withIcon(status, cleanText(role.state, 24))) + fg("dim", " · read-only")];
  const body = role.task ? ["", fg("dim", "TASK"), ...wrapTextWithAnsi(cleanText(role.task, 400), width).map((line) => fg("text", line))] : [];
  return { head, body };
}

/**
 * Overlay: subagents, shells and other extensions' teammates on the left; the selected one's live
 * details on the right, following new output until scrolled up. x stops a subagent or kills a shell.
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
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    const fg: Fg = (color, text) => theme.fg(color as never, text);
    const shells = sources.shells;
    const previous = shells?.onChange;
    const unsubscribe = sources.subagents.subscribe(() => tui.requestRender());
    if (shells) shells.onChange = () => { previous?.(); tui.requestRender(); };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      timer = undefined;
      unsubscribe();
      if (shells) shells.onChange = previous;
    };
    const close = () => { cleanup(); done(); };
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
        return;
      }
    };
    const scrollBy = (delta: number) => {
      if (!maxScroll) return;
      scroll = Math.max(0, Math.min(maxScroll, scroll + delta));
      // Scrolling up pauses follow; scrolling back down to the end resumes it.
      follow = delta > 0 && scroll >= maxScroll;
    };
    const stopSelected = () => {
      const item = items[at];
      if (!item || item.kind === "header" || item.kind === "role" || (item.status !== "running" && item.status !== "pending")) return;
      try {
        if (item.kind === "subagent") sources.subagents.stop(item.id);
        else shells?.kill(item.id);
      } catch (error) { ctx.ui.notify("pi-jar: " + (error instanceof Error ? error.message : String(error)), "error"); }
    };
    const component = {
      invalidate() {},
      dispose: cleanup,
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || data === "q") return close();
        if (matchesKey(data, Key.up) || data === "k") move(-1);
        else if (matchesKey(data, Key.down) || data === "j") move(1);
        else if (matchesKey(data, Key.pageUp)) scrollBy(-Math.max(1, bodyRows - 2));
        else if (matchesKey(data, Key.pageDown)) scrollBy(Math.max(1, bodyRows - 2));
        else if (data === "f" || data === "G") follow = true;
        else if (matchesKey(data, Key.enter)) follow = !follow;
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
          tui.requestRender();
          return { handled: true, focus: true };
        }
        const action = ACTIONS[event.y - layout.footerTop];
        if (action) { component.handleInput(action.key); return { handled: true }; }
      },
      render(available: number): string[] {
        width = Math.max(24, available);
        const rows = contentRows(6 + ACTIONS.length, 6);
        refresh();
        const picked = items[at];
        const item = picked && picked.kind !== "header" ? picked : undefined;
        const listWidth = sidebarWidth(width, 20, 34);
        const bodyWidth = listWidth ? width - listWidth - 6 : width - 4;
        const entries = items.filter((entry): entry is Entry => entry.kind !== "header");
        const details = !item ? { head: [fg("dim", "Nothing to show.")], body: [] }
          : item.kind === "subagent" ? subagentDetails(item.record.run, item.status, bodyWidth, fg)
          : item.kind === "shell" ? shellDetails(item.job, shells?.output(item.id, SHELL_TAIL) ?? [], bodyWidth, fg)
          : roleDetails(item.role, item.status, bodyWidth, fg);
        // Narrow terminals drop the list: a pager row above the pinned facts says what is selected.
        const pinned = [...(!listWidth && item ? [fg("accent", `‹ ${entries.indexOf(item) + 1}/${entries.length} ${withIcon(item.status, item.label)} ›`)] : []),
          ...details.head].slice(0, rows - 1);
        bodyRows = rows - pinned.length;
        maxScroll = Math.max(0, details.body.length - bodyRows);
        scroll = follow ? maxScroll : Math.min(scroll, maxScroll);
        if (at >= 0 && at < listTop) listTop = items[at - 1]?.kind === "header" ? at - 1 : at;
        if (at >= listTop + rows) listTop = at - rows + 1;
        listTop = Math.max(0, Math.min(listTop, items.length - rows));
        const list = listWidth ? items.slice(listTop, listTop + rows).map((entry, offset) => {
          if (entry.kind === "header") return fg("dim", truncateToWidth(entry.label, listWidth));
          const active = listTop + offset === at;
          const glyph = icon(entry.status);
          return fg(active ? "accent" : "muted", active ? "▌" : " ") + fg(COLOR[entry.status], glyph + " ")
            + fg(active ? "accent" : "muted", truncateToWidth(entry.label, Math.max(1, listWidth - 2 - visibleWidth(glyph))));
        }) : [];
        const running = entries.filter((entry) => entry.status === "running").length;
        const stoppable = item?.kind === "subagent" ? item.status === "running" || item.status === "pending" : item?.kind === "shell" && item.status === "running";
        const actions = optionList(theme, [item?.kind === "shell" ? "Kill the selected shell" : item?.kind === "role" ? "Stop (teammates from other extensions are read-only)" : "Stop the selected subagent",
          "Follow the latest output"], -1, ACTIONS.map((action) => action.key));
        if (!stoppable) actions[0] = fg("dim", stripTerminalSequences(actions[0]!));
        const footer = [...actions, fg("dim", `↑↓ select · PgUp/PgDn scroll · ${withIcon("enter", "follow")} · ${withIcon("esc", "close")}`)];
        const split = splitFrame(theme, width, `ACTIVITY · ${running} running${follow ? "" : " · paused"}`, list,
          [...pinned, ...details.body.slice(scroll, scroll + bodyRows)], footer, rows, listWidth);
        layout = split.layout;
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
