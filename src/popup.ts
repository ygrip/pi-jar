import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, stripTerminalSequences, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

type Factory<T> = (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component & { dispose?(): void };
export interface PopupOptions {
  /** Views with their own search/editor keep ownership of printable keys. */
  filter?: boolean;
}

/** Common containment for every jar popup. Oversized chrome remains reachable, not silently clipped by Pi. */
export function popup<T>(ctx: ExtensionContext, factory: Factory<T>, options: PopupOptions = {}): Promise<T> {
  return ctx.ui.custom<T>((tui, theme, keys, done) => {
    const child = factory(tui, theme, keys, done);
    const input = new Input({ prompt: "/ ", placeholder: "Filter popup content" });
    let searching = false;
    let scroll = 0;
    let height = 24;
    let width = 80;
    let source: string[] = [];
    let hits: number[] = [];
    let shown: number[] = [];
    let follow = false;
    const page = () => Math.max(1, height - 2);
    const move = (delta: number) => { scroll = Math.max(0, Math.min(Math.max(0, hits.length - page()), scroll + delta)); };
    input.onEscape = () => { searching = false; input.focused = false; input.setValue(""); scroll = 0; };
    input.onSubmit = () => {
      // Return to the original view, never activate a hidden selection on Enter.
      scroll = hits[scroll] ?? 0;
      searching = false; input.focused = false; input.setValue("");
    };
    return {
      get focused() { return searching ? input.focused : (child as Component & { focused?: boolean }).focused ?? false; },
      set focused(value: boolean) { input.focused = searching && value; (child as Component & { focused?: boolean }).focused = value; },
      invalidate() { child.invalidate(); input.invalidate(); },
      dispose() { child.dispose?.(); },
      handleInput(data: string) {
        if (searching) {
          if (matchesKey(data, Key.up)) move(-1);
          else if (matchesKey(data, Key.down)) move(1);
          else if (matchesKey(data, Key.pageUp)) move(-page());
          else if (matchesKey(data, Key.pageDown)) move(page());
          else { const before = input.getValue(); input.handleInput(data); if (input.getValue() !== before) scroll = 0; }
        } else if (options.filter !== false && data === "/") {
          searching = true; input.focused = true; scroll = 0;
        } else if (matchesKey(data, Key.ctrl("pageUp"))) move(-page());
        else if (matchesKey(data, Key.ctrl("pageDown"))) move(page());
        else { child.handleInput?.(data); follow = true; }
        tui.requestRender();
      },
      handleMouse(event) {
        if (event.type === "wheel" && event.wheelDelta && (searching || source.length > height)) {
          move(Math.sign(event.wheelDelta) * 3); tui.requestRender(); return { handled: true };
        }
        if (event.type === "wheel") return child.handleMouse?.(event);
        const original = shown[event.y];
        if (original === undefined || original < 0) return;
        return child.handleMouse?.({ ...event, y: original });
      },
      render(available) {
        width = Math.max(1, available);
        height = Math.max(1, tui.terminal?.rows ?? process.stdout.rows ?? 24);
        source = child.render(width);
        const terms = input.getValue().trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        hits = source.flatMap((line, index) => {
          const text = stripTerminalSequences(line).toLocaleLowerCase();
          return !searching || (/[\p{L}\p{N}]/u.test(text) && terms.every((term) => text.includes(term))) ? [index] : [];
        });
        if (!searching && source.length <= height) {
          scroll = 0; shown = hits; follow = false; return source.map((line) => truncateToWidth(line, width));
        }
        if (follow && !searching) {
          const selected = source.findIndex((line) => stripTerminalSequences(line).includes("❯"));
          if (selected >= 0) {
            if (selected < scroll) scroll = selected;
            if (selected >= scroll + page()) scroll = selected - page() + 1;
          }
        }
        follow = false;
        scroll = Math.max(0, Math.min(scroll, Math.max(0, hits.length - page())));
        const window = hits.slice(scroll, scroll + page());
        const body = window.length ? window.map((at) => source[at]!) : [theme.fg("dim", "No matches")];
        const header = searching ? input.render(width)[0]! : theme.fg("dim", "↑↓ in view · Ctrl+PgUp/PgDn / wheel scroll popup" + (options.filter !== false ? " · / filter" : ""));
        const footer = theme.fg("dim", `${hits.length ? scroll + 1 : 0}–${Math.min(hits.length, scroll + page())}/${hits.length}` + (searching ? " · Enter return to view · click to act · Esc clear" : ""));
        if (height <= 2) {
          shown = [...window.slice(0, 1), -1];
          return [body[0]!, footer].slice(0, height).map((line) => truncateToWidth(line, width));
        }
        shown = [-1, ...window, -1];
        // Header/footer have no child hit target, even on a one-row terminal.
        shown[0] = -1;
        return [header, ...body, footer].slice(0, height).map((line) => truncateToWidth(line, width));
      }
    };
  }, { overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 } });
}
