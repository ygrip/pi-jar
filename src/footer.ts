import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { roleFrame } from "./animations.ts";
import type { RoleStatus } from "./roles.ts";
import { ACTIVE_STATES, cleanText, type JarStatus } from "./status.ts";
import type { Quota } from "./quota.ts";

export type Color = "accent" | "warning" | "success" | "error" | "dim" | "muted";
export interface FooterTheme { fg(color: Color, text: string): string }
export interface FooterView extends JarStatus {
  model: string;
  context: string;
  cost?: string;
  quota?: Quota;
  branch: string | null;
  demo: boolean;
  animations: boolean;
  frame: number;
  motionBudget?: number;
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
  const roles = [...view.roles].sort((a, b) => Number(b.state === "failed") - Number(a.state === "failed"));
  const primary = roles.find((role) => role.state === "failed") ?? roles.find((role) => ACTIVE_STATES.has(role.state));
  const model = cleanText(view.model, 24) || "no-model";
  const context = cleanText(view.context, 12) || "ctx ?";
  const quota = view.quota;
  const windows = [quota?.fiveHour && `5h ${Math.round(quota.fiveHour.used)}%`, quota?.week && `week ${Math.round(quota.week.used)}%`].filter((value): value is string => !!value);
  const cost = view.cost ? cleanText(view.cost, 20) : undefined;
  const prefix = theme.fg("accent", "jar") + theme.fg("dim", view.demo ? " DEMO" : "");
  const firstRole = primary ? `${primary.label} ${roleFrame(primary.state, view.frame, view.animations)}` : undefined;
  const attention = firstRole ?? view.extras[0];
  // At narrow widths reserve the right-hand slot for critical/active status, then context.
  const left = `${prefix} ${theme.fg("muted", model)}`;
  // Fixed priority: context at every width; cost and quota only when there is space.
  const metrics = [context, ...(width >= 52 && cost ? [cost] : []), ...(width >= 90 ? windows : [])];
  let right = theme.fg("dim", metrics.join("  ·  "));
  if (width < 52 && attention && width >= 26) {
    const room = Math.max(0, width - visibleWidth(prefix) - 2 - visibleWidth(right) - 2);
    right = theme.fg(primary?.state === "failed" ? "error" : "warning", truncateToWidth(attention, Math.min(room, 14))) + " " + right;
  }
  const availableLeft = Math.max(0, width - visibleWidth(right) - 1);
  const fittedLeft = truncateToWidth(left, availableLeft);
  const gap = " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(right)));
  const lines = [truncateToWidth(fittedLeft + gap + right, width)];
  if (width < 52) return lines;

  let moving = 0;
  const segments = roles.map((role) => {
    const animated = view.animations && ACTIVE_STATES.has(role.state) && moving < (view.motionBudget ?? 2);
    if (animated) moving++;
    const glyph = roleFrame(role.state, view.frame, animated);
    const task = width >= 100 && role.task ? ` ${role.task}` : "";
    return theme.fg(roleColor(role), `${role.label} ${glyph}${task}`);
  });
  const remaining = Math.max(0, view.extras.length - (width >= 100 ? 2 : 1));
  const extras = view.extras.slice(0, width >= 100 ? 2 : 1).map((status) => theme.fg("muted", status));
  if (remaining) extras.push(theme.fg("dim", `+${remaining}`));
  if (width >= 100 && view.branch) extras.push(theme.fg("dim", `git ${cleanText(view.branch, 28)}`));
  const joined = [...segments, ...extras].join(theme.fg("dim", "  ·  "));
  if (joined) lines.push(truncateToWidth(joined, width));
  if (width >= 52 && width < 90 && windows.length) {
    const summary = windows.join("  ·  ");
    if (summary) lines.push(truncateToWidth(theme.fg("dim", summary), width));
  }
  return lines;
}
