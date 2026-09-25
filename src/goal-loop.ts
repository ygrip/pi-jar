import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Goal, GoalStore } from "./goals.ts";
import type { ModelRoleManager } from "./model-roles.ts";
import { isSafePlanCommand } from "./plan-utils.ts";
import type { Todo, TodoStore } from "./tasks.ts";

export const GOAL_TOOL = "jar_goal";
export const DEFAULT_GOAL_ROUNDS = 8;
const CONTEXT_TYPE = "pi-jar.goal-context";
const CONTINUATION_TYPE = "pi-jar.goal-continuation";
const WRITE_TOOLS = new Set(["write", "edit"]);

export interface GoalLoopOptions {
  goals: () => GoalStore | undefined;
  todos: () => TodoStore | undefined;
  roles: ModelRoleManager;
  planActive: () => boolean;
  maxRounds?: () => number;
  changed?: (ctx: ExtensionContext) => void;
  completed?: (ctx: ExtensionContext, goal: Goal) => void;
}

const taskLines = (items: readonly Todo[]) => items.length ? items.map((item) => `${item.done ? "[x]" : "[ ]"} ${item.title} (${item.id})`).join("\n") : "(no tasks yet)";

/** One-line goal progress for the footer and welcome card. */
export function goalProgress(goal: Goal | undefined, todos: readonly Todo[], maxRounds = DEFAULT_GOAL_ROUNDS): string | undefined {
  if (!goal) return undefined;
  const done = todos.filter((item) => item.done).length;
  const parts = [goal.text];
  if (todos.length) parts.push(`${done}/${todos.length} tasks`);
  if (goal.status === "active" && goal.rounds) parts.push(`round ${goal.rounds}/${maxRounds}`);
  if (goal.status === "active" && goal.phase === "audit") parts.push("auditing");
  if (goal.status === "paused") parts.push("paused" + (goal.reason ? ` (${goal.reason})` : ""));
  if (goal.status === "complete") parts.push("✓ complete");
  return parts.join(" · ");
}

/**
 * Goal mode: the implementor keeps working while jar_todo tasks are open; once they are all done
 * an auditor pass (advisor role) must verify the goal and call jar_goal complete with evidence.
 */
export class GoalLoop {
  private readonly pi: ExtensionAPI;
  private readonly options: GoalLoopOptions;
  private prompting = 0;
  private restoreRole: (() => Promise<void>) | undefined;

  constructor(pi: ExtensionAPI, options: GoalLoopOptions) {
    this.pi = pi;
    this.options = options;
  }

  maxRounds(): number { return Math.max(1, Math.floor(this.options.maxRounds?.() ?? DEFAULT_GOAL_ROUNDS)); }
  private tasks(): Todo[] { return this.options.todos()?.all() ?? []; }
  private goal(): Goal | undefined { return this.options.goals()?.current(); }
  progress(): string | undefined { return goalProgress(this.goal(), this.tasks(), this.maxRounds()); }

  /** Pause automation (for example when plan mode starts). */
  pause(ctx: ExtensionContext | undefined, reason: string): void {
    const store = this.options.goals();
    if (!store?.isActive()) return;
    store.setStatus("paused", { reason });
    if (ctx) { ctx.ui.notify("◎ Goal paused · " + reason + " · /goal resume", "info"); this.options.changed?.(ctx); }
  }

  private async restore(): Promise<void> {
    const restore = this.restoreRole;
    this.restoreRole = undefined;
    if (restore) await restore();
  }

  private context(goal: Goal): string {
    const tasks = this.tasks();
    return [
      "[PI-JAR ACTIVE GOAL]",
      goal.text,
      "Goal mode is on. Work until the goal is actually achieved:",
      "- Break the goal into concrete jar_todo tasks before editing anything; edits are blocked while no task is open.",
      "- Keep jar_todo synchronized: mark tasks done only when their outcome is verified, add tasks for newly discovered work.",
      "- pi-jar keeps you going while tasks remain. When all are done an audit pass verifies the goal; only then call jar_goal complete with evidence.",
      "- If you are truly blocked on the user, call jar_goal block with the reason instead of stopping silently.",
      "Current tasks:",
      taskLines(tasks)
    ].join("\n");
  }

  private implementMessage(goal: Goal, round: number): string {
    const open = this.tasks().filter((item) => !item.done);
    return [
      `[PI-JAR GOAL · implementor · round ${round}/${this.maxRounds()}]`,
      "Goal: " + goal.text,
      open.length ? "Continue with the open tasks. Verify each outcome before marking it done:" : "There are no tasks yet. Break the goal into concrete jar_todo tasks now, then start the first one.",
      open.length ? taskLines(open) : ""
    ].filter(Boolean).join("\n");
  }

  private auditMessage(goal: Goal, round: number): string {
    return [
      `[PI-JAR GOAL · auditor · round ${round}/${this.maxRounds()}]`,
      "Goal: " + goal.text,
      "All tracked tasks are marked done. Act as an independent auditor: check the goal against the current repository state, run the relevant tests or commands, and look for missed requirements or regressions.",
      "- If anything is missing or wrong, add jar_todo tasks for the gaps (do not edit files during the audit) and stop; the implementor will continue.",
      "- If the goal is fully achieved, call jar_goal complete with concrete evidence (commands run, results, files).",
      "Tasks:",
      taskLines(this.tasks())
    ].join("\n");
  }

