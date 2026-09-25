import { visibleWidth } from "@earendil-works/pi-tui";
import { row, tokens, type Paint } from "./panel.ts";

/** Rough token estimate used where the provider does not report per-part counts. */
export const estimate = (chars: number) => Math.ceil(chars / 4);

export interface ContextPart { key: string; label: string; tokens: number; color: string }
export interface ContextFileInfo { path: string; tokens: number }
export interface ContextBreakdown {
  model: string;
  window: number;
  /** Provider-reported total, when known. */
  reported: number | null;
  parts: ContextPart[];
  buffer: number;
  files: ContextFileInfo[];
  skills: ContextFileInfo[];
  tools: ContextFileInfo[];
}

type Message = { role?: string; content?: unknown; summary?: string; command?: string; output?: string; toolName?: string };
interface Inputs {
  model: string;
  window: number;
  reported: number | null;
  systemPrompt: string;
  contextFiles: readonly { path: string; content: string }[];
  skills: readonly { name: string; description: string; filePath: string }[];
  tools: readonly { name: string; description?: string; parameters?: unknown }[];
  messages: readonly Message[];
  reserve: number;
}

const partChars = (content: unknown): number => typeof content === "string" ? content.length
  : Array.isArray(content) ? content.reduce((sum: number, part: { type?: string; text?: string; thinking?: string; arguments?: unknown; data?: string }) =>
    sum + (part.type === "text" ? part.text?.length ?? 0 : part.type === "thinking" ? part.thinking?.length ?? 0
      : part.type === "toolCall" ? JSON.stringify(part.arguments ?? {}).length + 40 : part.type === "image" ? 6400 : 0), 0)
  : 0;

/**
 * Split the context into Claude-style categories. Parts are estimated at ~4 characters per token;
 * when the provider reported a total, the estimate is scaled to match it.
 */
export function contextBreakdown(input: Inputs): ContextBreakdown {
  const files = input.contextFiles.map((file) => ({ path: file.path, tokens: estimate(file.content.length) }));
  const skills = input.skills.map((skill) => ({ path: skill.name, tokens: estimate(skill.name.length + skill.description.length + skill.filePath.length + 30) }));
  const tools = input.tools.map((tool) => ({ path: tool.name, tokens: estimate(tool.name.length + (tool.description?.length ?? 0) + JSON.stringify(tool.parameters ?? {}).length) }));
  const sum = (items: readonly ContextFileInfo[]) => items.reduce((total, item) => total + item.tokens, 0);
  const system = Math.max(0, estimate(input.systemPrompt.length) - sum(files) - sum(skills));
  const kinds = { user: 0, assistant: 0, tool: 0, custom: 0, summary: 0 };
  for (const message of input.messages) {
    const chars = partChars(message.content);
    if (message.role === "user") kinds.user += chars;
    else if (message.role === "assistant") kinds.assistant += chars;
    else if (message.role === "toolResult") kinds.tool += chars;
    else if (message.role === "bashExecution") kinds.tool += (message.command?.length ?? 0) + (message.output?.length ?? 0);
    else if (message.role === "compactionSummary" || message.role === "branchSummary") kinds.summary += message.summary?.length ?? chars;
    else kinds.custom += chars;
  }
  const parts: ContextPart[] = [
    { key: "system", label: "System prompt", tokens: system, color: "muted" },
    { key: "tools", label: "System tools", tokens: sum(tools), color: "syntaxType" },
    { key: "files", label: "Context files", tokens: sum(files), color: "warning" },
    { key: "skills", label: "Skills", tokens: sum(skills), color: "syntaxFunction" },
    { key: "summary", label: "Compaction summary", tokens: estimate(kinds.summary), color: "thinkingText" },
    { key: "user", label: "User messages", tokens: estimate(kinds.user), color: "accent" },
    { key: "assistant", label: "Assistant messages", tokens: estimate(kinds.assistant), color: "success" },
    { key: "tool", label: "Tool results", tokens: estimate(kinds.tool), color: "syntaxKeyword" },
    { key: "custom", label: "Extension messages", tokens: estimate(kinds.custom), color: "customMessageLabel" }
  ];
  const estimated = parts.reduce((total, part) => total + part.tokens, 0);
  if (input.reported && estimated > 0) {
    const scale = input.reported / estimated;
    for (const item of [...parts, ...files, ...skills, ...tools]) item.tokens = Math.round(item.tokens * scale);
  }
  return { model: input.model, window: input.window, reported: input.reported, parts: parts.filter((part) => part.tokens > 0),
    buffer: Math.min(input.reserve, input.window), files, skills, tools };
}

