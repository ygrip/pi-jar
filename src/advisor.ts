import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ModelRoleManager } from "./model-roles.ts";
import { askRole, type SideUsage } from "./side-model.ts";
import { ROLE_PREFIX } from "./status.ts";

export const ADVISOR_TOOL = "jar_advisor";
export const ADVISOR_MESSAGE = "pi-jar.advisor";
const TRANSCRIPT_LIMIT = 24_000;
const GIT_LIMIT = 4_000;
/** Identical tool calls (same tool and input) within the recent window that count as a loop. */
export const LOOP_REPEATS = 3;
/** Consecutive failing tool results that count as stuck. */
export const FAILURE_STREAK = 3;
/** Automatic consultations allowed per user prompt. */
export const GATES_PER_PROMPT = 2;
const WINDOW = 8;

export const ADVISOR_SYSTEM = [
  "You are the advisor: a senior engineer giving a second opinion to a coding agent (the executor) mid-task.",
  "You see a transcript excerpt and the repository state; you cannot run tools.",
  "Be direct and specific. Lead with your verdict (proceed / revise / stop and ask the user), then the reasons,",
  "then concrete next steps. Point out wrong assumptions, missed edge cases, simpler approaches and risks.",
  "Keep it under 250 words. Do not restate the transcript."
].join("\n");

type Entry = { type: string; message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean; customType?: string } };

const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part: { type?: string; text?: string; name?: string; arguments?: unknown }) =>
    part.type === "text" ? part.text ?? "" : part.type === "toolCall" ? `[tool ${part.name} ${JSON.stringify(part.arguments ?? {}).slice(0, 300)}]` : "").filter(Boolean).join("\n")
    : "";

/** The most recent conversation, newest last, capped to `limit` characters. */
export function transcript(entries: readonly Entry[], limit = TRANSCRIPT_LIMIT): string {
  const parts: string[] = [];
  let size = 0;
  for (let index = entries.length - 1; index >= 0 && size < limit; index--) {
    const message = entries[index]!.type === "message" ? entries[index]!.message : undefined;
    if (!message?.role) continue;
    let body = textOf(message.content).trim();
    if (!body) continue;
    if (message.role === "toolResult" && body.length > 1200) body = body.slice(0, 1200) + " …";
    const label = message.role === "toolResult" ? `tool result (${message.toolName ?? "?"}${message.isError ? ", error" : ""})` : message.role;
    const part = `### ${label}\n${body}`;
    parts.unshift(part.slice(0, limit - size));
    size += part.length;
  }
  return parts.join("\n\n");
}

export interface AdvisorRequest { question?: string; draft?: string; trigger?: string }

export function advisorPrompt(request: AdvisorRequest, conversation: string, git: string): string {
  return [
    request.trigger ? `Automatic consultation: ${request.trigger}` : "",
    request.question ? `Executor's question: ${request.question}` : "Executor asks for a general review of its current direction.",
    request.draft ? `Executor's draft / candidate approach:\n${request.draft}` : "",
    git ? `Repository state:\n${git}` : "",
    `Recent conversation:\n${conversation || "(empty)"}`
  ].filter(Boolean).join("\n\n");
}

/** Stable key for loop detection. */
export const callKey = (tool: string, input: unknown) => tool + " " + JSON.stringify(input ?? {});

/** Tracks repeated calls and failure streaks within one user prompt. */
export class StuckDetector {
  private recent: string[] = [];
  private failures = 0;
  private gates = 0;
  reset(): void { this.recent = []; this.failures = 0; this.gates = 0; }
  /** Returns a trigger description when this call completes a loop. */
  call(key: string): string | undefined {
    this.recent.push(key);
    if (this.recent.length > WINDOW) this.recent.shift();
    const count = this.recent.filter((item) => item === key).length;
    if (count < LOOP_REPEATS || !this.take()) return undefined;
    this.recent = [];
    return `the executor has made the same tool call ${count} times: ${key.slice(0, 200)}`;
  }
  /** Returns a trigger description when a failure streak is reached. */
  result(isError: boolean, tool: string): string | undefined {
    this.failures = isError ? this.failures + 1 : 0;
    if (this.failures < FAILURE_STREAK || !this.take()) return undefined;
    this.failures = 0;
    return `${FAILURE_STREAK} tool calls in a row failed (last: ${tool})`;
  }
  private take(): boolean { if (this.gates >= GATES_PER_PROMPT) return false; this.gates++; return true; }
}

export interface AdvisorOptions { enabled: () => boolean; gates: () => boolean; usage: SideUsage }

