import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextBudget } from "./settings.ts";
import { cleanText } from "./status.ts";

/**
 * Context-budget guard. Pi compacts only near the window limit, so a long session re-sends a large,
 * growing prompt on every call. Past `softTokens` the guard either suggests /compact or /new once per
 * crossing, or compacts once at the next safe point:
 * - the end of a turn in which a jar_todo item completed while work remains. Every tool result of that
 *   turn is in, so the run stops there (Pi's compact() aborts an active run; it must never cut a tool
 *   chain), compacts once settled, then resumes with a hidden continuation;
 * - otherwise the run's own settlement, when nothing is in flight.
 * Decisions here are pure; extensions/index.ts feeds Pi events in and makes the Pi calls.
 */

/** Calls covered by the footer's average cost per call. */
export const RECENT_CALLS = 10;
/** Provider prompt caches (Anthropic's default TTL, OpenAI's inactivity window) lapse after about this long. */
export const CACHE_IDLE_MS = 5 * 60_000;
/** Below this, re-sending the context uncached is not worth a notice. */
export const CACHE_NOTICE_TOKENS = 100_000;
/** Hidden prompt that resumes a run stopped at a safe point once compaction finished. */
export const CONTEXT_CONTINUATION = "pi-jar.context-continuation";

/** One provider request: its prompt size, its cost and when it was sent. */
export interface ProviderCall { tokens: number; cost: number; at: number }
export interface BudgetSettle { compact: boolean; resume: boolean }
export interface BudgetCompaction { resume: boolean; tokens: number | undefined; softTokens: number; open: readonly string[] }

interface UsageLike { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: { total?: unknown } }
const amount = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** Prompt size of one call: fresh input plus cache reads and writes (its output is only re-sent by the next call). */
export function contextTokens(usage: UsageLike | undefined): number {
  return amount(usage?.input) + amount(usage?.cacheRead) + amount(usage?.cacheWrite);
}

/** The provider call behind an assistant message; none when nothing reached the provider (early abort, no usage). */
export function providerCall(message: unknown, now: number): ProviderCall | undefined {
  if (!message || typeof message !== "object") return undefined;
  const { role, usage, timestamp } = message as { role?: unknown; usage?: UsageLike; timestamp?: unknown };
  if (role !== "assistant") return undefined;
  const tokens = contextTokens(usage);
  if (!tokens) return undefined;
  // The message timestamp is the request time, which is what a provider cache's lifetime counts from.
  return { tokens, cost: amount(usage?.cost?.total), at: typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : now };
}

/**
 * Seed for a started, navigated or resumed branch: the latest call costs (oldest first) and the newest call,
 * unless a later compaction made its size stale. Walks back only as far as the window needs.
 */
export function branchCalls(branch: readonly unknown[], now: number): { costs: number[]; last?: ProviderCall } {
  const costs: number[] = [];
  let last: ProviderCall | undefined;
  let compacted = false;
  for (let index = branch.length - 1; index >= 0 && costs.length < RECENT_CALLS; index--) {
    const entry = branch[index];
    if (!entry || typeof entry !== "object") continue;
    const { type, message } = entry as { type?: unknown; message?: unknown };
    if (type === "compaction" && !costs.length) compacted = true;
    if (type !== "message") continue;
    const call = providerCall(message, now);
    if (!call) continue;
    if (!costs.length && !compacted) last = call;
    costs.push(call.cost);
  }
  return { costs: costs.reverse(), ...(last ? { last } : {}) };
}

