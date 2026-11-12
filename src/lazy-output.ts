import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Session entry that remembers which tool results were replaced by a stub. */
export const LAZY_OUTPUT_ENTRY = "pi-jar.lazy-output";

/**
 * Pi caches the conversation prefix. Replacing an old tool result changes that prefix, so the
 * whole conversation after it is billed again at the uncached rate. A sweep therefore only runs
 * when the saving outweighs that one-time rewrite: either the cache is already cold (nothing is
 * lost), or the stale results are a large share of the context.
 */
export interface LazyOutputPolicy {
  /** Results shorter than this are never replaced. */
  minResultChars: number;
  /** Tool results after the Nth-last assistant message stay untouched: the working set. */
  keepRecentTurns: number;
  /** No sweep below this context size. */
  triggerTokens: number;
  /** Warm cache: the sweep must save at least this many tokens per call... */
  warmMinSavedTokens: number;
  /** ...and at least this share of the context (a rewrite costs roughly 10-17 cached calls). */
  warmMinSavedShare: number;
  /** Cold cache: the rewrite is free, so a small saving is enough. */
  coldMinSavedTokens: number;
  /** An assistant message older than this means the provider cache has expired. */
  cacheTtlMs: number;
  /** Characters of the original output kept in the stub as a preview. */
  previewChars: number;
}

export const DEFAULT_LAZY_OUTPUT_POLICY: LazyOutputPolicy = {
  minResultChars: 3000,
  keepRecentTurns: 8,
  triggerTokens: 60_000,
  warmMinSavedTokens: 20_000,
  warmMinSavedShare: 0.25,
  coldMinSavedTokens: 8_000,
  cacheTtlMs: 5 * 60_000,
  previewChars: 300
};

interface MessageLike {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  timestamp?: number;
}

export interface SpillStore {
  /** Make sure `file` holds `text`. Throws when the disk refuses. */
  ensure(file: string, text: string): void;
}

export const diskSpill: SpillStore = {
  ensure(file, text) {
    if (existsSync(file)) return;
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text, "utf8");
  }
};

export interface ProjectionEnvironment {
  /** Directory that holds the full text of replaced results; read only when something is replaced. */
  spillDirectory(): string;
  /** Provider-reported context size when known; otherwise estimated from the messages. */
  contextTokens?: number | undefined;
  now: number;
}

export interface Projection<T> {
  /** The messages to send; undefined when nothing is replaced. */
  messages?: T[];
  /** Tool call ids replaced for the first time by this call. */
  newlyReplaced: string[];
  /** Results that could not be saved to disk and therefore stay in full. */
  failures: string[];
  savedTokens: number;
}

const estimateTokens = (chars: number) => Math.ceil(chars / 4);
const safeName = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "result";

