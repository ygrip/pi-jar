import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { estimate } from "./context-view.ts";
import { money, row, tokens, type Paint } from "./panel.ts";

/** Tokens charged for one image part, matching the context view. */
const IMAGE_TOKENS = 1600;
/** A call is a cache miss when at least this many prompt tokens were billed uncached. */
export const MISS_THRESHOLD_TOKENS = 10_000;
const LARGE_CONTEXT_TOKENS = 200_000;
const TOP_ROWS = 8;

export interface AuditInput {
  /** Session branch entries, oldest first. */
  entries: readonly unknown[];
  /** Cost and call count of side models (advisor, titles). */
  side?: { calls: number; cost: number };
  /** Costly cache breaks already explained by the cache diagnostics. */
  breaks?: { count: number; rewritten: number; cost: number };
}

export interface ToolAuditRow {
  name: string;
  calls: number;
  tokens: number;
  average: number;
  max: number;
  /** Share of all re-read context cost, 0-100. */
  share: number;
}

export interface NamedShare { name: string; tokens: number; count: number; share: number }

export interface TokenAudit {
  calls: number;
  models: { model: string; calls: number }[];
  modelSwitches: number;
  cost: { input: number; cacheRead: number; cacheWrite: number; output: number; total: number };
  usage: { uncached: number; cacheRead: number; output: number };
  context: { average: number; max: number; latest: number; largeCalls: number; growthPerCall: number };
  misses: { count: number; tokens: number; largest: number };
  assistant: { thinking: NamedShare; toolArguments: NamedShare; text: NamedShare };
  tools: ToolAuditRow[];
  extension: NamedShare[];
  repeatedReads: { path: string; reads: number; tokens: number }[];
  lazy: { replaced: number; savedTokens: number };
  /** Estimated tokens in the live context against the provider-reported total. */
  estimatedContext: number;
  breaks: AuditInput["breaks"];
  side: AuditInput["side"];
}

interface Entry {
  type?: string;
  customType?: string;
  data?: { ids?: unknown[]; savedTokens?: number };
  content?: unknown;
  summary?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    toolCallId?: string;
    provider?: string;
    model?: string;
    usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; cost?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; total?: number } };
  };
}

interface Part { type?: string; text?: string; thinking?: string; thinkingSignature?: string; name?: string; id?: string; arguments?: unknown }

const parts = (content: unknown): Part[] => Array.isArray(content) ? content as Part[] : [];

function contentTokens(content: unknown): number {
  if (typeof content === "string") return estimate(content.length);
  let chars = 0;
  let images = 0;
  for (const part of parts(content)) {
    if (part.type === "text") chars += part.text?.length ?? 0;
    else if (part.type === "image") images++;
  }
  return estimate(chars) + images * IMAGE_TOKENS;
}

interface Accumulator { tokens: number; count: number; weighted: number; max: number }
const newAccumulator = (): Accumulator => ({ tokens: 0, count: 0, weighted: 0, max: 0 });

function add(into: Accumulator, size: number, laterCalls: number): void {
  into.tokens += size;
  into.count++;
  into.weighted += size * laterCalls;
  into.max = Math.max(into.max, size);
}

function bump(map: Map<string, Accumulator>, key: string, size: number, laterCalls: number): void {
  let accumulator = map.get(key);
  if (!accumulator) { accumulator = newAccumulator(); map.set(key, accumulator); }
  add(accumulator, size, laterCalls);
}

/** Index of the first entry of the live context: everything after the last compaction. */
function epochStart(entries: readonly Entry[]): number {
  for (let index = entries.length - 1; index >= 0; index--) if (entries[index]!.type === "compaction") return index;
  return 0;
}

const isAssistantCall = (entry: Entry) => entry.type === "message" && entry.message?.role === "assistant";

/**
 * Where the tokens and the money went. "Re-read cost" weighs every item by the number of later
 * model calls that re-sent it: the context is billed on every call, so an item that arrives early
 * and stays costs far more than one that arrives last.
 */
