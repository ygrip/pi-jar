import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanText } from "./status.ts";

export const MODEL_ROLES = ["default", "smol", "slow", "plan", "commit", "task", "advisor"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface RoleAssignment { provider: string; model: string; thinking?: ThinkingLevel }
interface RoleConfig { version: 1; roles: Partial<Record<ModelRole, RoleAssignment>> }

const ROLE_FILE = "pi-jar-roles.json";
const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const isRole = (value: string): value is ModelRole => MODEL_ROLES.includes(value as ModelRole);
const isThinking = (value: unknown): value is ThinkingLevel => typeof value === "string" && THINKING.includes(value as ThinkingLevel);

function loadConfig(): RoleConfig {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(getAgentDir(), ROLE_FILE), "utf8"));
    if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>).version !== 1) return { version: 1, roles: {} };
    const source = (raw as { roles?: Record<string, unknown> }).roles ?? {};
    const roles: RoleConfig["roles"] = {};
    for (const role of MODEL_ROLES) {
      const value = source[role];
      if (!value || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      if (typeof item.provider !== "string" || typeof item.model !== "string") continue;
      roles[role] = {
        provider: cleanText(item.provider, 64), model: cleanText(item.model, 160),
        ...(isThinking(item.thinking) ? { thinking: item.thinking } : {})
      };
    }
    return { version: 1, roles };
  } catch {
    return { version: 1, roles: {} };
  }
}

function saveConfig(config: RoleConfig): void {
  const directory = getAgentDir();
  mkdirSync(directory, { recursive: true });
  const target = join(directory, ROLE_FILE);
  const temporary = target + "." + String(process.pid) + "." + Math.random().toString(36).slice(2) + ".tmp";
  try {
    writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    throw error;
  }
}

function describe(role: ModelRole, assignment?: RoleAssignment): string {
  if (!assignment) return role.toUpperCase() + "  ·  follow current model";
  return role.toUpperCase() + "  ·  " + assignment.provider + "/" + assignment.model + (assignment.thinking ? "  ·  " + assignment.thinking : "");
}

export class ModelRoleManager {
  private config = loadConfig();
  private active: ModelRole | undefined;
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  get(role: ModelRole): RoleAssignment | undefined {
    const value = this.config.roles[role];
    return value && { ...value };
  }

  private status(ctx: ExtensionContext): void {
    ctx.ui.setStatus("pi-jar.model-role", this.active ? ctx.ui.theme.fg("accent", "role:" + this.active) : undefined);
  }

  async activate(role: ModelRole, ctx: ExtensionContext, quiet = false): Promise<boolean> {
    const assignment = this.config.roles[role];
    if (!assignment) {
      if (!quiet) ctx.ui.notify("Role " + role + " follows the current model; assign one with /roles", "info");
      this.active = role;
      this.status(ctx);
      return true;
    }
    const model = ctx.modelRegistry.find(assignment.provider, assignment.model);
    if (!model) {
      if (!quiet) ctx.ui.notify("Model not found for role " + role + ": " + assignment.provider + "/" + assignment.model, "warning");
      return false;
    }
    const changed = await this.pi.setModel(model);
    if (!changed) {
      if (!quiet) ctx.ui.notify("No configured authentication for " + assignment.provider + "/" + assignment.model, "warning");
      return false;
    }
    if (assignment.thinking) this.pi.setThinkingLevel(assignment.thinking);
    this.active = role;
    this.status(ctx);
    if (!quiet) ctx.ui.notify("Role " + role + " · " + assignment.provider + "/" + assignment.model + (assignment.thinking ? " · " + assignment.thinking : ""), "info");
    return true;
  }

  async activateTemporary(role: ModelRole, ctx: ExtensionContext): Promise<() => Promise<void>> {
    const assignment = this.config.roles[role];
    if (!assignment) return async () => {};
    const previousModel = ctx.model;
    const previousThinking = this.pi.getThinkingLevel();
    const previousActive = this.active;
    const applied = await this.activate(role, ctx, true);
    if (!applied) return async () => {};
    return async () => {
      if (previousModel) await this.pi.setModel(previousModel);
      this.pi.setThinkingLevel(previousThinking);
      this.active = previousActive;
      this.status(ctx);
    };
  }

