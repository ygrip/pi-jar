import { stat } from "node:fs/promises";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  formatSize,
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ReadToolDetails
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isReadStub, readRangeKey, resolveToolPath, type ReadStubDetails } from "./context-diet.ts";

type ToolResult = { content: Array<{ type: string; text?: string }>; details?: unknown };

const SUMMARY_SCAN_CHARS = 32 * 1024;
const DIFF_SCAN_CHARS = 64 * 1024;
interface Summary { sample: string; lines: number; truncated: boolean; preview?: string }
/**
 * Pi hands renderResult a fresh `{ content, details }` wrapper on every display update, and Ctrl+O or a
 * theme change re-renders every tool of the session, so these caches key on the stable content/details.
 */
const resultSummaryCache = new WeakMap<object, Summary>();
const writeCountCache = new WeakMap<object, { lines: number; truncated: boolean }>();
const diffCountCache = new WeakMap<object, { diff: string; additions: number; removals: number }>();

/** Line count without splitting the text into an array. */
function lineCount(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) lines++;
  return lines;
}

function summarizeResult(result: ToolResult): Summary {
  const content = result.content;
  const cached = resultSummaryCache.get(content);
  if (cached) return cached;
  let sample = "";
  let truncated = false;
  let textParts = 0;
  for (const item of content) {
    if (item.type !== "text" || typeof item.text !== "string") continue;
    if (textParts++ && sample.length < SUMMARY_SCAN_CHARS) sample += "\n";
    const room = SUMMARY_SCAN_CHARS - sample.length;
    if (room <= 0) { truncated = true; break; }
    sample += item.text.slice(0, room);
    if (item.text.length > room) { truncated = true; break; }
  }
  const value: Summary = { sample, lines: lineCount(sample), truncated };
  if (content && typeof content === "object") resultSummaryCache.set(content, value);
  return value;
}

function firstNonEmpty(text: string): string {
  for (let start = 0; ;) {
    const end = text.indexOf("\n", start);
    const line = text.slice(start, end < 0 ? text.length : end);
    if (line.trim()) return line;
    if (end < 0) return "";
    start = end + 1;
  }
}

function boundedLineCount(text: string, limit = SUMMARY_SCAN_CHARS): { lines: number; truncated: boolean } {
  return { lines: lineCount(text.slice(0, limit)), truncated: text.length > limit };
}

const expandHint = " · [ expand ] Ctrl+O";

/** Streaming arguments arrive partially: a field can be missing or not yet a string. */
const str = (value: unknown): string => typeof value === "string" ? value : "";

type CardTheme = { bg(color: "toolPendingBg" | "toolErrorBg" | "toolSuccessBg", text: string): string };
interface CardContext { state?: { compactCard?: Box }; isPartial?: boolean; isError?: boolean; lastComponent?: unknown }
/**
 * Pi's edit tool renders its own framing (`renderShell: "self"`) so its expanded diff can own the
 * background. Collapsed, pi-jar draws the same padded, state-colored box Pi gives read/write, with the
 * call line and result summary in one card; the result renderer then contributes nothing.
 */
function compactCard(theme: CardTheme, context: CardContext, header: Text): Box | Text {
  if (!context.state) return header;
  const card = context.state.compactCard ??= new Box(1, 1);
  const color = context.isPartial !== false ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
  card.setBgFn((text) => theme.bg(color, text));
  card.clear();
  card.addChild(header);
  return card;
}
function intoCard(context: CardContext, line: Text): Container | Text {
  const card = context.state?.compactCard;
  if (!card) return line;
  card.addChild(line);
  const empty = context.lastComponent instanceof Container && !(context.lastComponent instanceof Box) ? context.lastComponent : new Container();
  empty.clear();
  return empty;
}

/** One collapsed edit result line: +/− counts from the diff, or the tool's own message. */
function editSummary(result: ToolResult, isPartial: boolean | undefined, theme: { fg(color: string, text: string): string }): Text {
  if (isPartial) return new Text(theme.fg("warning", "editing…"), 0, 0);
  const details = result.details as { diff?: string } | undefined;
  const diff = details?.diff ?? "";
  if (!diff) {
    const text = summarizeResult(result).sample;
    return new Text(theme.fg(text.startsWith("Error") ? "error" : "success", compactText(text || "applied", 96)), 0, 0);
  }
  if (diff.length > DIFF_SCAN_CHARS) return new Text(theme.fg("muted", `large diff${expandHint}`), 0, 0);
  let counts = diffCountCache.get(details!);
  if (counts?.diff !== diff) {
    counts = { diff, additions: 0, removals: 0 };
    for (let start = 0; start < diff.length;) {
      const end = diff.indexOf("\n", start);
      const stop = end < 0 ? diff.length : end;
      const first = diff[start];
      if (first === "+" && !diff.startsWith("+++", start)) counts.additions++;
      else if (first === "-" && !diff.startsWith("---", start)) counts.removals++;
      start = stop + 1;
    }
    diffCountCache.set(details!, counts);
  }
  return new Text(theme.fg("success", `+${counts.additions}`) + theme.fg("dim", " / ")
    + theme.fg("error", `-${counts.removals}`) + theme.fg("dim", expandHint), 0, 0);
}

