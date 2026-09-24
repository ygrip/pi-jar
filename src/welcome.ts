import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

// Each line occupies 21 cells. The asymmetric tips flicker while the tapered body stays put.
const FLAME_TIPS = [
  ["          ░          ", "         ▒▓░   ░     ", "       ░▓██▓▒ ░▒     "],
  ["         ░           ", "        ▒▓▒    ░     ", "       ▒▓██▓░ ▒▒     "],
  ["           ░         ", "         ▒▓▒  ░▒     ", "       ░▓██▓▒ ▒▓     "],
  ["        ░    ░       ", "        ▒▓▒  ▒▒      ", "       ▒▓██▓▒░▓▒     "],
  ["          ░          ", "         ▒▓▒   ░     ", "       ░▓██▓▒ ░▒     "],
  ["         ░           ", "        ▒▓░   ░▒     ", "       ▒▓██▓▒ ▒▓     "],
  ["           ░         ", "         ▒▓░  ░▒     ", "       ░▓██▓▒ ▒▒     "],
  ["        ░   ░        ", "        ▒▓▒  ▒░      ", "       ▒▓██▓▒░▓▒     "]
] as const;
const FLAME_BODY = [
  "      ░▓████▓▒▓▒     ",
  "     ▒▓████████▓▒    ",
  "    ░▓██████████▓░   ",
  "     ▒▓████████▓▒    ",
  "      ░▒▓████▓▒      ",
  "         ▒██▒        "
] as const;
const PI_LARGE = [
  "     ▄▄▄▄▄▄▄▄▄▄▄     ",
  "    ▄███████████▄    ",
  "      ██     ██      ",
  "      ██     ██      ",
  "     ▄██▄   ▄██▄     "
] as const;
const PI_COMPACT = ["  ▄▄▄▄▄▄▄  ", " ▄███████▄ ", "   █   █   ", "  ▄█   █▄  "] as const;
const ART_WIDTH = 24;
const spaceArt = (line: string) => " " + line + " ".repeat(Math.max(0, ART_WIDTH - visibleWidth(line) - 1));

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
    cell(fg("accent", "[ Settings ↗ ]") + fg("dim", narrow ? "  /jar hub" : "  ·  /jar hub  ·  /jar welcome")),
    fg("dim", "╰" + "─".repeat(w - 2) + "╯")
  ];
}

export function welcomeSettingsHit(lines: readonly string[], x: number, y: number): boolean {
  const line = lines[y];
  if (!line) return false;
  const text = stripTerminalSequences(line);
  const label = text.includes("[ Settings ↗ ]") ? "[ Settings ↗ ]" : "/jar settings";
  const offset = text.indexOf(label);
  if (offset < 0) return false;
  const start = visibleWidth(text.slice(0, offset));
  return x >= start && x < start + visibleWidth(label);
}

export function welcomeLines(width: number, frame: number, fg: Paint, info: WelcomeInfo = {}): string[] {
  if (width <= 0) return [];
  const fit = (line: string) => truncateToWidth(line, width);
  const step = ((frame % FLAME_TIPS.length) + FLAME_TIPS.length) % FLAME_TIPS.length;
  const flame = [...(FLAME_TIPS[step] ?? FLAME_TIPS[0]), ...FLAME_BODY];
  // The hot core glows amber; the edges stay red. No container interrupts the silhouette.
  const paintFlame = (line: string) => line.split(/(█+)/).map((part) => fg(part.includes("█") ? "warning" : "error", part)).join("");
  const compactFlame = [...flame.slice(0, 5), ...flame.slice(7)].map(paintFlame);
  if (width < 32) return [
    ...compactFlame.map(fit),
    ...PI_COMPACT.map((line) => fit(fg("accent", line))),
    fit(fg("accent", "pi-jar · role-assistant")), fit(fg("accent", "/jar settings"))
  ];
  const wide = width >= 72;
  const art = wide ? [
    ...flame.map((line) => paintFlame(spaceArt(line))),
    ...PI_LARGE.map((line) => fg("accent", spaceArt(line)))
  ] : [...compactFlame, ...PI_COMPACT.map((line) => fg("accent", line))];
  const details = card(wide ? width - ART_WIDTH - 2 : width, fg, info);
  if (!wide) return [...art.map(fit), ...details.map(fit)];
  return Array.from({ length: Math.max(art.length, details.length) }, (_, index) => {
    const left = art[index] ?? "";
    return fit(left + " ".repeat(Math.max(0, ART_WIDTH - visibleWidth(left))) + "  " + (details[index] ?? ""));
  });
}
