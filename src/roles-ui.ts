import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, stripTerminalSequences, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { promptText, selectPopup } from "./dialogs.ts";
import { popup } from "./popup.ts";
import { isRoleName, normalizeSpec, premiumRoleWarnings, THINKING, type ModelRoleManager, type RoleRow } from "./model-roles.ts";
import { contentRows, optionList, sidebarWidth, splitFrame } from "./split-view.ts";

type RoleAction = "model" | "fallback" | "alias" | "thinking" | "scope" | "activate" | "clear" | "new" | "delete";
const ACTIONS: { action: RoleAction; key: string; hint: string; label: string }[] = [
  { action: "activate", key: "\r", hint: "⏎", label: "Activate this role now" },
  { action: "model", key: "m", hint: "m", label: "Assign a model" },
  { action: "fallback", key: "f", hint: "f", label: "Set fallback model" },
  { action: "alias", key: "a", hint: "a", label: "Alias another role (@role)" },
  { action: "thinking", key: "t", hint: "t", label: "Set thinking effort" },
  { action: "scope", key: "s", hint: "s", label: "Move between global and project" },
  { action: "clear", key: "c", hint: "c", label: "Clear the assignment" },
  { action: "new", key: "n", hint: "n", label: "New custom role" },
  { action: "delete", key: "d", hint: "d", label: "Delete this custom role" }
];

function detail(row: RoleRow, active: string | undefined): [ThemeColor, string][] {
  const target: [ThemeColor, string] = row.error ? ["error", "⚠ " + row.error]
    : row.resolved ? ["accent", row.resolved.provider + "/" + row.resolved.model] : ["dim", "follows the current model"];
  return [
    ["accent", row.label + (row.custom ? "  (custom role)" : "")],
    ["dim", ""],
    ["muted", "Role      " + row.role + (active === row.role ? "  ● active" : "")],
    ["muted", "Used by   " + (row.usedBy ?? "your prompts and other extensions")],
    ["muted", "Spec      " + (row.spec ?? "—")],
    [target[0], "Model     " + target[1]],
    ["muted", "Alias     " + (row.resolved && row.resolved.via.length > 1 ? row.resolved.via.join(" → ") : "—")],
    ["muted", "Effort    " + (row.resolved?.thinking ?? "follow current")],
    ["muted", "Fallback  " + (row.fallbacks.length ? row.fallbacks.join(" → ") : "—")],
    ["muted", "Scope     " + (row.scope ?? "unset") + (row.scope === "project" ? "  (.pi/pi-jar-roles.json)" : row.scope === "global" ? "  (agent dir)" : "")],
    ["dim", ""],
    ["dim", "Specs: provider/model[:effort] · @role[:effort] · *"],
    ["dim", "Project assignments override global ones."]
  ];
}

