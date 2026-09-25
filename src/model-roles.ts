import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanText } from "./status.ts";

/** Built-in roles and the pi-jar feature that uses each one. Any other valid name is a custom role. */
export const BUILTIN_ROLES = [
  { role: "default", label: "Default", usedBy: "session start and approved plans" },
  { role: "smol", label: "Fast", usedBy: "quick edits and cycling" },
  { role: "slow", label: "Thinking", usedBy: "deep reasoning and cycling" },
  { role: "plan", label: "Architect", usedBy: "plan mode" },
  { role: "implement", label: "Builder", usedBy: "goal implement rounds and approved plans" },
  { role: "advisor", label: "Advisor", usedBy: "second opinions, stuck-work gates and the goal audit" },
  { role: "task", label: "Subtask", usedBy: "delegated tasks" },
  { role: "commit", label: "Commit", usedBy: "/jar commit messages" }
] as const;
export const MODEL_ROLES = BUILTIN_ROLES.map((item) => item.role);
export type ModelRole = string;
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type RoleScope = "global" | "project";
export interface RoleAssignment { provider: string; model: string; thinking?: ThinkingLevel }
export interface ResolvedRole extends RoleAssignment { via: string[] }
export interface RoleTag { name?: string; color?: string }
export interface RoleConfig { version: 2; roles: Record<string, string>; cycleOrder?: string[]; tags?: Record<string, RoleTag> }
export interface RoleRow {
  role: string; label: string; usedBy?: string; custom: boolean;
  spec?: string; scope?: RoleScope; resolved?: ResolvedRole; error?: string;
}

export const ROLE_FILE = "pi-jar-roles.json";
export const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_CYCLE = ["smol", "default", "slow"];
const MAX_ALIAS_DEPTH = 5;
export const isRoleName = (value: string): boolean => /^[a-z][a-z0-9-]{0,31}$/.test(value);
export const isThinking = (value: unknown): value is ThinkingLevel => typeof value === "string" && THINKING.includes(value as ThinkingLevel);

/** Parse `provider/model[:thinking]`, `@role[:thinking]` or `*`; returns a canonical spec or undefined. */
export function normalizeSpec(raw: string): string | undefined {
  const value = raw.trim();
  if (value === "*") return "@default";
  const colon = value.lastIndexOf(":");
  const suffix = colon > 0 ? value.slice(colon + 1) : "";
  const head = colon > 0 && isThinking(suffix) ? value.slice(0, colon) : value;
  const thinking = head === value ? "" : ":" + suffix;
  if (head.startsWith("@")) return isRoleName(head.slice(1)) ? head + thinking : undefined;
  const slash = head.indexOf("/");
  if (slash <= 0 || slash === head.length - 1 || /\s/.test(head)) return undefined;
  return cleanText(head.slice(0, slash), 64) + "/" + cleanText(head.slice(slash + 1), 160) + thinking;
}

/** Accepts v2 files and migrates v1 `{provider, model, thinking}` objects in memory. */
export function parseRoleConfig(raw: unknown): RoleConfig {
  const config: RoleConfig = { version: 2, roles: {} };
  if (!raw || typeof raw !== "object") return config;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 && value.version !== 2) return config;
  const source = value.roles && typeof value.roles === "object" ? value.roles as Record<string, unknown> : {};
  for (const [role, entry] of Object.entries(source)) {
    if (!isRoleName(role)) continue;
    let spec: string | undefined;
    if (typeof entry === "string") spec = normalizeSpec(entry);
    else if (entry && typeof entry === "object") {
      const item = entry as Record<string, unknown>;
      if (typeof item.provider === "string" && typeof item.model === "string") {
        spec = normalizeSpec(item.provider + "/" + item.model + (isThinking(item.thinking) ? ":" + item.thinking : ""));
      }
    }
    if (spec) config.roles[role] = spec;
  }
  if (Array.isArray(value.cycleOrder)) {
    const order = value.cycleOrder.filter((item): item is string => typeof item === "string" && isRoleName(item));
    if (order.length) config.cycleOrder = [...new Set(order)];
  }
  if (value.tags && typeof value.tags === "object") {
    const tags: Record<string, RoleTag> = {};
    for (const [role, tag] of Object.entries(value.tags as Record<string, unknown>)) {
      if (!isRoleName(role) || !tag || typeof tag !== "object") continue;
      const item = tag as Record<string, unknown>;
      tags[role] = {
        ...(typeof item.name === "string" ? { name: cleanText(item.name, 24) } : {}),
        ...(typeof item.color === "string" ? { color: cleanText(item.color, 16) } : {})
      };
    }
    if (Object.keys(tags).length) config.tags = tags;
  }
  return config;
}