/**
 * Whitespace-collapsed, trimmed text cut to `max` characters. Only a bounded prefix is scanned: a call
 * card re-renders on every streamed argument delta, so collapsing a whole heredoc each time was O(n²).
 */
function compactText(text: string, max = 72): string {
  for (let end = Math.min(text.length, 2 * max + 64); ; end = Math.min(text.length, end * 4)) {
    const clean = text.slice(0, end).replace(/\s+/g, " ").trimStart();
    if (end >= text.length) {
      const full = clean.trimEnd();
      return full.length <= max ? full : full.slice(0, Math.max(0, max - 1)) + "…";
    }
    // The collapsed prefix is a prefix of the whole; past max + 1 characters only one trailing space could still be trimmed.
    if (clean.length > max + 1) return clean.slice(0, Math.max(0, max - 1)) + "…";
  }
}

const bashCache = new WeakMap<object, { cwd: string; trusted: boolean; tool: ReturnType<typeof createBashToolDefinition> }>();
function bashFor(ctx: ExtensionContext) {
  const trusted = ctx.isProjectTrusted();
  const hit = bashCache.get(ctx as object);
  if (hit && hit.cwd === ctx.cwd && hit.trusted === trusted) return hit.tool;
  const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: trusted });
  const tool = createBashToolDefinition(ctx.cwd, {
    shellPath: settings.getShellPath(),
    commandPrefix: settings.getShellCommandPrefix()
  });
  bashCache.set(ctx as object, { cwd: ctx.cwd, trusted, tool });
  return tool;
}

/** Over Pi's 50 KB read cap, a read without offset/limit gets this many lines and a note saying so. */
const AUTO_LIMIT_BYTES = 50 * 1024;
const AUTO_LIMIT_LINES = 400;
/** Pi sends these as image attachments and ignores offset/limit for them. */
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
/** Pi's trailing `[… Use offset=N to continue.]` notice, which is not file text. */
const READ_NOTICE = /\n\n\[[^\n]*\]$/;

/** A read whose output is in context: the file revision it saw, its session ordinal and its line count. */
interface ReadMark { revision: string; ordinal: number; lines: number }

/**
 * Per-session record of what `read` put in context, behind the opt-in repeated-read stub. A mark answers
 * only for its exact path, line window and file revision. Anything that may change the file or drop that
 * output from context forgets marks: an edit/write of the path (even a failed edit: the model evidently
 * misremembers the file), a session start or switch, compaction and tree navigation.
 */
class ReadMemory {
  #files = new Map<string, Map<string, ReadMark>>();
  #reads = 0;
  /** Invalidation clock: a read that straddles an invalidation of its file is never remembered. */
  #clock = 0;
  #cleared = 0;
  #forgotten = new Map<string, number>();

