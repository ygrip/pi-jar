import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CACHE_IDLE_MS, contextTokens, formatTokens } from "./context-budget.ts";
import { duration, money } from "./panel.ts";

/**
 * Prompt-cache break diagnostics. Providers cache a prompt as an ordered prefix (tools, then system
 * prompt, then messages), so changing anything early in a request makes the provider re-process, and
 * bill again, everything after it. Pi tells you that a call missed the cache; this module says what changed.
 *
 * - before_provider_request: the final payload is reduced to an ordered list of {@link Segment}s (model,
 *   each tool, each system-prompt section, each message), each a hash and a size: no content is kept. The
 *   payload is only read, never replaced.
 * - Comparing a request with the previous completed one finds the first segment where the earlier
 *   sequence is no longer a prefix ({@link diffSegments}).
 * - message_end: the call's usage says whether the provider actually missed ({@link judgeCall}). Only a
 *   costly miss is a break: it is classified, logged to JSONL and announced once.
 * Decisions here are pure; {@link registerCacheBreaks} feeds Pi events in.
 */

/** A call is a costly break when its cache read falls short of the previous prompt by more than this... */
export const BREAK_SHORTFALL_TOKENS = 4096;
/** ...or reads nothing from the cache although its prompt is larger than this. */
export const BREAK_COLD_TOKENS = 8192;
/** Breaks kept in memory for /cache-breaks; the JSONL log keeps every one. */
const MAX_BREAKS = 200;
/** A system prompt is split into at most this many sections; the remainder becomes one `rest` section. */
const MAX_SECTIONS = 128;

export type SegmentKind = "model" | "tool" | "system" | "message";
/** Providers read the prompt in this order, so an earlier region changing invalidates every later one. */
const KIND_ORDER: Record<SegmentKind, number> = { model: 0, tool: 1, system: 2, message: 3 };

/** One ordered part of a provider prompt: what it is, a hash of its content, and its size in characters. */
export interface Segment { kind: SegmentKind; label: string; hash: string; size: number }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
/** Provider cache breakpoints move to the newest block on every call: markers, not prompt content. */
const dropMarkers = (key: string, value: unknown): unknown => key === "cache_control" ? undefined : value;

/** Plain text of a string or of an array of text blocks; other blocks count by their JSON. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    const block = record(part);
    return typeof block?.text === "string" ? block.text : JSON.stringify(part, dropMarkers) ?? "";
  }).join("\n\n");
}

const TAG_OPEN = /^<([A-Za-z][\w.-]*)(?:\s[^>]*)?>\s*$/;
const HEADING = /^#{1,3}\s+(\S.*?)\s*$/;

/**
 * A system prompt as named sections, so a change can be located: top-level `<tag>…</tag>` blocks (how Pi
 * assembles its prompt), markdown headings, and paragraphs for the text in between. Blank lines belong to
 * the section after them, so appending a section leaves the earlier ones unchanged; trailing blank lines
 * are ignored. Apart from those, sections tile the text, so any edit changes at least one section's hash.
 */
export function systemSections(text: string): { label: string; text: string }[] {
  const lines = text.split("\n");
  const spans: { label: string | undefined; from: number; to: number }[] = [];
  let from = 0;
  let label: string | undefined;
  let closing: string | undefined;
  const end = (to: number) => {
    if (to > from) spans.push({ label, from, to });
    from = to;
  };
  lines.forEach((line, index) => {
    if (closing !== undefined) {
      if (line.trim() !== closing) return;
      end(index + 1);
      label = closing = undefined;
      return;
    }
    const tag = TAG_OPEN.exec(line);
    const heading = tag ? null : HEADING.exec(line);
    if (!tag && !heading) return;
    end(index);
    label = tag ? `<${tag[1]}>` : `# ${heading![1]!.slice(0, 48)}`;
    if (tag) closing = `</${tag[1]}>`;
  });
  end(lines.length);

  const sections: { label: string; text: string }[] = [];
  const blanks: string[] = [];
  let paragraph = 0;
  const add = (label: string, body: string[]) => sections.push({ label, text: [...blanks.splice(0), ...body].join("\n") });
  for (const span of spans) {
    const body = lines.slice(span.from, span.to);
    if (span.label !== undefined) {
      let keep = body.length;
      while (keep > 1 && body[keep - 1]!.trim() === "") keep--;
      add(span.label, body.slice(0, keep));
      blanks.push(...body.slice(keep));
      continue;
    }
    // Loose text: a block is one paragraph together with the blank lines before it.
    const blocks: string[][] = [[]];
    let words = false;
    for (const line of body) {
      const blank = line.trim() === "";
      if (blank && words) { blocks.push([]); words = false; }
      blocks[blocks.length - 1]!.push(line);
      if (!blank) words = true;
    }
    for (const block of blocks) {
      if (block.every((line) => line.trim() === "")) blanks.push(...block);
      else add(sections.length === 0 ? "preamble" : `text ${++paragraph}`, block);
    }
  }
  if (sections.length > MAX_SECTIONS) {
    const rest = sections.splice(MAX_SECTIONS - 1);
    sections.push({ label: "rest", text: rest.map((section) => section.text).join("\n") });
  }
  const seen = new Map<string, number>();
  return sections.map((section) => {
    const times = (seen.get(section.label) ?? 0) + 1;
    seen.set(section.label, times);
    return times === 1 ? section : { ...section, label: `${section.label} #${times}` };
  });
}

