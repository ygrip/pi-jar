import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { FLAME_WIDTH, flameFrame } from "./flame.ts";
import { cleanText } from "./status.ts";

export type WelcomeAction = "settings" | "refresh" | "roles" | "plan" | "goal";

export interface WelcomeInfo {
  version?: string;
  model?: string;
  effort?: string;
  activeRole?: string;
  project?: string;
  context?: string;
  cost?: string;
  managers?: readonly ("tasks" | "subagents")[];
  quotaEnabled?: boolean;
  quota?: number;
  /** Publisher-supplied live roles (other extensions, subagents). */
  roles?: readonly { name: string; state: string; task?: string }[];
  tasks?: number;
  nextTask?: string;
  plan?: { enabled: boolean; title?: string; steps: number };
  goal?: string;
  rolesSummary?: string;
  branch?: string;
  dirty?: boolean;
  message?: string;
  /** Pi fullscreen mode delivers mouse events; otherwise keyboard hints are shown. */
  settingsClickable?: boolean;
  flameSeed?: number;
}

type WelcomeColor = "accent" | "warning" | "error" | "muted" | "dim";
type Paint = (color: WelcomeColor, text: string) => string;

export const HOPEFUL_WELCOME_MESSAGES = [
  "A small spark is enough to begin.",
  "Keep the light on. There is a way through.",
  "Even long nights end. One clear step at a time.",
  "Carry the light forward. The path will meet you.",
  "Steady hands, warm light, good work ahead.",
  "The next clear step is enough for now.",
  "Leave a little light for the work ahead.",
  "Every useful thing starts as a small spark."
] as const;

export function hopefulWelcomeMessage(random: () => number = Math.random, previous?: string): string {
  const pick = () => {
    const value = random();
    return HOPEFUL_WELCOME_MESSAGES[Math.min(HOPEFUL_WELCOME_MESSAGES.length - 1,
      Math.max(0, Math.floor((Number.isFinite(value) ? value : 0) * HOPEFUL_WELCOME_MESSAGES.length)))]!;
  };
  let message = pick();
  // Refresh should visibly change the message.
  for (let attempt = 0; previous && message === previous && attempt < 4; attempt++) message = pick();
  return message;
}

const PI_LARGE = [
  "    ▄▄▄▄▄▄▄▄▄▄▄    ",
  "   ▄█████████████▄   ",
  "      ██     ██      ",
  "      ██     ██      ",
  "      ██     ██      ",
  "      ██     ██      ",
  "     ▄██▄   ▄██▄     "
] as const;
const PI_COMPACT = [
  "  ▄▄▄▄▄▄▄  ",
  " ▄███████▄ ",
  "   █   █   ",
  "   █   █   ",
  "  ▄█   █▄  "
] as const;

const ART_WIDTH = 28;
const ACTIONS: readonly { action: WelcomeAction; label: string; hint: string }[] = [
  { action: "settings", label: "[ ⚙ Settings ]", hint: "ctrl+alt+s settings" },
  { action: "refresh", label: "[ ↻ Refresh ]", hint: "ctrl+alt+r refresh" },
  { action: "roles", label: "[ ◆ Roles ]", hint: "/roles" },
  { action: "plan", label: "[ ▤ Plan ]", hint: "/plan" },
  { action: "goal", label: "[ ◎ Goal ]", hint: "/goal" }
];

const center = (line: string, width: number) => {
  const room = Math.max(0, width - visibleWidth(line));
  const left = Math.floor(room / 2);
  return " ".repeat(left) + line + " ".repeat(room - left);
};
const fixedCell = (line: string, width: number) => {
  const value = truncateToWidth(line, width);
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
};

/** Pack chips into rows no wider than `width`. */
function pack(items: readonly string[], width: number, gap = " "): string[] {
  const rows: string[] = [];
  for (const item of items) {
    const last = rows.length - 1;
    if (last >= 0 && visibleWidth(rows[last]!) + visibleWidth(gap) + visibleWidth(item) <= width) rows[last] += gap + item;
    else rows.push(item);
  }
  return rows;
}

