import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Sharpened pi-jar dark preset values; keep these in sync with bundled theme vars. */
export const ACCENTS = {
  gray: { accent: "#D0D9E5", selected: "#252B35" },
  pink: { accent: "#FF88C6", selected: "#3B1D2D" },
  teal: { accent: "#45DDD1", selected: "#123433" },
  azure: { accent: "#75BCFF", selected: "#132A41" },
  violet: { accent: "#BCA0FF", selected: "#2C2350" },
  amber: { accent: "#F7B955", selected: "#3A2B0F" }
} as const;

export type AccentName = keyof typeof ACCENTS;
export const ACCENT_NAMES = Object.keys(ACCENTS) as AccentName[];

/** A loaded extension is not proof that Pi also discovered its package themes. */
export function loadedAccents(ctx: ExtensionContext): string[] {
  if (!ctx.hasUI || ctx.mode !== "tui") return [];
  try {
    return ["default", ...ACCENT_NAMES].filter((name) =>
      Boolean(ctx.ui.getTheme(name === "default" ? "pi-jar-dark" : `pi-jar-dark-${name}`)));
  } catch { return []; }
}

/** Only switch among complete bundled themes; never mutate semantic status colors. */
export function selectAccent(ctx: ExtensionContext, value: string): boolean {
  if (!ctx.hasUI || ctx.mode !== "tui") return false;
  const themeName = value === "default" ? "pi-jar-dark"
    : Object.hasOwn(ACCENTS, value) ? `pi-jar-dark-${value}` : undefined;
  if (!themeName) return false;
  try {
    if (!ctx.ui.getTheme(themeName)) return false;
    // Switching by name persists Pi's theme setting; passing a Theme instance does not.
    return ctx.ui.setTheme(themeName).success;
  } catch { return false; }
}
