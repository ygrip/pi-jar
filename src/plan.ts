import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { type ModelRoleManager } from "./model-roles.ts";
import { extractPlanSteps, isSafePlanCommand, planTextFromSteps } from "./plan-utils.ts";
import { cleanText } from "./status.ts";
import { type TodoStore } from "./tasks.ts";

export const PLAN_ENTRY = "pi-jar.plan";
type PlanAction = "implement" | "compact" | "stop";
type PlanState = { v: 1; enabled: boolean; steps: string[]; text?: string };

// Only tools with known read-only semantics are allowed. Name suffixes (for example
// "remote_get") do not prove that an extension or MCP tool is safe to invoke.
export const PLAN_SAFE_TOOLS = new Set(["read", "bash", "grep", "find", "ls", "jar_ask"]);

function safePlanText(value: string): string {
  return value.slice(0, 20000)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b./g, "")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "")
    .trim();
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const value = message as Record<string, unknown>;
  if (value.role !== "assistant") return "";
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return "";
  return value.content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const item = block as Record<string, unknown>;
    return item.type === "text" && typeof item.text === "string" ? item.text : "";
  }).filter(Boolean).join("\n");
}

async function planReview(ctx: ExtensionContext, steps: readonly string[], text: string): Promise<PlanAction | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") return undefined;
  const actions: { value: PlanAction; label: string; description: string; icon: string }[] = [
    { value: "implement", label: "Implement now", description: "Keep the current context and start execution.", icon: "▶" },
    { value: "compact", label: "Compact, then implement", description: "Preserve the approved plan, compact context, then execute.", icon: "◇" },
    { value: "stop", label: "Stop here", description: "Leave plan mode without making changes.", icon: "■" }
  ];
  return ctx.ui.custom<PlanAction | undefined>((tui, theme, _keys, done) => {
    let selected = 0;
    let scroll = 0;
    let actionRows: number[] = [];
    return {
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, Key.escape)) return done("stop");
        if (matchesKey(data, Key.up)) selected = (selected + actions.length - 1) % actions.length;
        else if (matchesKey(data, Key.down)) selected = (selected + 1) % actions.length;
        else if (matchesKey(data, Key.pageUp)) scroll = Math.max(0, scroll - 6);
        else if (matchesKey(data, Key.pageDown)) scroll += 6;
        else if (/^[1-3]$/.test(data)) return done(actions[Number(data) - 1]!.value);
        else if (matchesKey(data, Key.enter)) return done(actions[selected]!.value);
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === "wheel" && event.wheelDelta) {
          scroll = Math.max(0, scroll + Math.sign(event.wheelDelta) * 3);
          tui.requestRender(); return { handled: true };
        }
        if (event.type !== "click" || event.button !== "left") return;
        const index = actionRows.indexOf(event.y);
        if (index < 0) return;
        selected = index;
        done(actions[index]!.value);
        return { handled: true };
      },
      render(width: number): string[] {
        const fit = (text: string) => truncateToWidth(text, Math.max(0, width));
        const inner = Math.max(1, width - 5);
        const maxRows = Math.max(3, Math.min(16, (process.stdout.rows ?? 24) - 12));
        const content = text ? text.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(1, inner - 2)))
          : steps.flatMap((step, index) => wrapTextWithAnsi(`${index + 1}. ${step}`, Math.max(1, inner - 2)));
        scroll = Math.min(scroll, Math.max(0, content.length - maxRows));
        const lines = [
          fit(theme.fg("accent", "╭─ ◆ PLAN READY ─ [ READ ONLY ] ─")),
          fit(theme.fg("muted", "│ Review the plan before Pi gets write access.")),
          fit(theme.fg("dim", "├" + "─".repeat(Math.max(0, width - 1))))
        ];
        for (const row of content.slice(scroll, scroll + maxRows)) lines.push(fit(theme.fg("muted", "│ " + row)));
        if (content.length > maxRows) lines.push(fit(theme.fg("dim", `│  Plan lines ${scroll + 1}–${Math.min(content.length, scroll + maxRows)}/${content.length} · PgUp/PgDn scroll`)));
        lines.push(fit(theme.fg("dim", "├" + "─".repeat(Math.max(0, width - 1)))));
        actionRows = [];
        actions.forEach((action, index) => {
          actionRows.push(lines.length);
          const active = index === selected;
          lines.push(fit(theme.fg(active ? "accent" : "muted", "│ " + (active ? "❯ " : "  ") + String(index + 1) + ". [ " + action.icon + " " + action.label + " ]")));
          lines.push(fit(theme.fg("dim", "│      " + action.description)));
        });
        lines.push(fit(theme.fg("dim", "╰─ ↑↓ choose · PgUp/PgDn plan · 1-3 quick select · Enter confirm · Esc stop")));
        return lines;
      }
    };
  });
}