/** Follow `@alias` chains; an explicit thinking suffix on the referring role wins over the target's. */
export function resolveRole(roles: Readonly<Record<string, string>>, role: string): ResolvedRole | { error: string } | undefined {
  const via: string[] = [];
  let current = role;
  let thinking: ThinkingLevel | undefined;
  for (let depth = 0; depth <= MAX_ALIAS_DEPTH; depth++) {
    if (via.includes(current)) return { error: "alias cycle: " + [...via, current].join(" → ") };
    via.push(current);
    const spec = roles[current];
    if (!spec) return depth === 0 ? undefined : { error: "@" + current + " is not assigned" };
    const colon = spec.lastIndexOf(":");
    const suffix = colon > 0 ? spec.slice(colon + 1) : "";
    const head = colon > 0 && isThinking(suffix) ? spec.slice(0, colon) : spec;
    if (head !== spec) thinking ??= suffix as ThinkingLevel;
    if (head.startsWith("@")) { current = head.slice(1); continue; }
    const slash = head.indexOf("/");
    return { provider: head.slice(0, slash), model: head.slice(slash + 1), ...(thinking ? { thinking } : {}), via };
  }
  return { error: "alias chain deeper than " + MAX_ALIAS_DEPTH };
}

function readConfig(file: string): RoleConfig {
  try { return parseRoleConfig(JSON.parse(readFileSync(file, "utf8"))); }
  catch { return { version: 2, roles: {} }; }
}

function writeConfig(file: string, config: RoleConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = file + "." + String(process.pid) + "." + Math.random().toString(36).slice(2) + ".tmp";
  try {
    writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
    renameSync(temporary, file);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    throw error;
  }
}

export const projectRoleFile = (cwd: string) => join(cwd, ".pi", ROLE_FILE);

export function describeRole(row: RoleRow): string {
  const target = row.error ? "⚠ " + row.error
    : row.resolved ? row.resolved.provider + "/" + row.resolved.model + (row.resolved.thinking ? " · " + row.resolved.thinking : "")
    : "follows current model";
  return row.role + "  ·  " + (row.spec?.startsWith("@") ? row.spec + " → " : "") + target + (row.scope === "project" ? "  · project" : "");
}

export class ModelRoleManager {
  private global: RoleConfig = readConfig(join(getAgentDir(), ROLE_FILE));
  private project: RoleConfig = { version: 2, roles: {} };
  private cwd: string | undefined;
  private active: string | undefined;
  private readonly pi: ExtensionAPI;
  /** True while pi-jar itself is switching models, so its own changes are not seen as manual. */
  private applying = false;
  /** Bumped whenever the user picks a model or effort themselves. */
  private manualEpoch = 0;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  /** Reload global and project files; project assignments override global ones per role. */
  load(cwd?: string): void {
    this.global = readConfig(join(getAgentDir(), ROLE_FILE));
    this.cwd = cwd;
    this.project = cwd ? readConfig(projectRoleFile(cwd)) : { version: 2, roles: {} };
  }

  private merged(): Record<string, string> { return { ...this.global.roles, ...this.project.roles }; }
  activeRole(): string | undefined { return this.active; }
  cycleOrder(): string[] { return this.project.cycleOrder ?? this.global.cycleOrder ?? DEFAULT_CYCLE; }
  tag(role: string): RoleTag | undefined { return this.project.tags?.[role] ?? this.global.tags?.[role]; }
  spec(role: string): string | undefined { return this.merged()[role]; }
  scopeOf(role: string): RoleScope | undefined { return role in this.project.roles ? "project" : role in this.global.roles ? "global" : undefined; }