  private update(role: ModelRole, assignment: RoleAssignment | undefined): void {
    this.config = { version: 1, roles: { ...this.config.roles, [role]: assignment } };
    if (!assignment) delete this.config.roles[role];
    saveConfig(this.config);
  }

  private async configure(role: ModelRole, ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    while (true) {
      const current = this.config.roles[role];
      const choice = await ctx.ui.select("◆ ROLE · " + describe(role, current), [
        "Assign provider/model", "Set thinking effort", "Activate role now", "Clear assignment", "Back"
      ]);
      if (!choice || choice === "Back") return;
      if (choice === "Assign provider/model") {
        const models = ctx.modelRegistry.getAvailable().slice().sort((a, b) => (a.provider + "/" + a.id).localeCompare(b.provider + "/" + b.id));
        if (!models.length) { ctx.ui.notify("No authenticated models are currently available", "warning"); continue; }
        const labels = models.map((model) => model.provider + "/" + model.id);
        const selected = await ctx.ui.select("Model for " + role, labels);
        const at = selected ? labels.indexOf(selected) : -1;
        if (at >= 0) {
          const model = models[at]!;
          this.update(role, { provider: model.provider, model: model.id, ...(current?.thinking ? { thinking: current.thinking } : {}) });
        }
      } else if (choice === "Set thinking effort") {
        const selected = await ctx.ui.select("Thinking effort for " + role, ["follow current", ...THINKING]);
        if (!selected) continue;
        if (!current) { ctx.ui.notify("Assign a model first", "warning"); continue; }
        const { thinking: _previousThinking, ...base } = current;
        this.update(role, selected === "follow current"
          ? base
          : { ...base, thinking: selected as ThinkingLevel });
      } else if (choice === "Activate role now") {
        await this.activate(role, ctx);
      } else if (choice === "Clear assignment") {
        this.update(role, undefined);
        ctx.ui.notify("Role " + role + " now follows the current model", "info");
      }
    }
  }

  register(): void {
    this.pi.on("session_start", async (_event, ctx) => {
      if (this.config.roles.default) await this.activate("default", ctx, true);
    });

    this.pi.registerCommand("roles", {
      description: "Configure model assignments for default/smol/slow/plan/commit/task/advisor roles",
      handler: async (args, ctx) => {
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const verb = (parts[0] ?? "").toLowerCase();
        if (!verb) {
          if (!ctx.hasUI || ctx.mode !== "tui") {
            ctx.ui.notify(MODEL_ROLES.map((role) => describe(role, this.config.roles[role])).join("\n"), "info");
            return;
          }
          const labels = MODEL_ROLES.map((role) => describe(role, this.config.roles[role]));
          const selected = await ctx.ui.select("◆ pi-jar · model roles", labels);
          const at = selected ? labels.indexOf(selected) : -1;
          if (at >= 0) await this.configure(MODEL_ROLES[at]!, ctx);
          return;
        }
        if (verb === "set") {
          const role = (parts[1] ?? "").toLowerCase();
          const target = parts[2] ?? "";
          const slash = target.indexOf("/");
          if (!isRole(role) || slash <= 0) { ctx.ui.notify("Usage: /roles set ROLE PROVIDER/MODEL [effort]", "error"); return; }
          const thinking = parts[3];
          if (thinking && !isThinking(thinking)) { ctx.ui.notify("Unknown thinking effort: " + thinking, "error"); return; }
          this.update(role, { provider: target.slice(0, slash), model: target.slice(slash + 1), ...(thinking ? { thinking } : {}) });
          ctx.ui.notify("Assigned " + role + " → " + target, "info");
          return;
        }
        if (verb === "clear") {
          const role = (parts[1] ?? "").toLowerCase();
          if (!isRole(role)) { ctx.ui.notify("Usage: /roles clear ROLE", "error"); return; }
          this.update(role, undefined);
          ctx.ui.notify("Cleared role " + role, "info");
          return;
        }
        if (!isRole(verb)) { ctx.ui.notify("Unknown role. Use: " + MODEL_ROLES.join(", "), "error"); return; }
        await this.activate(verb, ctx);
      }
    });
  }
}
