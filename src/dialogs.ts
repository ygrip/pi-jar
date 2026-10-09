import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { todoMark, todoProgress, todoTotals, type Todo } from "./tasks.ts";
import { cleanText } from "./status.ts";
import { popup } from "./popup.ts";

const fit = (line: string, width: number) => truncateToWidth(line, Math.max(0, width));

/** Pi-jar owns these dialogs; Pi's normal and other extensions' questions are untouched. */
export async function promptText(ctx: ExtensionContext, title: string, question: string, initial = ""): Promise<string | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") return undefined;
  return popup<string | undefined>(ctx, (tui, theme, _keys, done) => {
    const input = new Input({ prompt: "❯ ", placeholder: "Type your answer" });
    input.focused = true;
    input.setValue(initial);
    input.onSubmit = (value) => done(value.trim() || undefined);
    input.onEscape = () => done(undefined);
    let footerRow = 0;
    return {
      invalidate() { input.invalidate(); },
      handleInput(data: string) { input.handleInput(data); tui.requestRender(); },
      handleMouse(event: TuiMouseEvent) {
        if (event.type !== "click" || event.button !== "left") return;
        if (event.y === footerRow) { done(input.getValue().trim() || undefined); return { handled: true }; }
      },
      render(width: number): string[] {
        const lines = [
          fit(theme.fg("accent", `╭─ ${cleanText(title, 56)} ─`), width),
          ...wrapTextWithAnsi(cleanText(question, 160), Math.max(1, width - 2)).map((line) => fit(theme.fg("muted", `│ ${line}`), width)),
          ...input.render(Math.max(1, width - 2)).map((line) => fit("│ " + line, width)),
          fit(theme.fg("dim", "╰─ Enter: confirm · Esc: cancel"), width)
        ];
        footerRow = lines.length - 1;
        return lines;
      }
    };
  }, { filter: false });
}

export async function promptChoice(ctx: ExtensionContext, title: string, question: string, choices: readonly string[], initial = 0): Promise<number | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui" || !choices.length) return undefined;
  return popup<number | undefined>(ctx, (tui, theme, _keys, done) => {
    const input = new Input({ prompt: "⌕ ", placeholder: "Type to filter" });
    input.focused = true;
    const labels = choices.map((choice) => cleanText(choice, 500));
    let visible = choices.map((_, index) => index);
    let selected = Math.max(0, Math.min(choices.length - 1, initial));
    let firstChoiceRow = 0;
    let first = 0;
    let page = 10;
    const choose = () => { const index = visible[selected]; if (index !== undefined) done(index); };
    input.onSubmit = choose;
    input.onEscape = () => done(undefined);
    const refresh = () => {
      const terms = input.getValue().trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      visible = labels.flatMap((label, index) => terms.every((term) => label.toLocaleLowerCase().includes(term)) ? [index] : []);
      selected = 0; first = 0;
    };
    const move = (delta: number) => { selected = Math.max(0, Math.min(Math.max(0, visible.length - 1), selected + delta)); };
    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      invalidate() { input.invalidate(); },
      handleInput(data: string) {
        if (matchesKey(data, Key.up)) move(-1);
        else if (matchesKey(data, Key.down)) move(1);
        else if (matchesKey(data, Key.pageUp)) move(-page);
        else if (matchesKey(data, Key.pageDown)) move(page);
        else if (matchesKey(data, Key.home)) selected = 0;
        else if (matchesKey(data, Key.end)) selected = Math.max(0, visible.length - 1);
        else { const before = input.getValue(); input.handleInput(data); if (input.getValue() !== before) refresh(); }
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === "wheel" && event.wheelDelta) { move(Math.sign(event.wheelDelta) * 3); tui.requestRender(); return { handled: true }; }
        if (event.type !== "click" || event.button !== "left") return;
        const offset = event.y - firstChoiceRow;
        if (offset >= 0 && offset < page && visible[first + offset] !== undefined) { selected = first + offset; choose(); return { handled: true }; }
      },
      render(width: number): string[] {
        const heading = [
          fit(theme.fg("accent", `╭─ ${cleanText(title, 56)} ─`), width),
          ...wrapTextWithAnsi(cleanText(question, 160), Math.max(1, width - 2)).slice(0, Math.max(0, Math.min(2, (tui.terminal?.rows ?? process.stdout.rows ?? 24) - 4))).map((line) => fit(theme.fg("muted", `│ ${line}`), width)),
          ...input.render(Math.max(1, width - 2)).map((line) => fit("│ " + line, width))
        ];
        firstChoiceRow = heading.length;
        page = Math.max(1, (tui.terminal?.rows ?? process.stdout.rows ?? 24) - heading.length - 1);
        if (selected < first) first = selected;
        if (selected >= first + page) first = selected - page + 1;
        first = Math.max(0, Math.min(first, Math.max(0, visible.length - page)));
        return [
          ...heading,
          ...(visible.length ? visible.slice(first, first + page).map((original, offset) => fit(theme.fg(first + offset === selected ? "accent" : "dim", `${first + offset === selected ? "❯" : " "} ${labels[original]}`), width)) : [fit(theme.fg("dim", "  No matches"), width)]),
          fit(theme.fg("dim", `╰─ ${visible.length ? selected + 1 : 0}/${visible.length} · type to filter · ↑↓/Pg: choose · Enter: confirm · Esc: cancel`), width)
        ];
      }
    };
  }, { filter: false });
}

