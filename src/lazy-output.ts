import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Session entry that remembers which tool results were replaced by a stub. */
export const LAZY_OUTPUT_ENTRY = "pi-jar.lazy-output";

/**
 * Pi caches the conversation prefix. Replacing an old tool result changes that prefix, so every
 * message after it is billed again at the uncached rate. A sweep therefore runs only when that
 * one-time rewrite is free (the cache is demonstrably cold) or pays for itself within a bounded
 * number of further calls.
 */
export interface LazyOutputPolicy {
  /** Results shorter than this are never replaced. */
  minResultChars: number;
  /** Results larger than this are never replaced: the copy on disk is bounded. */
  maxResultBytes: number;
  /** Total bytes one session may spill. */
  maxSessionBytes: number;
  /** Tool results after the Nth-last assistant message stay untouched: the working set. */
  keepRecentTurns: number;
  /** No sweep below this context size. */
  triggerTokens: number;
  /** Cold cache: the rewrite is free, so a small saving is enough. */
  coldMinSavedTokens: number;
  /** Idle time after which every common provider cache (including 1 hour retention) has expired. */
  coldIdleMs: number;
  /** Warm cache: the sweep must save at least this many tokens per call... */
  warmMinSavedTokens: number;
  /** ...and recover the rewrite within this many further calls. */
  warmHorizonCalls: number;
  /** Cached-read price as a share of the uncached input price, used for the break-even. */
  cacheReadPriceRatio: number;
  /** Calls that must pass between two warm sweeps, so new outputs ageing out cannot trigger a rewrite loop. */
  warmCooldownCalls: number;
  /** Characters of the original output kept in the stub as a preview. */
  previewChars: number;
}

export const DEFAULT_LAZY_OUTPUT_POLICY: LazyOutputPolicy = {
  minResultChars: 3000,
  maxResultBytes: 8 * 1024 * 1024,
  maxSessionBytes: 128 * 1024 * 1024,
  keepRecentTurns: 8,
  triggerTokens: 60_000,
  coldMinSavedTokens: 8_000,
  coldIdleMs: 65 * 60_000,
  warmMinSavedTokens: 20_000,
  warmHorizonCalls: 40,
  cacheReadPriceRatio: 0.1,
  warmCooldownCalls: 25,
  previewChars: 300
};

/** A cache read below this share of the prompt, twice in a row, means caching is not working here. */
const INEFFECTIVE_CACHE_SHARE = 0.1;
const IMAGE_CHARS = 6400;

interface UsageLike { input?: number; cacheRead?: number; cacheWrite?: number }
interface MessageLike {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  timestamp?: number;
  usage?: UsageLike;
  command?: string;
  output?: string;
}

export interface SpillStore {
  /** Make sure `file` holds exactly `text`, replacing anything else. Throws when that cannot be guaranteed. */
  ensure(file: string, text: string): void;
}

const sha256 = (...parts: string[]) => createHash("sha256").update(parts.join("\0")).digest("hex");

/** A regular, non-link file owned by us that holds exactly `text`. */
function holdsText(file: string, text: string): boolean {
  let descriptor: number | undefined;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    descriptor = openSync(file, flags);
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size !== Buffer.byteLength(text)) return false;
    return sha256(readFileSync(descriptor, "utf8")) === sha256(text);
  } catch {
    // Missing, a link (ELOOP) or unreadable: in every case the caller replaces the path.
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error(`${directory} is a symbolic link`);
  chmodSync(directory, 0o700);
}

/** Owner-only directory and files, exclusive creation, never following links; content is verified on reuse. */
export const diskSpill: SpillStore = {
  ensure(file, text) {
    privateDirectory(join(file, ".."));
    if (holdsText(file, text)) return;
    // Anything else at this path (stale, truncated, a link planted by someone else) is removed, then recreated exclusively.
    try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { writeSync(descriptor, text); }
    finally { closeSync(descriptor); }
  }
};

