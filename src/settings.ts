import { existsSync, readFileSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCENT_NAMES } from "./accent.ts";
import { DEFAULT_FOOTER_SETTINGS, FOOTER_FIELDS, loadFooterSettings, type FooterSettings } from "./footer-settings.ts";

export type JarAccent = "follow" | "default" | (typeof ACCENT_NAMES)[number];
export interface JarVisualSettings {
  version: 1;
  accent: JarAccent;
  animations: boolean;
  ui: boolean;
  composer: boolean;
  /** Ember mascot perched on the composer. */
  mascot: boolean;
  /** Agent-provided next-prompt ghost text in the composer. */
  suggestions: boolean;
  /** Automatic implement/audit rounds per user message while a goal is active. */
  goalRounds: number;
  footer: FooterSettings;
}

export const GOAL_ROUND_CHOICES = [4, 8, 12, 20] as const;

export const SETTINGS_FILE = "pi-jar-settings.json";
export function defaultVisualSettings(footer: FooterSettings = DEFAULT_FOOTER_SETTINGS): JarVisualSettings {
  return { version: 1, accent: "follow", animations: true, ui: true, composer: true, mascot: true, suggestions: true, goalRounds: 8, footer: { ...footer } };
}

/** Legacy footer choices are imported only while the new file is absent. Never modify the old file. */
export function loadVisualSettings(directory: string): JarVisualSettings {
  let text: string;
  try { text = readFileSync(join(directory, SETTINGS_FILE), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultVisualSettings(loadFooterSettings(directory));
    return defaultVisualSettings();
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return defaultVisualSettings(); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultVisualSettings();
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) return defaultVisualSettings();
  const fallback = defaultVisualSettings();
  const footer = value.footer && typeof value.footer === "object" && !Array.isArray(value.footer)
    ? value.footer as Record<string, unknown> : {};
  return {
    version: 1,
    accent: value.accent === "follow" || value.accent === "default" || ACCENT_NAMES.some((name) => name === value.accent)
      ? value.accent as JarAccent : fallback.accent,
    animations: typeof value.animations === "boolean" ? value.animations : fallback.animations,
    ui: typeof value.ui === "boolean" ? value.ui : fallback.ui,
    composer: typeof value.composer === "boolean" ? value.composer : fallback.composer,
    mascot: typeof value.mascot === "boolean" ? value.mascot : fallback.mascot,
    suggestions: typeof value.suggestions === "boolean" ? value.suggestions : fallback.suggestions,
    goalRounds: typeof value.goalRounds === "number" && Number.isInteger(value.goalRounds) && value.goalRounds >= 1 && value.goalRounds <= 50
      ? value.goalRounds : fallback.goalRounds,
    footer: Object.fromEntries(FOOTER_FIELDS.map((field) => [field,
      typeof footer[field] === "boolean" ? footer[field] : fallback.footer[field]])) as FooterSettings
  };
}

export function migrateLegacySettings(directory: string): boolean {
  if (existsSync(join(directory, SETTINGS_FILE)) || !existsSync(join(directory, "pi-jar-footer.json"))) return false;
  try {
    const legacy: unknown = JSON.parse(readFileSync(join(directory, "pi-jar-footer.json"), "utf8"));
    if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) return false;
    saveVisualSettings(directory, defaultVisualSettings(loadFooterSettings(directory)));
    return true;
  } catch { return false; } // Leave malformed legacy preferences untouched for manual repair.
}

export function saveVisualSettings(directory: string, settings: JarVisualSettings): void {
  mkdirSync(directory, { recursive: true });
  const target = join(directory, SETTINGS_FILE);
  if (existsSync(target)) {
    let prior: unknown;
    try { prior = JSON.parse(readFileSync(target, "utf8")); }
    catch { throw new Error("Cannot overwrite malformed pi-jar settings"); }
    if (!prior || typeof prior !== "object" || (prior as Record<string, unknown>).version !== 1) {
      throw new Error("Cannot overwrite unknown pi-jar settings version");
    }
  }
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", { flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* No temporary file to clean up. */ }
    throw error;
  }
}
