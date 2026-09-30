import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";

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

/**
 * Keep Pi's execution/schema/prompt metadata intact and replace only the collapsed
 * presentation. Expanded cards delegate back to Pi's native renderers.
 */
export function installCompactBuiltinTools(pi: ExtensionAPI): void {
  if (typeof (pi as ExtensionAPI & { registerTool?: unknown }).registerTool !== "function") return;

  const cwd = process.cwd();
  const read = createReadToolDefinition(cwd);
  const bash = createBashToolDefinition(cwd);
  const edit = createEditToolDefinition(cwd);
  const write = createWriteToolDefinition(cwd);

  pi.registerTool({
    ...read,
    renderCall(args, theme, context) {
      if (context.expanded && read.renderCall) return read.renderCall(args, theme, context);
      const range = args?.offset || args?.limit
        ? theme.fg("dim", ` · ${args.offset ?? 1}${args.limit ? `+${args.limit}` : ""}`)
        : "";
      return new Text(theme.fg("toolTitle", theme.bold("read ")) + theme.fg("accent", str(args?.path)) + range, 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.expanded && read.renderResult) return read.renderResult(result, options, theme, context);
      if (options.isPartial) return new Text(theme.fg("warning", "reading…"), 0, 0);
      const summary = summarizeResult(result);
      const count = `${summary.lines}${summary.truncated ? "+" : ""}`;
      return new Text(theme.fg("muted", `${count} line${summary.lines === 1 && !summary.truncated ? "" : "s"}${expandHint}`), 0, 0);
    }
  });

  pi.registerTool({
    ...bash,
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
    renderCall(args, theme, context) {
      if (context.expanded && edit.renderCall) return edit.renderCall(args, theme, context);
      const path = str(args?.path) || str((args as { file_path?: unknown } | undefined)?.file_path);
      return compactCard(theme, context, new Text(theme.fg("toolTitle", theme.bold("edit ")) + theme.fg("accent", path), 0, 0));
    },
    renderResult(result, options, theme, context) {
      if (options.expanded && edit.renderResult) return edit.renderResult(result, options, theme, context);
      return intoCard(context, editSummary(result, options.isPartial, theme));
    }
  });

  pi.registerTool({
    ...write,
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
      if (options.expanded && write.renderResult) return write.renderResult(result, options, theme, context);
      if (options.isPartial) return new Text(theme.fg("warning", "writing…"), 0, 0);
      const summary = summarizeResult(result);
      const text = summary.sample;
      return new Text(theme.fg(text.startsWith("Error") ? "error" : "success", compactText(text || "written", 96))
        + theme.fg("dim", text ? expandHint : ""), 0, 0);
    }
  });
}