/** First-class advisor: the jar_advisor tool, /advisor, and automatic gates for loops and failure streaks. */
export function registerAdvisor(pi: ExtensionAPI, roles: ModelRoleManager, options: AdvisorOptions) {
  const stuck = new StuckDetector();
  let busy = 0;

  const status = (ctx: ExtensionContext, task?: string) => {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setStatus(ROLE_PREFIX + "advisor", task ? JSON.stringify({ name: "Advisor", label: "advisor", state: "working", task, expiresAt: Date.now() + 30_000 }) : undefined);
    } catch { /* status is decoration */ }
  };

  const gitState = async (ctx: ExtensionContext): Promise<string> => {
    try {
      const [st, stat] = await Promise.all([
        pi.exec("git", ["status", "--short", "--branch"], { cwd: ctx.cwd, timeout: 5_000 }),
        pi.exec("git", ["diff", "--stat", "HEAD"], { cwd: ctx.cwd, timeout: 5_000 })
      ]);
      if (st.code !== 0) return "";
      return (st.stdout.trim() + (stat.code === 0 && stat.stdout.trim() ? "\n" + stat.stdout.trim() : "")).slice(0, GIT_LIMIT);
    } catch { return ""; } // repository state is optional context; not a git repo or git missing
  };

  const consult = async (ctx: ExtensionContext, request: AdvisorRequest, signal?: AbortSignal) => {
    busy++;
    status(ctx, request.trigger ?? request.question ?? "reviewing the current direction");
    try {
      const conversation = transcript(ctx.sessionManager.getBranch() as readonly Entry[]);
      return await askRole(ctx, roles, options.usage, "advisor", ADVISOR_SYSTEM, advisorPrompt(request, conversation, await gitState(ctx)), signal);
    } finally { if (--busy === 0) status(ctx); }
  };

  const Parameters = Type.Object({
    question: Type.Optional(Type.String({ description: "A focused question or decision for the advisor" })),
    draft: Type.Optional(Type.String({ description: "Your candidate plan, answer or fix for the advisor to critique" }))
  });

  if (typeof (pi as ExtensionAPI & { registerTool?: unknown }).registerTool === "function") pi.registerTool({
    name: ADVISOR_TOOL,
    label: "advisor",
    description: "Ask the advisor (a stronger reviewer model with a fresh view of this conversation and the repo state) for a second opinion. Returns its advice.",
    promptSnippet: "Use jar_advisor for a second opinion on consequential decisions, when stuck, or before declaring hard work done.",
    promptGuidelines: [
      "Call jar_advisor before committing to a risky or hard-to-reverse approach, after two failed attempts at the same problem, and before declaring a complex task complete.",
      "Form your own candidate first and pass it as draft; ask a specific question. Do not call it for routine steps."
    ],
    parameters: Parameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!options.enabled()) throw new Error("the advisor is turned off in /jar settings");
      const answer = await consult(ctx, { ...(params.question ? { question: params.question } : {}), ...(params.draft ? { draft: params.draft } : {}) }, signal);
      return { content: [{ type: "text", text: answer.text }], details: { model: answer.model } };
    }
  });

  const deliver = (ctx: ExtensionContext, heading: string, text: string) => {
    pi.sendMessage({ customType: ADVISOR_MESSAGE, content: `${heading}\n\n${text}`, display: true },
      ctx.isIdle() ? { deliverAs: "nextTurn" } : { deliverAs: "steer" });
  };

  pi.registerCommand("advisor", {
    description: "Ask the advisor for a second opinion on the current work: /advisor [focus]",
    handler: async (args, ctx) => {
      if (!options.enabled()) { ctx.ui.notify("The advisor is off; turn it on in /jar settings → Pi", "warning"); return; }
      const focus = args.trim();
      ctx.ui.notify("Consulting the advisor…", "info");
      try {
        const answer = await consult(ctx, focus ? { question: focus } : {});
        deliver(ctx, `◆ Advisor · ${answer.model}${focus ? " · " + focus : ""}`, answer.text);
      } catch (error) { ctx.ui.notify("Advisor failed: " + (error instanceof Error ? error.message : String(error)), "error"); }
    }
  });

  pi.on("input", (event) => { if (event.source === "interactive") stuck.reset(); });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === ADVISOR_TOOL || !options.enabled() || !options.gates()) return;
    const trigger = stuck.call(callKey(event.toolName, event.input));
    if (!trigger) return;
    try {
      const answer = await consult(ctx, { trigger }, ctx.signal);
      return { block: true, reason: `Loop detected: ${trigger}. The advisor (${answer.model}) reviewed the situation:\n\n${answer.text}` };
    } catch (error) {
      ctx.ui.notify("Advisor gate failed: " + (error instanceof Error ? error.message : String(error)), "warning");
      return undefined;
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === ADVISOR_TOOL || !options.enabled() || !options.gates()) return;
    const trigger = stuck.result(event.isError, event.toolName);
    if (!trigger) return;
    try {
      const answer = await consult(ctx, { trigger }, ctx.signal);
      deliver(ctx, `◆ Advisor · ${answer.model} · ${trigger}`, answer.text);
    } catch (error) {
      ctx.ui.notify("Advisor gate failed: " + (error instanceof Error ? error.message : String(error)), "warning");
    }
  });

  return { consult, stuck };
}
