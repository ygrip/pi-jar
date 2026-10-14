import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { todoProgress, todoTotals, type Todo } from "./tasks.ts";
import { todoRow } from "./task-tool.ts";

/** Retained across widget refreshes. Compact by default so tasks never bury the composer. */
export interface TaskWidgetState { expanded: boolean; scroll: number | undefined }
export function taskWidget(tui: TUI, theme: Theme, items: () => Todo[], state: TaskWidgetState,
  mascot?: { render(width: number): string[] | undefined; poke(): void }) {
  let page = 4;
  let taskX = 0;
  let taskY = 0;
  let mascotRows: string[] = [];
  const toggle = () => { state.expanded = !state.expanded; tui.requestRender(); };
  const move = (delta: number) => {
    state.scroll = Math.max(0, Math.min(Math.max(0, items().length - page), (state.scroll ?? 0) + delta));
    tui.requestRender();
  };
  return {
    invalidate() {},
    handleInput(data: string) {
      if (matchesKey(data, Key.enter) || data === " ") toggle();
      else if (matchesKey(data, Key.down)) move(1);
      else if (matchesKey(data, Key.up)) move(-1);
      else if (matchesKey(data, Key.pageDown)) move(page);
      else if (matchesKey(data, Key.pageUp)) move(-page);
    },
    handleMouse(event: TuiMouseEvent) {
      if (event.y < mascotRows.length && event.x >= 3 && event.x < visibleWidth(mascotRows[event.y] ?? "")) {
        if (event.type === "click" && event.button === "left") { mascot?.poke(); return { handled: true }; }
        return;
      }
      if (event.x < taskX || event.y < taskY) return;
      event = { ...event, x: event.x - taskX, y: event.y - taskY };
      if (event.type === "click" && event.button === "left" && event.y === 0) { toggle(); return { handled: true }; }
      if (event.type === "wheel" && event.wheelDelta && state.expanded) { move(Math.sign(event.wheelDelta) * 3); return { handled: true }; }
    },
    render(width: number) {
      mascotRows = mascot?.render(width) ?? [];
      const mascotWidth = Math.max(0, ...mascotRows.map(visibleWidth));
      taskX = mascotRows.length && width >= 60 && width - mascotWidth - 2 >= 24 ? mascotWidth + 2 : 0;
      taskY = taskX ? 0 : mascotRows.length;
      const taskWidth = Math.max(0, width - taskX);
      const all = items();
      const { done, total } = todoTotals(all);
      const parents = new Set(all.flatMap((item) => item.parentId ? [item.parentId] : []));
      const running = all.findIndex((item) => item.status === "in_progress" && !parents.has(item.id));
      const focus = Math.max(0, running >= 0 ? running : all.findIndex((item) => !item.done && !parents.has(item.id)));
      // At most a quarter of the terminal, including heading and spacer.
      const budget = Math.max(1, Math.floor((tui.terminal?.rows ?? process.stdout.rows ?? 24) / 4));
      page = Math.max(1, Math.min(4, budget - 2));
      const start = Math.max(0, Math.min(state.scroll ?? Math.max(0, focus - 1), Math.max(0, all.length - page)));
      const current = all[focus];
      const heading = theme.fg("accent", `${state.expanded ? "▾" : "▸"} Tasks`) + theme.fg("dim", ` · ${done}/${total} done`)
        + (!state.expanded && current && !current.done ? theme.fg("muted", ` · ${current.title}`) : "")
        + theme.fg("dim", ` · click to ${state.expanded ? "collapse" : "expand"} · /jar tasks`);
      const rows = [heading];
      if (state.expanded && budget > 2) {
        rows[0] += theme.fg("dim", ` · ${start + 1}–${Math.min(all.length, start + page)}/${all.length} · wheel scroll`);
        rows.push(...all.slice(start, start + page).map((item) => todoRow(item, (color, text) => theme.fg(color, text), (text) => theme.bold(text), parents.has(item.id) ? todoProgress(all, item.id) : undefined)));
      }
      rows.push(" ");
      const tasks = rows.slice(0, Math.max(1, budget)).map((line) => truncateToWidth(line, taskWidth));
      if (!taskX) return [...mascotRows, ...tasks];
      return Array.from({ length: Math.max(mascotRows.length, tasks.length) }, (_, index) => {
        const pet = mascotRows[index] ?? "";
        return pet + " ".repeat(taskX - visibleWidth(pet)) + (tasks[index] ?? "");
      });
    }
  };
}
