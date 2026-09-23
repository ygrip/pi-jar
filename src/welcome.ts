import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { cleanText } from "./status.ts";

export interface WelcomeInfo {
  model?: string;
  project?: string;
  context?: string;
  cost?: string;
  managers?: readonly ("tasks" | "subagents")[];
  quotaEnabled?: boolean;
}

type WelcomeColor = "accent" | "warning" | "error" | "muted" | "dim";
type Paint = (color: WelcomeColor, text: string) => string;

// Smoke rises independently of the flame. Its two frames cost no repaint at idle:
// the short-lived welcome widget alone advances them while animations are enabled.
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
  ["       ░       ", "      █▒       ", "     ▒███▒     ", "     █████░    "]
] as const;

// A large lowercase π: continuous top bar, two descenders and serif feet.
const PI_LARGE = [
  "   ▄▄▄▄▄▄▄▄▄   ",
  "  ▀██▀▀▀▀██▀   ",
  "    ██   ██    ",
  "    ██   ██    ",
  "   ▄██   ██▄   "
] as const;
const PI_COMPACT = [
  "  ▄▄▄▄▄▄▄  ",
  "  ███████  ",
  "   █   █   ",
  "  ▄█   █▄  "
] as const;

export function welcomeLines(width: number, frame: number, fg: Paint, info: WelcomeInfo = {}): string[] {
  if (width <= 0) return [];
  const model = cleanText(info.model ?? "", 28);
  const context = cleanText(info.context ?? "", 16);
  const cost = cleanText(info.cost ?? "", 20);
  const project = cleanText(info.project ?? "", 28);
  const managerNames = info.managers?.map((name) => name === "tasks" ? "/tasks" : "/subagents-fleet") ?? [];
  const quota = info.quotaEnabled ? "quota on · shown when available" : "quota off · /jar quota on";
  const fit = (line: string) => truncateToWidth(line, width);
  const step = ((frame % FLAMES.length) + FLAMES.length) % FLAMES.length;
  const smoke = SMOKE[step] ?? SMOKE[0];
  const flame = FLAMES[step] ?? FLAMES[0];
  const fire = flame.map((line, index) => fg(index < 2 ? "warning" : "error", line));

  if (width < 32) {
    return [
      fit(fg("dim", smoke[1])),
      ...fire.slice(2).map(fit),
      "", // even at narrow widths, smoke/fire never touches the π
      ...PI_COMPACT.map((line) => fit(fg("accent", line))),
      fit(fg("muted", [context, model].filter(Boolean).join(" · ") || "ready")),
      fit(fg("accent", "pi-jar")),
      fit(fg("dim", "/jar hub"))
    ];
  }

  const details = [
    fg("accent", "pi-jar") + fg("muted", "  ·  Setara × Punakawan"),
    ...(project ? [fg("muted", `project  ${project}`)] : []),
    ...(model ? [fg("muted", `model    ${model}`)] : []),
    ...((context || cost) ? [fg("muted", [context, cost].filter(Boolean).join("  ·  "))] : []),
    fg("dim", managerNames.length ? `managers  ${managerNames.join(" · ")}` : "managers  none detected"),
    fg("dim", quota),
    fg("dim", "roles from publishers · /jar demo"),
    fg("accent", "open /jar hub  ·  replay /jar welcome")
  ];
  if (width >= 72) {
    const art = [
      ...smoke.map((line) => fg("dim", line)),
      ...fire,
      "", // the flame floats above, never connects to, the large mathematical π
      ...PI_LARGE.map((line) => fg("accent", line))
    ];
    return Array.from({ length: Math.max(art.length, details.length) }, (_, index) => {
      const left = art[index] ?? "";
      return fit(left + " ".repeat(Math.max(0, 16 - visibleWidth(left))) + "  " + (details[index] ?? ""));
    });
  }

  const compactDetails = [
    details[0] ?? "",
    ...(width >= 48 && project ? [fg("muted", `project  ${project}`)] : []),
    ...(model ? [fg("muted", `model    ${model}`)] : []),
    ...((context || cost) ? [fg("muted", [context, cost].filter(Boolean).join("  ·  "))] : []),
    fg("dim", managerNames.length ? `managers  ${managerNames.join(" · ")}` : "managers  none detected"),
    fg("dim", quota),
    fg("accent", "roles published · /jar hub")
  ];
  return [
    fit(fg("dim", smoke[1])),
    ...fire.slice(1).map(fit),
    "",
    ...PI_COMPACT.map((line) => fit(fg("accent", line))),
    ...compactDetails.map(fit)
  ];
}
