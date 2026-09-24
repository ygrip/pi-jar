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
  message?: string;
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

export function hopefulWelcomeMessage(random: () => number = Math.random): string {
  const value = random();
  const index = Math.min(HOPEFUL_WELCOME_MESSAGES.length - 1,
    Math.max(0, Math.floor((Number.isFinite(value) ? value : 0) * HOPEFUL_WELCOME_MESSAGES.length)));
  return HOPEFUL_WELCOME_MESSAGES[index]!;
}

// Tall, layered pixel flames inspired by a real torch: a dark outer rim,
 // orange body, yellow-hot shell and a curling orange pocket inside. The body
 // stays anchored while eight silhouettes sway and the ember layer drifts.
const FLAME_FRAMES = [
  [
    "           ░           ",
    "          ░▒           ",
    "         ░▒▓░          ",
    "        ░▒▓█▓▒         ",
    "       ░▒▓████▒        ",
    "      ░▒▓██@██▓▒       ",
    "     ░▒▓██@@@██▓▒      ",
    "    ░▒▓██@@▓@██▓▒      ",
    "   ░▒▓██@▓▓▓@██▓▒      ",
    "   ░▒▓██████████▓▒     ",
    "    ░▒▓████████▓▒      ",
    "      ▒▓██████▓▒       ",
    "        ▒████▒         "
  ],
  [
    "         ░             ",
    "        ░▒             ",
    "       ░▒▓░            ",
    "       ▒▓█▓▒           ",
    "      ▒▓████▓▒         ",
    "     ░▒▓██@██▓▒        ",
    "    ░▒▓██@@@██▓▒       ",
    "   ░▒▓██@▓@@██▓▒       ",
    "   ▒▓██@▓▓▓@███▓▒      ",
    "    ▒▓██████████▓▒     ",
    "     ▒▓████████▓▒      ",
    "      ▒▓██████▓▒       ",
    "        ▒████▒         "
  ],
  [
    "             ░         ",
    "            ▒░         ",
    "          ░▒▓░         ",
    "         ▒▓██▒         ",
    "       ░▒▓████▓▒       ",
    "      ▒▓██@███▓▒       ",
    "     ▒▓██@@@███▓▒      ",
    "    ▒▓██@@▓@@██▓▒      ",
    "   ▒▓██@▓▓▓@███▓▒      ",
    "   ░▒▓██████████▓▒     ",
    "     ▒▓████████▓▒      ",
    "       ▒▓████▓▒        ",
    "        ▒████▒         "
  ],
  [
    "        ░              ",
    "        ░▒             ",
    "         ▒▓░           ",
    "        ▒▓██▒          ",
    "      ░▒▓████▒         ",
    "     ▒▓██@███▓▒        ",
    "    ▒▓██@@@███▓▒       ",
    "   ▒▓██@@▓@@██▓▒       ",
    "   ▒▓██@▓▓▓@██▓▒       ",
    "    ▒▓██████████▓▒     ",
    "     ▒▓████████▓▒      ",
    "      ▒▓██████▓▒       ",
    "        ▒████▒         "
  ],
  [
    "           ░           ",
    "         ░▒            ",
    "        ░▒▓░           ",
    "       ▒▓██▓▒          ",
    "      ▒▓█████▒         ",
    "    ░▒▓██@███▓▒        ",
    "   ░▒▓██@@@███▓▒       ",
    "    ▒▓██@▓@@██▓▒       ",
    "   ▒▓██@▓▓▓@███▓▒      ",
    "    ▒▓██████████▓▒     ",
    "     ▒▓████████▓▒      ",
    "       ▒▓████▓▒        ",
    "        ▒████▒         "
  ],
  [
    "         ░             ",
    "          ▒░           ",
    "         ▒▓░           ",
    "        ▒▓██▒          ",
    "       ▒▓████▓▒        ",
    "      ▒▓██@███▓▒       ",
    "    ░▒▓██@@@███▓▒      ",
    "   ░▒▓██@@▓@@██▓▒      ",
    "    ▒▓██@▓▓▓@██▓▒      ",
    "    ▒▓██████████▓▒     ",
    "     ▒▓████████▓▒      ",
    "      ▒▓██████▓▒       ",
    "        ▒████▒         "
  ],
  [
    "             ░         ",
    "           ░▒          ",
    "          ▒▓░          ",
    "        ░▒▓█▓▒         ",
    "       ▒▓████▓▒        ",
    "      ▒▓██@███▓▒       ",
    "     ▒▓██@@@███▓▒      ",
    "    ▒▓██@@▓@@██▓▒      ",
    "   ░▒▓██@▓▓▓@██▓▒      ",
    "    ▒▓██████████▓▒     ",
    "     ▒▓████████▓▒      ",
    "       ▒▓████▓▒        ",
    "        ▒████▒         "
  ],
  [
    "        ░              ",
    "         ▒░            ",
    "        ▒▓░            ",
    "       ▒▓██▒           ",
    "     ░▒▓████▓▒         ",
    "    ░▒▓██@███▓▒        ",
    "     ▒▓██@@@███▓▒      ",
    "    ▒▓██@@▓@@██▓▒      ",
    "   ▒▓██@▓▓▓@███▓▒      ",
    "    ▒▓██████████▓▒     ",
    "     ▒▓████████▓▒      ",
    "      ▒▓██████▓▒       ",
    "        ▒████▒         "
  ]
] as const;

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
const FLAME_WIDTH = 23;
const FIRE_RGB = {
  core: "#FFF2A6",
  hot: "#FFD45A",
  orange: "#FF8A1F",
  edge: "#B83A18",
  inner: "#FF6A00",
  spark: "#FFE16A",
  ember: "#FF991F",
  fading: "#A94320"
} as const;

