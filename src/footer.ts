import { homedir } from "node:os";
import { sep } from "node:path";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_FOOTER_SETTINGS, type FooterSettings } from "./footer-settings.ts";
import { roleFrame } from "./animations.ts";
import type { RoleStatus } from "./roles.ts";
import { ACTIVE_STATES, cleanText, type JarStatus } from "./status.ts";
import type { Quota } from "./quota.ts";

export type Color = "accent" | "warning" | "success" | "error" | "dim" | "muted"
  | "thinkingOff" | "thinkingMinimal" | "thinkingLow" | "thinkingMedium" | "thinkingHigh" | "thinkingXhigh" | "thinkingMax";
export interface FooterTheme { fg(color: Color, text: string): string }
export interface FooterView extends JarStatus {
  model: string;
  effort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  sessionName?: string;
  cwd?: string;
  settings?: FooterSettings;
  context: string;
  goal?: string;
  memory?: string;
  cost?: string;
  quota?: Quota;
  branch: string | null;
  demo: boolean;
  animations: boolean;
  frame: number;
  motionBudget?: number;
}

function fitCwd(cwd: string, width: number): string {
  if (visibleWidth(cwd) <= width) return cwd;
  return "…" + sliceByColumn(cwd, visibleWidth(cwd) - width + 1, width - 1);
}

function roleColor(role: RoleStatus): Color {
  if (role.state === "failed") return "error";
  if (role.state === "done") return "success";
  if (role.state === "waiting" || role.state === "idle") return "dim";
  if (role.state === "reviewing") return "warning";
  return "accent";
}