export function auditSession(input: AuditInput): TokenAudit {
  const entries = input.entries as readonly Entry[];
  const start = epochStart(entries);
  const epochCalls = entries.slice(start).filter(isAssistantCall).length;

  const modelCalls = new Map<string, number>();
  const cost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
  const usage = { uncached: 0, cacheRead: 0, output: 0 };
  const sizes: number[] = [];
  const misses = { count: 0, tokens: 0, largest: 0 };
  let modelSwitches = 0;
  let lastModel: string | undefined;

  const thinking = newAccumulator();
  const toolArguments = newAccumulator();
  const text = newAccumulator();
  const tools = new Map<string, Accumulator>();
  const extension = new Map<string, Accumulator>();
  const readPaths = new Map<string, { reads: number; tokens: number }>();
  const readById = new Map<string, string>();
  let summaryTokens = 0;
  let userTokens = 0;
  let lazyReplaced = 0;
  let lazySaved = 0;
  let callsSoFar = 0;

  entries.forEach((entry, index) => {
    const live = index >= start;
    if (entry.type === "custom" && entry.customType === "pi-jar.lazy-output") {
      lazyReplaced += entry.data?.ids?.length ?? 0;
      lazySaved = Math.max(lazySaved, entry.data?.savedTokens ?? 0);
      return;
    }
    if (entry.type === "compaction") { summaryTokens = estimate((entry.summary ?? "").length); return; }
    if (entry.type === "custom_message") {
      if (live) bump(extension, entry.customType ?? "custom", contentTokens(entry.content), Math.max(0, epochCalls - callsSoFar));
      return;
    }
    const message = entry.message;
    if (entry.type !== "message" || !message) return;
    if (message.role === "user") { if (live) userTokens += contentTokens(message.content); return; }
    if (message.role === "toolResult") {
      if (!live) return;
      const size = contentTokens(message.content);
      const name = message.toolName ?? "tool";
      bump(tools, name, size, Math.max(0, epochCalls - callsSoFar));
      const path = readById.get(message.toolCallId ?? "");
      if (path) {
        const seen = readPaths.get(path) ?? { reads: 0, tokens: 0 };
        seen.reads++;
        seen.tokens += size;
        readPaths.set(path, seen);
      }
      return;
    }
    if (message.role !== "assistant") return;

    const model = `${message.provider ?? "?"}/${message.model ?? "?"}`;
    modelCalls.set(model, (modelCalls.get(model) ?? 0) + 1);
    if (lastModel !== undefined && lastModel !== model) modelSwitches++;
    lastModel = model;
    const used = message.usage;
    if (used) {
      const prompt = (used.input ?? 0) + (used.cacheRead ?? 0) + (used.cacheWrite ?? 0);
      usage.uncached += used.input ?? 0;
      usage.cacheRead += used.cacheRead ?? 0;
      usage.output += used.output ?? 0;
      cost.input += used.cost?.input ?? 0;
      cost.cacheRead += used.cost?.cacheRead ?? 0;
      cost.cacheWrite += used.cost?.cacheWrite ?? 0;
      cost.output += used.cost?.output ?? 0;
      cost.total += used.cost?.total ?? 0;
      if (prompt > 0) sizes.push(prompt);
      const uncached = (used.input ?? 0) + (used.cacheWrite ?? 0);
      if (prompt > 0 && uncached >= MISS_THRESHOLD_TOKENS) {
        misses.count++;
        misses.tokens += uncached;
        misses.largest = Math.max(misses.largest, uncached);
      }
    }
    callsSoFar++;
    if (!live) return;
    const later = Math.max(0, epochCalls - callsSoFar);
    for (const part of parts(message.content)) {
      if (part.type === "thinking") add(thinking, estimate((part.thinking?.length ?? 0) + (part.thinkingSignature?.length ?? 0)), later);
      else if (part.type === "toolCall") {
        add(toolArguments, estimate(JSON.stringify(part.arguments ?? {}).length + 40), later);
        const path = part.name === "read" ? (part.arguments as { path?: unknown } | undefined)?.path : undefined;
        if (typeof path === "string" && part.id) readById.set(part.id, path);
      } else if (part.type === "text") add(text, estimate(part.text?.length ?? 0), later);
    }
  });

  const totalWeighted = thinking.weighted + toolArguments.weighted + text.weighted
    + [...tools.values(), ...extension.values()].reduce((sum, item) => sum + item.weighted, 0) || 1;
  const share = (item: Accumulator) => item.weighted / totalWeighted * 100;
  const named = (name: string, item: Accumulator): NamedShare => ({ name, tokens: item.tokens, count: item.count, share: share(item) });

  const toolRows = [...tools.entries()].map(([name, item]): ToolAuditRow => ({
    name, calls: item.count, tokens: item.tokens, average: item.count ? Math.round(item.tokens / item.count) : 0, max: item.max, share: share(item)
  })).sort((a, b) => b.share - a.share);
  const reads = [...readPaths.entries()].filter(([, value]) => value.reads > 1)
    .map(([path, value]) => ({ path, ...value })).sort((a, b) => b.tokens - a.tokens);
  const latest = sizes.at(-1) ?? 0;
  const first = sizes[0] ?? 0;
  const estimatedContext = thinking.tokens + toolArguments.tokens + text.tokens + summaryTokens + userTokens
    + [...tools.values(), ...extension.values()].reduce((sum, item) => sum + item.tokens, 0);

  return {
    calls: sizes.length,
    models: [...modelCalls.entries()].map(([model, calls]) => ({ model, calls })).sort((a, b) => b.calls - a.calls),
    modelSwitches, cost, usage,
    context: {
      average: sizes.length ? Math.round(sizes.reduce((sum, size) => sum + size, 0) / sizes.length) : 0,
      max: Math.max(0, ...sizes), latest,
      largeCalls: sizes.filter((size) => size >= LARGE_CONTEXT_TOKENS).length,
      growthPerCall: sizes.length > 1 ? Math.round((latest - first) / (sizes.length - 1)) : 0
    },
    misses,
    assistant: { thinking: named("Thinking", thinking), toolArguments: named("Tool arguments", toolArguments), text: named("Text", text) },
    tools: toolRows,
    extension: [...extension.entries()].map(([name, item]) => named(name, item)).sort((a, b) => b.share - a.share),
    repeatedReads: reads,
    lazy: { replaced: lazyReplaced, savedTokens: lazySaved },
    estimatedContext, breaks: input.breaks, side: input.side
  };
}

