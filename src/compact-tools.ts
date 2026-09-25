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

const outputText = (result: ToolResult): string => result.content
  .filter((item) => item.type === "text" && typeof item.text === "string")
  .map((item) => item.text!)
  .join("\n");

const nonEmptyLines = (text: string): string[] => text.split("\n").filter((line) => line.trim().length > 0);
const expandHint = " · [ expand ] Ctrl+O";

function compactText(text: string, max = 72): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, Math.max(0, max - 1)) + "…";
}

function bashFor(ctx: ExtensionContext) {
  const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
  return createBashToolDefinition(ctx.cwd, {
    shellPath: settings.getShellPath(),
    commandPrefix: settings.getShellCommandPrefix()
  });
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
      const text = outputText(result);
      const count = text ? text.split("\n").length : 0;
      return new Text(theme.fg("muted", `${count} line${count === 1 ? "" : "s"}${expandHint}`), 0, 0);
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
      const text = outputText(result);
      const lines = nonEmptyLines(text);
      const preview = lines[0] ? ` · ${compactText(lines[0], 56)}` : "";
      const label = options.isPartial ? "running" : "done";
      return new Text(theme.fg(options.isPartial ? "warning" : "muted",
        `${label} · ${lines.length} line${lines.length === 1 ? "" : "s"}${preview}${expandHint}`), 0, 0);
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
        const text = outputText(result);
        return new Text(theme.fg(text.startsWith("Error") ? "error" : "success", compactText(text || "applied", 96)), 0, 0);
      }
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
      const count = args.content.split("\n").length;
      return new Text(theme.fg("toolTitle", theme.bold("write ")) + theme.fg("accent", args.path)
        + theme.fg("dim", ` · ${count} lines`), 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.expanded && write.renderResult) return write.renderResult(result, options, theme, context);
      if (options.isPartial) return new Text(theme.fg("warning", "writing…"), 0, 0);
      const text = outputText(result);
      return new Text(theme.fg(text.startsWith("Error") ? "error" : "success", compactText(text || "written", 96))
        + theme.fg("dim", text ? expandHint : ""), 0, 0);
    }
  });
}
