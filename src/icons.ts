/**
 * Glyph sets for pi-jar chrome, modelled on omp's symbol presets:
 * - `unicode`: symbols every monospace font ships (default);
 * - `nerd`: Nerd Font icons (install a Nerd Font, e.g. via `brew install --cask font-jetbrains-mono-nerd-font`);
 * - `ascii`: no decorative glyphs; key hints spelled out.
 * Decorative keys may map to "" in `ascii`; always render through `withIcon`.
 */
export const ICON_SETS = ["unicode", "nerd", "ascii"] as const;
export type IconSet = (typeof ICON_SETS)[number];

export type IconKey =
  | "pi" | "model" | "folder" | "branch" | "context" | "memory" | "cost" | "quota" | "session"
  | "subagents" | "agent" | "shell" | "changes" | "goal" | "plan" | "tasks" | "time" | "tools" | "roles"
  | "esc" | "enter" | "tab" | "shiftEnter"
  | "success" | "error" | "running" | "pending" | "stopped" | "warning"
  | "thinkingMinimal" | "thinkingLow" | "thinkingMedium" | "thinkingHigh" | "thinkingXhigh" | "thinkingMax";

const UNICODE: Record<IconKey, string> = {
  pi: "π", model: "⬢", folder: "⌂", branch: "⎇", context: "◫", memory: "▤", cost: "", quota: "◔", session: "◈",
  subagents: "⧉", agent: "◉", shell: "⚙", changes: "±", goal: "◎", plan: "◆", tasks: "☰", time: "◷", tools: "⚒", roles: "⇄",
  esc: "⎋", enter: "⏎", tab: "⇥", shiftEnter: "⇧⏎",
  success: "✔", error: "✖", running: "●", pending: "○", stopped: "■", warning: "⚠",
  thinkingMinimal: "○", thinkingLow: "◔", thinkingMedium: "◑", thinkingHigh: "◒", thinkingXhigh: "◕", thinkingMax: "◉"
};

// Code points follow omp's nerd preset (Font Awesome / Codicons / Material Design ranges).
const NERD: Record<IconKey, string> = {
  pi: "\u{f0d57}", model: "\uec19", folder: "\uf115", branch: "\uf126", context: "\ue70f", memory: "\u{f035b}",
  cost: "\uf0d6", quota: "\uf0e4", session: "\u{f02da}",
  subagents: "\uf0c0", agent: "\uf007", shell: "\uf120", changes: "\uf044", goal: "\uf140", plan: "\uf2d2",
  tasks: "\uf0ae", time: "\uf017", tools: "\uf0ad", roles: "\u{f04e1}",
  esc: "\u{f12b7}", enter: "\u{f0311}", tab: "\u{f0312}", shiftEnter: "\u{f0636}\u{f0311}",
  success: "\uf00c", error: "\uf00d", running: "\uf111", pending: "\uf10c", stopped: "\uf04d", warning: "\uf071",
  thinkingMinimal: "\u{f0a9e}", thinkingLow: "\u{f0a9f}", thinkingMedium: "\u{f0aa1}", thinkingHigh: "\u{f0aa3}",
  thinkingXhigh: "\u{f0aa5}", thinkingMax: "\uf06d"
};

const ASCII: Record<IconKey, string> = {
  pi: "", model: "", folder: "", branch: "git", context: "ctx", memory: "ram", cost: "cost", quota: "quota", session: "",
  subagents: "", agent: "", shell: "$", changes: "+/-", goal: "goal", plan: "plan", tasks: "", time: "", tools: "", roles: "",
  esc: "esc", enter: "enter", tab: "tab", shiftEnter: "shift+enter",
  success: "ok", error: "x", running: "*", pending: "-", stopped: "#", warning: "!",
  thinkingMinimal: "", thinkingLow: "", thinkingMedium: "", thinkingHigh: "", thinkingXhigh: "", thinkingMax: ""
};

const SETS: Record<IconSet, Record<IconKey, string>> = { unicode: UNICODE, nerd: NERD, ascii: ASCII };
let active: IconSet = "unicode";

/** Process-wide: renderers read the active set on every paint, so a settings change applies on the next frame. */
export function setIconSet(set: IconSet): void { active = set; }
export function iconSet(): IconSet { return active; }
export function icon(key: IconKey): string { return SETS[active][key]; }
/** `glyph text`, or just `text` when the active set has no glyph for `key`. */
export function withIcon(key: IconKey, text: string): string {
  const glyph = SETS[active][key];
  return glyph ? (text ? glyph + " " + text : glyph) : text;
}
