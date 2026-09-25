import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { promptText } from "./dialogs.ts";
import { type ModelRoleManager } from "./model-roles.ts";
import { openPlanView } from "./plan-view.ts";
import { extractApproachSteps, isSafePlanCommand, PLAN_TEMPLATE, planTextFromSteps, validatePlanDocument } from "./plan-utils.ts";
import { cleanText } from "./status.ts";
import { type TodoStore } from "./tasks.ts";

export const PLAN_ENTRY = "pi-jar.plan";
export const PLAN_SUBMIT_TOOL = "jar_plan_submit";
type PlanState = { v: 2; enabled: boolean; steps: string[]; text?: string; path?: string; title?: string };

// Only tools with known read-only semantics are allowed. Name suffixes (for example
// "remote_get") do not prove that an extension or MCP tool is safe to invoke.
export const PLAN_SAFE_TOOLS = new Set(["read", "bash", "grep", "find", "ls", "jar_ask"]);
/** Allowed only for markdown files inside the session's plan directory. */
const PLAN_WRITE_TOOLS = new Set(["write", "edit"]);
const MAX_PLAN_BYTES = 64 * 1024;
const MAX_REMINDERS = 2;

export function safePlanText(value: string): string {
  return value.slice(0, MAX_PLAN_BYTES)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b./g, "")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, (char) => char === "\t" ? "  " : "")
    .trim();
}

/** Global, temporary home for plan documents: `$TMPDIR/pi-jar/plans/<session>`. */
export function planDirectory(sessionId: string | undefined, root = tmpdir()): string {
  const safe = (sessionId ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "session";
  return join(root, "pi-jar", "plans", safe);
}

/**
 * Resolve a tool path and return its real location only when it is a markdown file inside `root`.
 * Symlinks are resolved on the nearest existing ancestor (and on the file itself when present).
 */
export function resolvePlanPath(root: string, raw: unknown, cwd: string): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw.trim();
  const absolute = resolve(cwd, expanded);
  if (!absolute.toLowerCase().endsWith(".md")) return undefined;
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { return undefined; }
  let probe = absolute;
  const rest: string[] = [];
  while (!existsSync(probe)) {
    rest.unshift(basename(probe));
    const parent = dirname(probe);
    if (parent === probe) return undefined;
    probe = parent;
  }
  let real: string;
  try { real = join(realpathSync(probe), ...rest); } catch { return undefined; }
  const inside = relative(realRoot, real);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return undefined;
  return real;
}

export class PlanMode {
  private enabled = false;
  private steps: string[] = [];
  private planText = "";
  private planPath: string | undefined;
  private planTitle: string | undefined;
  private directory: string | undefined;
  private toolsBefore: string[] | undefined;
  private pendingReview = false;
  private reminders = 0;
  private reviewing = false;
  private compacting = false;
  private compactGeneration = 0;
  private restoreRole: (() => Promise<void>) | undefined;
  private onEnter: ((ctx: ExtensionContext) => void) | undefined;
  private readonly pi: ExtensionAPI;
  private readonly todos: () => TodoStore | undefined;
  private readonly roles: ModelRoleManager;
  private readonly todosChanged: (ctx: ExtensionContext) => void;
  private readonly root: string | undefined;

  constructor(pi: ExtensionAPI, todos: () => TodoStore | undefined, roles: ModelRoleManager, todosChanged: (ctx: ExtensionContext) => void, root?: string) {
    this.pi = pi;
    this.todos = todos;
    this.roles = roles;
    this.todosChanged = todosChanged;
    this.root = root;
  }

  isEnabled(): boolean { return this.enabled; }
  latestSteps(): string[] { return [...this.steps]; }
  hasPlan(): boolean { return !!(this.planText || this.steps.length); }
  summary(): { enabled: boolean; title?: string; steps: number } {
    return { enabled: this.enabled, ...(this.planTitle ? { title: this.planTitle } : {}), steps: this.steps.length };
  }
  /** Called when plan mode starts, so goal automation can pause. */
  setOnEnter(handler: (ctx: ExtensionContext) => void): void { this.onEnter = handler; }

