import type { Quota, QuotaWindow } from "./quota.ts";
import type { SideCall } from "./side-model.ts";
import { bar, duration, money, row, tokens, type Paint } from "./panel.ts";

export interface ModelUsage { label: string; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number; calls: number }
export interface UsageStats { started?: number; prompts: number; responses: number; models: ModelUsage[]; side: ModelUsage[]; total: ModelUsage }

type Entry = { type: string; timestamp?: string; message?: { role?: string; provider?: string; model?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } } };

const empty = (label: string): ModelUsage => ({ label, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 });
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
function add(target: ModelUsage, usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number }): void {
  target.input += num(usage.input); target.output += num(usage.output); target.cacheRead += num(usage.cacheRead);
  target.cacheWrite += num(usage.cacheWrite); target.cost += num(usage.cost); target.calls++;
}

/** Session totals from the active branch plus pi-jar's own side calls (advisor, commit, ...). */
export function collectUsage(entries: readonly Entry[], side: readonly SideCall[]): UsageStats {
  const models = new Map<string, ModelUsage>();
  const sideModels = new Map<string, ModelUsage>();
  const total = empty("total");
  let started: number | undefined;
  let prompts = 0;
  let responses = 0;
  for (const entry of entries) {
    const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (Number.isFinite(at) && (started === undefined || at < started)) started = at;
    const message = entry.type === "message" ? entry.message : undefined;
    if (message?.role === "user") prompts++;
    if (message?.role !== "assistant" || !message.usage) continue;
    responses++;
    const label = `${message.provider ?? "?"}/${message.model ?? "?"}`;
    const usage = { ...message.usage, cost: message.usage.cost?.total };
    add(models.get(label) ?? models.set(label, empty(label)).get(label)!, usage);
    add(total, usage);
  }
  for (const call of side) {
    const label = `${call.role} → ${call.model}`;
    add(sideModels.get(label) ?? sideModels.set(label, empty(label)).get(label)!, call);
    add(total, call);
  }
  const byCost = (a: ModelUsage, b: ModelUsage) => b.cost - a.cost || b.calls - a.calls;
  return { ...(started !== undefined ? { started } : {}), prompts, responses, models: [...models.values()].sort(byCost), side: [...sideModels.values()].sort(byCost), total };
}

function resetText(window: QuotaWindow, now: number): string {
  if (!window.resetsAt) return "";
  const at = window.resetsAt < 1e12 ? window.resetsAt * 1000 : window.resetsAt;
  const date = new Date(at);
  const soon = at - now < 24 * 3_600_000;
  const when = date.toLocaleString(undefined, soon ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
  return `Resets ${when} (in ${duration(Math.max(0, at - now))})`;
}

export interface UsageView { stats: UsageStats; provider?: string; quota?: Quota; quotaEnabled: boolean; now: number }

/** Claude-style usage page: session totals, per-model breakdown, then plan limit bars. */
export function usageLines(view: UsageView, width: number, fg: Paint): string[] {
  const { stats, now } = view;
  const heading = (text: string) => fg("accent", text);
  const inner = Math.max(20, width - 2);
  const tokenLine = (usage: ModelUsage) => [`${tokens(usage.input)} in`, `${tokens(usage.output)} out`,
    ...(usage.cacheRead ? [`${tokens(usage.cacheRead)} cache read`] : []), ...(usage.cacheWrite ? [`${tokens(usage.cacheWrite)} cache write`] : [])].join(" · ");
  const lines = [
    heading("Session"),
    "  " + row("Total cost", money(stats.total.cost), inner - 2),
    "  " + row("Total duration", stats.started !== undefined ? duration(now - stats.started) : "—", inner - 2),
    "  " + row("Turns", `${stats.prompts} prompt${stats.prompts === 1 ? "" : "s"} · ${stats.responses} response${stats.responses === 1 ? "" : "s"}`, inner - 2),
    "  " + row("Tokens", tokenLine(stats.total), inner - 2),
    "",
    heading("Usage by model")
  ];
  if (!stats.models.length && !stats.side.length) lines.push(fg("dim", "  No model calls yet in this session."));
  for (const usage of [...stats.models, ...stats.side]) {
    const calls = stats.side.includes(usage) ? ` · ${usage.calls} call${usage.calls === 1 ? "" : "s"}` : "";
    lines.push("  " + row(usage.label, fg("success", money(usage.cost)), inner - 2), fg("dim", "    " + tokenLine(usage) + calls));
  }
  lines.push("", heading(`Plan usage limits${view.provider ? " · " + view.provider : ""}`));
  const windows: [string, QuotaWindow | undefined][] = [["Current session (5h)", view.quota?.fiveHour], ["Current week", view.quota?.week]];
  if (!windows.some(([, window]) => window)) {
    lines.push(fg("dim", view.provider === "anthropic" || view.provider === "openai-codex"
      ? view.quotaEnabled ? "  Loading limits… reopen in a moment." : "  Limit lookup is off; enable it with /jar quota on."
      : "  Plan limits are available for anthropic and openai-codex subscriptions."));
    return lines;
  }
  for (const [label, window] of windows) {
    if (!window) continue;
    const used = Math.round(window.used);
    const color = used >= 90 ? "error" : used >= 70 ? "warning" : "accent";
    const suffix = ` ${used}% used`;
    lines.push("  " + label, "  " + bar(fg, window.used, Math.min(50, inner - 4 - suffix.length), color) + suffix);
    const reset = resetText(window, now);
    if (reset) lines.push(fg("dim", "  " + reset));
    lines.push("");
  }
  return lines;
}
