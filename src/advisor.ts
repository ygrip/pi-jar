import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ModelRoleManager } from "./model-roles.ts";
import { askRole, type SideUsage, type SideCall } from "./side-model.ts";
import { ROLE_PREFIX, cleanText } from "./status.ts";
import { sessionBranch } from "./session-branch.ts";
import { runProcess } from "./async-process.ts";

export const ADVISOR_TOOL = "jar_advisor";
export const ADVISOR_MESSAGE = "pi-jar.advisor";
const TRANSCRIPT_LIMIT = 24_000;
const GIT_LIMIT = 4_000;
/** Identical tool calls (same tool and input) within the recent window that count as a loop. */
export const LOOP_REPEATS = 4;
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

/** Shell status polls that legitimately repeat with identical input. */
const POLL_ACTIONS: Record<string, true> = { output: true, wait: true, peek: true };
/** Test runners: rerunning the same suite between edits is the normal fix loop, not a stuck one. */
const TEST_COMMAND = /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?|node\s+(?:\S+\s+)*--test|(?:npx\s+)?(?:pytest|vitest|jest|mocha|phpunit|rspec|playwright\s+test)|(?:go|cargo|dotnet|deno|swift|mix)\s+test|python3?\s+-m\s+(?:pytest|unittest)|(?:\.\/)?(?:gradlew|gradle|mvnw|mvn)\s+(?:\S+\s+)*test|make\s+(?:\S+\s+)*test)(?=$|[\s;&|)])/;
/**
 * Calls that repeat identically during normal work never count toward a loop: re-reads, shell
 * output/wait/peek polls and test reruns. They still count toward failure streaks.
 */
export function loopExempt(tool: string, input: unknown): boolean {
  if (tool === "read") return true;
  const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (tool === "jar_shell" && typeof fields.action === "string" && Object.hasOwn(POLL_ACTIONS, fields.action)) return true;
  return (tool === "bash" || (tool === "jar_shell" && fields.action === "start"))
    && typeof fields.command === "string" && TEST_COMMAND.test(fields.command);
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
  /** Total context/provider deadline, including models that ignore cancellation. */
  timeoutMs?: number;
}

export interface AdvisorJob {
  id: string;
  state: "running" | "completed" | "failed" | "cancelled";
  question: string;
  startedAt: number;
  endedAt?: number;
  model?: string;
  text?: string;
  error?: string;
}
const MAX_ADVISOR_RUNNING = 2;
const MAX_ADVISOR_HISTORY = 16;
const ANSWER_LIMIT = 8_000;
const boundedRequest = (request: AdvisorRequest): AdvisorRequest => ({
  ...(request.question ? { question: request.question.slice(0, 2_000) } : {}),
  ...(request.draft ? { draft: request.draft.slice(0, 8_000) } : {}),
  ...(request.trigger ? { trigger: request.trigger.slice(0, 300) } : {})
});