/** `950`, `130k`, `1.2M`. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 999_500) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function elapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 120 ? `${minutes}m` : minutes < 2880 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}

export class ContextBudgetGuard {
  private readonly budget: () => ContextBudget;
  /** Costs of the last RECENT_CALLS calls, oldest first. */
  private costs: number[] = [];
  /** Prompt size of the newest call; unknown before the first call and after a compaction. */
  private tokens: number | undefined;
  /** When the provider cache was last surely warm: the newest call, or a Pi cache refresh since. */
  private warmAt: number | undefined;
  /** A crossing may still notify or compact; re-armed once a call fits the budget again. */
  private armed = true;
  /** Compact mode: this crossing's compaction waits for a safe point. */
  private pending = false;
  /** This guard stopped the run at a safe point, so the settled run resumes after compacting. */
  private stopped = false;
  /** A jar_todo call completed an item during the current turn. */
  private completed = false;
  /** The topic-switch hint was shown for the current finished task list. */
  private topicShown = false;

  constructor(budget: () => ContextBudget) { this.budget = budget; }

  /** Footer chip: the newest call's prompt is past the budget. */
  get over(): boolean {
    const { action, softTokens } = this.budget();
    return action !== "off" && this.tokens !== undefined && this.tokens > softTokens;
  }
  /** Average provider cost over the last RECENT_CALLS calls: at most ten additions, no session walk. */
  get perCall(): number | undefined {
    return this.costs.length ? this.costs.reduce((sum, cost) => sum + cost, 0) / this.costs.length : undefined;
  }
  get lastTokens(): number | undefined { return this.tokens; }
  /** Settlement has work: a compaction waits, or a stopped run must resume. */
  get busy(): boolean { return this.pending || this.stopped; }

  /** A new or re-rooted branch: everything starts over from its seed. */
  reset(seed: { costs?: readonly number[]; last?: ProviderCall } = {}): void {
    this.costs = (seed.costs ?? []).slice(-RECENT_CALLS);
    this.tokens = seed.last?.tokens;
    this.warmAt = seed.last?.at;
    this.armed = true;
    this.pending = this.stopped = this.completed = this.topicShown = false;
  }

  /** One provider call ended; returns the suggest-mode notice for a fresh crossing. */
  call(call: ProviderCall | undefined): string | undefined {
    if (!call) return undefined;
    this.costs.push(call.cost);
    if (this.costs.length > RECENT_CALLS) this.costs.shift();
    this.tokens = call.tokens;
    this.warmAt = Math.max(this.warmAt ?? call.at, call.at);
    const { action, softTokens } = this.budget();
    if (call.tokens <= softTokens) { this.armed = true; return undefined; }
    if (!this.armed || action === "off") return undefined;
    this.armed = false;
    if (action === "compact") { this.pending = true; return undefined; }
    return `Context ${formatTokens(call.tokens)} is past the ${formatTokens(softTokens)} budget — /compact, or /new for the next task`;
  }

  /** A jar_todo call raised the completed count: a safe point at this turn's end, and a new list for the topic hint. */
  todoCompleted(): void { this.completed = true; this.topicShown = false; }

  /** Turn end: true when the run should stop here, to compact once settled and then resume. */
  turnEnd(turn: { open: () => number; interrupted: boolean; blocked: boolean }): boolean {
    const completed = this.completed;
    this.completed = false;
    if (this.stopped || !completed || !this.pending || this.budget().action !== "compact"
      || turn.interrupted || turn.blocked || turn.open() <= 0) return false;
    this.stopped = true;
    return true;
  }

  /**
   * Run settled. Compacts when due and nothing else holds the session (another compaction, plan mode); a
   * pending compaction otherwise waits for the next settlement. A stopped run resumes unless the session is
   * held, which means the user took over (their own /compact, plan mode).
   */
  settle(state: { idle: boolean; blocked: boolean }): BudgetSettle | undefined {
    const resume = this.stopped;
    this.stopped = false;
    if (!state.idle || state.blocked) return undefined;
    // A request made under another action (the setting changed since) is dropped here.
    const compact = this.pending && this.budget().action === "compact";
    this.pending = false;
    return compact || resume ? { compact, resume } : undefined;
  }

  /** Any compaction (this guard's, Pi's threshold, /compact): the size is unknown until the next call. */
  compacted(): void { this.tokens = undefined; this.pending = false; }

  /** Pi refreshed the prompt cache while idle (cache warming), which restarts its lifetime. */
  warmed(at: number): void { if (this.warmAt !== undefined) this.warmAt = Math.max(this.warmAt, at); }

  /** An interactive prompt to an idle agent: hint /new after a finished task list, and flag a cold cache. */
  prompt(now: number, todos: { done: number; total: number }): string | undefined {
    const { action, softTokens } = this.budget();
    const tokens = this.tokens;
    if (action === "off" || tokens === undefined) return undefined;
    const idle = this.warmAt === undefined ? 0 : now - this.warmAt;
    const cold = idle > CACHE_IDLE_MS && tokens > CACHE_NOTICE_TOKENS;
    const topic = !this.topicShown && todos.total > 0 && todos.done === todos.total && tokens > softTokens / 2;
    if (topic) this.topicShown = true;
    const size = formatTokens(tokens);
    if (topic && cold) return `All tasks are done and the ${size} context is likely uncached (last call ${elapsed(idle)} ago). For a new task, /new starts fresh; /compact carries a summary over instead.`;
    if (topic) return `All tasks are done (context ${size}). For an unrelated task, /new starts fresh; /compact carries a summary over instead.`;
    if (cold) return `Last model call was ${elapsed(idle)} ago: the provider cache has likely expired, so this prompt re-sends ${size} uncached. After a break, /compact first.`;
    return undefined;
  }
}

