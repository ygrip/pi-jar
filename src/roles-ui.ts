import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, stripTerminalSequences, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { promptText } from "./dialogs.ts";
import { isRoleName, normalizeSpec, THINKING, type ModelRoleManager, type RoleRow } from "./model-roles.ts";
import { contentRows, optionList, sidebarWidth, splitFrame } from "./split-view.ts";

type RoleAction = "model" | "alias" | "thinking" | "scope" | "activate" | "clear" | "new" | "delete";
const ACTIONS: { action: RoleAction; key: string; hint: string; label: string }[] = [
  { action: "activate", key: "\r", hint: "⏎", label: "Activate this role now" },
  { action: "model", key: "m", hint: "m", label: "Assign a model" },
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
    ["muted", "Scope     " + (row.scope ?? "unset") + (row.scope === "project" ? "  (.pi/pi-jar-roles.json)" : row.scope === "global" ? "  (agent dir)" : "")],
    ["dim", ""],
    ["dim", "Specs: provider/model[:effort] · @role[:effort] · *"],
    ["dim", "Project assignments override global ones."]
  ];
}

async function roleScreen(ctx: ExtensionContext, roles: ModelRoleManager, initial: number): Promise<{ action: RoleAction; index: number } | undefined> {
  return ctx.ui.custom<{ action: RoleAction; index: number } | undefined>((tui, theme, _keys, done) => {
    let selected = initial;
    let scroll = 0;
    let layout = { top: 1, rows: 0, leftWidth: 0, bodyX: 2, footerTop: 0 };
    let width = 80;
    let actionsTop = -1;
    const rows = () => roles.list();
    const finish = (action: RoleAction) => done({ action, index: selected });
    return {
      invalidate() {},
      handleInput(data: string) {
        const count = rows().length;
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
        // Actions are listed in the detail pane, one per row.
        const actionIndex = row - actionsTop;
        if (row >= 0 && row < layout.rows && event.x >= layout.bodyX && actionIndex >= 0 && actionIndex < ACTIONS.length) {
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
        const height = Math.min(contentRows(5, 8), Math.max(12 + ACTIONS.length + 2, list.length));
        if (selected < scroll) scroll = selected;
        if (selected >= scroll + height) scroll = selected - height + 1;
        const active = roles.activeRole();
        const left = list.slice(scroll, scroll + height).map((row, index) => {
          const current = scroll + index === selected;
          const mark = row.error ? "⚠" : row.resolved ? "●" : "○";
          return theme.fg(current ? "accent" : row.resolved ? "muted" : "dim", (current ? "❯ " : "  ") + mark + " " + row.role + (active === row.role ? " *" : ""));
        });
        const row = list[selected]!;
        const info = detail(row, active).map(([color, text]) => theme.fg(color, text));
        // Narrow terminals collapse the sidebar into a pager header above the details.
        const narrow = sidebarWidth(width) === 0;
        const header = narrow ? [theme.fg("accent", `‹ ${selected + 1}/${list.length} ${row.role} ›`)] : [];
        const actions = optionList(theme, ACTIONS.map((item) => item.label), -1, ACTIONS.map((item) => item.hint))
          .map((line, at) => ACTIONS[at]!.action === "delete" && !row.custom ? theme.fg("dim", stripTerminalSequences(line)) : line);
        // Actions come right after the facts; the spec help (last three lines) goes last.
        const facts = info.slice(0, -3), help = info.slice(-3);
        const body = [...header, ...facts, theme.fg("accent", "Actions"), ...actions, ...help];
        actionsTop = header.length + facts.length + 1;
        const split = splitFrame(theme, width, "pi-jar · roles", narrow ? [] : left, body, [
          theme.fg("dim", "↑↓ choose role · press a key or click an action · Esc close")
        ], height);
        layout = split.layout;
        return split.lines;
      }
    };
  }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } });
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
      const selected = await ctx.ui.select("Model for " + row.role, labels);
      if (selected) roles.update(row.role, selected + effort(), scope);
      return;
    }
    case "alias": {
      const targets = roles.list().filter((item) => item.role !== row.role).map((item) => "@" + item.role);
      const selected = await ctx.ui.select("Alias " + row.role + " to", targets);
      if (selected) roles.update(row.role, selected + effort(), scope);
      return;
    }
    case "thinking": {
      if (!row.spec) { ctx.ui.notify("Assign a model or alias first", "warning"); return; }
      const selected = await ctx.ui.select("Thinking effort for " + row.role, ["follow current", ...THINKING]);
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
