import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type ToolResult = { content: Array<{ type: string; text?: string }>; details?: unknown };

const outputText = (result: ToolResult): string => result.content
  .filter((item) => item.type === "text" && typeof item.text === "string")
  .map((item) => item.text!)
  .join("\n");

const nonEmptyLines = (text: string): string[] => text.split("\n").filter((line) => line.trim().length > 0);
const expandHint = " · click/Ctrl+E to expand";

function compactText(text: string, max = 72): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, Math.max(0, max - 1)) + "…";
}

function fullText(text: string, theme: { fg(color: string, text: string): string }): Text {
  if (!text) return new Text(theme.fg("dim", "(no output)"), 0, 0);
  return new Text(text.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n"), 0, 0);
}

const cache = new Map<string, ReturnType<typeof createTools>>();
function createTools(cwd: string) {
  return {
    read: createReadTool(cwd),
    bash: createBashTool(cwd),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
    grep: createGrepTool(cwd),
    find: createFindTool(cwd),
    ls: createLsTool(cwd)
  };
}
function toolsFor(cwd: string) {
  let tools = cache.get(cwd);
  if (!tools) {
    tools = createTools(cwd);
    cache.set(cwd, tools);
  }
  return tools;
}

export function installCompactBuiltinTools(pi: ExtensionAPI): void {
  if (typeof (pi as ExtensionAPI & { registerTool?: unknown }).registerTool !== "function") return;

  const seed = toolsFor(process.cwd());

  pi.registerTool({
    name: "read", label: "read", description: seed.read.description, parameters: seed.read.parameters,
    async execute(id, params, signal, onUpdate, ctx) { return toolsFor(ctx.cwd).read.execute(id, params, signal, onUpdate); },
    renderCall(args, theme) {
      const range = args.offset || args.limit ? theme.fg("dim", ` · ${args.offset ?? 1}${args.limit ? `+${args.limit}` : ""}`) : "";
      return new Text(theme.fg("toolTitle", theme.bold("read ")) + theme.fg("accent", args.path) + range, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "reading…"), 0, 0);
      const text = outputText(result);
      if (expanded) return fullText(text, theme);
      const count = text.split("\n").length;
      return new Text(theme.fg("muted", `${count} line${count === 1 ? "" : "s"}${expandHint}`), 0, 0);
    }
  });

  pi.registerTool({
    name: "bash", label: "bash", description: seed.bash.description, parameters: seed.bash.parameters,
    async execute(id, params, signal, onUpdate, ctx) { return toolsFor(ctx.cwd).bash.execute(id, params, signal, onUpdate); },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("$ ")) + theme.fg("accent", compactText(args.command, 88)), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const text = outputText(result);
      if (expanded) return fullText(text, theme);
      const lines = nonEmptyLines(text);
      const preview = lines[0] ? ` · ${compactText(lines[0], 56)}` : "";
      const label = isPartial ? "running" : "done";
      return new Text(theme.fg(isPartial ? "warning" : "muted", `${label} · ${lines.length} line${lines.length === 1 ? "" : "s"}${preview}${expandHint}`), 0, 0);
    }
  });

  pi.registerTool({
    name: "edit", label: "edit", description: seed.edit.description, parameters: seed.edit.parameters,
    async execute(id, params, signal, onUpdate, ctx) { return toolsFor(ctx.cwd).edit.execute(id, params, signal, onUpdate); },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("edit ")) + theme.fg("accent", args.path), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "editing…"), 0, 0);
      const details = result.details as { diff?: string } | undefined;
      const diff = details?.diff ?? "";
      if (!diff) {
        const text = outputText(result);
        return new Text(theme.fg(text.startsWith("Error") ? "error" : "success", compactText(text || "applied", 96)), 0, 0);
      }
      if (expanded) return fullText(diff, theme);
      let additions = 0;
      let removals = 0;
      for (const line of diff.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        else if (line.startsWith("-") && !line.startsWith("---")) removals++;
      }
      return new Text(theme.fg("success", `+${additions}`) + theme.fg("dim", " / ") + theme.fg("error", `-${removals}`) + theme.fg("dim", expandHint), 0, 0);
    }
  });

  pi.registerTool({
    name: "write", label: "write", description: seed.write.description, parameters: seed.write.parameters,
    async execute(id, params, signal, onUpdate, ctx) { return toolsFor(ctx.cwd).write.execute(id, params, signal, onUpdate); },
    renderCall(args, theme) {
      const count = args.content.split("\n").length;
      return new Text(theme.fg("toolTitle", theme.bold("write ")) + theme.fg("accent", args.path) + theme.fg("dim", ` · ${count} lines`), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "writing…"), 0, 0);
      const text = outputText(result);
      if (expanded && text) return fullText(text, theme);
      return new Text(theme.fg(text.startsWith("Error") ? "error" : "success", compactText(text || "written", 96)) + theme.fg("dim", text ? expandHint : ""), 0, 0);
    }
  });

  pi.registerTool({
    name: "grep", label: "grep", description: seed.grep.description, parameters: seed.grep.parameters,
    async execute(id, params, signal, onUpdate, ctx) { return toolsFor(ctx.cwd).grep.execute(id, params, signal, onUpdate); },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("grep ")) + theme.fg("accent", `/${args.pattern}/ in ${args.path ?? "."}`), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const text = outputText(result);
      if (expanded) return fullText(text, theme);
      const count = nonEmptyLines(text).length;
      return new Text(theme.fg(isPartial ? "warning" : "muted", `${isPartial ? "searching" : count + " match" + (count === 1 ? "" : "es")}${expandHint}`), 0, 0);
    }
  });

  pi.registerTool({
    name: "find", label: "find", description: seed.find.description, parameters: seed.find.parameters,
    async execute(id, params, signal, onUpdate, ctx) { return toolsFor(ctx.cwd).find.execute(id, params, signal, onUpdate); },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("find ")) + theme.fg("accent", `${args.pattern} in ${args.path ?? "."}`), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const text = outputText(result);
      if (expanded) return fullText(text, theme);
      const count = nonEmptyLines(text).length;
      return new Text(theme.fg(isPartial ? "warning" : "muted", `${isPartial ? "searching" : count + " file" + (count === 1 ? "" : "s")}${expandHint}`), 0, 0);
    }
  });

  pi.registerTool({
    name: "ls", label: "ls", description: seed.ls.description, parameters: seed.ls.parameters,
    async execute(id, params, signal, onUpdate, ctx) { return toolsFor(ctx.cwd).ls.execute(id, params, signal, onUpdate); },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("ls ")) + theme.fg("accent", args.path ?? "."), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const text = outputText(result);
      if (expanded) return fullText(text, theme);
      const count = nonEmptyLines(text).length;
      return new Text(theme.fg(isPartial ? "warning" : "muted", `${isPartial ? "listing" : count + " entr" + (count === 1 ? "y" : "ies")}${expandHint}`), 0, 0);
    }
  });
}