const EMBERS = [
  { x: 2, startY: 10, phase: 0, life: 14, drift: 0.45 },
  { x: 20, startY: 10, phase: 3, life: 15, drift: -0.45 },
  { x: 4, startY: 8, phase: 6, life: 17, drift: -0.25 },
  { x: 18, startY: 9, phase: 9, life: 16, drift: 0.30 },
  { x: 1, startY: 11, phase: 12, life: 18, drift: 0.35 },
  { x: 21, startY: 7, phase: 2, life: 13, drift: -0.35 },
  { x: 6, startY: 12, phase: 5, life: 15, drift: 0.20 },
  { x: 16, startY: 12, phase: 8, life: 14, drift: -0.20 },
  { x: 3, startY: 6, phase: 10, life: 16, drift: 0.30 },
  { x: 19, startY: 6, phase: 1, life: 17, drift: -0.30 }
] as const;

const center = (line: string, width: number) => {
  const room = Math.max(0, width - visibleWidth(line));
  const left = Math.floor(room / 2);
  return " ".repeat(left) + line + " ".repeat(room - left);
};
const fixedCell = (line: string, width: number) => {
  const value = truncateToWidth(line, width);
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
};
const flameCell = (line: string) => fixedCell(line, FLAME_WIDTH);
const flameArtCell = (line: string) => center(line, ART_WIDTH);
const piArtCell = (line: string) => center(fixedCell(line, 21), ART_WIDTH);

