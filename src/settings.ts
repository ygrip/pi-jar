import { existsSync, readFileSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCENT_NAMES } from "./accent.ts";
import { DEFAULT_FOOTER_SETTINGS, FOOTER_FIELDS, type FooterSettings } from "./footer-settings.ts";
import { ICON_SETS, type IconSet } from "./icons.ts";

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
  /** Retained live subagent pool, including idle/paused agents; lowering does not terminate them. */
  maxSubagents: MaxSubagents;
  /** The jar_advisor second-opinion tool and /advisor. */
  advisor: boolean;
  /** Consult the advisor automatically when the agent repeats a tool call or keeps failing. */
  advisorGates: boolean;
  /** Opt-in provider-context pruning of reasoning from completed earlier user turns. */
  contextDiet: boolean;
  /** Explain prompt-cache breaks: which tool, system section or message changed when a call re-sent cached context. */
  cacheDiagnostics: boolean;
  /** Context-size guard: past softTokens, suggest /compact or /new, or compact at the next safe point. */
  contextBudget: ContextBudget;
  /** Opt-in: an unchanged repeated `read` of the same range returns a short stub instead of the content. */
  readCache: boolean;
  /** Glyph set for footer, composer and views: unicode, Nerd Font icons, or plain ascii. */
  icons: IconSet;
  footer: FooterSettings;
}

export const CONTEXT_BUDGET_ACTIONS = ["off", "suggest", "compact"] as const;
export type ContextBudgetAction = (typeof CONTEXT_BUDGET_ACTIONS)[number];
export interface ContextBudget { softTokens: number; action: ContextBudgetAction }
export const CONTEXT_BUDGET_CHOICES = [80_000, 120_000, 160_000, 200_000] as const;
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = { softTokens: 120_000, action: "suggest" };
/** Accepts any stored integer budget in a sane range, not only the picker's choices. */
export function parseContextBudget(value: unknown): ContextBudget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { softTokens, action } = value as Record<string, unknown>;
  if (typeof softTokens !== "number" || !Number.isInteger(softTokens) || softTokens < 10_000 || softTokens > 2_000_000) return undefined;
  if (!CONTEXT_BUDGET_ACTIONS.some((choice) => choice === action)) return undefined;
  return { softTokens, action: action as ContextBudgetAction };
}

export const GOAL_ROUND_CHOICES = [4, 8, 12, 20] as const;
export const MAX_SUBAGENT_CHOICES = [2, 4, 6, 8, 16] as const;
export type MaxSubagents = (typeof MAX_SUBAGENT_CHOICES)[number];
export function isMaxSubagents(value: unknown): value is MaxSubagents {
  return MAX_SUBAGENT_CHOICES.some((choice) => choice === value);
}

export const SETTINGS_FILE = "pi-jar-settings.json";
export function defaultVisualSettings(footer: FooterSettings = DEFAULT_FOOTER_SETTINGS): JarVisualSettings {
  return { version: 1, accent: "follow", animations: true, ui: true, composer: true, mascot: true, suggestions: true, goalRounds: 8, maxSubagents: 2, advisor: true, advisorGates: false, contextDiet: false, cacheDiagnostics: true, contextBudget: { ...DEFAULT_CONTEXT_BUDGET }, readCache: false, icons: "unicode", footer: { ...footer } };
}

/** Legacy footer choices are imported only while the new file is absent. Never modify the old file. */
export function loadVisualSettings(directory: string): JarVisualSettings {
  let text: string;
  try { text = readFileSync(join(directory, SETTINGS_FILE), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultVisualSettings();
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
    maxSubagents: isMaxSubagents(value.maxSubagents) ? value.maxSubagents : fallback.maxSubagents,
    advisor: typeof value.advisor === "boolean" ? value.advisor : fallback.advisor,
    advisorGates: typeof value.advisorGates === "boolean" ? value.advisorGates : fallback.advisorGates,
    contextDiet: typeof value.contextDiet === "boolean" ? value.contextDiet : fallback.contextDiet,
    cacheDiagnostics: typeof value.cacheDiagnostics === "boolean" ? value.cacheDiagnostics : fallback.cacheDiagnostics,
    contextBudget: parseContextBudget(value.contextBudget) ?? fallback.contextBudget,
    readCache: typeof value.readCache === "boolean" ? value.readCache : fallback.readCache,
    icons: ICON_SETS.some((set) => set === value.icons) ? value.icons as IconSet : fallback.icons,
    footer: Object.fromEntries(FOOTER_FIELDS.map((field) => [field,
      typeof footer[field] === "boolean" ? footer[field] : fallback.footer[field]])) as FooterSettings
  };
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