/** Searchable replacement for Pi's native selector, preserving string results. */
export async function selectPopup(ctx: ExtensionContext, title: string, choices: readonly string[]): Promise<string | undefined> {
  const index = await promptChoice(ctx, title, "", choices);
  return index === undefined ? undefined : choices[index];
}

export type TodoFilter = "all" | "open" | "done";
export type TodoAction = { kind: "add" | "toggle" | "edit" | "delete"; id?: string };

export async function todoView(ctx: ExtensionContext, todos: () => Todo[], filter: { value: TodoFilter; collapsed?: Set<string> }): Promise<TodoAction | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") return undefined;
  return popup<TodoAction | undefined>(ctx, (tui, theme, _keys, done) => {
    let selected = 0;
    const collapsed = filter.collapsed ??= new Set<string>();
    const search = new Input({ prompt: "/ ", placeholder: "Filter all tasks" });
    let searching = false;
    search.onSubmit = () => { searching = false; search.focused = false; };
    search.onEscape = () => { searching = false; search.focused = false; search.setValue(""); selected = 0; };
    const filtered = () => {
      const all = todos();
      const byId = new Map(all.map((item) => [item.id, item]));
      return all.filter((item) => {
        if (!(filter.value === "all" || (filter.value === "done") === item.done)) return false;
        const term = search.getValue().trim().toLocaleLowerCase();
        if (term) return item.title.toLocaleLowerCase().includes(term);
        let parent = item.parentId;
        const seen = new Set<string>();
        while (parent && !seen.has(parent)) {
          if (collapsed.has(parent)) return false;
          seen.add(parent); parent = byId.get(parent)?.parentId;
        }
        return true;
      });
    };
    let firstVisible = 0;
    let page = 12;
    return {
      get focused() { return search.focused; },
      set focused(value: boolean) { search.focused = searching && value; },
      invalidate() { search.invalidate(); },
      handleInput(data: string) {
        if (searching) { search.handleInput(data); selected = 0; tui.requestRender(); return; }
        if (data === "/") { searching = true; search.focused = true; tui.requestRender(); return; }
        const items = filtered();
        if (matchesKey(data, Key.escape) || data === "q") return done(undefined);
        if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1);
        else if (matchesKey(data, Key.down)) selected = Math.min(Math.max(0, items.length - 1), selected + 1);
        else if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
          const item = items[selected];
          if (item && todos().some((child) => child.parentId === item.id)) {
            if (matchesKey(data, Key.left)) collapsed.add(item.id); else collapsed.delete(item.id);
          }
        } else if (matchesKey(data, Key.pageDown)) selected = Math.min(Math.max(0, items.length - 1), selected + page);
        else if (matchesKey(data, Key.pageUp)) selected = Math.max(0, selected - page);
        else if (data === "f") {
          const next: Record<TodoFilter, TodoFilter> = { all: "open", open: "done", done: "all" };
          filter.value = next[filter.value]; selected = 0;
        } else if (data === "a") return done({ kind: "add" });
        else if (items[selected] && (data === " " || matchesKey(data, Key.enter))) return done({ kind: "toggle", id: items[selected].id });
        else if (items[selected] && data === "e") return done({ kind: "edit", id: items[selected].id });
        else if (items[selected] && data === "d") return done({ kind: "delete", id: items[selected].id });
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === "wheel" && event.wheelDelta) {
          selected = Math.max(0, Math.min(filtered().length - 1, selected + Math.sign(event.wheelDelta)));
          tui.requestRender(); return { handled: true };
        }
        if (event.type !== "click" || event.button !== "left") return;
        const index = firstVisible + event.y - 1;
        const item = filtered()[index];
        if (event.y >= 1 && event.y <= page && item) {
          selected = index; done({ kind: "toggle", id: item.id }); return { handled: true };
        }
      },
      render(width: number): string[] {
        const items = filtered();
        selected = Math.min(selected, Math.max(0, items.length - 1));
        const all = todos();
        const totals = todoTotals(all);
        page = Math.max(1, Math.min(12, (tui.terminal?.rows ?? process.stdout.rows ?? 24) - 2));
        const start = Math.max(0, Math.min(selected - page + 1, items.length - page));
        firstVisible = start;
        return [
          fit(theme.fg("accent", `╭─ pi-jar to-do · ${totals.total - totals.done} open · ${filter.value} ─`), width),
          ...(items.length ? items.slice(start, start + page).map((item, index) => {
            const progress = todoProgress(all, item.id);
            const row = `${start + index === selected ? "❯" : " "} ${item.parentId ? "  " : ""}${progress.total ? (collapsed.has(item.id) ? "▸ " : "▾ ") : ""}${todoMark(item)} ${item.title}${progress.total ? ` (${progress.done}/${progress.total})` : ""}`;
            return fit(theme.fg(start + index === selected ? "accent" : item.done ? "dim" : item.status === "in_progress" ? "warning" : "muted", row), width);
          })
            : [fit(theme.fg("dim", "  No items in this view"), width)]),
          searching ? fit(search.render(width)[0]!, width) : fit(theme.fg("dim", "╰─ ↑↓/Pg: select · ←→: collapse/expand · /: search · Space: check · a/e/d: add/edit/delete · f: status · Esc: close"), width)
        ];
      }
    };
  }, { filter: false });
}