export class PlanMode {
  private enabled = false;
  private steps: string[] = [];
  private planText = "";
  private toolsBefore: string[] | undefined;
  private lastAssistant = "";
  private reviewing = false;
  private compacting = false;
  private compactGeneration = 0;
  private restoreRole: (() => Promise<void>) | undefined;
  private readonly pi: ExtensionAPI;
  private readonly todos: () => TodoStore | undefined;
  private readonly roles: ModelRoleManager;
  private readonly todosChanged: (ctx: ExtensionContext) => void;

  constructor(pi: ExtensionAPI, todos: () => TodoStore | undefined, roles: ModelRoleManager, todosChanged: (ctx: ExtensionContext) => void) {
    this.pi = pi;
    this.todos = todos;
    this.roles = roles;
    this.todosChanged = todosChanged;
  }

  isEnabled(): boolean { return this.enabled; }
  latestSteps(): string[] { return [...this.steps]; }

  private persist(): void {
    this.pi.appendEntry(PLAN_ENTRY, { v: 1, enabled: this.enabled, steps: this.steps, text: this.planText } satisfies PlanState);
  }

  private updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus("pi-jar.plan", this.enabled ? ctx.ui.theme.fg("warning", "◆ PLAN · read-only") : undefined);
  }

  private planTools(active: string[]): string[] {
    const available = new Set(this.pi.getAllTools().map((tool) => tool.name));
    return [...new Set(active.filter((name) => available.has(name) && PLAN_SAFE_TOOLS.has(name)))];
  }

  private async enter(ctx: ExtensionContext, persist = true): Promise<void> {
    if (this.enabled) return;
    this.enabled = true;
    this.lastAssistant = "";
    this.toolsBefore = this.pi.getActiveTools();
    this.pi.setActiveTools(this.planTools(this.toolsBefore));
    this.restoreRole = await this.roles.activateTemporary("plan", ctx);
    this.updateStatus(ctx);
    if (persist) this.persist();
    ctx.ui.notify("Plan mode · read-only tools only. Build the plan, then choose how to continue.", "info");
  }

  private async leave(ctx: ExtensionContext, persist = true): Promise<void> {
    this.enabled = false;
    this.compacting = false;
    this.compactGeneration++;
    if (this.toolsBefore) this.pi.setActiveTools(this.toolsBefore);
    this.toolsBefore = undefined;
    if (this.restoreRole) await this.restoreRole();
    this.restoreRole = undefined;
    this.updateStatus(ctx);
    if (persist) this.persist();
  }

  private seedTodos(ctx: ExtensionContext): void {
    const store = this.todos();
    if (!store) return;
    const existing = new Set(store.all().map((item) => item.title.trim().toLowerCase()));
    let changed = false;
    for (const step of this.steps) {
      const key = step.trim().toLowerCase();
      if (!key || existing.has(key)) continue;
      if (store.add(step, "Approved /plan step")) { existing.add(key); changed = true; }
    }
    if (changed) this.todosChanged(ctx);
  }

  private executeMessage(): string {
    return [
      "Implement the approved plan now.",
      "Keep jar_todo synchronized as each step is completed.",
      "Approved plan:",
      this.planText || planTextFromSteps(this.steps)
    ].join("\n\n");
  }

  private async implement(ctx: ExtensionContext): Promise<void> {
    this.seedTodos(ctx);
    await this.leave(ctx);
    this.pi.sendUserMessage(this.executeMessage(), { deliverAs: "followUp" });
  }

  private compactThenImplement(ctx: ExtensionContext): void {
    this.compacting = true;
    const generation = ++this.compactGeneration;
    const plan = this.planText || planTextFromSteps(this.steps);
    ctx.ui.notify("Compacting context while preserving the approved plan…", "info");
    ctx.compact({
      customInstructions: "Preserve this approved implementation plan exactly enough to execute it after compaction:\n" + plan,
      onComplete: () => {
        if (!this.enabled || generation !== this.compactGeneration) return;
        this.compacting = false;
        ctx.ui.notify("Context compacted · starting approved plan", "info");
        void this.implement(ctx);
      },
      onError: (error) => {
        if (generation !== this.compactGeneration) return;
        this.compacting = false;
        ctx.ui.notify("Compaction failed; plan mode is still active: " + error.message, "error");
      }
    });
  }

  private async review(ctx: ExtensionContext): Promise<void> {
    if (this.reviewing || this.compacting || !this.enabled || !this.steps.length) return;
    this.reviewing = true;
    try {
      const action = await planReview(ctx, this.steps, this.planText);
      if (action === "implement") await this.implement(ctx);
      else if (action === "compact") this.compactThenImplement(ctx);
      else if (action === "stop") {
        await this.leave(ctx);
        ctx.ui.notify("Plan stopped · no implementation started", "info");
      }
    } finally {
      this.reviewing = false;
    }
  }

  private async restore(branch: readonly unknown[], ctx: ExtensionContext): Promise<void> {
    let state: PlanState | undefined;
    for (const raw of branch) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      if (entry.type !== "custom" || entry.customType !== PLAN_ENTRY || !entry.data || typeof entry.data !== "object") continue;
      const data = entry.data as Record<string, unknown>;
      if (data.v !== 1 || typeof data.enabled !== "boolean" || !Array.isArray(data.steps)) continue;
      state = { v: 1, enabled: data.enabled, steps: data.steps.filter((item): item is string => typeof item === "string").map((item) => cleanText(item, 240)).filter(Boolean).slice(0, 50), text: typeof data.text === "string" ? safePlanText(data.text) : "" };
    }
    if (this.enabled) await this.leave(ctx, false);
    this.steps = state?.steps ?? [];
    this.planText = state?.text ?? "";
    if (state?.enabled) await this.enter(ctx, false);
    else this.updateStatus(ctx);
  }

  register(): void {
    this.pi.registerCommand("plan", {
      description: "Enter first-class read-only planning mode and review/implement the resulting plan",
      handler: async (args, ctx) => {
        const text = args.trim();
        if (/^(?:off|stop|exit)$/i.test(text)) {
          await this.leave(ctx);
          ctx.ui.notify("Plan mode off", "info");
          return;
        }
        const wasEnabled = this.enabled;
        if (!this.enabled) await this.enter(ctx);
        if (text) {
          this.pi.sendUserMessage(text, { deliverAs: "followUp" });
          return;
        }
        if (wasEnabled && this.steps.length) await this.review(ctx);
      }
    });

    this.pi.on("tool_call", async (event) => {
      if (!this.enabled) return;
      if (event.toolName === "bash") {
        if (!this.pi.getActiveTools().includes("bash")) return { block: true, reason: "Plan mode is read-only: bash is not active." };
        const command = event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>).command : undefined;
        if (typeof command !== "string" || !isSafePlanCommand(command)) {
          return { block: true, reason: "Plan mode is read-only: this shell command is not on the read-only allowlist." };
        }
        return;
      }
      if (!PLAN_SAFE_TOOLS.has(event.toolName) || !this.pi.getActiveTools().includes(event.toolName)) return { block: true, reason: "Plan mode is read-only: tool " + event.toolName + " is disabled until the plan is approved." };
    });

    this.pi.on("before_agent_start", async () => {
      if (!this.enabled) return;
      return {
        message: {
          customType: "pi-jar.plan-context",
          content: [
            "[PI-JAR PLAN MODE · READ ONLY]",
            "Explore and reason without modifying files, repositories, remote services, or external state.",
            "Use jar_ask for structured clarifying questions when a choice is required.",
            "Finish with a concrete numbered implementation plan under exactly this header:",
            "Plan:",
            "1. First actionable outcome",
            "2. Second actionable outcome",
            "Do not implement the plan until the user chooses an implementation action in the plan review UI."
          ].join("\n"),
          display: false
        }
      };
    });

    this.pi.on("context", async (event) => {
      if (this.enabled) return;
      return { messages: event.messages.filter((raw) => {
        const message = raw as { customType?: string };
        return message.customType !== "pi-jar.plan-context";
      }) };
    });

    this.pi.on("message_end", (event) => {
      if (!this.enabled) return;
      const text = assistantText(event.message);
      if (text) this.lastAssistant = text;
    });

    this.pi.on("agent_end", async (_event, ctx) => {
      if (!this.enabled || !this.lastAssistant) return;
      const draft = this.lastAssistant;
      const next = extractPlanSteps(draft);
      this.lastAssistant = "";
      if (!next.length) {
        ctx.ui.notify("No numbered plan found. Add a Plan: section with numbered steps, or use /plan off.", "warning");
        return;
      }
      this.steps = next;
      this.planText = safePlanText(draft);
      this.persist();
      // agent_end may still be processing when approval finishes; implement() queues a follow-up.
      await this.review(ctx);
    });

    this.pi.on("session_start", async (_event, ctx) => {
      await this.restore(ctx.sessionManager.getBranch(), ctx);
    });
    this.pi.on("session_tree", async (_event, ctx) => {
      await this.restore(ctx.sessionManager.getBranch(), ctx);
    });
    this.pi.on("session_shutdown", async (_event, ctx) => {
      if (this.enabled) await this.leave(ctx, false);
    });
  }
}
