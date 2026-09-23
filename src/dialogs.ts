import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Todo } from "./tasks.ts";
import { cleanText } from "./status.ts";

const fit = (line: string, width: number) => truncateToWidth(line, Math.max(0, width));

/** Pi-jar owns these dialogs; Pi's normal and other extensions' questions are untouched. */
export async function promptText(ctx: ExtensionContext, title: string, question: string, initial = ""): Promise<string | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") return undefined;
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    const input = new Input({ prompt: "❯ ", placeholder: "Type your answer" });
    input.focused = true;
    input.setValue(initial);
    input.onSubmit = (value) => done(value.trim() || undefined);
    input.onEscape = () => done(undefined);
    return {
      invalidate() { input.invalidate(); },
      handleInput(data: string) { input.handleInput(data); tui.requestRender(); },
      render(width: number): string[] {
        return [
          fit(theme.fg("accent", `╭─ ${cleanText(title, 56)} ─`), width),
          ...wrapTextWithAnsi(cleanText(question, 160), Math.max(1, width - 2)).map((line) => fit(theme.fg("muted", `│ ${line}`), width)),
          ...input.render(Math.max(1, width - 2)).map((line) => fit("│ " + line, width)),
          fit(theme.fg("dim", "╰─ Enter: confirm · Esc: cancel"), width)
        ];
      }
    };
  });
}

export async function promptChoice(ctx: ExtensionContext, title: string, question: string, choices: readonly string[], initial = 0): Promise<number | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui" || !choices.length) return undefined;
  return ctx.ui.custom<number | undefined>((tui, theme, _keys, done) => {
    let selected = Math.max(0, Math.min(choices.length - 1, initial));
    return {
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, Key.escape)) return done(undefined);
        if (matchesKey(data, Key.enter)) return done(selected);
        if (matchesKey(data, Key.up)) selected = (selected + choices.length - 1) % choices.length;
        if (matchesKey(data, Key.down)) selected = (selected + 1) % choices.length;
        tui.requestRender();
      },
      render(width: number): string[] {
        return [
          fit(theme.fg("accent", `╭─ ${cleanText(title, 56)} ─`), width),
          ...wrapTextWithAnsi(cleanText(question, 160), Math.max(1, width - 2)).map((line) => fit(theme.fg("muted", `│ ${line}`), width)),
          ...choices.map((choice, index) => fit(theme.fg(index === selected ? "accent" : "dim", `${index === selected ? "❯" : " "} ${cleanText(choice, 80)}`), width)),
          fit(theme.fg("dim", "╰─ ↑↓: choose · Enter: confirm · Esc: cancel"), width)
        ];
      }
    };
  });
}

export type TodoFilter = "all" | "open" | "done";
export type TodoAction = { kind: "add" | "toggle" | "edit" | "delete"; id?: string };

export async function todoView(ctx: ExtensionContext, todos: () => Todo[], filter: { value: TodoFilter }): Promise<TodoAction | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") return undefined;
  return ctx.ui.custom<TodoAction | undefined>((tui, theme, _keys, done) => {
    let selected = 0;
    const filtered = () => todos().filter((item) => filter.value === "all" || (filter.value === "done") === item.done);
    return {
      invalidate() {},
      handleInput(data: string) {
        const items = filtered();
        if (matchesKey(data, Key.escape) || data === "q") return done(undefined);
        if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1);
        else if (matchesKey(data, Key.down)) selected = Math.min(Math.max(0, items.length - 1), selected + 1);
        else if (data === "f") {
          const next: Record<TodoFilter, TodoFilter> = { all: "open", open: "done", done: "all" };
          filter.value = next[filter.value]; selected = 0;
        } else if (data === "a") return done({ kind: "add" });
        else if (items[selected] && (data === " " || matchesKey(data, Key.enter))) return done({ kind: "toggle", id: items[selected].id });
        else if (items[selected] && data === "e") return done({ kind: "edit", id: items[selected].id });
        else if (items[selected] && data === "d") return done({ kind: "delete", id: items[selected].id });
        tui.requestRender();
      },
      render(width: number): string[] {
        const items = filtered();
        selected = Math.min(selected, Math.max(0, items.length - 1));
        const count = todos().filter((item) => !item.done).length;
        const start = Math.max(0, selected - 11);
        return [
          fit(theme.fg("accent", `╭─ pi-jar to-do · ${count} open · ${filter.value} ─`), width),
          ...(items.length ? items.slice(start, start + 12).map((item, index) =>
            fit(theme.fg(start + index === selected ? "accent" : item.done ? "dim" : "muted", `${start + index === selected ? "❯" : " "} ${item.done ? "☑" : "☐"} ${item.title}`), width))
            : [fit(theme.fg("dim", "  No items in this view"), width)]),
          fit(theme.fg("dim", "╰─ ↑↓: select · Space: check · a: add · e: edit · d: delete · f: filter · Esc: close"), width)
        ];
      }
    };
  });
}