/** Remember which tool each call id belongs to, so a result can be labelled with its tool's name. */
function rememberCalls(message: Record<string, unknown>, calls: Map<string, string>): void {
  const remember = (id: unknown, name: unknown) => { if (typeof id === "string" && typeof name === "string") calls.set(id, name); };
  remember(message.call_id, message.name); // Responses: function_call / custom_tool_call items
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      const part = record(block);
      if (part?.type === "tool_use") remember(part.id, part.name); // Anthropic
    }
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const entry = record(call);
      remember(entry?.id, record(entry?.function)?.name ?? entry?.name); // Chat Completions
    }
  }
}

/** `user`, `assistant`, `tool result: bash`, `tool call: bash`, `reasoning`, … for one message or input item. */
function messageLabel(message: Record<string, unknown>, calls: ReadonlyMap<string, string>): string {
  const type = message.type;
  if (type === "function_call" || type === "custom_tool_call") return `tool call: ${typeof message.name === "string" ? message.name : "?"}`;
  if (type === "function_call_output" || type === "custom_tool_call_output") return `tool result: ${calls.get(String(message.call_id)) ?? "?"}`;
  if (message.role === "tool") return `tool result: ${calls.get(String(message.tool_call_id)) ?? (typeof message.name === "string" ? message.name : "?")}`;
  if (Array.isArray(message.content)) {
    const names = new Set<string>();
    for (const block of message.content) {
      const part = record(block);
      if (part?.type === "tool_result") names.add(calls.get(String(part.tool_use_id)) ?? "?");
    }
    if (names.size) return `tool result: ${[...names].slice(0, 3).join(", ")}${names.size > 3 ? ` +${names.size - 3}` : ""}`;
  }
  return typeof message.role === "string" ? message.role : typeof type === "string" ? type : "message";
}

/**
 * The ordered segments of a provider payload: the model, each tool, each system-prompt section, then each
 * message. Understands Anthropic Messages (`system`, `messages`) and OpenAI Responses and Chat Completions
 * (`instructions`, `input` / `messages`, with the system prompt as the leading system or developer item);
 * any other shape is `undefined`. Cache markers are ignored. The payload is never modified.
 */