/** The text of a result, or undefined when it holds anything else (images are never replaced). */
function textOf(message: MessageLike): string | undefined {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  let text = "";
  for (const part of message.content as { type?: string; text?: string }[]) {
    if (part.type !== "text" || typeof part.text !== "string") return undefined;
    text += part.text;
  }
  return text;
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function spillFile(directory: string, message: MessageLike): string {
  return join(directory, `${safeName(message.toolName ?? "tool")}-${safeName(message.toolCallId ?? "")}.txt`);
}

/** Deterministic: the same message and file always give the same stub, so the prefix stays stable. */
export function stubText(message: MessageLike, text: string, file: string, previewChars: number): string {
  const preview = text.slice(0, previewChars).replace(/\s+$/, "");
  return [
    `[Tool output removed from context to save tokens: ${message.toolName ?? "tool"}, ${lineCount(text)} lines, ${text.length} chars.`,
    `Full text: ${file} (read it with offset/limit, or run the tool again).]`,
    "Preview:",
    preview
  ].join("\n");
}

/**
 * Projects stale large tool results into stubs for the provider, leaving the session file intact.
 * Once a result is replaced it stays replaced on every later call, and the decision depends only
 * on messages before it, so a sweep changes the cached prefix exactly once.
 */
export class LazyOutputProjector {
  readonly #policy: LazyOutputPolicy;
  readonly #spill: SpillStore;
  readonly #replaced = new Set<string>();
  readonly #saved = new Set<string>();

  constructor(policy: LazyOutputPolicy = DEFAULT_LAZY_OUTPUT_POLICY, spill: SpillStore = diskSpill) {
    this.#policy = policy;
    this.#spill = spill;
  }

  get replacedCount(): number { return this.#replaced.size; }

  /** Forget everything, for a new session. */
  reset(): void {
    this.#replaced.clear();
    this.#saved.clear();
  }

  /** Reapply decisions persisted in the session. */
  restore(ids: Iterable<string>): void {
    for (const id of ids) this.#replaced.add(id);
  }

  project<T>(messages: T[], environment: ProjectionEnvironment): Projection<T> {
    const result: Projection<T> = { newlyReplaced: [], failures: [], savedTokens: 0 };
    const sweep = this.#sweep(messages as MessageLike[], environment);
    for (const id of sweep) {
      this.#replaced.add(id);
      result.newlyReplaced.push(id);
    }
    if (!this.#replaced.size) return result;
    const projected: T[] = [];
    let changed = false;
    for (const message of messages) {
      const stub = this.#stubFor(message as MessageLike, environment, result);
      if (stub === undefined) { projected.push(message); continue; }
      changed = true;
      projected.push({ ...(message as object), content: [{ type: "text", text: stub }] } as T);
    }
    if (changed) result.messages = projected;
    return result;
  }

  #stubFor(message: MessageLike, environment: ProjectionEnvironment, result: Projection<unknown>): string | undefined {
    if (message.role !== "toolResult" || !message.toolCallId || !this.#replaced.has(message.toolCallId)) return undefined;
    const text = textOf(message);
    if (text === undefined) return undefined;
    const file = spillFile(environment.spillDirectory(), message);
    if (!this.#saved.has(file)) {
      try {
        this.#spill.ensure(file, text);
        this.#saved.add(file);
      } catch (error) {
        result.failures.push(`${message.toolName ?? "tool"}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    }
    const stub = stubText(message, text, file, this.#policy.previewChars);
    result.savedTokens += Math.max(0, estimateTokens(text.length) - estimateTokens(stub.length));
    return stub;
  }

  /** Ids to replace now, or none when the cache rewrite would not pay for itself. */
  #sweep(messages: MessageLike[], environment: ProjectionEnvironment): string[] {
    const policy = this.#policy;
    const protectedFrom = this.#protectedFrom(messages);
    const candidates: { id: string; saved: number }[] = [];
    let totalChars = 0;
    let lastAssistantAt: number | undefined;
    messages.forEach((message, index) => {
      totalChars += typeof message.content === "string" ? message.content.length : JSON.stringify(message.content ?? "").length;
      if (message.role === "assistant" && typeof message.timestamp === "number") lastAssistantAt = message.timestamp;
      if (index >= protectedFrom || message.role !== "toolResult" || !message.toolCallId) return;
      if (this.#replaced.has(message.toolCallId)) return;
      const text = textOf(message);
      if (text === undefined || text.length < policy.minResultChars) return;
      candidates.push({ id: message.toolCallId, saved: estimateTokens(text.length) - estimateTokens(policy.previewChars + 220) });
    });
    if (!candidates.length) return [];
    const context = environment.contextTokens ?? estimateTokens(totalChars);
    if (context < policy.triggerTokens) return [];
    const saved = candidates.reduce((sum, candidate) => sum + candidate.saved, 0);
    const cold = lastAssistantAt === undefined || environment.now - lastAssistantAt >= policy.cacheTtlMs;
    if (cold && saved >= policy.coldMinSavedTokens) return candidates.map((candidate) => candidate.id);
    const worthIt = saved >= policy.warmMinSavedTokens && saved >= context * policy.warmMinSavedShare;
    return worthIt ? candidates.map((candidate) => candidate.id) : [];
  }

  /** Index of the first message in the protected working set. */
  #protectedFrom(messages: MessageLike[]): number {
    let seen = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]!.role !== "assistant") continue;
      seen++;
      if (seen >= this.#policy.keepRecentTurns) return index;
    }
    return 0;
  }
}

export interface LazyOutputOptions {
  enabled(): boolean;
  policy?: LazyOutputPolicy;
  spillRoot?: string;
}

interface BranchEntry { type?: string; customType?: string; data?: { ids?: unknown } }

function persistedIds(ctx: ExtensionContext): string[] {
  const ids: string[] = [];
  for (const entry of ctx.sessionManager.getBranch() as BranchEntry[]) {
    if (entry.type !== "custom" || entry.customType !== LAZY_OUTPUT_ENTRY || !Array.isArray(entry.data?.ids)) continue;
    for (const id of entry.data.ids) if (typeof id === "string") ids.push(id);
  }
  return ids;
}

/** Hook the projector into Pi's context event. */
export function registerLazyOutput(pi: ExtensionAPI, options: LazyOutputOptions): LazyOutputProjector {
  const projector = new LazyOutputProjector(options.policy);
  const spillRoot = options.spillRoot ?? join(tmpdir(), "pi-jar-spill");
  let warned = false;
  const restore = (_event: unknown, ctx: ExtensionContext) => {
    projector.reset();
    projector.restore(persistedIds(ctx));
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("context", (event, ctx) => {
    if (!options.enabled()) return;
    const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    const outcome = projector.project(event.messages, {
      spillDirectory: () => join(spillRoot, safeName(ctx.sessionManager.getSessionId())),
      contextTokens: usage?.tokens ?? undefined,
      now: Date.now()
    });
    if (outcome.newlyReplaced.length) pi.appendEntry(LAZY_OUTPUT_ENTRY, { ids: outcome.newlyReplaced, savedTokens: outcome.savedTokens });
    if (outcome.failures.length && !warned) {
      warned = true;
      ctx.ui.notify("pi-jar: could not save large tool output, keeping it in context: " + outcome.failures[0], "warning");
    }
    if (outcome.messages) return { messages: outcome.messages };
  });
  return projector;
}
