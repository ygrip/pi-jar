import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { FOOTER_FIELDS, type FooterField } from "./footer-settings.ts";
import { GOAL_ROUND_CHOICES, type JarAccent, type JarVisualSettings } from "./settings.ts";

const LABELS: Record<FooterField, string> = {
  model: "Model", effort: "Model effort", sessionName: "Session name", cwd: "Working directory",
  context: "Context usage", memory: "Process RAM (RSS)", cost: "Session cost", quota: "Quota windows", roles: "Active roles",
  extras: "Extension statuses", branch: "Git branch"
};

type Page = "appearance" | "footer" | "pi";
const PAGES: Page[] = ["appearance", "footer", "pi"];

/** Pi-level preferences pi-jar can toggle (written to Pi's own settings). */
export interface PiPreferences {
  get(): { fullscreen: boolean; copyOnSelect: boolean };
  setFullscreen(enabled: boolean): void;
  setCopyOnSelect(enabled: boolean): void;
}

/** A single settings screen, keyboard-accessible everywhere and clickable in Pi fullscreen mode. */
export async function openJarSettings(
  ctx: ExtensionContext,
  current: () => JarVisualSettings,
  update: (settings: JarVisualSettings) => void,
  availableAccents: readonly string[],
  pi?: PiPreferences
): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let page: Page = "appearance";
    let selected = 0;
    let width = 64;
    const accents: JarAccent[] = ["follow", ...availableAccents.filter((name): name is JarAccent =>
      name === "default" || ["gray", "pink", "teal", "azure", "violet", "amber"].includes(name))];
    const fields = () => page === "footer" ? FOOTER_FIELDS.length : page === "pi" ? 3 : 6;
    const piError = (error: unknown) => ctx.ui.notify("Could not change Pi setting: " + (error as Error).message, "error");
    const pageSize = () => Math.min(fields(), Math.max(4, (process.stdout.rows ?? 24) - 9));
    const firstVisible = () => Math.min(Math.max(0, selected - pageSize() + 1), Math.max(0, fields() - pageSize()));
    const visibleCount = () => Math.min(pageSize(), fields());
    const apply = (index: number) => {
      const state = current();
      if (page === "footer") {
        const field = FOOTER_FIELDS[index];
        if (field) update({ ...state, footer: { ...state.footer, [field]: !state.footer[field] } });
      } else if (page === "pi") {
        if (index === 0 && pi) { try { pi.setFullscreen(!pi.get().fullscreen); ctx.ui.notify("Pi TUI mode saved; restart Pi to apply", "info"); } catch (error) { piError(error); } }
        else if (index === 1 && pi) { try { pi.setCopyOnSelect(!pi.get().copyOnSelect); } catch (error) { piError(error); } }
        else if (index === 2) {
          const at = GOAL_ROUND_CHOICES.indexOf(state.goalRounds as never);
          update({ ...state, goalRounds: GOAL_ROUND_CHOICES[(at + 1) % GOAL_ROUND_CHOICES.length]! });
        }
      } else if (index === 0) {
        const at = Math.max(0, accents.indexOf(state.accent));
        update({ ...state, accent: accents[(at + 1) % accents.length]! });
      } else if (index === 1) update({ ...state, animations: !state.animations });
      else if (index === 2) update({ ...state, composer: !state.composer });
      else if (index === 3) update({ ...state, mascot: !state.mascot });
      else if (index === 4) update({ ...state, suggestions: !state.suggestions });
      else if (index === 5) update({ ...state, ui: !state.ui });
      tui.requestRender();
    };
    const row = (index: number, label: string, value: string, enabled: boolean) => {
      const marker = selected === index ? theme.fg("accent", "❯") : " ";
      const innerWidth = Math.max(0, width - 7);
      const right = theme.fg(enabled ? "success" : "dim", value);
      const room = Math.max(0, innerWidth - visibleWidth(right) - 1);
      const left = truncateToWidth(label, room);
      const body = marker + " " + left + " ".repeat(Math.max(1, innerWidth - visibleWidth(left) - visibleWidth(right))) + right;
      return theme.fg("dim", "│  ") + truncateToWidth(body, Math.max(0, width - 5)) + theme.fg("dim", " │");
    };
    return {
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || data === "q") { done(); return; }
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
          page = PAGES[(PAGES.indexOf(page) + 1) % PAGES.length]!;
          selected = 0;
        } else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
          page = PAGES[(PAGES.indexOf(page) + PAGES.length - 1) % PAGES.length]!;
          selected = 0;
        } else if (matchesKey(data, Key.up)) selected = (selected + fields() - 1) % fields();
        else if (matchesKey(data, Key.down)) selected = (selected + 1) % fields();
        else if (data === " " || matchesKey(data, Key.enter)) apply(selected);
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === "wheel" && event.wheelDelta) {
          selected = Math.max(0, Math.min(fields() - 1, selected + Math.sign(event.wheelDelta)));
          tui.requestRender(); return { handled: true };
        }
        if (event.type !== "click" || event.button !== "left") return;
        if (event.y === 0 && event.x >= width - 4) { done(); return { handled: true }; }
        if (event.y === 1) {
          if (event.x >= 2 && event.x < Math.min(width - 2, 19)) { page = "appearance"; selected = 0; }
          else if (event.x >= 19 && event.x < Math.min(width - 2, 32)) { page = "footer"; selected = 0; }
          else if (event.x >= 32 && event.x < width - 2) { page = "pi"; selected = 0; }
          else return;
          tui.requestRender(); return { handled: true, focus: true };
        }
        if (event.y >= 5 && event.y < 5 + visibleCount() && event.x >= 2 && event.x < width - 2) {
          selected = firstVisible() + event.y - 5; apply(selected); return { handled: true, focus: true };
        }
        if (event.y === 5 + visibleCount() && event.x >= 2 && event.x < width - 2) { done(); return { handled: true }; }
      },
      render(available: number): string[] {
        width = Math.max(8, available);
        const state = current();
        const fit = (text: string) => truncateToWidth(text, width);
        const line = (text: string) => {
          const inner = Math.max(0, width - 5);
          const content = truncateToWidth(text, inner);
          return fit(theme.fg("dim", "│  ") + content + " ".repeat(Math.max(0, inner - visibleWidth(content))) + theme.fg("dim", " │"));
        };
        const title = " pi-jar · settings ";
        const top = theme.fg("accent", "╭─" + truncateToWidth(title, Math.max(0, width - 6))
          + "─".repeat(Math.max(0, width - 4 - visibleWidth(title))) + "×╮");
        const tabs = line(theme.fg(page === "appearance" ? "accent" : "muted", "[ Appearance ]")
          + "   " + theme.fg(page === "footer" ? "accent" : "muted", "[ Footer ]")
          + "   " + theme.fg(page === "pi" ? "accent" : "muted", "[ Pi ]"));
        const prefs = pi?.get();
        const divider = theme.fg("dim", "├" + "─".repeat(Math.max(0, width - 2)) + "┤");
        const allRows = page === "footer"
          ? FOOTER_FIELDS.map((field, index) => row(index, LABELS[field], state.footer[field] ? "ON" : "OFF", state.footer[field]))
          : page === "pi" ? [
            row(0, "Mouse clicks (Pi fullscreen, restart)", !prefs ? "N/A" : prefs.fullscreen ? "ON" : "OFF", !!prefs?.fullscreen),
            row(1, "Copy on select", !prefs ? "N/A" : prefs.copyOnSelect ? "ON" : "OFF", !!prefs?.copyOnSelect),
            row(2, "Goal auto rounds", String(state.goalRounds), true)
          ] : [
            row(0, "Accent", state.accent === "follow" ? "FOLLOW PI" : state.accent.toUpperCase(), true),
            row(1, "Motion", state.animations ? "ON" : "OFF", state.animations),
            row(2, "Rounded composer", state.composer ? "ON" : "OFF", state.composer),
            row(3, "Ember mascot", state.mascot ? "ON" : "OFF", state.mascot),
            row(4, "Next-prompt suggestions", state.suggestions ? "ON" : "OFF", state.suggestions),
            row(5, "Pi-jar UI", state.ui ? "ON" : "OFF", state.ui)
          ];
        const start = firstVisible();
        const rows = allRows.slice(start, start + pageSize());
        return [fit(top), tabs, divider,
          line(theme.fg("accent", page === "footer" ? " FOOTER VISIBILITY" : page === "pi" ? " PI & WORKFLOWS" : " APPEARANCE & MOTION")),
          line(theme.fg("dim", page === "footer" ? ` Footer fields ${start + 1}–${start + rows.length}/${fields()}`
            : page === "pi" ? " Fullscreen mode enables clicks and copy-on-select" : " Accent cycles through loaded themes")),
          ...rows.map(fit),
          line(theme.fg("dim", " Tab: section · ↑↓: choose · Enter/click: change · Esc")),
          fit(theme.fg("dim", "╰" + "─".repeat(Math.max(0, width - 2)) + "╯"))];
      }
    };
  });
}
