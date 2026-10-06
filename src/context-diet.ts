import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Character counts are diagnostics, NOT token estimates: signatures can be opaque ciphertext. */
export interface ThinkingDietStats {
  removedThinkingParts: number;
  removedVisibleChars: number;
  removedSignatureChars: number;
}
/** Superseded `read` results replaced by a stub, and the characters of file text they carried. */
export interface ReadDietStats {
  stubbedReads: number;
  stubbedReadChars: number;
}
export type ContextDietStats = ThinkingDietStats & ReadDietStats;

export interface DietMessage {
  role: string;
  content?: unknown;
  toolCallId?: string;
}

const emptyStats = (): ContextDietStats => ({ removedThinkingParts: 0, removedVisibleChars: 0, removedSignatureChars: 0, stubbedReads: 0, stubbedReadChars: 0 });
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * `details` of a read-cache stub (src/compact-tools.ts). Such a result points at an earlier read
 * instead of carrying file text, so it never supersedes that read.
 */
export interface ReadStubDetails { unchangedSinceRead: number }
export const isReadStub = (details: unknown): details is ReadStubDetails => typeof record(details)?.unchangedSinceRead === "number";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
/**
 * Pi's read/edit/write path resolution (odd spaces, `@path`, `~`, file URLs) without probing the
 * filesystem. Undefined for a file URL Pi itself rejects; callers then just don't match the path.
 */
export function resolveToolPath(path: string, cwd: string): string | undefined {
  let value = path.replace(UNICODE_SPACES, " ");
  if (value.startsWith("@")) value = value.slice(1);
  if (value === "~" || value.startsWith("~/")) value = join(homedir(), value.slice(2));
  else if (value.startsWith("file://")) {
    try { value = fileURLToPath(value); } catch { return undefined; }
  }
  return resolve(cwd, value);
}

/**
 * The line window a read returns; Pi treats a missing offset and offsets ≤ 1 alike. Undefined when the
 * arguments are not plain numbers, so an unvalidated request never matches another.
 */
export function readRangeKey(offset: unknown, limit: unknown): string | undefined {
  const start = offset === undefined ? 1 : typeof offset === "number" ? Math.max(offset, 1) : undefined;
  if (start === undefined || (limit !== undefined && typeof limit !== "number")) return undefined;
  return `${start}:${limit ?? ""}`;
}

/** Completed prior user turns span [firstUser, boundary); every call there has its result there. */
interface History { firstUser: number; boundary: number; results: Map<string, number> }

/**
 * The completed prior-user-turn span a projection may rewrite; the complete current reasoning/tool
 * chain is never eligible. Ambiguous, unresolved or boundary-crossing historical tool calls make it
 * undefined, so every projection is a no-op: reducing context is less important than preserving
 * provider sequencing constraints.
 */
function completedHistory(messages: readonly DietMessage[]): History | undefined {
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === "user") { boundary = index; break; }
  }
  const firstUser = messages.findIndex(message => message.role === "user");
  if (boundary <= 0 || firstUser === boundary) return undefined;

  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "toolResult") {
      const id = message.toolCallId;
      if (typeof id !== "string" || !id || results.has(id)) return undefined;
      results.set(id, index);
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const value of message.content) {
      const part = record(value);
      if (part?.type !== "toolCall") continue;
      const id = part.id;
      if (typeof id !== "string" || !id || calls.has(id)) return undefined;
      calls.set(id, index);
    }
  }
  for (const [id, index] of calls) {
    if (index >= boundary) continue;
    const result = results.get(id);
    if (result === undefined || result <= index || result >= boundary) return undefined;
  }
  // A detached historical result means the original reasoning sequence is not fully known.
  for (const [id, index] of results) {
    if (index < boundary && !calls.has(id)) return undefined;
  }
  return { firstUser, boundary, results };
}

/**
 * Opt-in provider-context projection; never edits the session or mutates its messages.
 * Only prior user turns are eligible (see completedHistory).
 */
export function trimCompletedThinking<T extends DietMessage>(messages: T[]): { messages: T[]; stats: ThinkingDietStats } {
  const stats: ThinkingDietStats = { removedThinkingParts: 0, removedVisibleChars: 0, removedSignatureChars: 0 };
  const history = completedHistory(messages);
  if (!history) return { messages, stats };
  const { firstUser, boundary } = history;

  let changed = false;
  const projected = messages.map((message, index) => {
    if (index < firstUser || index >= boundary || message.role !== "assistant" || !Array.isArray(message.content)) return message;
    const kept = message.content.filter(value => record(value)?.type !== "thinking");
    // Retain thinking-only rows unchanged rather than manufacturing empty assistant messages.
    if (!kept.length || kept.length === message.content.length) return message;
    for (const value of message.content) {
      const part = record(value);
      if (part?.type !== "thinking") continue;
      stats.removedThinkingParts++;
      if (typeof part.thinking === "string") stats.removedVisibleChars += part.thinking.length;
      if (typeof part.thinkingSignature === "string") stats.removedSignatureChars += part.thinkingSignature.length;
    }
    changed = true;
    return { ...message, content: kept } as T;
  });
  return { messages: changed ? projected : messages, stats };
}