export function fingerprintPayload(payload: unknown, provider?: string): Segment[] | undefined {
  const body = record(payload);
  if (!body || typeof body.model !== "string") return undefined;
  const input: unknown[] | undefined = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input
    : typeof body.input === "string" ? [{ role: "user", content: body.input }] : undefined;
  if (!input) return undefined;

  const segments: Segment[] = [];
  const add = (kind: SegmentKind, label: string, value: unknown) => {
    const text = typeof value === "string" ? value : JSON.stringify(value, dropMarkers) ?? "";
    segments.push({ kind, label, hash: createHash("sha1").update(text).digest("base64url").slice(0, 12), size: text.length });
  };
  const model = provider ? `${provider}/${body.model}` : body.model;
  add("model", model, model);

  if (Array.isArray(body.tools)) {
    body.tools.forEach((tool: unknown, index) => {
      const definition = record(tool);
      const inner = record(definition?.function);
      const name = typeof definition?.name === "string" ? definition.name : typeof inner?.name === "string" ? inner.name
        : typeof definition?.type === "string" ? definition.type : `tool ${index + 1}`;
      add("tool", name, tool);
    });
  }

  // The system prompt travels as `system` (Anthropic), `instructions` (Responses) or leading system/developer items.
  const prompts = [textOf(body.system), textOf(body.instructions)];
  let leading = 0;
  for (; leading < input.length; leading++) {
    const item = record(input[leading]);
    if (!item || (item.role !== "system" && item.role !== "developer") || (item.type !== undefined && item.type !== "message")) break;
    prompts.push(textOf(item.content));
  }
  const texts = prompts.filter((text) => text !== "");
  texts.forEach((text, index) => {
    for (const section of systemSections(text)) add("system", texts.length > 1 ? `#${index + 1} ${section.label}` : section.label, section.text);
  });

  const calls = new Map<string, string>();
  for (const item of input.slice(leading)) {
    const message = record(item);
    if (message) rememberCalls(message, calls);
    // A provider turns the newest message's string content into a text block to carry its cache marker.
    const content = message && typeof message.content === "string" ? { ...message, content: [{ type: "text", text: message.content }] } : item;
    add("message", message ? messageLabel(message, calls) : "message", content);
  }
  return segments;
}

/** Names that differ between two sections of a prompt (tools, or system sections). */
interface Named { added: string[]; removed: string[]; changed: string[]; reordered: boolean }

export type PromptChange = { segment: number; first: string } & (
  | { kind: "model"; from: string; to: string }
  | ({ kind: "tools" } & Named)
  | ({ kind: "system" } & Named)
  | { kind: "message"; index: number; total: number; label: string; before: number; after: number; dropped: number }
  | { kind: "truncated"; from: number; to: number });

function diffNamed(before: readonly Segment[], after: readonly Segment[]): Named {
  const was = new Map(before.map((segment) => [segment.label, segment.hash]));
  const now = new Map(after.map((segment) => [segment.label, segment.hash]));
  const added = [...now.keys()].filter((label) => !was.has(label));
  const removed = [...was.keys()].filter((label) => !now.has(label));
  const changed = [...now].filter(([label, hash]) => was.has(label) && was.get(label) !== hash).map(([label]) => label);
  return { added, removed, changed, reordered: !added.length && !removed.length && !changed.length };
}

/**
 * Where `current` stops extending `previous`: the first segment that differs, classified by the earliest
 * prompt region it falls in. `undefined` when `previous` is a prefix of `current` (an identical prompt, or
 * only messages appended), the normal case in which the provider cache is read up to the old end.
 */
export function diffSegments(previous: readonly Segment[], current: readonly Segment[]): PromptChange | undefined {
  const shared = Math.min(previous.length, current.length);
  let at = 0;
  while (at < shared && previous[at]!.kind === current[at]!.kind && previous[at]!.hash === current[at]!.hash) at++;
  if (at === previous.length) return undefined;
  const old = previous[at]!;
  const now = current[at];
  const kind = now && KIND_ORDER[now.kind] < KIND_ORDER[old.kind] ? now.kind : old.kind;
  // Name the segment of the changed region itself: a removed tool is `old`, an added one is `now`.
  const first = `${kind} ${(now?.kind === kind ? now : old).label}`;
  const region = (segments: readonly Segment[]) => segments.filter((segment) => segment.kind === kind);
  if (kind === "model") return { kind, segment: at, first, from: old.label, to: now?.label ?? "" };
  if (kind === "tool") return { kind: "tools", segment: at, first, ...diffNamed(region(previous), region(current)) };
  if (kind === "system") return { kind, segment: at, first, ...diffNamed(region(previous), region(current)) };
  const before = region(previous).length;
  const total = region(current).length;
  if (!now) return { kind: "truncated", segment: at, first, from: before, to: total };
  return { kind: "message", segment: at, first, index: at - previous.findIndex((segment) => segment.kind === "message"), total,
    label: now.label, before: old.size, after: now.size, dropped: Math.max(0, before - total) };
}

/** `+added, -removed, ~changed`, at most three entries before `+N more`. */
function nameList(change: Named): string {
  const entries = [...change.added.map((name) => `+${name}`), ...change.removed.map((name) => `-${name}`), ...change.changed.map((name) => `~${name}`)];
  if (!entries.length) return "reordered";
  return (entries.length > 3 ? [...entries.slice(0, 2), `+${entries.length - 2} more`] : entries).join(", ");
}