function card(width: number, fg: Paint, info: WelcomeInfo): string[] {
  const w = Math.max(12, width);
  const inner = w - 4;
  const narrow = w < 48;
  const cell = (value: string) => {
    const text = truncateToWidth(value, inner);
    return fg("dim", "│ ") + text + " ".repeat(Math.max(0, inner - visibleWidth(text))) + fg("dim", " │");
  };
  const divider = fg("dim", "├" + "─".repeat(w - 2) + "┤");
  const labelWidth = narrow ? 8 : 10;
  const label = (name: string, value: string, color: WelcomeColor = "muted") =>
    fg("dim", name.padEnd(labelWidth)) + fg(color, cleanText(value, 120));

  const header = [fg("accent", "pi-jar" + (info.version ? " " + info.version : "")),
    info.model ? fg("muted", cleanText(info.model, 40)) : fg("dim", "no model"),
    info.effort && info.effort !== "off" ? fg("muted", info.effort) : "",
    info.activeRole ? fg("warning", "role:" + cleanText(info.activeRole, 16)) : ""].filter(Boolean).join(fg("dim", " · "));

  const git = info.branch ? "git " + cleanText(info.branch, 24) + (info.dirty ? " · dirty" : "") : "git unavailable";
  const quota = info.quota != null ? `quota ${Math.round(info.quota)}%` : `quota ${info.quotaEnabled ? "unavailable" : "off"}`;
  const plan = info.plan?.enabled ? "◆ planning" + (info.plan.title ? " · " + info.plan.title : "")
    : info.plan?.title ? "last · " + info.plan.title + ` (${info.plan.steps} steps)` : "none · /plan <idea>";
  const tasks = info.tasks ? `${info.tasks} open${info.nextTask ? " · next: " + info.nextTask : ""}` : "none open";
  const live = info.roles?.filter((role) => role.name !== "assistant") ?? [];
  const lead = info.roles?.find((item) => ["working", "thinking", "reviewing", "failed"].includes(item.state));
  const managers = info.managers?.length ? info.managers.map((m) => m === "tasks" ? "/tasks" : "/subagents-fleet").join(" · ") : "";
  const team = [lead ? `${cleanText(lead.name, 16)} ${lead.state}` : "", live.length ? `${live.length} subagent${live.length === 1 ? "" : "s"}` : "",
    lead?.task ? cleanText(lead.task, 30) : "", managers].filter(Boolean).join(" · ");

  const actions = info.settingsClickable === false
    ? pack(ACTIONS.map((item) => item.hint), inner, fg("dim", " · ")).map((row) => fg("dim", row))
    : pack(ACTIONS.map((item) => fg(item.action === "settings" ? "accent" : "muted", item.label)), inner);
  return [
    fg("dim", "╭" + "─".repeat(w - 2) + "╮"),
    cell(header),
    divider,
    cell(label("PROJECT", (info.project || "unavailable") + " · " + git, info.dirty ? "warning" : "muted")),
    cell(label("SESSION", [info.context ?? "ctx ?", quota, info.cost ?? ""].filter(Boolean).join(" · "))),
    divider,
    cell(label("PLAN", plan, info.plan?.enabled ? "warning" : "muted")),
    cell(label("GOAL", info.goal ?? "none · /goal <outcome>", info.goal ? "accent" : "muted")),
    cell(label("TASKS", tasks, info.tasks ? "accent" : "muted")),
    cell(label("ROLES", info.rolesSummary ?? "all roles follow the current model")),
    ...(team ? [cell(label("TEAM", team, lead?.state === "failed" ? "error" : "muted"))] : []),
    divider,
    cell(fg("muted", "Welcome to ") + fg("accent", "pi-jar") + fg("dim", " — " + cleanText(info.message ?? HOPEFUL_WELCOME_MESSAGES[0], 100))),
    divider,
    ...actions.map(cell),
    fg("dim", "╰" + "─".repeat(w - 2) + "╯")
  ];
}

/** Which welcome action (if any) sits under a zero-based cell in the rendered lines. */
export function welcomeHit(lines: readonly string[], x: number, y: number): WelcomeAction | undefined {
  const line = lines[y];
  if (!line) return undefined;
  const text = stripTerminalSequences(line);
  for (const item of ACTIONS) {
    const offset = text.indexOf(item.label);
    if (offset < 0) continue;
    const start = visibleWidth(text.slice(0, offset));
    if (x >= start && x < start + visibleWidth(item.label)) return item.action;
  }
  return undefined;
}

/** Back-compat helper: true when the Settings chip is under the pointer. */
export function welcomeSettingsHit(lines: readonly string[], x: number, y: number): boolean {
  return welcomeHit(lines, x, y) === "settings";
}

export function welcomeLines(width: number, frame: number, fg: Paint, info: WelcomeInfo = {}): string[] {
  if (width <= 0) return [];
  const fit = (line: string) => truncateToWidth(line, width);
  const seed = info.flameSeed ?? 1;
  const flame = flameFrame(frame, seed, (color, text) => fg(color, text));
  if (width < 32) {
    const start = Math.max(0, Math.floor((FLAME_WIDTH - width) / 2));
    return [
      ...flame.slice(4).map((line) => fit(sliceByColumn(line, start, Math.min(width, FLAME_WIDTH)))),
      ...PI_COMPACT.map((line) => fit(fg("accent", line))),
      fit(fg("accent", "pi-jar")),
      fit(fg(info.settingsClickable === false ? "dim" : "accent", info.settingsClickable === false ? "ctrl+alt+s settings" : "[ ⚙ Settings ]")),
      ""
    ];
  }
  const wide = width >= 72;
  const flameArt = flame.map((line) => center(fixedCell(line, FLAME_WIDTH), ART_WIDTH));
  if (!wide) {
    const art = [...flame.slice(2).map((line) => center(fixedCell(line, FLAME_WIDTH), Math.min(width, ART_WIDTH))),
      ...PI_COMPACT.map((line) => fg("accent", center(line, Math.min(width, ART_WIDTH))))];
    return [...art.map(fit), ...card(width, fg, info).map(fit), ""];
  }
  const art = [...flameArt, ...PI_LARGE.map((line) => fg("accent", center(fixedCell(line, 21), ART_WIDTH)))];
  const details = card(width - ART_WIDTH - 2, fg, info);
  const topPad = Math.max(0, Math.floor((details.length - art.length) / 2));
  const artRows = [...Array.from({ length: topPad }, () => " ".repeat(ART_WIDTH)), ...art];
  const merged = Array.from({ length: Math.max(artRows.length, details.length) }, (_, index) => {
    const left = artRows[index] ?? " ".repeat(ART_WIDTH);
    return fit(left + "  " + (details[index] ?? ""));
  });
  return [...merged, "", ""];
}