async function roleScreen(ctx: ExtensionContext, roles: ModelRoleManager, initial: number): Promise<{ action: RoleAction; index: number } | undefined> {
  return popup<{ action: RoleAction; index: number } | undefined>(ctx, (tui, theme, _keys, done) => {
    let selected = initial;
    let scroll = 0;
    let layout = { top: 1, rows: 0, leftWidth: 0, bodyX: 2, footerTop: 0 };
    let width = 80;
    const input = new Input({ prompt: "/ ", placeholder: "Filter roles" });
    let searching = false;
    const rows = () => roles.list().filter((row) => `${row.role} ${row.label} ${row.spec ?? ""}`.toLocaleLowerCase().includes(input.getValue().trim().toLocaleLowerCase()));
    input.onSubmit = () => { searching = false; input.focused = false; };
    input.onEscape = () => { searching = false; input.focused = false; input.setValue(""); selected = 0; scroll = 0; };
    // Read once per screen: every action closes the screen, and reopening it re-checks against the current model.
    const warnings = premiumRoleWarnings(roles, ctx);
    const finish = (action: RoleAction) => {
      const row = rows()[selected];
      if (row) done({ action, index: roles.list().findIndex((item) => item.role === row.role) });
    };
    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = searching && value; },
      invalidate() { input.invalidate(); },
      handleInput(data: string) {
        if (searching) { input.handleInput(data); selected = 0; scroll = 0; tui.requestRender(); return; }
        if (data === "/") { searching = true; input.focused = true; tui.requestRender(); return; }
        const count = rows().length;
        if (!count && !matchesKey(data, Key.escape)) return;
        if (matchesKey(data, Key.escape) || data === "q") return done(undefined);
        if (matchesKey(data, Key.up) || data === "k") selected = (selected + count - 1) % count;
        else if (matchesKey(data, Key.down) || data === "j") selected = (selected + 1) % count;
        else if (matchesKey(data, Key.enter)) return finish("activate");
        else {
          const hit = ACTIONS.find((item) => item.key === data);
          if (hit) return finish(hit.action);
        }
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        const count = rows().length;
        if (event.type === "wheel" && event.wheelDelta) {
          selected = Math.max(0, Math.min(count - 1, selected + Math.sign(event.wheelDelta)));
          tui.requestRender(); return { handled: true };
        }
        if (event.type !== "click" || event.button !== "left") return;
        if (event.y === 0 && event.x >= width - 3) { done(undefined); return { handled: true }; }
        const row = event.y - layout.top;
        // Actions stay in the footer so even short terminals can click every action.
        const actionIndex = event.y - layout.footerTop;
        if (event.x >= 2 && event.x < width - 2 && actionIndex >= 0 && actionIndex < ACTIONS.length) {
          finish(ACTIONS[actionIndex]!.action); return { handled: true };
        }
        if (row >= 0 && row < layout.rows && (layout.leftWidth === 0 || event.x < layout.leftWidth + 3)) {
          const index = scroll + row;
          if (index < count) { selected = index; tui.requestRender(); return { handled: true, focus: true }; }
        }
      },
      render(available: number): string[] {
        width = Math.max(24, available);
        const list = rows();
        selected = Math.max(0, Math.min(list.length - 1, selected));
        const height = Math.min(contentRows(ACTIONS.length + 4, 4), Math.max(13, list.length));
        if (selected < scroll) scroll = selected;
        if (selected >= scroll + height) scroll = selected - height + 1;
        const active = roles.activeRole();
        const left = list.slice(scroll, scroll + height).map((row, index) => {
          const current = scroll + index === selected;
          const mark = row.error ? "⚠" : row.resolved ? "●" : "○";
          return theme.fg(current ? "accent" : row.resolved ? "muted" : "dim", (current ? "❯ " : "  ") + mark + " " + row.role + (active === row.role ? " *" : ""));
        });
        const row = list[selected];
        if (!row) return [theme.fg("accent", "pi-jar · roles"), ...input.render(width), theme.fg("dim", "No matching roles · / edit filter · Esc close")];
        const info = detail(row, active).map(([color, text]) => theme.fg(color, text));
        // Narrow terminals collapse the sidebar into a pager header above the details.
        const narrow = sidebarWidth(width) === 0;
        const header = narrow ? [theme.fg("accent", `‹ ${selected + 1}/${list.length} ${row.role} ›`)] : [];
        const actions = optionList(theme, ACTIONS.map((item) => item.label), -1, ACTIONS.map((item) => item.hint))
          .map((line, at) => ACTIONS[at]!.action === "delete" && !row.custom ? theme.fg("dim", stripTerminalSequences(line)) : line);
        const body = [...header, ...warnings.map((text) => theme.fg("warning", text)), ...info];
        const split = splitFrame(theme, width, "pi-jar · roles", narrow ? [] : left, body, [
          ...actions,
          searching ? input.render(width)[0]! : theme.fg("dim", "↑↓ choose role · / filter roles · press a key or click an action · Esc close")
        ], height);
        layout = split.layout;
        return split.lines;
      }
    };
  }, { filter: false });
}