  private persist(): void {
    this.pi.appendEntry(PLAN_ENTRY, { v: 2, enabled: this.enabled, steps: this.steps, text: this.planText,
      ...(this.planPath ? { path: this.planPath } : {}), ...(this.planTitle ? { title: this.planTitle } : {}) } satisfies PlanState);
  }

  private updateStatus(ctx: ExtensionContext): void {
    try { ctx.ui.setStatus("pi-jar.plan", this.enabled ? ctx.ui.theme.fg("warning", "◆ PLAN · read-only") : undefined); }
    catch { /* decorative */ }
  }

  private planTools(active: string[]): string[] {
    const available = new Set(this.pi.getAllTools().map((tool) => tool.name));
    const allowed = [...active.filter((name) => PLAN_SAFE_TOOLS.has(name)), ...PLAN_WRITE_TOOLS, PLAN_SUBMIT_TOOL];
    return [...new Set(allowed.filter((name) => available.has(name)))];
  }

  private ensureDirectory(ctx: ExtensionContext): string {
    const id = (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.();
    const directory = planDirectory(id, this.root);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // On shared temp dirs, refuse a directory another user planted (or a symlink to elsewhere).
    const info = lstatSync(directory);
    const uid = process.getuid?.();
    if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) throw new Error(directory + " is not a private directory");
    this.directory = directory;
    return directory;
  }

  private async enter(ctx: ExtensionContext, persist = true): Promise<void> {
    if (this.enabled) return;
    try { this.ensureDirectory(ctx); }
    catch (error) { ctx.ui.notify("Plan mode unavailable: cannot create plan directory: " + (error as Error).message, "error"); return; }
    this.enabled = true;
    this.pendingReview = false;
    this.reminders = 0;
    this.toolsBefore = this.pi.getActiveTools();
    this.pi.setActiveTools(this.planTools(this.toolsBefore));
    this.onEnter?.(ctx);
    this.restoreRole = await this.roles.activateTemporary("plan", ctx);
    this.updateStatus(ctx);
    if (persist) this.persist();
    ctx.ui.notify("Plan mode · read-only. The agent writes a plan file, then you review it.", "info");
  }

  private async leave(ctx: ExtensionContext, persist = true): Promise<void> {
    const wasEnabled = this.enabled;
    this.enabled = false;
    this.compacting = false;
    this.pendingReview = false;
    this.compactGeneration++;
    if (this.toolsBefore) this.pi.setActiveTools(this.toolsBefore);
    this.toolsBefore = undefined;
    if (this.restoreRole) await this.restoreRole();
    this.restoreRole = undefined;
    this.updateStatus(ctx);
    if (persist && wasEnabled) this.persist();
  }

  private seedTodos(ctx: ExtensionContext): void {
    const store = this.todos();
    if (!store) return;
    const existing = new Set(store.all().map((item) => item.title.trim().toLowerCase()));
    let changed = false;
    for (const step of this.steps) {
      const key = step.trim().toLowerCase();
      if (!key || existing.has(key)) continue;
      if (store.add(step, "Approved plan step")) { existing.add(key); changed = true; }
    }
    if (changed) this.todosChanged(ctx);
  }

  private executeMessage(): string {
    const text = this.planText || planTextFromSteps(this.steps);
    return [
      "Implement the approved plan now.",
      "Work through it step by step. Keep jar_todo synchronized: mark each step done as it completes and add any newly discovered work.",
      "Verify each step as described in the plan before moving on. If the plan is wrong, say so and adjust rather than silently diverging.",
      this.planPath ? "The plan file is " + this.planPath + "; re-read it only if this inline copy is lost to compaction." : "",
      `<plan${this.planPath ? ` path="${this.planPath}"` : ""}>`,
      text,
      "</plan>"
    ].filter(Boolean).join("\n\n");
  }

  private async implement(ctx: ExtensionContext, role?: string): Promise<void> {
    this.seedTodos(ctx);
    await this.leave(ctx);
    if (role) await this.roles.activate(role, ctx, true);
    this.pi.sendUserMessage(this.executeMessage(), { deliverAs: "followUp" });
  }