/** Every line is bounded in terminal cells; critical role failure takes precedence. */
export function renderFooter(view: FooterView, width: number, theme: FooterTheme): string[] {
  if (width <= 0) return [];
  const show = view.settings ?? DEFAULT_FOOTER_SETTINGS;
  if (!view.goal && !Object.entries(show).some(([field, enabled]) => enabled && (field !== "memory" || !!view.memory))) return [];
  // Keep tiny terminals unframed so context and urgent role status stay readable.
  const framed = width >= 32;
  const contentWidth = framed ? width - 4 : width;
  const roles = show.roles ? [...view.roles].sort((a, b) => Number(b.state === "failed") - Number(a.state === "failed")) : [];
  const primary = roles.find((role) => role.state === "failed") ?? roles.find((role) => ACTIVE_STATES.has(role.state));
  const model = cleanText(view.model, 24) || "no-model";
  const context = cleanText(view.context, 12) || "ctx ?";
  const goal = view.goal ? cleanText(view.goal, 240) : "";
  const quota = view.quota;
  const windows = [quota?.fiveHour && `5h ${Math.round(quota.fiveHour.used)}%`, quota?.week && `week ${Math.round(quota.week.used)}%`].filter((value): value is string => !!value);
  const cost = view.cost ? cleanText(view.cost, 20) : undefined;
  const prefix = view.demo ? theme.fg("warning", "DEMO") : "";
  const effortColors = {
    off: "thinkingOff", minimal: "thinkingMinimal", low: "thinkingLow", medium: "thinkingMedium",
    high: "thinkingHigh", xhigh: "thinkingXhigh", max: "thinkingMax"
  } as const;
  const effort = show.effort && view.effort ? theme.fg(effortColors[view.effort], view.effort) : "";
  const firstRole = primary ? `${primary.label} ${roleFrame(primary.state, view.frame, view.animations)}` : undefined;
  const attention = firstRole ?? (show.extras ? view.extras[0] : undefined);
  // At narrow widths reserve the right-hand slot for critical/active status, then context.
  const modelLabel = show.model ? theme.fg("muted", model) : "";
  const left = [prefix, modelLabel, effort].filter(Boolean).join(theme.fg("dim", " · "));
  // Context is never dropped; optional metrics move to a second line on medium widths.
  const metrics = [...(show.context ? [context] : []), ...(show.memory && contentWidth >= 90 && view.memory ? [view.memory] : []), ...(show.cost && contentWidth >= 52 && cost ? [cost] : []), ...(show.quota && contentWidth >= 90 ? windows : [])];
  let right = theme.fg("dim", metrics.join("  ·  "));
  if (contentWidth < 52 && attention && contentWidth >= 26) {
    const room = Math.max(0, contentWidth - Math.min(visibleWidth(left), 12) - visibleWidth(right) - 4);
    right = theme.fg(primary?.state === "failed" ? "error" : "warning", truncateToWidth(attention, Math.min(room, 14))) + " " + right;
  }
  const availableLeft = Math.max(0, contentWidth - visibleWidth(right) - 1);
  // Never leave a dangling separator when the effort level gets squeezed out.
  const fittedLeft = (() => {
    if (visibleWidth(left) <= availableLeft) return left;
    if (!effort) return truncateToWidth(left, availableLeft);
    const beforeEffort = [prefix, modelLabel].filter(Boolean).join(theme.fg("dim", " · "));
    const room = availableLeft - visibleWidth(effort) - 3;
    if (room >= 3 && beforeEffort) return truncateToWidth(beforeEffort, room) + theme.fg("dim", " · ") + effort;
    return truncateToWidth(beforeEffort || effort, availableLeft);
  })();
  const name = show.sessionName && view.sessionName ? cleanText(view.sessionName, 128) : "";
  const rawCwd = show.cwd && view.cwd ? cleanText(view.cwd, 256) : "";
  const home = homedir();
  const cwd = home && rawCwd.startsWith(home + sep) ? `~${rawCwd.slice(home.length)}` : rawCwd;
  let namedLeft = fittedLeft;
  let space = availableLeft - visibleWidth(namedLeft);
  if (cwd && space >= 7) {
    const budget = name ? Math.min(24, Math.max(4, Math.floor((space - 6) / 2))) : Math.min(32, space - 3);
    namedLeft += theme.fg("dim", " · ") + theme.fg("muted", fitCwd(cwd, budget));
    space = availableLeft - visibleWidth(namedLeft);
  }
  if (name && space >= 7) namedLeft += theme.fg("dim", " · ") + theme.fg("muted", truncateToWidth(name, space - 3, "…"));
  const gap = " ".repeat(Math.max(1, contentWidth - visibleWidth(namedLeft) - visibleWidth(right)));
  const lines = [truncateToWidth(namedLeft + gap + right, contentWidth)];
  if (goal) {
    const goalPrefix = theme.fg("accent", "◎ goal") + theme.fg("dim", " · ");
    const room = Math.max(0, contentWidth - visibleWidth(goalPrefix));
    lines.push(truncateToWidth(goalPrefix + theme.fg("muted", truncateToWidth(goal, room, "…")), contentWidth));
  }
  if (contentWidth < 52) {
    const small = [...(show.memory && view.memory ? [view.memory] : []), ...(show.quota ? windows : [])];
    if (small.length && contentWidth >= 26) lines.push(truncateToWidth(theme.fg("dim", small.join("  ·  ")), contentWidth));
    return framed ? frameFooter(lines, width, view, theme) : lines;
  }

  let moving = 0;
  const segments = roles.map((role) => {
    const animated = view.animations && ACTIVE_STATES.has(role.state) && moving < (view.motionBudget ?? 2);
    if (animated) moving++;
    const glyph = roleFrame(role.state, view.frame, animated);
    const task = contentWidth >= 100 && role.task ? ` ${role.task}` : "";
    return theme.fg(roleColor(role), `${role.label} ${glyph}${task}`);
  });
  const remaining = Math.max(0, view.extras.length - (contentWidth >= 100 ? 2 : 1));
  const extras = show.extras ? view.extras.slice(0, contentWidth >= 100 ? 2 : 1).map((status) => theme.fg("muted", status)) : [];
  if (show.extras && remaining) extras.push(theme.fg("dim", `+${remaining}`));
  if (show.branch && contentWidth >= 52 && view.branch) extras.push(theme.fg("dim", `git ${cleanText(view.branch, 28)}`));
  const joined = [...segments, ...extras].join(theme.fg("dim", "  ·  "));
  if (joined) lines.push(truncateToWidth(joined, contentWidth));
  if (contentWidth < 90 && ((show.quota && windows.length) || (show.memory && view.memory))) {
    const summary = [...(show.memory && view.memory ? [view.memory] : []), ...(show.quota ? windows : [])].join("  ·  ");
    if (summary) lines.push(truncateToWidth(theme.fg("dim", summary), contentWidth));
  }
  return framed ? frameFooter(lines, width, view, theme) : lines;
}

function frameFooter(lines: string[], width: number, view: FooterView, theme: FooterTheme): string[] {
  const active = (view.settings?.roles ?? true) && view.roles.some((role) => ACTIVE_STATES.has(role.state));
  const pulse = active && view.animations ? ["◇", "◈", "◆", "◈"][view.frame % 4] : "◇";
  const top = theme.fg("dim", "╭─") + theme.fg(active ? "accent" : "dim", pulse)
    + theme.fg("dim", "─".repeat(width - 4) + "╮");
  const bottom = theme.fg("dim", "╰" + "─".repeat(width - 2) + "╯");
  // Only the glyph changes between frames; the outline and content never shift.
  return [top, ...lines.map((line) =>
    theme.fg("dim", "│ ") + line + " ".repeat(Math.max(0, width - 4 - visibleWidth(line))) + theme.fg("dim", " │")
  ), bottom];
}
