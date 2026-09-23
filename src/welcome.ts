import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { cleanText } from "./status.ts";

export interface WelcomeInfo {
  model?: string;
  project?: string;
  context?: string;
  cost?: string;
  managers?: readonly ("tasks" | "subagents")[];
  quotaEnabled?: boolean;
  quota?: number;
  roles?: readonly { name: string; state: string; task?: string }[];
  tasks?: number;
  advisor?: string;
  branch?: string;
  dirty?: boolean;
}

type WelcomeColor = "accent" | "warning" | "error" | "muted" | "dim";
type Paint = (color: WelcomeColor, text: string) => string;

const SMOKE = [
  ["       ·       ", "     ·  ·      "],
  ["    ·          ", "       ·       "],
  ["          ·    ", "    ·          "],
  ["     ·         ", "         ·     "]
] as const;
const FLAMES = [
  ["       ░       ", "      ▒█▒      ", "     ▒███▒     ", "    ░█████░    "],
  ["      ░        ", "     ▒█▒       ", "      ███▒     ", "    ░█████░    "],
  ["        ░      ", "       █▒      ", "     ▒███▒     ", "    ░█████░    "],
  ["       ░       ", "      █▒       ", "     ▒███▒     ", "    ░█████░    "]
] as const;
const PI_LARGE = ["   ▄▄▄▄▄▄▄▄▄   ", "  ▀██▀▀▀▀██▀   ", "    ██   ██    ", "    ██   ██    ", "   ▄██   ██▄   "] as const;
const PI_COMPACT = ["  ▄▄▄▄▄▄▄  ", "  ███████  ", "   █   █   ", "  ▄█   █▄  "] as const;

function card(width: number, fg: Paint, info: WelcomeInfo): string[] {
  const w = Math.max(8, width);
  const inner = w - 4;
  const cell = (value: string) => {
    const text = truncateToWidth(value, inner);
    return fg("dim", "│ ") + text + " ".repeat(Math.max(0, inner - visibleWidth(text))) + fg("dim", " │");
  };
  const divider = fg("dim", "├" + "─".repeat(w - 2) + "┤");
  const role = info.roles?.find((item) => ["working", "thinking", "reviewing", "failed"].includes(item.state)) ?? info.roles?.[0];
  const roleName = cleanText(role?.name ?? "assistant", w < 48 ? 12 : 25);
  const roleState = cleanText(role?.state ?? "ready", 12);
  const advisor = cleanText(info.advisor ?? "unavailable", 20);
  const task = role?.task ?? (info.tasks ? `${info.tasks} open to-do${info.tasks === 1 ? "" : "s"}` : "no active task");
  const subagents = Math.max(0, (info.roles?.length ?? 0) - (info.roles?.some((r) => r.name === "assistant") ? 1 : 0));
  const roleChip = fg("accent", `[ role-${roleName} ]`);
  const activityChip = fg(role?.state === "failed" ? "error" : "warning", `[ ${roleState} ]`);
  const advisorChip = fg(advisor === "unavailable" || advisor === "off" ? "dim" : "accent", `[ advisor ${advisor} ]`);
  const subagentChip = fg("accent", `[ subagents ${subagents} ]`);
  const quotaChip = info.quota != null
    ? fg("warning", `[ quota ${Math.round(info.quota)}% ]`)
    : fg("dim", `[ quota ${info.quotaEnabled ? "unavailable" : "off"} ]`);
  const narrow = w < 48;
  const badges = [roleChip, activityChip, advisorChip, subagentChip, quotaChip];
  const badgeRows: string[] = [];
  for (const badge of badges) {
    const last = badgeRows.length - 1;
    if (last >= 0 && visibleWidth(badgeRows[last]!) + visibleWidth(badge) + 1 <= inner) badgeRows[last] += " " + badge;
    else badgeRows.push(badge);
  }
  const branch = info.branch ? fg("muted", `[ git ${cleanText(info.branch, 24)} ]`) : fg("dim", "[ git unavailable ]");
  const git = branch + (info.dirty ? " " + fg("warning", "[ dirty ]") : "");
  const label = (name: string, value: string, color: WelcomeColor = "muted") => fg("dim", `${name.padEnd(10)} │ `) + fg(color, cleanText(value, 70));
  return [
    fg("dim", "╭" + "─".repeat(w - 2) + "╮"),
    cell(fg("accent", "pi-jar") + fg("muted", "  ·  roles & orchestration")),
    divider,
    ...badgeRows.map(cell),
    divider,
    cell(label("TASK", task, role?.state === "failed" ? "error" : "accent")),
    cell(label("PROJECT", info.project || "unavailable")),
    cell(label("ADVISOR", advisor, advisor === "unavailable" ? "dim" : "accent")),
    cell(label("MANAGERS", info.managers?.length ? narrow ? info.managers.join(" + ") : info.managers.map((m) => m === "tasks" ? "/tasks" : "/subagents-fleet").join(" · ") : "none detected")),
    cell(git),
    cell(fg("dim", [info.model, info.context, info.cost].filter(Boolean).map((v) => cleanText(v!, 28)).join("  ·  "))),
    divider,
    cell(fg("dim", narrow ? "/jar hub  ·  /jar welcome" : "open /jar hub  ·  replay /jar welcome")),
    fg("dim", "╰" + "─".repeat(w - 2) + "╯")
  ];
}

export function welcomeLines(width: number, frame: number, fg: Paint, info: WelcomeInfo = {}): string[] {
  if (width <= 0) return [];
  const fit = (line: string) => truncateToWidth(line, width);
  const step = ((frame % FLAMES.length) + FLAMES.length) % FLAMES.length;
  const smoke = SMOKE[step] ?? SMOKE[0];
  const fire = (FLAMES[step] ?? FLAMES[0]).map((line, index) => fg(index < 2 ? "warning" : "error", line));
  if (width < 32) return [
    fit(fg("dim", smoke[1])), ...fire.slice(2).map(fit), "",
    ...PI_COMPACT.map((line) => fit(fg("accent", line))),
    fit(fg("accent", "pi-jar · role-assistant")), fit(fg("dim", "/jar hub"))
  ];
  const wide = width >= 72;
  const art = wide ? [
    ...smoke.map((line) => fg("dim", line)), ...fire, "",
    ...PI_LARGE.map((line) => fg("accent", line))
  ] : [fg("dim", smoke[1]), ...fire.slice(1), "", ...PI_COMPACT.map((line) => fg("accent", line))];
  const details = card(wide ? width - 18 : width, fg, info);
  if (!wide) return [...art.map(fit), ...details.map(fit)];
  return Array.from({ length: Math.max(art.length, details.length) }, (_, index) => {
    const left = art[index] ?? "";
    return fit(left + " ".repeat(Math.max(0, 16 - visibleWidth(left))) + "  " + (details[index] ?? ""));
  });
}