  private complete(ctx: ExtensionContext, evidence: string): { ok: boolean; message: string } {
    const store = this.options.goals();
    const goal = store?.current();
    if (!store || !goal || goal.status !== "active") return { ok: false, message: "No active goal." };
    const open = this.tasks().filter((item) => !item.done);
    if (open.length) return { ok: false, message: "Cannot complete: tasks are still open:\n" + taskLines(open) };
    if (goal.phase !== "audit") return { ok: false, message: "Cannot complete yet: finish your turn; pi-jar runs an audit pass before a goal can be completed." };
    if (!evidence.trim()) return { ok: false, message: "Provide concrete evidence (commands run, results, files) to complete the goal." };
    if (!store.setStatus("complete", { evidence })) return { ok: false, message: "Could not record goal completion." };
    ctx.ui.notify("◎ Goal complete · " + goal.text, "info");
    this.options.changed?.(ctx);
    this.options.completed?.(ctx, { ...goal, status: "complete", evidence });
    return { ok: true, message: "Goal marked complete." };
  }

  /** Set a goal and kick off the implementor. */
  async start(ctx: ExtensionContext, text: string): Promise<void> {
    const store = this.options.goals();
    if (!store) { ctx.ui.notify("Goal state is unavailable before the session starts", "warning"); return; }
    if (!store.set(text)) { ctx.ui.notify("Could not set goal; keep it concise and plain-text", "error"); return; }
    this.options.changed?.(ctx);
    ctx.ui.notify("◎ Goal active · " + store.current()!.text, "info");
    if (this.options.planActive()) { this.pause(ctx, "plan mode is on"); return; }
    this.pi.sendUserMessage("Work toward the active goal: " + store.current()!.text, { deliverAs: "followUp" });
  }

  /** Ask for a goal in the TUI editor (welcome action). */
  async prompt(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const current = this.options.goals()?.text();
    const edited = (await ctx.ui.editor(current ? "◎ Replace goal" : "◎ New goal", current ?? ""))?.trim();
    if (edited && edited !== current) await this.start(ctx, edited);
  }