/** At most six titles of 80 characters: compaction instructions and the continuation stay small. */
const titles = (open: readonly string[]) => open.slice(0, 6).map((title) => cleanText(title, 80)).join("; ")
  + (open.length > 6 ? `; +${open.length - 6} more` : "");

/** Continue a run stopped at a safe point; the message is hidden, so the transcript shows only the work. */
export function resumeAfterBudget(pi: Pick<ExtensionAPI, "sendMessage">, ctx: Pick<ExtensionContext, "ui">, open: readonly string[]): void {
  const content = "[pi-jar] Context was compacted at a safe point after a task completed; the request is not finished. "
    + `Continue the open jar_todo tasks${open.length ? ": " + titles(open) : ""}. Use jar_todo to check or update them.`;
  try { pi.sendMessage({ customType: CONTEXT_CONTINUATION, content, display: false }, { triggerTurn: true }); }
  catch (error) { ctx.ui.notify(`Could not resume after compaction: ${(error as Error).message}. Send a message to continue.`, "error"); }
}

/**
 * Compact once, then resume a run this guard stopped unless the user cancelled. Await it from agent_settled:
 * Pi defers the resumed turn until settlement handlers return, so print/json runs wait for it and no other
 * wake-up starts a run mid-compaction. `current` turns false when the session was replaced meanwhile.
 */
export async function compactForBudget(pi: Pick<ExtensionAPI, "sendMessage">, ctx: Pick<ExtensionContext, "compact" | "ui">,
  job: BudgetCompaction, current: () => boolean): Promise<void> {
  const size = job.tokens === undefined ? "" : " " + formatTokens(job.tokens);
  ctx.ui.notify(`Context${size} is past the ${formatTokens(job.softTokens)} budget: compacting at a safe point…`, "info");
  const keep = "Preserve completed work, verification results, key decisions, file paths and open questions.";
  // Executor form: the project's TS lib target predates Promise.withResolvers.
  const error = await new Promise<Error | undefined>((resolve) => {
    try {
      ctx.compact({ customInstructions: job.open.length ? `${keep} Work continues on these open jar_todo tasks: ${titles(job.open)}.` : keep,
        onComplete: () => resolve(undefined), onError: resolve });
    } catch (thrown) { resolve(thrown instanceof Error ? thrown : new Error(String(thrown))); }
  });
  if (!current()) return;
  // Only the user interrupts a compaction (Esc); Pi's other refusals and failures leave the context usable.
  const userCancelled = error !== undefined && (error.name === "AbortError" || /\b(cancel|abort)/i.test(error.message));
  if (error && !userCancelled) ctx.ui.notify(`Context compaction failed: ${error.message}${job.resume ? " · continuing without it" : ""}`, "warning");
  if (job.resume && !userCancelled) resumeAfterBudget(pi, ctx, job.open);
}