  private compactThenImplement(ctx: ExtensionContext, role?: string): void {
    this.compacting = true;
    const generation = ++this.compactGeneration;
    ctx.ui.notify("Compacting context while preserving the approved plan…", "info");
    ctx.compact({
      customInstructions: "Preserve this approved implementation plan exactly enough to execute it after compaction:\n" + (this.planText || planTextFromSteps(this.steps)),
      onComplete: () => {
        if (!this.enabled || generation !== this.compactGeneration) return;
        this.compacting = false;
        ctx.ui.notify("Context compacted · starting approved plan", "info");
        void this.implement(ctx, role);
      },
      onError: (error) => {
        if (generation !== this.compactGeneration) return;
        this.compacting = false;
        ctx.ui.notify("Compaction failed; plan mode is still active: " + error.message, "error");
      }
    });
  }

  private writeBack(text: string): void {
    if (!this.planPath) return;
    writeFileSync(this.planPath, text.endsWith("\n") ? text : text + "\n", "utf8");
  }

  /** Open the plan view and act on the user's choice. */
  async review(ctx: ExtensionContext): Promise<void> {
    if (this.reviewing || this.compacting || !this.hasPlan()) return;
    if (!ctx.hasUI || ctx.mode !== "tui") {
      ctx.ui.notify("Plan ready for review" + (this.planPath ? ": " + this.planPath : "") + ". Run /plan review in the interactive TUI.", "info");
      return;
    }
    this.reviewing = true;
    this.pendingReview = false;
    try {
      while (true) {
        const roles = this.roles.cycleOrder().filter((role) => this.roles.resolve(role));
        const result = await openPlanView(ctx, { title: this.planTitle ?? "Plan", text: this.planText || planTextFromSteps(this.steps),
          ...(this.planPath ? { path: this.planPath } : {}), roles });
        const action = result?.action ?? "stop";
        if (action === "edit") {
          const edited = await ctx.ui.editor("Edit plan" + (this.planPath ? " · " + this.planPath : ""), this.planText);
          if (edited != null && edited.trim() && edited !== this.planText) {
            this.planText = safePlanText(edited);
            this.planTitle = validatePlanDocument(this.planText).title ?? this.planTitle;
            this.steps = extractApproachSteps(this.planText);
            try { this.writeBack(this.planText); } catch (error) { ctx.ui.notify("Plan edited in memory but not saved: " + (error as Error).message, "warning"); }
            this.persist();
          }
          continue;
        }
        if (action === "implement") { if (!this.enabled) await this.enter(ctx, false); await this.implement(ctx, result?.role); }
        else if (action === "compact") { if (!this.enabled) await this.enter(ctx, false); this.compactThenImplement(ctx, result?.role); }
        else if (action === "refine") {
          const feedback = await promptText(ctx, "Refine plan", "What should change in the plan?");
          if (feedback) {
            if (!this.enabled) await this.enter(ctx);
            this.pi.sendUserMessage("Revise the plan file with this feedback, then submit it again with " + PLAN_SUBMIT_TOOL + ":\n\n" + feedback, { deliverAs: "followUp" });
          }
        } else {
          if (this.enabled) await this.leave(ctx);
          ctx.ui.notify("Plan stopped · no implementation started", "info");
        }
        return;
      }
    } finally {
      this.reviewing = false;
    }
  }

  private submit(raw: unknown, ctx: ExtensionContext): { ok: boolean; message: string } {
    if (!this.enabled) return { ok: false, message: "Plan mode is not active; there is nothing to submit." };
    const directory = this.directory ?? this.ensureDirectory(ctx);
    const path = resolvePlanPath(directory, raw, ctx.cwd);
    if (!path) return { ok: false, message: `Submit a markdown file inside ${directory}.` };
    let text: string;
    try {
      if (statSync(path).size > MAX_PLAN_BYTES) return { ok: false, message: "Plan file is larger than 64 KB; tighten it." };
      text = safePlanText(readFileSync(path, "utf8"));
    } catch (error) {
      return { ok: false, message: "Could not read the plan file: " + (error as Error).message };
    }
    const validation = validatePlanDocument(text);
    if (!validation.ok) {
      return { ok: false, message: ["The plan is incomplete. Fix it and submit again:",
        ...validation.missing.map((name) => `- add a \`## ${name}\` section`), ...validation.problems.map((problem) => "- " + problem),
        "", "Required structure:", PLAN_TEMPLATE].join("\n") };
    }
    this.planText = text;
    this.planPath = path;
    this.planTitle = validation.title;
    this.steps = extractApproachSteps(text);
    this.pendingReview = true;
    this.persist();
    return { ok: true, message: `Plan "${validation.title}" submitted for review (${this.steps.length} steps). Stop now; the user reviews it in the plan view.` };
  }

