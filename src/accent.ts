import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Dark preset values mirror ../GDN/punakawan/web/panel/src/lib/accent.ts. */
export const ACCENTS = {
  gray: { accent: "#B8C0CC", selected: "#252B35" },
  pink: { accent: "#F472B6", selected: "#3B1D2D" },
  teal: { accent: "#35C7C4", selected: "#123433" },
  azure: { accent: "#65A9EF", selected: "#132A41" },
  violet: { accent: "#A78BFA", selected: "#2C2350" },
  amber: { accent: "#E5A940", selected: "#3A2B0F" }
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