  /** The session ordinal of a new read and the clock it starts at. */
  begin(): { ordinal: number; since: number } {
    return { ordinal: ++this.#reads, since: this.#clock };
  }
  find(file: string, range: string, revision: string): ReadMark | undefined {
    const mark = this.#files.get(file)?.get(range);
    return mark?.revision === revision ? mark : undefined;
  }
  remember(file: string, range: string, mark: ReadMark, since: number): void {
    if (this.#cleared > since || (this.#forgotten.get(file) ?? 0) > since) return;
    let ranges = this.#files.get(file);
    if (!ranges) this.#files.set(file, ranges = new Map());
    ranges.set(range, mark);
  }
  forget(file: string): void {
    this.#forgotten.set(file, ++this.#clock);
    this.#files.delete(file);
  }
  /** A new session also restarts read numbering. */
  clear(newSession = false): void {
    this.#cleared = ++this.#clock;
    this.#files.clear();
    this.#forgotten.clear();
    if (newSession) this.#reads = 0;
  }
}

/** A regular file's resolved path, size and revision (Pi's own dev:ino:size:mtime:ctime file key). */
async function inspectFile(path: string, cwd: string): Promise<{ file: string; size: number; revision: string } | undefined> {
  const file = resolveToolPath(path, cwd);
  if (!file) return undefined;
  try {
    const stats = await stat(file, { bigint: true });
    if (!stats.isFile()) return undefined;
    return { file, size: Number(stats.size), revision: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}` };
  } catch {
    // Missing or unreadable: Pi's read reports the error itself (or resolves a macOS name variant), uncached.
    return undefined;
  }
}

export interface CompactToolOptions {
  /** Opt-in repeated-read stub; consulted per call, so a settings toggle applies to the next read. */
  readCache?: () => boolean;
}

/**
 * Keep Pi's execution and schema, replace only the collapsed presentation and keep the per-call prompt
 * rules short (detail lives in tool and parameter descriptions). Expanded cards delegate back to Pi's
 * native renderers. `read` also caps whole reads of large files and can stub unchanged repeats.
 */
export function installCompactBuiltinTools(pi: ExtensionAPI, { readCache }: CompactToolOptions = {}): void {
  if (typeof (pi as ExtensionAPI & { registerTool?: unknown }).registerTool !== "function") return;

  const cwd = process.cwd();
  const read = createReadToolDefinition(cwd);
  const bash = createBashToolDefinition(cwd);
  const edit = createEditToolDefinition(cwd);
  const write = createWriteToolDefinition(cwd);

  // Without session events a mark could outlive a compaction, so the read cache requires them.
  const memory = typeof (pi as Partial<ExtensionAPI>).on === "function" ? new ReadMemory() : undefined;
  if (memory) {
    pi.on("session_start", () => memory.clear(true));
    pi.on("session_compact", () => memory.clear());
    pi.on("session_tree", () => memory.clear());
  }
  const forget = (path: string, ctx: ExtensionContext) => {
    const file = resolveToolPath(path, ctx.cwd);
    if (file) memory?.forget(file);
  };

  const readParameters = Type.Object({
    ...read.parameters.properties,
    force: Type.Optional(Type.Boolean({ description: "Re-read even if unchanged since an earlier read." }))
  });
  pi.registerTool<typeof readParameters, ReadToolDetails | ReadStubDetails | undefined>({
    ...read,
    description: `${read.description} Without offset/limit, files over ${formatSize(AUTO_LIMIT_BYTES)} stop at ${AUTO_LIMIT_LINES} lines.`,
    promptGuidelines: ["Use read, not cat/sed, to view files.", "Keep plans in jar_todo or the plan tool, not /tmp/*.md files you re-read."],
    parameters: readParameters,
    async execute(id, { force, ...request }, signal, onUpdate, ctx) {
      const cache = readCache?.() === true ? memory : undefined;
      // Taken before the stat: an invalidation from here on keeps this read from being remembered.
      const started = cache?.begin();
      const whole = request.offset === undefined && request.limit === undefined;
      const target = cache || whole ? await inspectFile(request.path, ctx.cwd) : undefined;
      const limited = whole && target !== undefined && target.size > AUTO_LIMIT_BYTES && !IMAGE_FILE.test(target.file);
      const effective = limited ? { ...request, limit: AUTO_LIMIT_LINES } : request;
      const range = readRangeKey(effective.offset, effective.limit);
      const slot = cache && started && target && range !== undefined
        ? { cache, ...started, file: target.file, range, revision: target.revision } : undefined;
      if (slot && !force) {
        const mark = slot.cache.find(slot.file, slot.range, slot.revision);
        if (mark) return {
          content: [{ type: "text", text: `[unchanged since read #${mark.ordinal} (${mark.lines} line${mark.lines === 1 ? "" : "s"}); pass force: true to re-read]` }],
          details: { unchangedSinceRead: mark.ordinal }
        };
      }
      const result = await read.execute(id, effective, signal, onUpdate, ctx);
      let text = "";
      for (const part of result.content) {
        // Images ignore offset/limit and are never remembered.
        if (part.type !== "text") return result;
        text += part.text;
      }
      slot?.cache.remember(slot.file, slot.range, { revision: slot.revision, ordinal: slot.ordinal, lines: lineCount(text.replace(READ_NOTICE, "")) }, slot.since);
      if (!limited) return result;
      const note = `\n\n[${formatSize(target.size)} file: a read without offset/limit returns its first ${AUTO_LIMIT_LINES} lines. Use offset/limit to read more.]`;
      const last = result.content.length - 1;
      return { ...result, content: result.content.map((part, index) => index === last && part.type === "text" ? { ...part, text: part.text + note } : part) };
    },
    renderCall(args, theme, context) {
      if (context.expanded && read.renderCall) return read.renderCall(args, theme, context);
      const range = args?.offset || args?.limit
        ? theme.fg("dim", ` · ${args.offset ?? 1}${args.limit ? `+${args.limit}` : ""}`)
        : "";
      return new Text(theme.fg("toolTitle", theme.bold("read ")) + theme.fg("accent", str(args?.path)) + range, 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.expanded && read.renderResult) return read.renderResult(result as Parameters<NonNullable<typeof read.renderResult>>[0], options, theme, context);
      if (options.isPartial) return new Text(theme.fg("warning", "reading…"), 0, 0);
      if (isReadStub(result.details)) return new Text(theme.fg("muted", `unchanged since read #${result.details.unchangedSinceRead}${expandHint}`), 0, 0);
      const summary = summarizeResult(result);
      const count = `${summary.lines}${summary.truncated ? "+" : ""}`;
      return new Text(theme.fg("muted", `${count} line${summary.lines === 1 && !summary.truncated ? "" : "s"}${expandHint}`), 0, 0);
    }
  });

  pi.registerTool({
    ...bash,
    description: `${bash.description} PI_* env vars describe the current model and session.`,
    promptGuidelines: [],
    async execute(id, params, signal, onUpdate, ctx) {
      return bashFor(ctx).execute(id, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      if (context.expanded && bash.renderCall) return bash.renderCall(args, theme, context);
      return new Text(theme.fg("toolTitle", theme.bold("$ ")) + theme.fg("accent", compactText(str(args?.command), 88)), 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.expanded && bash.renderResult) return bash.renderResult(result as Parameters<NonNullable<typeof bash.renderResult>>[0], options, theme, context);
      const summary = summarizeResult(result);
      if (summary.preview === undefined) {
        const first = firstNonEmpty(summary.sample);
        summary.preview = first ? ` · ${compactText(first, 56)}` : "";
      }
      const preview = summary.preview;
      const count = `${summary.lines}${summary.truncated ? "+" : ""}`;
      const label = options.isPartial ? "running" : "done";
      return new Text(theme.fg(options.isPartial ? "warning" : "muted",
        `${label} · ${count} line${summary.lines === 1 && !summary.truncated ? "" : "s"}${preview}${expandHint}`), 0, 0);
    }
  });

  pi.registerTool({
    ...edit,
    promptSnippet: "Precise exact-text file edits",
    promptGuidelines: ["Batch all changes to one file into one edit call (several edits[] entries); keep each oldText minimal but unique."],
    execute(id, params, signal, onUpdate, ctx) {
      return edit.execute(id, params, signal, onUpdate, ctx).finally(() => forget(params.path, ctx));
    },
    renderCall(args, theme, context) {
      if (context.expanded && edit.renderCall) return edit.renderCall(args, theme, context);
      const path = str(args?.path) || str((args as { file_path?: unknown } | undefined)?.file_path);
      return compactCard(theme, context, new Text(theme.fg("toolTitle", theme.bold("edit ")) + theme.fg("accent", path), 0, 0));
    },
    renderResult(result, options, theme, context) {
      if (options.expanded && edit.renderResult) return edit.renderResult(result as Parameters<NonNullable<typeof edit.renderResult>>[0], options, theme, context);
      return intoCard(context, editSummary(result, options.isPartial, theme));
    }
  });

  pi.registerTool({
    ...write,
    promptSnippet: "Create new files or complete rewrites; use edit for partial changes",
    promptGuidelines: [],
    execute(id, params, signal, onUpdate, ctx) {
      return write.execute(id, params, signal, onUpdate, ctx).finally(() => forget(params.path, ctx));
    },
    renderCall(args, theme, context) {
      if (context.expanded && write.renderCall) return write.renderCall(args, theme, context);
      const content = str(args?.content);
      let count = args && typeof args === "object" ? writeCountCache.get(args as object) : undefined;
      if (!count) {
        count = boundedLineCount(content);
        if (args && typeof args === "object") writeCountCache.set(args as object, count);
      }
      return new Text(theme.fg("toolTitle", theme.bold("write ")) + theme.fg("accent", str(args?.path))
        + theme.fg("dim", ` · ${count.lines}${count.truncated ? "+" : ""} line${count.lines === 1 && !count.truncated ? "" : "s"}`), 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.expanded && write.renderResult) return write.renderResult(result as Parameters<NonNullable<typeof write.renderResult>>[0], options, theme, context);
      if (options.isPartial) return new Text(theme.fg("warning", "writing…"), 0, 0);
      const summary = summarizeResult(result);
      const text = summary.sample;
      return new Text(theme.fg(text.startsWith("Error") ? "error" : "success", compactText(text || "written", 96))
        + theme.fg("dim", text ? expandHint : ""), 0, 0);
    }
  });
}
