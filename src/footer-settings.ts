import { readFileSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FOOTER_FIELDS = ["model", "effort", "sessionName", "cwd", "context", "memory", "cost", "quota", "roles", "extras", "branch"] as const;
export type FooterField = (typeof FOOTER_FIELDS)[number];
export type FooterSettings = Record<FooterField, boolean>;
export const DEFAULT_FOOTER_SETTINGS: FooterSettings = Object.fromEntries(FOOTER_FIELDS.map((field) => [field, true])) as FooterSettings;

export function loadFooterSettings(directory: string): FooterSettings {
  try {
    const value: unknown = JSON.parse(readFileSync(join(directory, "pi-jar-footer.json"), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_FOOTER_SETTINGS };
    const entries = value as Record<string, unknown>;
    return Object.fromEntries(FOOTER_FIELDS.map((field) => [field,
      typeof entries[field] === "boolean" ? entries[field] : true])) as FooterSettings;
  } catch {
    return { ...DEFAULT_FOOTER_SETTINGS };
  }
}

export function saveFooterSettings(directory: string, settings: FooterSettings): void {
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "pi-jar-footer.json");
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", { flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* No temporary file to clean up. */ }
    throw error;
  }
}
