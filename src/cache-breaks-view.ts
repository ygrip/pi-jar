import { homedir } from "node:os";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { BREAK_SHORTFALL_TOKENS, summarizeBreaks, type BreakKind, type CacheBreakState } from "./cache-breaks.ts";
import { money, row, tokens, type Paint } from "./panel.ts";

const CAUSES: Record<BreakKind, string> = {
  model: "model switch", tools: "tool list changed", system: "system prompt changed", message: "message changed",
  truncated: "history shortened", idle: "cache expired (idle)", unknown: "no prompt change found"
};
const HOW = `A break is a call whose cache read fell more than ${BREAK_SHORTFALL_TOKENS.toLocaleString("en-US")} tokens short of the previous prompt.`;

const pad = (value: number) => String(value).padStart(2, "0");

/** `10:42:03` today, `10-07 10:42` on an earlier day, in local time. */
function when(timestamp: string, now: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "?";
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return new Date(now).toDateString() === date.toDateString() ? `${clock}:${pad(date.getSeconds())}` : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

/** The Cache tab of /usage and /context, and `/cache-breaks`: costly prompt-cache breaks of the session, totals first. */
export function cacheBreakLines(view: CacheBreakState & { now: number }, width: number, fg: Paint): string[] {
  const inner = Math.max(20, width - 2);
  const heading = (text: string) => fg("accent", text);
  const extra = (amount: number) => fg("warning", "~" + money(amount));
  const wrap = (text: string, color: string | undefined, indent = ""): string[] =>
    wrapTextWithAnsi(text, Math.max(10, inner - indent.length)).map((line) => indent + (color ? fg(color, line) : line));
  const totals = summarizeBreaks(view.breaks);
  const lines: string[] = [];
  if (!view.enabled) lines.push(...wrap("Cache diagnostics are off. Turn them on in /jar settings → Pi.", "warning"), "");
  lines.push(heading("Session"), "  " + row("Calls checked", String(view.calls), inner - 2), "  " + row("Costly cache breaks", String(totals.count), inner - 2));
  if (!totals.count) return [...lines, fg("dim", "  None so far."), "", ...wrap(HOW, "dim")];
  lines.push("  " + row("Tokens rewritten", tokens(totals.rewritten), inner - 2));
  if (totals.cost > 0) lines.push("  " + row("Estimated extra cost", extra(totals.cost), inner - 2));

  lines.push("", heading("By cause"));
  for (const [kind, sum] of [...totals.kinds].sort((a, b) => b[1].cost - a[1].cost || b[1].rewritten - a[1].rewritten)) {
    lines.push("  " + row(CAUSES[kind], `${sum.count} · ${tokens(sum.rewritten)}${sum.cost > 0 ? " · " + extra(sum.cost) : ""}`, inner - 2));
  }

  lines.push("", heading("Breaks (oldest first)"));
  for (const entry of view.breaks) {
    lines.push(`  #${entry.request}  ${when(entry.timestamp, view.now)}  ${fg("warning", tokens(entry.rewrittenTokens) + " tokens")}${entry.costUsd !== undefined ? " · " + extra(entry.costUsd) : ""}`);
    lines.push(...wrap(entry.summary, undefined, "       "));
    if (entry.first !== undefined) lines.push(...wrap(`first change: ${entry.first} (segment ${entry.segment})`, "dim", "       "));
  }

  const home = homedir();
  if (view.file) lines.push("", ...wrap("Log: " + (home && view.file.startsWith(home) ? "~" + view.file.slice(home.length) : view.file), "dim"));
  lines.push(...wrap(HOW, "dim"));
  return lines;
}