/** Keyboard- and pointer-driven model role manager. */
export async function openRolesUi(ctx: ExtensionContext, roles: ModelRoleManager): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  let index = 0;
  while (true) {
    const result = await roleScreen(ctx, roles, index);
    if (!result) return;
    index = result.index;
    const row = roles.list()[index];
    if (!row) return;
    try {
      await applyAction(ctx, roles, row, result.action, (next) => { index = next; });
    } catch (error) {
      ctx.ui.notify("Role change failed: " + (error as Error).message, "error");
    }
  }
}

async function applyAction(ctx: ExtensionContext, roles: ModelRoleManager, row: RoleRow, action: RoleAction, select: (index: number) => void): Promise<void> {
  const scope = row.scope ?? "global";
  const effort = () => {
    const spec = row.spec ?? "";
    const colon = spec.lastIndexOf(":");
    return colon > 0 && THINKING.includes(spec.slice(colon + 1) as never) ? spec.slice(colon) : "";
  };
  const base = () => {
    const spec = row.spec ?? "";
    return effort() ? spec.slice(0, spec.length - effort().length) : spec;
  };
  switch (action) {
    case "model": {
      const models = ctx.modelRegistry.getAvailable().slice().sort((a, b) => (a.provider + "/" + a.id).localeCompare(b.provider + "/" + b.id));
      if (!models.length) { ctx.ui.notify("No authenticated models are currently available", "warning"); return; }
      const labels = models.map((model) => model.provider + "/" + model.id);
      const selected = await selectPopup(ctx, "Model for " + row.role, labels);
      if (selected) roles.update(row.role, selected + effort(), scope);
      return;
    }
    case "fallback": {
      const models = ctx.modelRegistry.getAvailable().slice().sort((a, b) => (a.provider + "/" + a.id).localeCompare(b.provider + "/" + b.id));
      if (!models.length) { ctx.ui.notify("No authenticated models are currently available", "warning"); return; }
      const choices = ["Clear fallback", ...models.map((model) => model.provider + "/" + model.id)];
      const selected = await selectPopup(ctx, "Fallback model for " + row.role, choices);
      if (!selected) return;
      roles.updateFallbacks(row.role, selected === "Clear fallback" ? [] : [selected], scope);
      return;
    }
    case "alias": {
      const targets = roles.list().filter((item) => item.role !== row.role).map((item) => "@" + item.role);
      const selected = await selectPopup(ctx, "Alias " + row.role + " to", targets);
      if (selected) roles.update(row.role, selected + effort(), scope);
      return;
    }
    case "thinking": {
      if (!row.spec) { ctx.ui.notify("Assign a model or alias first", "warning"); return; }
      const selected = await selectPopup(ctx, "Thinking effort for " + row.role, ["follow current", ...THINKING]);
      if (selected) roles.update(row.role, base() + (selected === "follow current" ? "" : ":" + selected), scope);
      return;
    }
    case "scope": {
      if (!row.spec) { ctx.ui.notify("Assign the role before moving it between scopes", "warning"); return; }
      const next = scope === "global" ? "project" : "global";
      roles.update(row.role, row.spec, next);
      roles.update(row.role, undefined, scope);
      ctx.ui.notify(`Role ${row.role} moved to ${next} scope`, "info");
      return;
    }
    case "activate": await roles.activate(row.role, ctx); return;
    case "clear": if (row.spec) roles.update(row.role, undefined, scope); return;
    case "new": {
      const name = (await promptText(ctx, "New role", "Role name (lowercase, e.g. review)"))?.toLowerCase();
      if (!name) return;
      if (!isRoleName(name)) { ctx.ui.notify("Role names use a-z, 0-9 and -, starting with a letter", "warning"); return; }
      const spec = await promptText(ctx, "Role target", "provider/model[:effort] or @role", "@default");
      if (!spec || !normalizeSpec(spec)) { ctx.ui.notify("Invalid role target", "warning"); return; }
      roles.update(name, spec, "global");
      select(roles.list().findIndex((item) => item.role === name));
      return;
    }
    case "delete":
      if (!row.custom) { ctx.ui.notify("Built-in roles can be cleared, not deleted", "info"); return; }
      roles.update(row.role, undefined, scope);
      select(0);
      return;
  }
}
