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
import { Text } from "@earendil-works/pi-tui";

type ToolResult = { content: Array<{ type: string; text?: string }>; details?: unknown };

const SUMMARY_SCAN_CHARS = 32 * 1024;
const DIFF_SCAN_CHARS = 64 * 1024;
const resultSummaryCache = new WeakMap<object, { sample: string; lines: number; truncated: boolean }>();
const writeCountCache = new WeakMap<object, { lines: number; truncated: boolean }>();

function summarizeResult(result: ToolResult): { sample: string; lines: number; truncated: boolean } {
  if (result && typeof result === "object") {
    const cached = resultSummaryCache.get(result as object);
    if (cached) return cached;
  }
  let sample = "";
  let truncated = false;
  let textParts = 0;
  for (const item of result.content) {
    if (item.type !== "text" || typeof item.text !== "string") continue;
    if (textParts++ && sample.length < SUMMARY_SCAN_CHARS) sample += "\n";
    const room = SUMMARY_SCAN_CHARS - sample.length;
    if (room <= 0) { truncated = true; break; }
    sample += item.text.slice(0, room);
    if (item.text.length > room) { truncated = true; break; }
  }
  const value = { sample, lines: sample ? sample.split("\n").length : 0, truncated };
  if (result && typeof result === "object") resultSummaryCache.set(result as object, value);
  return value;
}

function firstNonEmpty(text: string): string {
  for (const line of text.split("\n")) if (line.trim()) return line;
  return "";
}

function boundedLineCount(text: string, limit = SUMMARY_SCAN_CHARS): { lines: number; truncated: boolean } {
  const sample = text.slice(0, limit);
  return { lines: sample ? sample.split("\n").length : 0, truncated: text.length > limit };
}

const expandHint = " · [ expand ] Ctrl+O";

function compactText(text: string, max = 72): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, Math.max(0, max - 1)) + "…";
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
      const range = args.offset || args.limit
        ? theme.fg("dim", ` · ${args.offset ?? 1}${args.limit ? `+${args.limit}` : ""}`)
        : "";
      return new Text(theme.fg("toolTitle", theme.bold("read ")) + theme.fg("accent", args.path) + range, 0, 0);
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
      return new Text(theme.fg("toolTitle", theme.bold("$ ")) + theme.fg("accent", compactText(args.command, 88)), 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.expanded && bash.renderResult) return bash.renderResult(result as Parameters<NonNullable<typeof bash.renderResult>>[0], options, theme, context);
      const summary = summarizeResult(result);
      const first = firstNonEmpty(summary.sample);
      const preview = first ? ` · ${compactText(first, 56)}` : "";
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
      return new Text(theme.fg("toolTitle", theme.bold("edit ")) + theme.fg("accent", args.path), 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.expanded && edit.renderResult) return edit.renderResult(result, options, theme, context);
      if (options.isPartial) return new Text(theme.fg("warning", "editing…"), 0, 0);
      const details = result.details as { diff?: string } | undefined;
      const diff = details?.diff ?? "";
      if (!diff) {
        const summary = summarizeResult(result);
        const text = summary.sample;
        return new Text(theme.fg(text.startsWith("Error") ? "error" : "success", compactText(text || "applied", 96)), 0, 0);
      }
      if (diff.length > DIFF_SCAN_CHARS) return new Text(theme.fg("muted", `large diff${expandHint}`), 0, 0);
      let additions = 0;
      let removals = 0;
      for (const line of diff.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        else if (line.startsWith("-") && !line.startsWith("---")) removals++;
      }
      return new Text(theme.fg("success", `+${additions}`) + theme.fg("dim", " / ")
        + theme.fg("error", `-${removals}`) + theme.fg("dim", expandHint), 0, 0);
    }
  });

  pi.registerTool({
    ...write,
    renderCall(args, theme, context) {
      if (context.expanded && write.renderCall) return write.renderCall(args, theme, context);
      let count = args && typeof args === "object" ? writeCountCache.get(args as object) : undefined;
      if (!count) {
        count = boundedLineCount(args.content);
        if (args && typeof args === "object") writeCountCache.set(args as object, count);
      }
      return new Text(theme.fg("toolTitle", theme.bold("write ")) + theme.fg("accent", args.path)
        + theme.fg("dim", ` · ${count.lines}${count.truncated ? "+" : ""} lines`), 0, 0);
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