  register(): void {
    const progress = () => this.progress();
    this.pi.registerTool?.({
      name: GOAL_TOOL,
      label: "goal",
      description: "Inspect or finish pi-jar's active goal. complete requires audit-phase evidence and no open jar_todo tasks; block pauses the loop for the user.",
      promptSnippet: "When a pi-jar goal is active, track work with jar_todo and finish with jar_goal complete (evidence) after the audit pass.",
      parameters: Type.Object({
        action: Type.Unsafe<"get" | "complete" | "block">({ type: "string", enum: ["get", "complete", "block"] }),
        evidence: Type.Optional(Type.String({ description: "For complete: commands run, results and files that prove the goal is met." })),
        reason: Type.Optional(Type.String({ description: "For block: what you need from the user." }))
      }),
      execute: async (_id, params, _signal, _update, ctx) => {
        const goal = this.goal();
        if (params.action === "complete") {
          const result = this.complete(ctx, params.evidence ?? "");
          return { content: [{ type: "text", text: result.message }], details: { action: "complete", ok: result.ok }, ...(result.ok ? { terminate: true } : {}) };
        }
        if (params.action === "block") {
          if (!goal || goal.status !== "active") return { content: [{ type: "text", text: "No active goal." }], details: { action: "block", ok: false } };
          const reason = (params.reason ?? "").trim() || "needs user input";
          this.options.goals()?.setStatus("paused", { reason });
          ctx.ui.notify("◎ Goal blocked · " + reason, "warning");
          this.options.changed?.(ctx);
          return { content: [{ type: "text", text: "Goal paused for the user: " + reason }], details: { action: "block", ok: true }, terminate: true };
        }
        const text = goal ? [`Goal: ${goal.text}`, `Status: ${goal.status} · phase ${goal.phase} · round ${goal.rounds}/${this.maxRounds()}`, taskLines(this.tasks())].join("\n") : "No goal is set.";
        return { content: [{ type: "text", text }], details: { action: "get", ok: !!goal } };
      },
      renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("goal")) + " " + theme.fg("accent", String(args.action)), 0, 0); },
      renderResult(result, _options, theme) {
        const details = result.details as { action?: string; ok?: boolean } | undefined;
        const label = details?.action === "complete" ? (details.ok ? "◎ goal complete" : "not complete yet") : details?.action === "block" ? "goal paused for you" : progress() ?? "no goal";
        return new Text(theme.fg(details?.ok === false ? "warning" : "success", label), 0, 0);
      }
    });

    this.pi.registerCommand("goal", {
      description: "Goal mode: /goal <outcome> starts an implement → audit loop; /goal pause|resume|clear|status",
      handler: async (args, ctx) => {
        const store = this.options.goals();
        if (!store) { ctx.ui.notify("Goal state is unavailable before the session starts", "warning"); return; }
        const raw = args.trim();
        const verb = raw.toLowerCase();
        if (/^(?:clear|off|none|drop)$/.test(verb)) {
          await this.restore();
          if (store.clear()) { this.options.changed?.(ctx); ctx.ui.notify("Goal cleared", "info"); }
          return;
        }
        if (verb === "pause") { this.pause(ctx, "paused by you"); return; }
        if (verb === "resume") {
          const goal = store.current();
          if (!goal || goal.status !== "paused") { ctx.ui.notify(goal ? "Goal is " + goal.status : "No goal to resume", "info"); return; }
          if (this.options.planActive()) { ctx.ui.notify("Leave plan mode before resuming the goal", "warning"); return; }
          store.setStatus("active");
          store.setRound(0, goal.phase);
          this.options.changed?.(ctx);
          this.pi.sendUserMessage("Resume work on the active goal: " + goal.text, { deliverAs: "followUp" });
          return;
        }
        if (!raw || verb === "status") {
          if (!raw && !store.text() && ctx.hasUI && ctx.mode === "tui") {
            const edited = (await ctx.ui.editor("◎ New goal", ""))?.trim();
            if (edited) await this.start(ctx, edited);
            return;
          }
          ctx.ui.notify(this.progress() ? "◎ " + this.progress() : "No goal. Use /goal <outcome>.", "info");
          return;
        }
        await this.start(ctx, raw);
      }
    });

    this.pi.on("ui_prompt_start", () => { this.prompting++; });
    this.pi.on("ui_prompt_end", () => { this.prompting = Math.max(0, this.prompting - 1); });

    // A real user message starts a fresh budget of automatic rounds.
    this.pi.on("input", (event) => {
      if (event.source !== "interactive") return;
      const store = this.options.goals();
      const goal = store?.current();
      if (goal?.status === "active") store!.setRound(0, goal.phase);
    });

    this.pi.on("tool_call", async (event) => {
      const goal = this.goal();
      if (!goal || goal.status !== "active" || this.options.planActive()) return;
      const open = this.tasks().filter((item) => !item.done).length;
      if (open) return;
      const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
      const unsafeCommand = !(typeof input.command === "string" && isSafePlanCommand(input.command));
      const mutating = WRITE_TOOLS.has(event.toolName)
        || (goal.phase === "implement" && event.toolName === "bash" && unsafeCommand)
        || (goal.phase === "implement" && event.toolName === "jar_shell" && input.action === "start" && unsafeCommand)
        || (event.toolName === "jar_delegate" && input.write === true);
      if (!mutating) return;
      return { block: true, reason: goal.phase === "audit"
        ? "Goal audit: do not edit during the audit. Add jar_todo tasks for the gaps you found instead."
        : "Goal active: create jar_todo tasks for the goal first; changes are blocked while no task is open." };
    });

    this.pi.on("before_agent_start", async () => {
      const goal = this.goal();
      if (!goal || goal.status === "complete") return;
      return { message: { customType: CONTEXT_TYPE, content: this.context(goal), display: false } };
    });

    // Keep only the newest goal context and continuation so repeated rounds do not bloat the prompt.
    this.pi.on("context", async (event) => {
      const goal = this.goal();
      const seen = new Set<string>();
      const messages = [...event.messages].reverse().filter((raw) => {
        const type = (raw as { customType?: string }).customType;
        if (type !== CONTEXT_TYPE && type !== CONTINUATION_TYPE) return true;
        if (!goal || goal.status === "complete" || seen.has(type)) return false;
        seen.add(type);
        return true;
      }).reverse();
      return { messages };
    });

    this.pi.on("agent_before_settle", async (event, ctx) => {
      const store = this.options.goals();
      const goal = store?.current();
      if (!store || !goal || goal.status !== "active" || this.options.planActive() || event.continue) return;
      if (event.outcome !== "completed") {
        await this.restore();
        this.pause(ctx, event.outcome === "aborted" ? "interrupted" : "turn failed");
        return;
      }
      if (this.prompting) return;
      if (goal.rounds >= this.maxRounds()) {
        await this.restore();
        this.pause(ctx, `reached ${this.maxRounds()} automatic rounds`);
        return;
      }
      const tasks = this.tasks();
      const audit = tasks.length > 0 && tasks.every((item) => item.done);
      const round = goal.rounds + 1;
      store.setRound(round, audit ? "audit" : "implement");
      if (audit && !this.restoreRole) this.restoreRole = await this.options.roles.activateTemporary("advisor", ctx);
      if (!audit) await this.restore();
      this.options.changed?.(ctx);
      return {
        entries: [{ type: "custom_message", customType: CONTINUATION_TYPE, display: false,
          content: audit ? this.auditMessage(goal, round) : this.implementMessage(goal, round) }],
        continue: true
      };
    });

    this.pi.on("agent_settled", async (_event, ctx) => {
      if (!this.restoreRole) return;
      await this.restore();
      this.options.changed?.(ctx);
    });

    this.pi.on("session_shutdown", async () => { await this.restore(); });
  }
}