/** Remove session spill directories not touched for `maxAgeMs`. Returns what was removed. */
export function pruneSpill(root: string, maxAgeMs: number, now: number): string[] {
  const removed: string[] = [];
  let names: string[];
  try { names = readdirSync(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return removed;
    throw error;
  }
  for (const name of names) {
    const directory = join(root, name);
    const stats = lstatSync(directory);
    if (!stats.isDirectory() || now - stats.mtimeMs < maxAgeMs) continue;
    rmSync(directory, { recursive: true, force: true });
    removed.push(directory);
  }
  return removed;
}

export interface ProjectionEnvironment {
  /** Directory that holds the full text of replaced results; read only when something is spilled. */
  spillDirectory(): string;
  /** Provider-reported context size when known; otherwise estimated from the messages. */
  contextTokens?: number | undefined;
  now: number;
  /** False keeps earlier replacements in place but starts no new sweep. */
  sweep: boolean;
}

export interface Projection<T> {
  /** The messages to send; undefined when nothing is replaced. */
  messages?: T[];
  /** Tool call ids replaced for the first time by this call and verified on disk. */
  newlyReplaced: string[];
  /** Results that could not be saved to disk and therefore stay in full. */
  failures: string[];
  /** Estimated tokens the newly replaced results no longer cost per request. */
  savedTokens: number;
}

interface Candidate { message: MessageLike; index: number; text: string; saved: number }
interface Stub { text: string; saved: number }

const estimateTokens = (chars: number) => Math.ceil(chars / 4);
const safeName = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "tool";
const lengthCache = new WeakMap<object, number>();

/** Characters a message adds to the prompt, without serializing it; remembered per message object. */
function messageChars(message: MessageLike): number {
  const known = lengthCache.get(message);
  if (known !== undefined) return known;
  let chars = 0;
  if (typeof message.content === "string") chars = message.content.length;
  else if (Array.isArray(message.content)) {
    for (const part of message.content as { type?: string; text?: string; thinking?: string; thinkingSignature?: string; arguments?: unknown }[]) {
      if (part.type === "text") chars += part.text?.length ?? 0;
      else if (part.type === "thinking") chars += (part.thinking?.length ?? 0) + (part.thinkingSignature?.length ?? 0);
      else if (part.type === "toolCall") chars += JSON.stringify(part.arguments ?? {}).length + 40;
      else if (part.type === "image") chars += IMAGE_CHARS;
    }
  }
  chars += (message.command?.length ?? 0) + (message.output?.length ?? 0);
  lengthCache.set(message, chars);
  return chars;
}

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

const lineCount = (text: string) => text ? text.split("\n").length : 0;

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

function unavailableStub(message: MessageLike, text: string): string {
  return `[Tool output removed from context to save tokens: ${message.toolName ?? "tool"}, ${lineCount(text)} lines, ${text.length} chars. The saved copy is unavailable: run the tool again.]`;
}

/** Evidence that the next request will re-process the prompt anyway. */
function cacheIsCold(messages: readonly MessageLike[], now: number, policy: LazyOutputPolicy): boolean {
  const assistants = messages.filter((message) => message.role === "assistant");
  const last = assistants.at(-1);
  if (!last || typeof last.timestamp !== "number") return true;
  if (now - last.timestamp >= policy.coldIdleMs) return true;
  // Two recent large prompts that read (almost) nothing from the cache: it is not working in this session.
  const recent = assistants.slice(-2);
  if (recent.length < 2) return false;
  return recent.every((message) => {
    const usage = message.usage;
    if (!usage) return false;
    const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    return prompt >= policy.triggerTokens && (usage.cacheRead ?? 0) < prompt * INEFFECTIVE_CACHE_SHARE;
  });
}

/**
 * Projects stale large tool results into stubs for the provider, leaving the session file intact.
 * A result is replaced only after its full text is verified on disk; once replaced it stays replaced
 * on every later call, and a decision depends only on messages before it.
 */
export class LazyOutputProjector {
  readonly #policy: LazyOutputPolicy;
  readonly #spill: SpillStore;
  readonly #replaced = new Set<string>();
  readonly #stubs = new Map<string, Stub>();
  readonly #refused = new Set<string>();
  #calls = 0;
  #lastSweepCall = Number.NEGATIVE_INFINITY;
  #spilledBytes = 0;

  constructor(policy: LazyOutputPolicy = DEFAULT_LAZY_OUTPUT_POLICY, spill: SpillStore = diskSpill) {
    this.#policy = policy;
    this.#spill = spill;
  }

  get replacedCount(): number { return this.#replaced.size; }

  /** Forget everything, for a new session. */
  reset(): void {
    this.#replaced.clear();
    this.#stubs.clear();
    this.#refused.clear();
    this.#calls = 0;
    this.#lastSweepCall = Number.NEGATIVE_INFINITY;
    this.#spilledBytes = 0;
  }

  /** Reapply decisions persisted in the session. */
  restore(ids: Iterable<string>): void {
    for (const id of ids) this.#replaced.add(id);
  }

  project<T>(messages: T[], environment: ProjectionEnvironment): Projection<T> {
    const result: Projection<T> = { newlyReplaced: [], failures: [], savedTokens: 0 };
    this.#calls++;
    if (environment.sweep) this.#sweep(messages as MessageLike[], environment, result);
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

  /** The stub of an already replaced result; a restored decision whose copy is gone degrades to a plain notice. */
  #stubFor(message: MessageLike, environment: ProjectionEnvironment, result: Projection<unknown>): string | undefined {
    if (message.role !== "toolResult" || !message.toolCallId || !this.#replaced.has(message.toolCallId)) return undefined;
    const known = this.#stubs.get(message.toolCallId);
    if (known) return known.text;
    const text = textOf(message);
    if (text === undefined) return undefined;
    const prepared = this.#prepare(message, text, environment, result);
    if (prepared) return prepared.text;
    const fallback = { text: unavailableStub(message, text), saved: 0 };
    this.#stubs.set(message.toolCallId, fallback);
    return fallback.text;
  }

  /** Save the full text and remember its stub, or record why that failed. */
  #prepare(message: MessageLike, text: string, environment: ProjectionEnvironment, result: Projection<unknown>): Stub | undefined {
    const id = message.toolCallId!;
    const bytes = Buffer.byteLength(text);
    if (this.#spilledBytes + bytes > this.#policy.maxSessionBytes) {
      result.failures.push(`${message.toolName ?? "tool"}: session spill limit reached`);
      return undefined;
    }
    const file = join(environment.spillDirectory(), `${safeName(message.toolName ?? "tool")}-${sha256(message.toolName ?? "", id, text).slice(0, 40)}.txt`);
    try { this.#spill.ensure(file, text); }
    catch (error) {
      result.failures.push(`${message.toolName ?? "tool"}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    this.#spilledBytes += bytes;
    const stub = stubText(message, text, file, this.#policy.previewChars);
    const prepared = { text: stub, saved: Math.max(0, estimateTokens(text.length) - estimateTokens(stub.length)) };
    this.#stubs.set(id, prepared);
    return prepared;
  }

  #sweep(messages: MessageLike[], environment: ProjectionEnvironment, result: Projection<unknown>): void {
    const policy = this.#policy;
    // The reported size is free; the estimate walks the history, so it is only needed without one.
    if (environment.contextTokens !== undefined && environment.contextTokens < policy.triggerTokens) return;
    const protectedFrom = this.#protectedFrom(messages);
    const candidates: Candidate[] = [];
    let totalChars = 0;
    const prefixChars: number[] = [];
    messages.forEach((message, index) => {
      prefixChars.push(totalChars);
      totalChars += messageChars(message);
      if (index >= protectedFrom || message.role !== "toolResult" || !message.toolCallId) return;
      if (this.#replaced.has(message.toolCallId) || this.#refused.has(message.toolCallId)) return;
      const text = textOf(message);
      if (text === undefined || text.length < policy.minResultChars || Buffer.byteLength(text) > policy.maxResultBytes) return;
      candidates.push({ message, index, text, saved: estimateTokens(text.length) - estimateTokens(policy.previewChars + 220) });
    });
    if (!candidates.length) return;
    const context = environment.contextTokens ?? estimateTokens(totalChars);
    if (context < policy.triggerTokens) return;
    const saved = candidates.reduce((sum, candidate) => sum + candidate.saved, 0);
    const suffixTokens = estimateTokens(totalChars - prefixChars[candidates[0]!.index]!);
    if (!this.#worthSweeping(messages, environment, saved, suffixTokens)) return;

    this.#lastSweepCall = this.#calls;
    for (const candidate of candidates) {
      const prepared = this.#prepare(candidate.message, candidate.text, environment, result);
      if (!prepared) { this.#refused.add(candidate.message.toolCallId!); continue; }
      // Only a verified copy makes the replacement permanent.
      this.#replaced.add(candidate.message.toolCallId!);
      result.newlyReplaced.push(candidate.message.toolCallId!);
      result.savedTokens += prepared.saved;
    }
  }

  #worthSweeping(messages: MessageLike[], environment: ProjectionEnvironment, saved: number, suffixTokens: number): boolean {
    const policy = this.#policy;
    if (cacheIsCold(messages, environment.now, policy)) return saved >= policy.coldMinSavedTokens;
    if (saved < policy.warmMinSavedTokens) return false;
    if (this.#calls - this.#lastSweepCall < policy.warmCooldownCalls) return false;
    // Rewriting the suffix costs (1 - r) per token once; each later call saves r per removed token.
    const ratio = policy.cacheReadPriceRatio;
    const callsToRecover = suffixTokens * (1 - ratio) / (saved * ratio);
    return callsToRecover <= policy.warmHorizonCalls;
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
  /** Whether new sweeps may start. Earlier replacements stay in place either way, so toggling never rewrites the prefix. */
  enabled(): boolean;
  policy?: LazyOutputPolicy;
  spillRoot?: string;
  /** Spill directories untouched for this long are removed at session start. */
  retentionMs?: number;
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
  const spillRoot = options.spillRoot ?? join(getAgentDir(), "pi-jar-spill");
  const retentionMs = options.retentionMs ?? 7 * 24 * 3_600_000;
  let warned = false;
  const restore = (_event: unknown, ctx: ExtensionContext) => {
    projector.reset();
    projector.restore(persistedIds(ctx));
    warned = false;
  };
  pi.on("session_start", (event, ctx) => {
    restore(event, ctx);
    try { pruneSpill(spillRoot, retentionMs, Date.now()); }
    catch (error) { console.error("pi-jar: could not clean old spilled tool output", error); }
  });
  pi.on("session_tree", restore);
  pi.on("context", (event, ctx) => {
    const sweep = options.enabled();
    if (!sweep && !projector.replacedCount) return;
    const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    const outcome = projector.project(event.messages, {
      spillDirectory: () => join(spillRoot, sha256(ctx.sessionManager.getSessionId()).slice(0, 32)),
      contextTokens: usage?.tokens ?? undefined,
      now: Date.now(),
      sweep
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
