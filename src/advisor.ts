import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ModelRoleManager } from "./model-roles.ts";
import { askRole, type SideUsage } from "./side-model.ts";
import { ROLE_PREFIX } from "./status.ts";
import { sessionBranch } from "./session-branch.ts";
import { runProcess } from "./async-process.ts";

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
/** Serialized inputs up to this length stay verbatim in a loop key; longer ones keep a prefix and a digest. */
const KEY_INPUT_CHARS = 1024;

export const ADVISOR_SYSTEM = [
  "You are the advisor: a senior engineer giving a second opinion to a coding agent (the executor) mid-task.",
  "You see a transcript excerpt and the repository state; you cannot run tools.",
  "Be direct and specific. Lead with your verdict (proceed / revise / stop and ask the user), then the reasons,",
  "then concrete next steps. Point out wrong assumptions, missed edge cases, simpler approaches and risks.",
  "Keep it under 250 words. Do not restate the transcript."
].join("\n");

type Entry = { type: string; message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean; customType?: string } };

const toolHint = (args: unknown): string => {
  if (!args || typeof args !== "object") return "";
  const object = args as Record<string, unknown>;
  const keys = ["command", "path", "file_path", "query", "id"];
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value) return `${key}=${value.slice(0, 240)}`;
  }
  return "";
};

const textOf = (content: unknown, limit = 4_000): string => {
  if (typeof content === "string") return content.slice(0, limit);
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content as Array<{ type?: string; text?: string; name?: string; arguments?: unknown }>) {
    const piece = part.type === "text" ? part.text ?? ""
      : part.type === "toolCall" ? `[tool ${part.name ?? "?"}${toolHint(part.arguments) ? " " + toolHint(part.arguments) : ""}]` : "";
    if (!piece) continue;
    const separator = out ? "\n" : "";
    const room = limit - out.length - separator.length;
    if (room <= 0) break;
    out += separator + piece.slice(0, room);
    if (piece.length > room) break;
  }
  return out;
};

/** The most recent conversation, newest last, capped to `limit` characters. */
export function transcript(entries: readonly Entry[], limit = TRANSCRIPT_LIMIT): string {
  const parts: string[] = [];
  let size = 0;
  for (let index = entries.length - 1; index >= 0 && size < limit; index--) {
    const message = entries[index]!.type === "message" ? entries[index]!.message : undefined;
    if (!message?.role) continue;
    let body = textOf(message.content, Math.min(4_000, limit - size)).trim();
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

/** Stable key for loop detection. A `write` of a large file must not pin its whole content in the recent window. */
export function callKey(tool: string, input: unknown): string {
  const json = String(JSON.stringify(input ?? {}));
  return tool + " " + (json.length <= KEY_INPUT_CHARS ? json : json.slice(0, 200) + "…#" + createHash("sha1").update(json).digest("hex"));
}

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

export interface AdvisorOptions {
  enabled: () => boolean;
  gates: () => boolean;
  usage: SideUsage;
  /** Injectable subprocess boundary for hosts/tests; defaults to bounded asynchronous execution. */
  processRunner?: typeof runProcess;
}

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

  const gitState = async (ctx: ExtensionContext, signal?: AbortSignal): Promise<string> => {
    const git = (args: string[]) => (options.processRunner ?? runProcess)(process.env.PI_JAR_GIT_PATH?.trim() || "git", args, {
      cwd: ctx.cwd, signal, timeoutMs: 5_000, maxOutputBytes: GIT_LIMIT
    }).then(output => output.toString("utf8"));
    try {
      const [status, diff] = await Promise.all([
        git(["status", "--short", "--branch"]),
        git(["diff", "--stat", "HEAD"])
      ]);
      return (status.trim() + (diff.trim() ? "\n" + diff.trim() : "")).slice(0, GIT_LIMIT);
    } catch { return ""; } // repository state is optional context; not a git repo or git missing
  };

  const consult = async (ctx: ExtensionContext, request: AdvisorRequest, signal?: AbortSignal) => {
    busy++;
    status(ctx, request.trigger ?? request.question ?? "reviewing the current direction");
    try {
      const conversation = transcript(sessionBranch(ctx) as readonly Entry[]);
      return await askRole(ctx, roles, options.usage, "advisor", ADVISOR_SYSTEM, advisorPrompt(request, conversation, await gitState(ctx, signal)), signal);
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
        const answer = await consult(ctx, focus ? { question: focus } : {}, ctx.signal);
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