/** Total text of an all-text result; undefined when it holds images or unknown parts. */
function textLength(content: unknown): number | undefined {
  if (!Array.isArray(content) || !content.length) return undefined;
  let chars = 0;
  for (const value of content) {
    const part = record(value);
    if (part?.type !== "text" || typeof part.text !== "string") return undefined;
    chars += part.text.length;
  }
  return chars;
}

interface OpenRead { result: number; path: string; chars: number }

/**
 * Opt-in projection, under the same eligibility as trimCompletedThinking: a `read` result that a later
 * read of the same file and line window, or a successful edit/write of the file, superseded becomes a
 * one-line stub; the toolResult keeps its id, name and position. Only operations inside the read's own
 * completed user turn count. A result's projection is therefore fixed when its turn completes and
 * changes together with the thinking trim, never later: re-projecting an older message after newer
 * ones arrive would re-bill the whole prefix after it (src/workflow-context.ts). Operations issued in
 * the read's own assistant message may have run in parallel with it, so they never supersede it.
 * Read-cache stubs, errors, images and results answered outside their turn are left alone.
 */
export function stubSupersededReads<T extends DietMessage>(messages: T[], cwd: string): { messages: T[]; stats: ReadDietStats } {
  const stats: ReadDietStats = { stubbedReads: 0, stubbedReadChars: 0 };
  const history = completedHistory(messages);
  if (!history) return { messages, stats };
  const { firstUser, boundary, results } = history;

  const stubs = new Map<number, string>();
  const supersede = (read: OpenRead, by: string) => {
    const stub = `[superseded by a later ${by} of ${read.path}]`;
    if (stubs.has(read.result) || stub.length >= read.chars) return;
    stubs.set(read.result, stub);
    stats.stubbedReads++;
    stats.stubbedReadChars += read.chars;
  };
  for (let start = firstUser; start < boundary;) {
    // The boundary is a user message, so every completed turn ends at one.
    let end = start + 1;
    while (messages[end]!.role !== "user") end++;
    /** File → line window → newest read of this turn not yet superseded. */
    const open = new Map<string, Map<string, OpenRead>>();
    for (let index = start + 1; index < end; index++) {
      const message = messages[index]!;
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      const added: Array<{ file: string; range: string; read: OpenRead }> = [];
      for (const value of message.content) {
        const part = record(value);
        const args = record(part?.arguments);
        const name = part?.name;
        if (part?.type !== "toolCall" || (name !== "read" && name !== "edit" && name !== "write") || typeof args?.path !== "string") continue;
        const result = results.get(part.id as string)!;
        const outcome = record(messages[result]);
        const file = resolveToolPath(args.path, cwd);
        if (result >= end || !file || outcome?.isError === true) continue;
        if (name !== "read") {
          for (const read of open.get(file)?.values() ?? []) supersede(read, name);
          open.delete(file);
          continue;
        }
        const range = readRangeKey(args.offset, args.limit);
        const chars = range === undefined || isReadStub(outcome?.details) ? undefined : textLength(outcome?.content);
        if (range === undefined || chars === undefined) continue;
        const prior = open.get(file)?.get(range);
        if (prior) supersede(prior, "read");
        added.push({ file, range, read: { result, path: args.path, chars } });
      }
      for (const { file, range, read } of added) {
        let ranges = open.get(file);
        if (!ranges) open.set(file, ranges = new Map());
        ranges.set(range, read);
      }
    }
    start = end;
  }
  if (!stubs.size) return { messages, stats };
  const projected = messages.map((message, index) => {
    const stub = stubs.get(index);
    return stub === undefined ? message : { ...message, content: [{ type: "text", text: stub }] } as T;
  });
  return { messages: projected, stats };
}

/** Register a runtime-toggleable diet; caller owns its persisted, opt-in setting. */
export function registerContextDiet(pi: ExtensionAPI, enabled: () => boolean): { stats: () => ContextDietStats } {
  let latest = emptyStats();
  pi.on("context", (event, ctx) => {
    latest = emptyStats();
    if (!enabled()) return;
    const thinking = trimCompletedThinking(event.messages);
    const reads = stubSupersededReads(thinking.messages, ctx.cwd);
    latest = { ...thinking.stats, ...reads.stats };
    if (reads.messages !== event.messages) return { messages: reads.messages };
  });
  pi.on("session_start", () => { latest = emptyStats(); });
  return { stats: () => ({ ...latest }) };
}