  resolve(role: string): ResolvedRole | undefined {
    const result = resolveRole(this.merged(), role);
    return result && !("error" in result) ? result : undefined;
  }

  get(role: string): RoleAssignment | undefined {
    const resolved = this.resolve(role);
    if (!resolved) return undefined;
    const { via: _via, ...assignment } = resolved;
    return assignment;
  }

  list(): RoleRow[] {
    const roles = this.merged();
    const custom = Object.keys(roles).filter((role) => !MODEL_ROLES.includes(role as never)).sort();
    const rows = [
      ...BUILTIN_ROLES.map((item) => ({ role: item.role, label: item.label, usedBy: item.usedBy as string, custom: false })),
      ...custom.map((role) => ({ role, label: this.tag(role)?.name ?? role, custom: true }))
    ];
    return rows.map((row) => {
      const result = resolveRole(roles, row.role);
      return { ...row, spec: roles[row.role], scope: this.scopeOf(row.role),
        ...(result && "error" in result ? { error: result.error } : result ? { resolved: result } : {}) };
    });
  }

  /** Summary for compact surfaces such as the welcome card. */
  summary(limit = 3): string {
    const rows = this.list().filter((row) => row.resolved || row.spec);
    if (!rows.length) return "all roles follow the current model";
    return rows.slice(0, limit).map((row) => row.role + "→" + (row.spec?.startsWith("@") ? row.spec.split(":")[0] : row.resolved?.model ?? "?")).join(" · ")
      + (rows.length > limit ? ` · +${rows.length - limit}` : "");
  }

  private status(ctx: ExtensionContext): void {
    try { ctx.ui.setStatus("pi-jar.model-role", this.active ? ctx.ui.theme.fg("accent", "role:" + this.active) : undefined); }
    catch { /* status is decorative */ }
  }

  async activate(role: string, ctx: ExtensionContext, quiet = false): Promise<boolean> {
    const result = resolveRole(this.merged(), role);
    if (result && "error" in result) {
      if (!quiet) ctx.ui.notify("Role " + role + ": " + result.error, "warning");
      return false;
    }
    if (!result) {
      if (!quiet) ctx.ui.notify("Role " + role + " follows the current model; assign one with /roles", "info");
      this.active = role;
      this.status(ctx);
      return true;
    }
    const model = ctx.modelRegistry.find(result.provider, result.model);
    if (!model) {
      if (!quiet) ctx.ui.notify("Model not found for role " + role + ": " + result.provider + "/" + result.model, "warning");
      return false;
    }
    let changed: boolean;
    this.applying = true;
    try { changed = await this.pi.setModel(model); } finally { this.applying = false; }
    if (!changed) {
      if (!quiet) ctx.ui.notify("No configured authentication for " + result.provider + "/" + result.model, "warning");
      return false;
    }
    if (result.thinking) this.withApplying(() => this.pi.setThinkingLevel(result.thinking!));
    this.active = role;
    this.status(ctx);
    if (!quiet) ctx.ui.notify("Role " + role + " · " + result.provider + "/" + result.model + (result.thinking ? " · " + result.thinking : ""), "info");
    return true;
  }

  /** Switch to a role for a bounded workflow; the returned function restores the previous model. */
  async activateTemporary(role: string, ctx: ExtensionContext): Promise<() => Promise<void>> {
    if (!this.resolve(role)) return async () => {};
    const previousModel = ctx.model;
    const previousThinking = this.pi.getThinkingLevel();
    const previousActive = this.active;
    const applied = await this.activate(role, ctx, true);
    if (!applied) return async () => {};
    const epoch = this.manualEpoch;
    return async () => {
      // A model or effort the user picked during the workflow wins over the saved one.
      if (this.manualEpoch !== epoch) { this.active = undefined; this.status(ctx); return; }
      this.applying = true;
      try { if (previousModel) await this.pi.setModel(previousModel); this.pi.setThinkingLevel(previousThinking); }
      finally { this.applying = false; }
      this.active = previousActive;
      this.status(ctx);
    };
  }

  private withApplying(action: () => void): void {
    this.applying = true;
    try { action(); } finally { this.applying = false; }
  }