/** One clause naming what changed: `tools changed (+jendral_build_get, +17 more)`. */
function describeChange(change: PromptChange): string {
  switch (change.kind) {
    case "model": return `model changed (${change.from} → ${change.to})`;
    case "tools": return `tools changed (${nameList(change)})`;
    case "system": return `system prompt changed (${nameList(change)})`;
    case "truncated": return `history shortened (${change.from} → ${change.to} messages)`;
    case "message": {
      const size = change.after < change.before ? `, ${formatTokens(change.before)} → ${formatTokens(change.after)} chars` : "";
      const dropped = change.dropped ? `; ${change.dropped} message${change.dropped === 1 ? "" : "s"} dropped` : "";
      return `message ${change.index + 1}/${change.total} ${change.after < change.before ? "shrank" : "changed"} (${change.label}${size}, ${change.total - 1 - change.index} from the end)${dropped}`;
    }
  }
}

/** The usage a provider reported for one call. */
export interface CallUsage {
  input?: unknown; cacheRead?: unknown; cacheWrite?: unknown;
  cost?: { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown; total?: unknown };
}

/**
 * Whether a call's cache read fits the previous prompt. `rewritten` is the part of the previous prompt (or
 * of this one, when smaller) that was billed again instead of read from the cache; a call is costly when
 * that exceeds {@link BREAK_SHORTFALL_TOKENS}, or when nothing was read from a prompt over {@link BREAK_COLD_TOKENS}.
 */
export function judgeCall(previousPrompt: number, usage: CallUsage | undefined): { rewritten: number; costly: boolean } {
  const prompt = contextTokens(usage);
  const cacheRead = count(usage?.cacheRead);
  const rewritten = Math.max(0, Math.min(previousPrompt, prompt) - cacheRead);
  return { rewritten, costly: rewritten > BREAK_SHORTFALL_TOKENS || (cacheRead === 0 && prompt > BREAK_COLD_TOKENS) };
}

/**
 * Extra dollars the rewritten tokens cost over reading them from the cache, from the call's own cost split:
 * its average price per fresh token (input plus cache write), minus its cache-read price (taken from the
 * call, else `readPerMTok`, the model's price per million tokens, else free). Undefined without a cost.
 */
export function rewriteCost(usage: CallUsage | undefined, rewritten: number, readPerMTok?: number): number | undefined {
  const fresh = count(usage?.input) + count(usage?.cacheWrite);
  const freshRate = fresh > 0 ? (count(usage?.cost?.input) + count(usage?.cost?.cacheWrite)) / fresh : 0;
  if (!(freshRate > 0) || rewritten <= 0) return undefined;
  const read = count(usage?.cacheRead);
  const readRate = read > 0 && count(usage?.cost?.cacheRead) > 0 ? count(usage?.cost?.cacheRead) / read : count(readPerMTok) / 1_000_000;
  return Math.round(rewritten * Math.max(0, freshRate - readRate) * 10_000) / 10_000;
}

export type BreakKind = PromptChange["kind"] | "idle" | "unknown";

/** One costly break, as listed by /cache-breaks and appended to the session's JSONL log. */
export interface CacheBreakRecord {
  version: 1;
  /** When the call was sent (ISO 8601). */
  timestamp: string;
  /** Provider calls observed for this session, counted from the first one pi-jar saw. */
  request: number;
  /** What changed: a prompt region, an expired cache (`idle`) or `unknown` when nothing in the prompt changed. */
  kind: BreakKind;
  summary: string;
  /** Index of the first changed segment in the ordered prompt (model, tools, system sections, messages), and what it is. */
  segment?: number;
  first?: string;
  model: string;
  promptTokens: number;
  cacheReadTokens: number;
  /** Tokens of the previous prompt that were billed again instead of read from the cache. */
  rewrittenTokens: number;
  /** Estimated extra cost in USD, when the call reported its cost. */
  costUsd?: number;
  /** Time since the cache was last known warm. */
  idleMs: number;
}

interface Baseline { segments: readonly Segment[]; prompt: number; at: number }
interface Pending { segments: readonly Segment[]; change: PromptChange | undefined }