function rgb(hex: string, text: string): string {
  const value = hex.replace("#", "");
  if (value.length !== 6) return text;
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

function addEmbers(lines: readonly string[], frame: number): string[] {
  const canvas = lines.map((line) => [...flameCell(line)]);
  for (const particle of EMBERS) {
    const age = (frame + particle.phase) % particle.life;
    if (age > 8) continue;
    const rise = Math.floor(age / 2);
    const y = particle.startY - rise;
    const x = Math.round(particle.x + particle.drift * age);
    if (y < 0 || y >= canvas.length || x < 0 || x >= FLAME_WIDTH) continue;
    if (canvas[y]![x] !== " ") continue;
    canvas[y]![x] = age <= 1 ? "S" : age <= 4 ? "s" : ".";
  }
  return canvas.map((row) => row.join(""));
}

function paintFlame(line: string): string {
  return line
    .replace(/@+/g, (part) => rgb(FIRE_RGB.inner, "█".repeat(part.length)))
    .replace(/█+/g, (part) => rgb(FIRE_RGB.core, part))
    .replace(/▓+/g, (part) => rgb(FIRE_RGB.hot, part))
    .replace(/▒+/g, (part) => rgb(FIRE_RGB.orange, part))
    .replace(/░+/g, (part) => rgb(FIRE_RGB.edge, part))
    .replace(/S+/g, (part) => rgb(FIRE_RGB.spark, "■".repeat(part.length)))
    .replace(/s+/g, (part) => rgb(FIRE_RGB.ember, "▪".repeat(part.length)))
    .replace(/\.+/g, (part) => rgb(FIRE_RGB.fading, "·".repeat(part.length)));
}

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
  const task = role?.task ?? (info.tasks ? `${info.tasks} open to-do${info.tasks === 1 ? "" : "s"}` : "no active task");
  const subagents = Math.max(0, (info.roles?.length ?? 0) - (info.roles?.some((r) => r.name === "assistant") ? 1 : 0));
  const roleChip = fg("accent", `[ role-${roleName} ]`);
  const activityChip = fg(role?.state === "failed" ? "error" : "warning", `[ ${roleState} ]`);
  const subagentChip = fg("accent", `[ subagents ${subagents} ]`);
  const quotaChip = info.quota != null
    ? fg("warning", `[ quota ${Math.round(info.quota)}% ]`)
    : fg("dim", `[ quota ${info.quotaEnabled ? "unavailable" : "off"} ]`);
  const narrow = w < 48;
  const badges = [roleChip, activityChip, subagentChip, quotaChip];
  const badgeRows: string[] = [];
  for (const badge of badges) {
    const last = badgeRows.length - 1;
    if (last >= 0 && visibleWidth(badgeRows[last]!) + visibleWidth(badge) + 1 <= inner) badgeRows[last] += " " + badge;
    else badgeRows.push(badge);
  }
  const branch = info.branch ? fg("muted", `[ git ${cleanText(info.branch, 24)} ]`) : fg("dim", "[ git unavailable ]");
  const git = branch + (info.dirty ? " " + fg("warning", "[ dirty ]") : "");
  const label = (name: string, value: string, color: WelcomeColor = "muted") =>
    fg("dim", `${name.padEnd(10)} │ `) + fg(color, cleanText(value, 70));
  const managers = info.managers?.length
    ? (narrow ? info.managers.join(" + ") : info.managers.map((m) => m === "tasks" ? "/tasks" : "/subagents-fleet").join(" · "))
    : "none detected";
  const hope = cleanText(info.message ?? HOPEFUL_WELCOME_MESSAGES[0], 100);
  return [
    fg("dim", "╭" + "─".repeat(w - 2) + "╮"),
    cell(fg("accent", "pi-jar") + fg("muted", "  ·  roles & orchestration")),
    divider,
    ...badgeRows.map(cell),
    divider,
    cell(fg("muted", "Welcome to ") + fg("accent", "pi-jar")),
    cell(fg("dim", hope)),
    divider,
    cell(label("TASK", task, role?.state === "failed" ? "error" : "accent")),
    cell(label("PROJECT", info.project || "unavailable")),
    cell(label("MANAGERS", managers)),
    cell(git),
    divider,
    cell(fg("accent", "[ ⚙ Settings ↗ ]") + fg("dim", narrow ? "  /jar settings" : "  ·  /jar hub  ·  /jar welcome")),
    fg("dim", "╰" + "─".repeat(w - 2) + "╯")
  ];
}

export function welcomeSettingsHit(lines: readonly string[], x: number, y: number): boolean {
  const line = lines[y];
  if (!line) return false;
  const text = stripTerminalSequences(line);
  const labels = ["[ ⚙ Settings ↗ ]", "[ Settings ↗ ]", "/jar settings"];
  const label = labels.find((candidate) => text.includes(candidate));
  if (!label) return false;
  const offset = text.indexOf(label);
  const start = visibleWidth(text.slice(0, offset));
  return x >= Math.max(0, start - 1) && x < start + visibleWidth(label) + 1;
}

export function welcomeLines(width: number, frame: number, fg: Paint, info: WelcomeInfo = {}): string[] {
  if (width <= 0) return [];
  const fit = (line: string) => truncateToWidth(line, width);
  const step = ((frame % FLAME_FRAMES.length) + FLAME_FRAMES.length) % FLAME_FRAMES.length;
  const flame = addEmbers(FLAME_FRAMES[step] ?? FLAME_FRAMES[0], frame).map((line) => paintFlame(line));
  const compactFlame = flame.slice(2, 10);
  if (width < 32) return [
    ...compactFlame.map((line) => fit(line)),
    ...PI_COMPACT.map((line) => fit(fg("accent", line))),
    fit(fg("accent", "pi-jar · role-assistant")),
    fit(fg("accent", "/jar settings")),
    ""
  ];
  const wide = width >= 72;
  const art = wide ? [
    ...flame.map((line) => flameArtCell(line)),
    ...PI_LARGE.map((line) => fg("accent", piArtCell(line)))
  ] : [...compactFlame, ...PI_COMPACT.map((line) => fg("accent", line))];
  const details = card(wide ? width - ART_WIDTH - 2 : width, fg, info);
  if (!wide) return [...art.map(fit), ...details.map(fit), ""];
  const topPad = Math.max(0, Math.floor((details.length - art.length) / 2));
  const artRows = [...Array.from({ length: topPad }, () => " ".repeat(ART_WIDTH)), ...art];
  const merged = Array.from({ length: Math.max(artRows.length, details.length) }, (_, index) => {
    const left = artRows[index] ?? " ".repeat(ART_WIDTH);
    return fit(left + "  " + (details[index] ?? ""));
  });
  return [...merged, "", ""];
}