const GRID = 10;

/** Claude-style `/context`: a 10×10 grid (1 cell ≈ 1% of the window) beside the legend, then per-item detail. */
export function contextLines(view: ContextBreakdown, width: number, fg: Paint): string[] {
  const used = view.parts.reduce((total, part) => total + part.tokens, 0);
  if (view.window <= 0) {
    return [fg("accent", view.model) + fg("dim", ` · ~${tokens(used)} tokens · context window unknown (select a model)`),
      ...view.parts.map((part) => fg(part.color, "⛁ ") + `${part.label}: ` + fg("dim", tokens(part.tokens)))];
  }
  const windowSize = Math.max(1, view.window);
  const free = Math.max(0, windowSize - used - view.buffer);
  const pct = (value: number) => (value / windowSize * 100).toFixed(1).replace(/\.0$/, "") + "%";
  // Each cell is filled by the category holding most of its 1% slice.
  const cells: { color: string; glyph: string }[] = [];
  const segments = [...view.parts.map((part) => ({ tokens: part.tokens, color: part.color, glyph: "⛁" })),
    { tokens: free, color: "dim", glyph: "⛶" }, { tokens: view.buffer, color: "dim", glyph: "⛝" }];
  const unit = windowSize / (GRID * GRID);
  let cursor = 0;
  let segment = 0;
  let offset = 0;
  for (let cell = 0; cell < GRID * GRID; cell++) {
    const end = (cell + 1) * unit;
    const shares = new Map<number, number>();
    while (cursor < end && segment < segments.length) {
      const take = Math.min(segments[segment]!.tokens - offset, end - cursor);
      if (take > 0) { shares.set(segment, (shares.get(segment) ?? 0) + take); cursor += take; offset += take; }
      if (offset >= segments[segment]!.tokens) { segment++; offset = 0; }
    }
    const [best, share] = [...shares.entries()].sort((a, b) => b[1] - a[1])[0] ?? [segments.length - 1, unit];
    const chosen = segments[best]!;
    cells.push({ color: chosen.color, glyph: chosen.glyph === "⛁" && share < unit / 2 ? "⛀" : chosen.glyph });
  }
  const grid = Array.from({ length: GRID }, (_, y) => cells.slice(y * GRID, y * GRID + GRID).map((cell) => fg(cell.color, cell.glyph)).join(" "));
  const legend = [
    fg("accent", view.model) + fg("dim", ` · ${tokens(used)}/${tokens(windowSize)} tokens (${pct(used)})`),
    fg("dim", view.reported ? "estimated per part, scaled to the reported total" : "estimated (~4 chars/token); exact after the next response"),
    ...view.parts.map((part) => fg(part.color, "⛁ ") + `${part.label}: ` + fg("dim", `${tokens(part.tokens)} (${pct(part.tokens)})`)),
    fg("dim", "⛶ ") + "Free space: " + fg("dim", `${tokens(free)} (${pct(free)})`),
    fg("dim", "⛝ ") + "Autocompact buffer: " + fg("dim", `${tokens(view.buffer)} (${pct(view.buffer)})`)
  ];
  const gridWidth = GRID * 2 - 1;
  const lines: string[] = [];
  if (width >= gridWidth + 4 + 36) {
    for (let index = 0; index < Math.max(grid.length, legend.length); index++) {
      lines.push((grid[index] ?? " ".repeat(gridWidth)) + "   " + (legend[index] ?? ""));
    }
  } else lines.push(...grid, "", ...legend);
  const section = (title: string, items: readonly ContextFileInfo[]) => {
    if (!items.length) return;
    lines.push("", fg("accent", title));
    for (const item of [...items].sort((a, b) => b.tokens - a.tokens)) {
      const value = fg("dim", tokens(item.tokens));
      const room = Math.max(8, width - 4 - visibleWidth(value));
      const label = item.path.length > room ? "…" + item.path.slice(-(room - 1)) : item.path;
      lines.push("  " + row(label, value, width - 2));
    }
  };
  section("Context files", view.files);
  section("Skills", view.skills);
  section("Tools", view.tools);
  return lines;
}