/**
 * Correlates provider requests with the calls' usage. Feed it `request` for every provider payload and
 * `complete` for every assistant message; the baseline is the last completed call, so a failed or aborted
 * request neither moves it nor can be mistaken for a break.
 */
export class CacheBreakTracker {
  private baseline: Baseline | undefined;
  private pending: Pending | undefined;
  private warmAt = 0;
  private cacheSeen = false;
  private calls = 0;
  private offset = 0;
  private log: CacheBreakRecord[] = [];

  /** Calls checked since this session was loaded. */
  get checked(): number { return this.calls; }
  get breaks(): readonly CacheBreakRecord[] { return this.log; }

  /** The prompt about to be sent; `undefined` when the payload could not be fingerprinted. */
  request(segments: readonly Segment[] | undefined): void {
    this.pending = segments ? { segments, change: this.baseline ? diffSegments(this.baseline.segments, segments) : undefined } : undefined;
  }

  /** A deliberate change of history (compaction, tree navigation, disabling): the next call has nothing to compare with. */
  rebase(): void {
    this.baseline = undefined;
    this.pending = undefined;
  }

  /** Pi refreshed the provider cache while idle, which restarts its lifetime. */
  warmed(at: number): void { this.warmAt = Math.max(this.warmAt, at); }

  /** A new session: forget everything, then continue from the breaks an earlier run of it logged. */
  reset(earlier: readonly CacheBreakRecord[] = []): void {
    this.rebase();
    this.warmAt = this.calls = 0;
    this.cacheSeen = false;
    this.log = earlier.slice(-MAX_BREAKS);
    this.offset = earlier.reduce((last, entry) => Math.max(last, entry.request), 0);
  }

  /** An assistant message ended; the record when its call was a costly break. */
  complete(call: { usage: CallUsage | undefined; at: number; model: string; readPerMTok?: number }): CacheBreakRecord | undefined {
    const { pending, baseline } = this;
    this.pending = undefined;
    const prompt = contextTokens(call.usage);
    if (!prompt) return undefined; // Nothing reached the provider: keep the last good baseline.
    this.calls++;
    this.cacheSeen ||= count(call.usage?.cacheRead) + count(call.usage?.cacheWrite) > 0;
    this.baseline = pending ? { segments: pending.segments, prompt, at: call.at } : undefined;
    // Providers that never report caching make every call look cold, so wait for the first sign of it.
    if (!pending || !baseline || !this.cacheSeen) return undefined;
    const { rewritten, costly } = judgeCall(baseline.prompt, call.usage);
    if (!costly) return undefined;
    const idleMs = Math.max(0, call.at - Math.max(baseline.at, this.warmAt));
    const idle = idleMs >= CACHE_IDLE_MS;
    const { change } = pending;
    const cost = rewriteCost(call.usage, rewritten, call.readPerMTok);
    const entry: CacheBreakRecord = {
      version: 1, timestamp: new Date(call.at).toISOString(), request: this.offset + this.calls,
      kind: change?.kind ?? (idle ? "idle" : "unknown"),
      summary: change ? describeChange(change) + (idle ? `, after ${duration(idleMs)} idle` : "")
        : idle ? `cache expired after ${duration(idleMs)} idle` : "no prompt change found",
      ...(change ? { segment: change.segment, first: change.first } : {}),
      model: call.model, promptTokens: prompt, cacheReadTokens: count(call.usage?.cacheRead), rewrittenTokens: rewritten,
      ...(cost !== undefined ? { costUsd: cost } : {}), idleMs
    };
    this.log = [...this.log, entry].slice(-MAX_BREAKS);
    return entry;
  }
}

export interface BreakTotals { count: number; rewritten: number; cost: number }

/** Totals over breaks, overall and per cause. */
export function summarizeBreaks(breaks: readonly CacheBreakRecord[]): BreakTotals & { kinds: Map<BreakKind, BreakTotals> } {
  const total: BreakTotals = { count: 0, rewritten: 0, cost: 0 };
  const kinds = new Map<BreakKind, BreakTotals>();
  for (const entry of breaks) {
    const bucket = kinds.get(entry.kind) ?? { count: 0, rewritten: 0, cost: 0 };
    kinds.set(entry.kind, bucket);
    for (const sum of [total, bucket]) { sum.count++; sum.rewritten += entry.rewrittenTokens; sum.cost += entry.costUsd ?? 0; }
  }
  return { ...total, kinds };
}