/** Detached advisor requests: the main agent never waits on a provider unless it explicitly asks to wait. */
export function registerAdvisor(pi: ExtensionAPI, roles: ModelRoleManager, options: AdvisorOptions) {
  const stuck = new StuckDetector();
  const timeoutMs = Math.max(1, Math.min(120_000, options.timeoutMs ?? 60_000));
  type Record = AdvisorJob & { controller: AbortController; generation: number; acknowledged: boolean; delivered: boolean; finished: Promise<void> };
  const jobs = new Map<string, Record>();
  const consultations = new Set<symbol>();
  const consultationControllers = new Set<AbortController>();
  let sequence = 0, generation = 0, active = false, interrupted = false;
  let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
  let deliveryContext: ExtensionContext | undefined;
  const idle = () => { try { return deliveryContext?.isIdle() === true; } catch { return false; } };

  const status = (ctx: ExtensionContext, task?: string) => {
    if (!ctx.hasUI) return;
    try { ctx.ui.setStatus(ROLE_PREFIX + "advisor", task ? JSON.stringify({ name: "Advisor", label: "advisor", state: "working", task: cleanText(task, 160), expiresAt: Date.now() + timeoutMs + 1_000 }) : undefined); }
    catch { /* decoration must never fail a request */ }
  };
  const toast = (ctx: ExtensionContext, text: string, failed = false) => {
    if (!ctx.hasUI) return;
    try { ctx.ui.notify(text, failed ? "warning" : "info"); } catch { /* non-blocking decoration */ }
  };
  const snapshot = (job: Record): AdvisorJob => ({ id: job.id, state: job.state, question: job.question, startedAt: job.startedAt,
    ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}), ...(job.model ? { model: job.model } : {}),
    ...(job.text ? { text: job.text } : {}), ...(job.error ? { error: job.error } : {}) });
  const get = (id: string): AdvisorJob | undefined => { const job = jobs.get(id); return job && snapshot(job); };
  const pending = () => [...jobs.values()].filter(job => job.state !== "running" && !job.acknowledged && !job.delivered);
  const resultText = (job: AdvisorJob) => job.state === "completed"
    ? `◆ Advisor ${job.id} · ${job.model} · ${job.question}\n\n${job.text}`
    : `Advisor ${job.id} · ${job.state}${job.error ? ": " + job.error : ""}`;
  const message = (items: Record[]) => ({ type: "custom_message" as const, customType: ADVISOR_MESSAGE, display: true,
    content: items.map(resultText).join("\n\n"), details: { ids: items.map(job => job.id), summary: `${items.length} advisor result(s)` } });
  const drain = () => {
    clearTimeout(deliveryTimer); deliveryTimer = undefined;
    const items = pending();
    if (!items.length) return undefined;
    for (const job of items) job.delivered = true;
    return message(items);
  };
  const notify = () => {
    if (active || interrupted || !idle() || deliveryTimer || !pending().length) return;
    const owner = generation;
    deliveryTimer = setTimeout(() => {
      deliveryTimer = undefined;
      if (owner !== generation || active || interrupted || !idle()) return;
      const items = pending();
      if (!items.length) return;
      const { type: _type, ...entry } = message(items);
      try { pi.sendMessage(entry, { triggerTurn: true, deliverAs: "nextTurn" }); for (const job of items) job.delivered = true; }
      catch { /* retain results for the next boundary or explicit get/wait */ }
    }, 30);
    deliveryTimer.unref?.();
  };
  const gitState = async (ctx: ExtensionContext, signal: AbortSignal): Promise<string> => {
    const git = (args: string[]) => (options.processRunner ?? runProcess)(process.env.PI_JAR_GIT_PATH?.trim() || "git", args, {
      cwd: ctx.cwd, signal, timeoutMs: 5_000, maxOutputBytes: GIT_LIMIT
    }).then(output => output.toString("utf8"));
    try {
      const [state, diff] = await Promise.all([git(["status", "--short", "--branch"]), git(["diff", "--stat", "HEAD"])]);
      return (state.trim() + (diff.trim() ? "\n" + diff.trim() : "")).slice(0, GIT_LIMIT);
    } catch { return ""; }
  };
  const consult = async (ctx: ExtensionContext, supplied: AdvisorRequest, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if ([...consultationControllers].filter(controller => !controller.signal.aborted).length >= MAX_ADVISOR_RUNNING) throw new Error("Advisor is busy; wait for or cancel an existing request");
    const owner = generation, token = Symbol(), controller = new AbortController();
    const request = boundedRequest(supplied);
    const forwardAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    consultationControllers.add(controller); consultations.add(token);
    status(ctx, request.trigger ?? request.question ?? "reviewing the current direction");
    const timer = setTimeout(() => controller.abort(new Error(`Advisor timed out after ${timeoutMs}ms`)), timeoutMs);
    let abortListener: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(controller.signal.reason ?? new Error("Advisor cancelled"));
        controller.signal.addEventListener("abort", abortListener, { once: true });
        if (controller.signal.aborted) abortListener();
      });
      const work = async () => {
        // Freeze model/alias choices before asynchronous Git preparation or later role edits.
        const primary = roles.resolve("advisor");
        const fallbacks = [...(roles.fallbackSpecs?.("advisor") ?? [])];
        const targets = new Map<string, () => ReturnType<ModelRoleManager["resolveSpec"]>>();
        for (const spec of fallbacks) {
          try { const target = roles.resolveSpec(spec); targets.set(spec, () => target); }
          catch (error) { targets.set(spec, () => { throw error; }); }
        }
        const selectedRoles = { resolve: () => primary, fallbackSpecs: () => fallbacks,
          resolveSpec: (spec: string) => targets.get(spec)!() } as unknown as ModelRoleManager;
        const selectedContext = { model: ctx.model, modelRegistry: ctx.modelRegistry, ui: ctx.ui } as ExtensionContext;
        const conversation = transcript(sessionBranch(ctx) as readonly Entry[], 12_000);
        const git = await gitState(ctx, controller.signal);
        controller.signal.throwIfAborted();
        const usage = options.usage;
        const requestUsage = usage && { add: (call: SideCall) => { if (owner === generation) usage.add(call); } };
        const answer = await askRole(selectedContext, selectedRoles, requestUsage, "advisor", ADVISOR_SYSTEM, advisorPrompt(request, conversation, git), controller.signal);
        return { ...answer, model: answer.model.slice(0, 200), text: answer.text.slice(0, ANSWER_LIMIT) };
      };
      return await Promise.race([work(), aborted]);
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", forwardAbort);
      if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      consultationControllers.delete(controller); consultations.delete(token);
      if (owner === generation) status(ctx, consultations.size ? `${consultations.size} advisor request(s) running` : undefined);
    }
  };
  const cancel = (id: string): AdvisorJob | undefined => {
    const job = jobs.get(id);
    if (!job) return undefined;
    job.acknowledged = true;
    if (job.state === "running") { job.state = "cancelled"; job.endedAt = Date.now(); job.controller.abort(new Error("Advisor cancelled")); }
    return snapshot(job);
  };
  const start = (ctx: ExtensionContext, supplied: AdvisorRequest = {}, signal?: AbortSignal): AdvisorJob => {
    if (!options.enabled()) throw new Error("the advisor is turned off in /jar settings");
    signal?.throwIfAborted();
    if ([...jobs.values()].filter(job => job.state === "running").length >= MAX_ADVISOR_RUNNING) throw new Error("Advisor is busy; get, wait for, or cancel an existing request");
    for (const [id, job] of jobs) { if (jobs.size < MAX_ADVISOR_HISTORY) break; if (job.acknowledged || job.delivered) jobs.delete(id); }
    if (jobs.size >= MAX_ADVISOR_HISTORY) throw new Error("Collect pending advisor results before starting another request");
    const request = boundedRequest(supplied);
    const job: Record = { id: `a${++sequence}`, state: "running", question: cleanText(request.trigger ?? request.question ?? "general review", 200),
      startedAt: Date.now(), generation, controller: new AbortController(), acknowledged: false, delivered: false, finished: Promise.resolve() };
    jobs.set(job.id, job); deliveryContext = ctx;
    const abort = () => { cancel(job.id); };
    signal?.addEventListener("abort", abort, { once: true });
    job.finished = Promise.resolve().then(() => consult(ctx, request, job.controller.signal)).then(answer => {
      if (job.generation !== generation || job.state !== "running") return;
      job.state = "completed"; job.model = answer.model; job.text = answer.text;
    }, error => {
      if (job.generation !== generation || job.state !== "running") return;
      job.state = "failed"; job.error = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    }).then(() => {
      signal?.removeEventListener("abort", abort);
      if (job.generation !== generation) return;
      job.endedAt ??= Date.now();
      if (!job.acknowledged) { toast(ctx, `Advisor ${job.id} ${job.state}; result available`, job.state !== "completed"); notify(); }
    });
    return snapshot(job);
  };
  const observe = (id: string) => {
    const job = jobs.get(id);
    if (!job) throw new Error("Unknown advisor request: " + id);
    if (job.state !== "running") job.acknowledged = true;
    return snapshot(job);
  };
  const wait = async (id: string, milliseconds = 1_000, signal?: AbortSignal): Promise<AdvisorJob> => {
    const job = jobs.get(id);
    if (!job) throw new Error("Unknown advisor request: " + id);
    signal?.throwIfAborted();
    if (job.state !== "running") return observe(id);
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
      await Promise.race([job.finished, new Promise<void>((resolve, reject) => {
        timer = setTimeout(resolve, Math.max(0, Math.min(30_000, milliseconds)));
        abort = () => reject(signal?.reason ?? new Error("Wait cancelled"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      })]);
    } finally { clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
    if (jobs.get(id) !== job) return { ...snapshot(job), state: "cancelled", error: "Session changed" };
    return observe(id);
  };
  const reset = (_event?: unknown, ctx?: ExtensionContext) => {
    generation++; clearTimeout(deliveryTimer); deliveryTimer = undefined;
    for (const job of jobs.values()) { job.acknowledged = true; job.controller.abort(new Error("Session changed")); }
    for (const controller of consultationControllers) controller.abort(new Error("Session changed"));
    jobs.clear(); consultationControllers.clear(); consultations.clear(); stuck.reset(); active = false; interrupted = false; deliveryContext = ctx;
    if (ctx) status(ctx);
  };
  const Parameters = Type.Object({
    action: Type.Optional(Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("get"), Type.Literal("wait"), Type.Literal("cancel")])),
    id: Type.Optional(Type.String({ maxLength: 64, description: "Advisor request ID returned by start" })),
    waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000 })),
    question: Type.Optional(Type.String({ description: "Focused question (first 2,000 characters are used)" })),
    draft: Type.Optional(Type.String({ description: "Candidate approach (first 8,000 characters are used)" }))
  });
  if (typeof (pi as ExtensionAPI & { registerTool?: unknown }).registerTool === "function") pi.registerTool({
    name: ADVISOR_TOOL, label: "advisor",
    description: "Start a background second opinion and return its request ID immediately. Start is a pending receipt, not approval: continue useful work and collect the advice with get, or wait (bounded to 30 seconds) when no useful work remains, before the consequential decision. Completions also arrive at a safe agent boundary; they cannot interrupt an in-flight response. status/cancel manage requests.",
    promptSnippet: "Use jar_advisor only when the user asks or after two failed attempts at the same problem; pass your candidate approach as draft and collect the advice before deciding.",
    parameters: Parameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const action = params.action ?? "start";
      if (action === "status") {
        const items = params.id ? [get(params.id)] : [...jobs.values()].map(snapshot);
        if (items.some(job => !job)) throw new Error("Unknown advisor request: " + params.id);
        const summaries = items.map(job => { const { text: _text, error: _error, ...summary } = job!; return summary; });
        return { content: [{ type: "text", text: summaries.map(job => `${job.id} · ${job.state} · ${job.question}`).join("\n") || "No advisor requests" }], details: params.id ? summaries[0] : { jobs: summaries } };
      }
      const job = action === "start" ? start(ctx, { question: params.question, draft: params.draft }, signal)
        : action === "wait" ? await wait(params.id ?? "", params.waitMs, signal)
        : action === "cancel" ? cancel(params.id ?? "") : observe(params.id ?? "");
      if (!job) throw new Error("Unknown advisor request: " + (params.id ?? ""));
      const text = job.state === "running" ? `Advisor ${job.id} ${action === "start" ? "started" : "still running"} · running. Continue useful work; use get/wait with this ID to collect the review.` : resultText(job);
      return { content: [{ type: "text", text }], details: job };
    }
  });
  pi.registerCommand("advisor", {
    description: "Start a background second opinion: /advisor [focus]",
    handler: async (args, ctx) => {
      if (!options.enabled()) { ctx.ui.notify("The advisor is off; turn it on in /jar settings → Pi", "warning"); return; }
      try { const job = start(ctx, { question: args.trim() }, ctx.signal); toast(ctx, `Advisor ${job.id} started in the background`); }
      catch (error) { ctx.ui.notify("Advisor: " + (error instanceof Error ? error.message : String(error)), "warning"); }
    }
  });
  pi.on("session_start", reset); pi.on("session_shutdown", reset);
  pi.on("input", event => { if (event.source === "interactive") stuck.reset(); });
  pi.on("before_agent_start", () => { active = true; interrupted = false; const entry = drain(); if (entry) { const { type: _type, ...message } = entry; return { message }; } });
  pi.on("agent_start", () => { active = true; clearTimeout(deliveryTimer); deliveryTimer = undefined; });
  const boundary = (event: { outcome: string; context?: { canContinue?: boolean } }) => {
    if (event.outcome !== "completed" || event.context?.canContinue === false) return;
    const entry = drain(); if (entry) return { entries: [entry], continue: true };
  };
  pi.on("turn_end", boundary);
  pi.on("agent_before_settle", event => { interrupted = event.outcome !== "completed"; return boundary(event); });
  pi.on("agent_settled", (_event, ctx) => { active = false; if (ctx) deliveryContext = ctx; notify(); });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === ADVISOR_TOOL || !options.enabled() || !options.gates() || loopExempt(event.toolName, event.input)) return;
    const trigger = stuck.call(callKey(event.toolName, event.input)); if (!trigger) return;
    try { const job = start(ctx, { trigger }, ctx.signal); return { block: true, reason: `Loop detected: ${trigger}. Advisor ${job.id} is reviewing in the background. Change approach and collect its result with jar_advisor get/wait.` }; }
    catch (error) { toast(ctx, "Advisor gate: " + (error instanceof Error ? error.message : String(error)), true); }
  });
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName === ADVISOR_TOOL || !options.enabled() || !options.gates()) return;
    const trigger = stuck.result(event.isError, event.toolName); if (!trigger) return;
    try { start(ctx, { trigger }, ctx.signal); }
    catch (error) { toast(ctx, "Advisor gate: " + (error instanceof Error ? error.message : String(error)), true); }
  });
  return { consult, stuck, start, get, wait, cancel, isBusy: () => consultations.size > 0 || [...jobs.values()].some(job => job.state === "running"), dispose: reset };
}
