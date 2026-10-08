import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { FOOTER_FIELDS, type FooterField } from "./footer-settings.ts";
import { formatTokens } from "./context-budget.ts";
import { ICON_SETS } from "./icons.ts";
import { CONTEXT_BUDGET_ACTIONS, CONTEXT_BUDGET_CHOICES, GOAL_ROUND_CHOICES, MAX_SUBAGENT_CHOICES, type JarAccent, type JarVisualSettings } from "./settings.ts";
import type { ProfileAction } from "./profile-ui.ts";

const LABELS: Record<FooterField, string> = {
  model: "Model", effort: "Model effort", sessionName: "Session name", cwd: "Working directory",
  context: "Context usage", memory: "Process RAM (RSS)", cost: "Session cost", quota: "Quota windows", roles: "Active roles",
  extras: "Extension statuses", branch: "Git branch"
};

type Page = "appearance" | "footer" | "pi" | "profiles";

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
  pi?: PiPreferences,
  profiles?: { activeName(): string; open(action: ProfileAction): Promise<void> }
): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  const PAGES: Page[] = profiles ? ["appearance", "footer", "pi", "profiles"] : ["appearance", "footer", "pi"];
  let lastPage: Page = "appearance";
  while (true) {
  const action = await ctx.ui.custom<ProfileAction | undefined>((tui, theme, _keys, done) => {
    let page: Page = lastPage;
    let selected = 0;
    let width = 64;
    const accents: JarAccent[] = ["follow", ...availableAccents.filter((name): name is JarAccent =>
      name === "default" || ["gray", "pink", "teal", "azure", "violet", "amber"].includes(name))];
    let choosing: "goalRounds" | "maxSubagents" | "contextBudget" | undefined;
    const choices = () => choosing === "maxSubagents" ? MAX_SUBAGENT_CHOICES : choosing === "contextBudget" ? CONTEXT_BUDGET_CHOICES : GOAL_ROUND_CHOICES;
    const fields = () => choosing ? choices().length : page === "footer" ? FOOTER_FIELDS.length : page === "pi" ? 11 : page === "profiles" ? 2 : 7;
    // Back on the row that opened the picker.
    const finishChoice = () => { selected = choosing === "maxSubagents" ? 3 : choosing === "contextBudget" ? 9 : 2; choosing = undefined; };
    const piError = (error: unknown) => ctx.ui.notify("Could not change Pi setting: " + (error as Error).message, "error");
    const explainPool = () => choosing === "maxSubagents" || (page === "pi" && !choosing && selected === 3);
    const pageSize = () => Math.min(fields(), Math.max(4, (process.stdout.rows ?? 24) - (explainPool() ? 10 : 9)));
    const firstVisible = () => Math.min(Math.max(0, selected - pageSize() + 1), Math.max(0, fields() - pageSize()));
    const visibleCount = () => Math.min(pageSize(), fields());
    const apply = (index: number) => {
      const state = current();
      if (choosing) {
        if (choosing === "maxSubagents") update({ ...state, maxSubagents: MAX_SUBAGENT_CHOICES[index]! });
        else if (choosing === "contextBudget") update({ ...state, contextBudget: { ...state.contextBudget, softTokens: CONTEXT_BUDGET_CHOICES[index]! } });
        else update({ ...state, goalRounds: GOAL_ROUND_CHOICES[index]! });
        finishChoice();
      } else if (page === "profiles") {
        lastPage = page;
        done(index === 0 ? "switch" : "create");
        return;
      } else if (page === "footer") {
        const field = FOOTER_FIELDS[index];
        if (field) update({ ...state, footer: { ...state.footer, [field]: !state.footer[field] } });
      } else if (page === "pi") {
        if (index === 0 && pi) { try { pi.setFullscreen(!pi.get().fullscreen); ctx.ui.notify("Pi TUI mode saved; restart Pi to apply", "info"); } catch (error) { piError(error); } }
        else if (index === 1 && pi) { try { pi.setCopyOnSelect(!pi.get().copyOnSelect); } catch (error) { piError(error); } }
        else if (index === 2) {
          choosing = "goalRounds";
          selected = Math.max(0, GOAL_ROUND_CHOICES.indexOf(state.goalRounds as never));
        }
        else if (index === 3) {
          choosing = "maxSubagents";
          selected = Math.max(0, MAX_SUBAGENT_CHOICES.indexOf(state.maxSubagents));
        }
        else if (index === 4) update({ ...state, advisor: !state.advisor });
        else if (index === 5) update({ ...state, advisorGates: !state.advisorGates });
        else if (index === 6) update({ ...state, contextDiet: !state.contextDiet });
        else if (index === 7) update({ ...state, cacheDiagnostics: !state.cacheDiagnostics });
        else if (index === 8) {
          const at = CONTEXT_BUDGET_ACTIONS.indexOf(state.contextBudget.action);
          update({ ...state, contextBudget: { ...state.contextBudget, action: CONTEXT_BUDGET_ACTIONS[(at + 1) % CONTEXT_BUDGET_ACTIONS.length]! } });
        }
        else if (index === 9) {
          choosing = "contextBudget";
          selected = Math.max(0, CONTEXT_BUDGET_CHOICES.indexOf(state.contextBudget.softTokens as never));
        }
        else if (index === 10) update({ ...state, readCache: !state.readCache });
      } else if (index === 0) {
        const at = Math.max(0, accents.indexOf(state.accent));
        update({ ...state, accent: accents[(at + 1) % accents.length]! });
      } else if (index === 1) update({ ...state, animations: !state.animations });
      else if (index === 2) update({ ...state, composer: !state.composer });
      else if (index === 3) update({ ...state, mascot: !state.mascot });
      else if (index === 4) update({ ...state, suggestions: !state.suggestions });
      else if (index === 5) update({ ...state, ui: !state.ui });
      else if (index === 6) update({ ...state, icons: ICON_SETS[(ICON_SETS.indexOf(state.icons) + 1) % ICON_SETS.length]! });
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
        if (matchesKey(data, Key.escape) || data === "q") {
          if (choosing) { finishChoice(); tui.requestRender(); } else done(undefined);
          return;
        }
        if (choosing && (matchesKey(data, Key.tab) || matchesKey(data, Key.right)
          || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) return;
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
        if (event.y === 0 && event.x >= width - 4) { done(undefined); return { handled: true }; }
        if (event.y === 1) {
          choosing = undefined;
          if (event.x >= 2 && event.x < Math.min(width - 2, 19)) { page = "appearance"; selected = 0; }
          else if (event.x >= 19 && event.x < Math.min(width - 2, 32)) { page = "footer"; selected = 0; }
          else if (event.x >= 32 && event.x < Math.min(width - 2, 41)) { page = "pi"; selected = 0; }
          else if (profiles && event.x >= 41 && event.x < width - 2) { page = "profiles"; selected = 0; }
          else return;
          tui.requestRender(); return { handled: true, focus: true };
        }
        if (event.y >= 5 && event.y < 5 + visibleCount() && event.x >= 2 && event.x < width - 2) {
          selected = firstVisible() + event.y - 5; apply(selected); return { handled: true, focus: true };
        }
        if (event.y === 5 + visibleCount() && event.x >= 2 && event.x < width - 2) { done(undefined); return { handled: true }; }
      },
      render(available: number): string[] {
        width = Math.max(8, available);
        const state = current();
        // Rows are assembled from exact-width parts, so one truncate-and-pad pass per row is enough.
        const line = (text: string) => theme.fg("dim", "│  ") + truncateToWidth(text, Math.max(0, width - 5), "...", true) + theme.fg("dim", " │");
        const title = " pi-jar · settings ";
        const top = theme.fg("accent", "╭─" + truncateToWidth(title, Math.max(0, width - 6))
          + "─".repeat(Math.max(0, width - 4 - visibleWidth(title))) + "×╮");
        const tabs = line(theme.fg(page === "appearance" ? "accent" : "muted", "[ Appearance ]")
          + "   " + theme.fg(page === "footer" ? "accent" : "muted", "[ Footer ]")
          + "   " + theme.fg(page === "pi" ? "accent" : "muted", "[ Pi ]")
          + (profiles ? "   " + theme.fg(page === "profiles" ? "accent" : "muted", "[ Profiles ]") : ""));
        const prefs = pi?.get();
        const divider = theme.fg("dim", "├" + "─".repeat(Math.max(0, width - 2)) + "┤");
        const budgetOn = state.contextBudget.action !== "off";
        const chosen = choosing === "contextBudget" ? state.contextBudget.softTokens : choosing ? state[choosing] : undefined;
        const allRows = choosing
          ? choices().map((choice, index) => row(index, choosing === "contextBudget" ? formatTokens(choice) + " tokens" : String(choice), chosen === choice ? "CURRENT" : "", true))
          : page === "footer"
          ? FOOTER_FIELDS.map((field, index) => row(index, LABELS[field], state.footer[field] ? "ON" : "OFF", state.footer[field]))
          : page === "pi" ? [
            row(0, "Mouse clicks (Pi fullscreen, restart)", !prefs ? "N/A" : prefs.fullscreen ? "ON" : "OFF", !!prefs?.fullscreen),
            row(1, "Copy on select", !prefs ? "N/A" : prefs.copyOnSelect ? "ON" : "OFF", !!prefs?.copyOnSelect),
            row(2, "Goal auto rounds", String(state.goalRounds), true),
            row(3, "Max subagents (retained live pool)", String(state.maxSubagents), true),
            row(4, "Advisor (jar_advisor, /advisor)", state.advisor ? "ON" : "OFF", state.advisor),
            row(5, "Advisor gates (loops, repeated failures)", state.advisorGates ? "ON" : "OFF", state.advisorGates),
          row(6, "Context diet (prior-turn reasoning)", state.contextDiet ? "ON" : "OFF", state.contextDiet),
            row(7, "Cache diagnostics (explain cache breaks)", state.cacheDiagnostics ? "ON" : "OFF", state.cacheDiagnostics),
            row(8, "Context budget (past the limit)", state.contextBudget.action.toUpperCase(), budgetOn),
            row(9, "Context budget limit", formatTokens(state.contextBudget.softTokens), budgetOn),
            row(10, "Repeated-read stub (unchanged re-reads)", state.readCache ? "ON" : "OFF", state.readCache)
          ] : page === "profiles" ? [
            row(0, "Switch profile…", profiles!.activeName(), true),
            row(1, "Create profile…", "OPEN", true)
          ] : [
            row(0, "Accent", state.accent === "follow" ? "FOLLOW PI" : state.accent.toUpperCase(), true),
            row(1, "Motion", state.animations ? "ON" : "OFF", state.animations),
            row(2, "Rounded composer", state.composer ? "ON" : "OFF", state.composer),
            row(3, "Ember mascot", state.mascot ? "ON" : "OFF", state.mascot),
            row(4, "Next-prompt suggestions", state.suggestions ? "ON" : "OFF", state.suggestions),
            row(5, "Pi-jar UI", state.ui ? "ON" : "OFF", state.ui),
            row(6, "Icons (nerd needs a Nerd Font)", state.icons.toUpperCase(), state.icons !== "ascii")
          ];
        const start = firstVisible();
        const rows = allRows.slice(start, start + pageSize());
        return [top, tabs, divider,
          line(theme.fg("accent", choosing === "maxSubagents" ? " MAX SUBAGENTS · RETAINED LIVE POOL"
            : choosing === "contextBudget" ? " CONTEXT BUDGET · SOFT LIMIT"
            : choosing === "goalRounds" ? " GOAL AUTO ROUNDS" : page === "footer" ? " FOOTER VISIBILITY" : page === "pi" ? " PI & WORKFLOWS" : page === "profiles" ? " PROFILES" : " APPEARANCE & MOTION")),
          line(theme.fg("dim", explainPool() ? " Live pool includes idle/paused subagents"
            : choosing ? " Select a value; Enter/click to save, Esc to cancel"
            : page === "footer" ? ` Footer fields ${start + 1}–${start + rows.length}/${fields()}`
            : page === "pi" ? (selected === 7 ? " Names what changed when a call re-sent cached context (/cache-breaks)"
              : selected === 8 || selected === 9 ? " Past the limit: suggest /compact or /new, or compact at a safe point"
              : selected === 10 ? " An unchanged re-read of the same range returns a short stub" : " Fullscreen mode enables clicks and copy-on-select")
            : page === "profiles" ? " Switch only in a fresh, idle session; roles via /roles" : " Accent cycles through loaded themes")),
          ...rows,
          line(theme.fg("dim", choosing ? " ↑↓: choose · Enter/click: save · Esc: cancel"
            : " Tab: section · ↑↓: choose · Enter/click: change · Esc")),
          ...(explainPool() ? [line(theme.fg("dim", " Lowering does not terminate existing subagents"))] : []),
          theme.fg("dim", "╰" + "─".repeat(Math.max(0, width - 2)) + "╯")];
      }
    };
  });
  if (!action || !profiles) return;
  try { await profiles.open(action); }
  catch (error) { ctx.ui.notify("Could not change profile: " + (error as Error).message, "error"); }
  // A new profile hands off to the roles UI; reopening settings over it would bury that step.
  if (action === "create") return;
  }
}