  private restoreFrom(branch: readonly unknown[]): PlanState | undefined {
    let state: PlanState | undefined;
    for (const raw of branch) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      if (entry.type !== "custom" || entry.customType !== PLAN_ENTRY || !entry.data || typeof entry.data !== "object") continue;
      const data = entry.data as Record<string, unknown>;
      if ((data.v !== 1 && data.v !== 2) || typeof data.enabled !== "boolean" || !Array.isArray(data.steps)) continue;
      state = {
        v: 2, enabled: data.enabled,
        steps: data.steps.filter((item): item is string => typeof item === "string").map((item) => cleanText(item, 240)).filter(Boolean).slice(0, 50),
        text: typeof data.text === "string" ? safePlanText(data.text) : "",
        ...(typeof data.path === "string" ? { path: data.path } : {}),
        ...(typeof data.title === "string" ? { title: cleanText(data.title, 120) } : {})
      };
    }
    return state;
  }

  private async restore(branch: readonly unknown[], ctx: ExtensionContext): Promise<void> {
    const state = this.restoreFrom(branch);
    if (this.enabled) await this.leave(ctx, false);
    this.steps = state?.steps ?? [];
    this.planText = state?.text ?? "";
    this.planPath = state?.path;
    this.planTitle = state?.title;
    if (state?.enabled) await this.enter(ctx, false);
    else this.updateStatus(ctx);
  }

  private async toggle(ctx: ExtensionContext): Promise<void> {
    if (this.enabled) { await this.leave(ctx); ctx.ui.notify("Plan mode off", "info"); }
    else await this.enter(ctx);
  }

  private context(): string {
    return [
      "[PI-JAR PLAN MODE · READ ONLY]",
      "You are planning, not implementing. Explore with read-only tools; do not modify the repository, remote services or any external state.",
      `Write the plan as markdown to ${this.directory ?? planDirectory(undefined, this.root)}/<short-kebab-slug>-plan.md with write/edit (the only place writes are allowed).`,
      "Make it decision-complete: someone new to the conversation can execute it without making design choices.",
      "Use jar_ask for structured clarifying questions when a real decision is the user's to make.",
      `Every turn must end with ${PLAN_SUBMIT_TOOL}({ path }) once the plan is ready. Never ask for approval in chat; the user approves in the plan view.`,
      "Required structure:",
      PLAN_TEMPLATE
    ].join("\n");
  }

  register(): void {
    this.pi.registerTool?.({
      name: PLAN_SUBMIT_TOOL,
      label: "plan",
      description: "Submit the finished plan markdown file for user review. Only available in pi-jar plan mode.",
      promptSnippet: "In plan mode, write the plan file then call jar_plan_submit to request review.",
      parameters: Type.Object({ path: Type.String({ description: "Path of the plan markdown file inside the plan directory." }) }),
      execute: async (_id, params, _signal, _update, ctx) => {
        const result = this.submit(params.path, ctx);
        return { content: [{ type: "text", text: result.message }], details: { ok: result.ok, title: this.planTitle, steps: this.steps.length }, ...(result.ok ? { terminate: true } : {}) };
      },
      renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("plan")) + " " + theme.fg("accent", "submit") + " " + theme.fg("muted", String(args.path ?? "")), 0, 0); },
      renderResult(result, _options, theme) {
        const details = result.details as { ok?: boolean; title?: string; steps?: number } | undefined;
        return new Text(details?.ok ? theme.fg("success", `◆ ${details.title ?? "Plan"} · ${details.steps ?? 0} steps · awaiting review`) : theme.fg("warning", "Plan needs changes before review"), 0, 0);
      }
    });

    this.pi.registerCommand("plan", {
      description: "Plan mode: /plan [prompt] enters read-only planning, /plan review reopens the plan view, /plan off exits",
      handler: async (args, ctx) => {
        const text = args.trim();
        if (/^(?:off|stop|exit)$/i.test(text)) {
          await this.leave(ctx);
          ctx.ui.notify("Plan mode off", "info");
          return;
        }
        if (/^(?:review|view|show)$/i.test(text)) {
          if (!this.hasPlan()) { ctx.ui.notify("No plan yet. Use /plan <what to plan>.", "info"); return; }
          await this.review(ctx);
          return;
        }
        const wasEnabled = this.enabled;
        if (!this.enabled) await this.enter(ctx);
        if (!this.enabled) return;
        if (text) {
          this.pi.sendUserMessage(text, { deliverAs: "followUp" });
          return;
        }
        if (wasEnabled && this.hasPlan()) await this.review(ctx);
      }
    });

    this.pi.registerShortcut?.(Key.ctrlAlt("p"), {
      description: "Toggle pi-jar plan mode",
      handler: async (ctx) => { await this.toggle(ctx); }
    });

    this.pi.on("tool_call", async (event, ctx) => {
      if (!this.enabled) return;
      const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
      if (event.toolName === "bash") {
        if (!this.pi.getActiveTools().includes("bash")) return { block: true, reason: "Plan mode is read-only: bash is not active." };
        if (typeof input.command !== "string" || !isSafePlanCommand(input.command)) {
          return { block: true, reason: "Plan mode is read-only: this shell command is not on the read-only allowlist." };
        }
        return;
      }
      if (PLAN_WRITE_TOOLS.has(event.toolName)) {
        const directory = this.directory ?? this.ensureDirectory(ctx);
        if (resolvePlanPath(directory, input.path ?? input.file_path, ctx.cwd)) return;
        return { block: true, reason: `Plan mode: the working tree is read-only. Write your plan to ${directory}/<slug>-plan.md instead.` };
      }
      if (event.toolName === PLAN_SUBMIT_TOOL) return;
      if (!PLAN_SAFE_TOOLS.has(event.toolName) || !this.pi.getActiveTools().includes(event.toolName)) {
        return { block: true, reason: "Plan mode is read-only: tool " + event.toolName + " is disabled until the plan is approved." };
      }
    });

    this.pi.on("before_agent_start", async () => {
      if (!this.enabled) return;
      return { message: { customType: "pi-jar.plan-context", content: this.context(), display: false } };
    });

    this.pi.on("context", async (event) => {
      if (this.enabled) return;
      return { messages: event.messages.filter((raw) => {
        const message = raw as { customType?: string };
        return message.customType !== "pi-jar.plan-context" && message.customType !== "pi-jar.plan-reminder";
      }) };
    });

    this.pi.on("input", (event) => {
      if (event.source === "interactive") this.reminders = 0;
    });

    // The final actionable boundary: nudge the agent to submit instead of ending with a chat-only plan.
    this.pi.on("agent_before_settle", (event, ctx) => {
      if (!this.enabled || this.pendingReview || this.reviewing || this.compacting || event.continue || event.outcome !== "completed") return;
      if (this.reminders >= MAX_REMINDERS) {
        if (this.reminders++ === MAX_REMINDERS) ctx.ui.notify("Plan mode: the agent has not submitted a plan file. Ask it to, or /plan off.", "warning");
        return;
      }
      this.reminders++;
      return {
        entries: [{ type: "custom_message", customType: "pi-jar.plan-reminder", display: false,
          content: `[PI-JAR PLAN MODE] You ended the turn without ${PLAN_SUBMIT_TOOL}. If the plan is ready, write it to the plan directory and call ${PLAN_SUBMIT_TOOL}. If you need a decision from the user, use jar_ask. Do not ask for approval in chat.` }],
        continue: true
      };
    });

    this.pi.on("agent_settled", async (_event, ctx) => {
      if (this.enabled && this.pendingReview) await this.review(ctx);
    });

    this.pi.on("session_start", async (_event, ctx) => { await this.restore(ctx.sessionManager.getBranch(), ctx); });
    this.pi.on("session_tree", async (_event, ctx) => { await this.restore(ctx.sessionManager.getBranch(), ctx); });
    this.pi.on("session_shutdown", async (_event, ctx) => { if (this.enabled) await this.leave(ctx, false); });
  }
}