const percent = (value: number) => value.toFixed(value < 10 ? 1 : 0) + "%";

/** The panel: biggest contributors first, with the numbers behind every claim. */
export function tokenAuditLines(audit: TokenAudit, width: number, fg: Paint): string[] {
  const inner = Math.max(30, width - 2);
  const heading = (title: string) => fg("accent", title);
  const line = (label: string, value: string) => "  " + row(label, value, inner - 2);
  const lines: string[] = [];
  if (!audit.calls) return [heading("Token audit"), fg("dim", "  No model call in this session yet.")];

  const total = audit.cost.total || 1;
  lines.push(heading("Cost"));
  lines.push(line("Total", money(audit.cost.total) + fg("dim", ` · ${audit.calls} model requests`)));
  lines.push(line("Cache reads", money(audit.cost.cacheRead) + fg("dim", ` · ${percent(audit.cost.cacheRead / total * 100)} · ${tokens(audit.usage.cacheRead)} tokens`)));
  lines.push(line("Uncached input", money(audit.cost.input + audit.cost.cacheWrite) + fg("dim", ` · ${percent((audit.cost.input + audit.cost.cacheWrite) / total * 100)} · ${tokens(audit.usage.uncached)} tokens`)));
  lines.push(line("Output", money(audit.cost.output) + fg("dim", ` · ${tokens(audit.usage.output)} tokens`)));
  if (audit.side?.calls) lines.push(line("Side models", money(audit.side.cost) + fg("dim", ` · ${audit.side.calls} calls`)));

  lines.push("", heading("Context per request"));
  lines.push(line("Average / max", `${tokens(audit.context.average)} / ${tokens(audit.context.max)}`));
  lines.push(line("Latest", tokens(audit.context.latest)));
  lines.push(line("Growth per request", "+" + tokens(audit.context.growthPerCall)));
  lines.push(line("Requests over 200k", String(audit.context.largeCalls)));

  lines.push("", heading("Top tool results"), fg("dim", "  " + row("tool  (calls · avg · max)", "tokens · re-read cost", inner - 2)));
  for (const tool of audit.tools.slice(0, TOP_ROWS)) {
    lines.push(line(`${tool.name}  ${fg("dim", `${tool.calls} · ${tokens(tool.average)} · ${tokens(tool.max)}`)}`, `${tokens(tool.tokens)} · ${percent(tool.share)}`));
  }
  if (!audit.tools.length) lines.push(fg("dim", "  none in the live context"));

  lines.push("", heading("Assistant content"));
  for (const item of [audit.assistant.thinking, audit.assistant.toolArguments, audit.assistant.text]) {
    lines.push(line(item.name, `${tokens(item.tokens)} · ${percent(item.share)}`));
  }

  if (audit.extension.length) {
    lines.push("", heading("Extension messages"));
    for (const item of audit.extension.slice(0, 5)) lines.push(line(`${item.name}  ${fg("dim", String(item.count) + "×")}`, `${tokens(item.tokens)} · ${percent(item.share)}`));
  }

  if (audit.repeatedReads.length) {
    lines.push("", heading("Repeated reads"));
    for (const item of audit.repeatedReads.slice(0, 5)) {
      const room = Math.max(10, inner - 24);
      const path = item.path.length > room ? "…" + item.path.slice(-(room - 1)) : item.path;
      lines.push(line(path, `${item.reads}× · ${tokens(item.tokens)}`));
    }
  }

  lines.push("", heading("Cache"));
  lines.push(line("Misses (≥10k uncached)", `${audit.misses.count} · ${tokens(audit.misses.tokens)} tokens`));
  if (audit.breaks?.count) lines.push(line("Explained breaks", `${audit.breaks.count} · ${tokens(audit.breaks.rewritten)} · ~${money(audit.breaks.cost)}`));
  lines.push(line("Model switches", String(audit.modelSwitches)));
  lines.push(line("Lazy tool output", audit.lazy.replaced ? `${audit.lazy.replaced} replaced` : "nothing replaced"));

  const note = `Re-read cost weighs each item by the later requests that re-sent it. Sizes are ~4 chars/token estimates; the live context is ~${tokens(audit.estimatedContext)} estimated against ${tokens(audit.context.latest)} reported.`;
  lines.push("", ...wrapTextWithAnsi(note, inner).map((wrapped) => fg("dim", wrapped)));
  return lines;
}