  /** Activate the next assigned role in the cycle order. */
  async cycle(ctx: ExtensionContext): Promise<string | undefined> {
    const order = this.cycleOrder().filter((role) => this.resolve(role));
    if (!order.length) { ctx.ui.notify("No roles in the cycle order are assigned; configure them with /roles", "info"); return undefined; }
    const next = order[(order.indexOf(this.active ?? "") + 1) % order.length]!;
    return await this.activate(next, ctx) ? next : undefined;
  }

  /** Assign (or clear with undefined) a role in the chosen scope. */
  update(role: string, spec: string | undefined, scope: RoleScope = this.scopeOf(role) ?? "global"): void {
    if (!isRoleName(role)) throw new Error("Invalid role name: " + role);
    const normalized = spec === undefined ? undefined : normalizeSpec(spec);
    if (spec !== undefined && !normalized) throw new Error("Invalid role target: " + spec);
    if (scope === "project" && !this.cwd) throw new Error("Project roles need a working directory");
    const target = scope === "project" ? this.project : this.global;
    const roles = { ...target.roles };
    if (normalized) roles[role] = normalized; else delete roles[role];
    const next: RoleConfig = { ...target, version: 2, roles };
    writeConfig(scope === "project" ? projectRoleFile(this.cwd!) : join(getAgentDir(), ROLE_FILE), next);
    if (scope === "project") this.project = next; else this.global = next;
  }

  register(openUi?: (ctx: ExtensionContext) => Promise<void>): void {
    const manual = (_event: unknown, ctx: ExtensionContext) => {
      if (this.applying) return;
      this.manualEpoch++;
      if (this.active) { this.active = undefined; this.status(ctx); }
    };
    this.pi.on("model_select", manual);
    this.pi.on("thinking_level_select", manual);
    this.pi.on("session_start", async (_event, ctx) => {
      this.load(ctx.cwd);
      this.active = undefined;
      if (this.resolve("default")) await this.activate("default", ctx, true);
    });

    this.pi.registerCommand("roles", {
      description: "Configure model roles (default/smol/slow/plan/advisor/task/commit or custom): /roles, /roles set ROLE provider/model[:effort]|@role, /roles <role>",
      handler: async (args, ctx) => {
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const verb = (parts[0] ?? "").toLowerCase();
        if (!verb || verb === "list") {
          if (!verb && ctx.hasUI && ctx.mode === "tui" && openUi) { await openUi(ctx); return; }
          ctx.ui.notify(this.list().map(describeRole).join("\n"), "info");
          return;
        }
        if (verb === "cycle") { await this.cycle(ctx); return; }
        if (verb === "set") {
          const role = (parts[1] ?? "").toLowerCase();
          const legacyThinking = parts[3];
          const target = (parts[2] ?? "") + (legacyThinking && isThinking(legacyThinking) ? ":" + legacyThinking : "");
          const scope: RoleScope = parts.includes("--project") ? "project" : "global";
          if (legacyThinking && legacyThinking !== "--project" && !isThinking(legacyThinking)) { ctx.ui.notify("Unknown thinking effort: " + legacyThinking, "error"); return; }
          if (!isRoleName(role) || !normalizeSpec(target)) { ctx.ui.notify("Usage: /roles set ROLE PROVIDER/MODEL[:effort]|@ROLE [--project]", "error"); return; }
          try { this.update(role, target, scope); }
          catch (error) { ctx.ui.notify("Could not save role: " + (error as Error).message, "error"); return; }
          ctx.ui.notify("Assigned " + role + " → " + normalizeSpec(target) + (scope === "project" ? " (project)" : ""), "info");
          return;
        }
        if (verb === "clear") {
          const role = (parts[1] ?? "").toLowerCase();
          if (!isRoleName(role)) { ctx.ui.notify("Usage: /roles clear ROLE", "error"); return; }
          try { this.update(role, undefined); }
          catch (error) { ctx.ui.notify("Could not save role: " + (error as Error).message, "error"); return; }
          ctx.ui.notify("Cleared role " + role, "info");
          return;
        }
        if (!isRoleName(verb)) { ctx.ui.notify("Unknown role. Use: " + this.list().map((row) => row.role).join(", "), "error"); return; }
        await this.activate(verb, ctx);
      }
    });
  }
}