/** Per-session JSONL log: `<agent dir>/pi-jar-cache-breaks/<session id>.jsonl`. */
export function cacheBreakFile(sessionId: string | undefined, directory = join(getAgentDir(), "pi-jar-cache-breaks")): string {
  return join(directory, `${(sessionId ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "session"}.jsonl`);
}

/** Breaks logged for a session so far; unreadable files and malformed lines are skipped. */
export function readCacheBreaks(file: string): CacheBreakRecord[] {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  const breaks: CacheBreakRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown> | undefined;
    try { parsed = record(JSON.parse(line)); } catch { continue; }
    if (parsed?.version === 1 && typeof parsed.kind === "string" && typeof parsed.summary === "string" && typeof parsed.timestamp === "string"
      && Number.isFinite(parsed.request) && Number.isFinite(parsed.rewrittenTokens) && Number.isFinite(parsed.promptTokens)) breaks.push(parsed as unknown as CacheBreakRecord);
  }
  return breaks.slice(-MAX_BREAKS);
}

/** What the /cache-breaks tab shows. */
export interface CacheBreakState { enabled: boolean; calls: number; breaks: readonly CacheBreakRecord[]; file: string | undefined }

/** The one thing needed from Pi's context to find a session's log. */
export interface SessionRef { sessionManager: { getSessionId(): string } }

export interface CacheBreakOptions {
  /** Runtime-toggleable setting; the caller owns its persisted value. */
  enabled(): boolean;
  /** Directory of the per-session logs, for tests; Pi's agent directory by default. */
  directory?: string;
}

/**
 * Watch provider requests and calls for costly cache breaks, announce each one and log it. Observes only:
 * the payload and the messages are never modified. A fingerprint of a payload that another extension
 * rewrites afterwards is of the payload as this extension saw it.
 */
export function registerCacheBreaks(pi: ExtensionAPI, options: CacheBreakOptions): { state(ctx: SessionRef): CacheBreakState } {
  const tracker = new CacheBreakTracker();
  const logFile = (ctx: SessionRef) => cacheBreakFile(ctx.sessionManager.getSessionId(), options.directory);

  pi.on("session_start", (_event, ctx) => {
    let earlier: CacheBreakRecord[] = [];
    try { earlier = readCacheBreaks(logFile(ctx)); } catch { /* The log is optional. */ }
    tracker.reset(earlier);
  });
  // Compaction and navigating the tree rewrite the history on purpose; the next call starts a new baseline.
  pi.on("session_compact", () => tracker.rebase());
  pi.on("session_tree", () => tracker.rebase());
  pi.on("cache_warming_decision", (event) => { if (event.action === "warm") tracker.warmed(Date.now()); });

  pi.on("before_provider_request", (event, ctx) => {
    if (!options.enabled()) { tracker.rebase(); return; }
    let segments: Segment[] | undefined;
    try { segments = fingerprintPayload(event.payload, ctx.model?.provider); } catch { /* Not a JSON-shaped payload. */ }
    tracker.request(segments);
    // No return value: Pi keeps the payload as it is.
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || !options.enabled()) return;
    try {
      const model = ctx.model?.provider === message.provider && ctx.model.id === message.model ? ctx.model : ctx.modelRegistry?.find?.(message.provider, message.model);
      const found = tracker.complete({
        usage: message.usage, model: `${message.provider}/${message.model}`, readPerMTok: model?.cost?.cacheRead,
        at: Number.isFinite(message.timestamp) && message.timestamp > 0 ? message.timestamp : Date.now()
      });
      if (!found) return;
      try {
        const file = logFile(ctx);
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        appendFileSync(file, JSON.stringify(found) + "\n", { mode: 0o600 });
      } catch { /* The notice and the tab still report it. */ }
      const cost = found.costUsd !== undefined ? ` (~${money(found.costUsd)})` : "";
      ctx.ui.notify(`cache break: ${found.summary} — rewrote ${formatTokens(found.rewrittenTokens)} tokens${cost}`, "warning");
    } catch { /* Diagnostics must never disturb a run. */ }
  });

  return {
    state(ctx) {
      let file: string | undefined;
      try { file = logFile(ctx); } catch { /* No session id yet. */ }
      return { enabled: options.enabled(), calls: tracker.checked, breaks: tracker.breaks, file };
    }
  };
}
