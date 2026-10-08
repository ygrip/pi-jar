import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRoleName, normalizeSpec, parseRoleConfig, type RoleConfig } from "./model-roles.ts";
import { isMaxSubagents, defaultVisualSettings, loadVisualSettings, parseContextBudget, DEFAULT_CONTEXT_BUDGET, type JarVisualSettings } from "./settings.ts";
import { ACCENT_NAMES } from "./accent.ts";
import { FOOTER_FIELDS } from "./footer-settings.ts";
import { ICON_SETS } from "./icons.ts";

export interface JarProfile { id: string; name: string; theme: string; settings: JarVisualSettings; roles: RoleConfig }
interface ProfileDocument { version: 1; active: string; profiles: JarProfile[] }
export const PROFILE_FILE = "pi-jar-profiles.json";
export const DEFAULT_PROFILE = "Default";
export const PROFILE_ENTRY = "pi-jar.profile";
export function conversationStarted(entries: readonly unknown[]): boolean {
  return entries.some((entry) => isPlainObject(entry) && (entry.role === "user"
    || (entry.type === "message" && isPlainObject(entry.message) && entry.message.role === "user")));
}
export function pinnedProfileId(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (isPlainObject(entry) && entry.type === "custom" && entry.customType === PROFILE_ENTRY
      && isPlainObject(entry.data) && entry.data.version === 1 && typeof entry.data.id === "string") return entry.data.id;
  }
  return undefined;
}
const safeName = (value: string) => value.trim().replace(/\s+/g, " ");
const profileId = () => `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function validProfileName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 32 && !/[\\/\0\u0001-\u001f\u007f-\u009f]/.test(value) && value.trim() === value;
}
function normalizeProfile(value: unknown): JarProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!validProfileName(raw.name) || typeof raw.theme !== "string" || !raw.theme || !isPlainObject(raw.settings)
    || raw.settings.version !== 1 || !isPlainObject(raw.roles) || raw.roles.version !== 2 || !isPlainObject(raw.roles.roles)) return undefined;
  const settings = raw.settings;
  const footer = settings.footer;
  if (!["accent", "animations", "ui", "composer", "mascot", "suggestions", "goalRounds", "maxSubagents", "advisor", "advisorGates", "icons", "footer"].every((key) => key in settings)
    || !isPlainObject(settings.footer) || typeof settings.animations !== "boolean" || typeof settings.ui !== "boolean"
    || typeof settings.composer !== "boolean" || typeof settings.mascot !== "boolean" || typeof settings.suggestions !== "boolean"
    || typeof settings.advisor !== "boolean" || typeof settings.advisorGates !== "boolean"
    || (settings.contextDiet !== undefined && typeof settings.contextDiet !== "boolean")
    || (settings.cacheDiagnostics !== undefined && typeof settings.cacheDiagnostics !== "boolean")
    || (settings.contextBudget !== undefined && !parseContextBudget(settings.contextBudget))
    || (settings.readCache !== undefined && typeof settings.readCache !== "boolean") || !Number.isInteger(settings.goalRounds)
    || (settings.goalRounds as number) < 1 || (settings.goalRounds as number) > 50
    || !isMaxSubagents(settings.maxSubagents) || typeof settings.accent !== "string"
    || !(settings.accent === "follow" || settings.accent === "default" || ACCENT_NAMES.includes(settings.accent as never))
    || !ICON_SETS.includes(settings.icons as never)
    || !isPlainObject(footer) || !FOOTER_FIELDS.every((field) => typeof footer[field] === "boolean")) return undefined;
  if (raw.name === DEFAULT_PROFILE && raw.id !== "default") return undefined;
  if (raw.name !== DEFAULT_PROFILE && (typeof raw.id !== "string" || !/^profile-[a-z0-9-]{8,64}$/.test(raw.id))) return undefined;
  for (const [role, spec] of Object.entries(raw.roles.roles)) if (!isRoleName(role) || typeof spec !== "string" || !normalizeSpec(spec)) return undefined;
  const contextBudget = parseContextBudget(settings.contextBudget) ?? { ...DEFAULT_CONTEXT_BUDGET };
  return { id: raw.id as string, name: raw.name, theme: raw.theme, settings: { ...raw.settings, contextDiet: settings.contextDiet ?? false,
    cacheDiagnostics: settings.cacheDiagnostics ?? true, contextBudget, readCache: settings.readCache ?? false } as unknown as JarVisualSettings, roles: parseRoleConfig(raw.roles) };
}
function atomicSave(file: string, document: ProfileDocument): string {
  mkdirSync(join(file, ".."), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const text = JSON.stringify(document, null, 2) + "\n";
  try { writeFileSync(temporary, text, { flag: "wx" }); renameSync(temporary, file); }
  catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
  return text;
}

export class ProfileStore {
  private document: ProfileDocument;
  private savedContents: string | undefined;
  readonly directory: string;
  constructor(directory: string, initialTheme = "pi-jar-dark", initialRoles: RoleConfig = { version: 2, roles: {} }) {
    this.directory = directory;
    const file = join(directory, PROFILE_FILE);
    let loaded: ProfileDocument | undefined;
    let missing = false;
    try {
      this.savedContents = readFileSync(file, "utf8");
      const raw: unknown = JSON.parse(this.savedContents);
      if (!isPlainObject(raw) || raw.version !== 1 || !Array.isArray(raw.profiles) || typeof raw.active !== "string") throw new Error("Unsupported or malformed pi-jar profiles file");
      const profiles: JarProfile[] = [];
      const names = new Set<string>(); const ids = new Set<string>();
      for (const entry of raw.profiles) {
        const profile = normalizeProfile(entry);
        if (!profile) throw new Error("Malformed profile entry");
        const name = profile.name.toLocaleLowerCase();
        if (names.has(name) || ids.has(profile.id)) throw new Error("Duplicate profile name or id");
        names.add(name); ids.add(profile.id); profiles.push(profile);
      }
      if (profiles.filter((profile) => profile.name === DEFAULT_PROFILE && profile.id === "default").length !== 1) throw new Error("Missing or invalid Default profile");
      const active = profiles.find((profile) => profile.name === raw.active || profile.id === raw.active)?.name;
      if (!active) throw new Error("Active profile does not exist");
      loaded = { version: 1, active, profiles };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") missing = true;
      else throw new Error(`Cannot load ${PROFILE_FILE}: ${(error as Error).message}`);
    }
    if (!loaded && missing) {
      let legacy = defaultVisualSettings();
      try { legacy = loadVisualSettings(directory); } catch { /* default settings */ }
      loaded = { version: 1, active: DEFAULT_PROFILE, profiles: [{ id: "default", name: DEFAULT_PROFILE, theme: initialTheme, settings: legacy, roles: parseRoleConfig(initialRoles) }] };
    }
    this.document = loaded!;
    if (missing) this.persist();
  }
  private persist(next = this.document): void {
    const file = join(this.directory, PROFILE_FILE);
    let current: string | undefined;
    try { current = readFileSync(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current !== this.savedContents) throw new Error("Profiles changed in another session or externally; reload before saving");
    this.savedContents = atomicSave(file, next);
  }
  list(): JarProfile[] { return this.document.profiles.map((profile) => structuredClone(profile)); }
  active(): JarProfile { return structuredClone(this.document.profiles.find((profile) => profile.name === this.document.active)!); }
  get activeName(): string { return this.document.active; }
  update(name: string, patch: Partial<Pick<JarProfile, "theme" | "settings">>): JarProfile {
    const index = this.document.profiles.findIndex((profile) => profile.name === name);
    if (index < 0) throw new Error("Unknown profile: " + name);
    const profiles = [...this.document.profiles];
    const profile = normalizeProfile(structuredClone({ ...profiles[index]!, ...patch }));
    if (!profile) throw new Error("Invalid profile settings or theme");
    profiles[index] = profile;
    const next = { ...this.document, profiles };
    this.persist(next);
    this.document = next;
    return structuredClone(profile);
  }
  add(name: string, theme: string, settings: JarVisualSettings, roles: RoleConfig = { version: 2, roles: {} }): JarProfile {
    if (typeof name !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new Error("Profile name cannot contain control characters");
    const normalized = safeName(name);
    if (!validProfileName(normalized)) throw new Error("Profile name must be 1–32 characters and cannot contain slashes");
    if (this.document.profiles.some((profile) => profile.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) throw new Error("A profile with that name already exists");
    const id = profileId();
    const profile = normalizeProfile({ id, name: normalized, theme, settings: structuredClone(settings), roles });
    if (!profile) throw new Error("Invalid profile settings, theme, or roles");
    const next = { ...this.document, profiles: [...this.document.profiles, profile] };
    this.persist(next);
    this.document = next;
    return structuredClone(profile);
  }
  activate(name: string): JarProfile {
    if (!this.document.profiles.some((profile) => profile.name === name)) throw new Error("Unknown profile: " + name);
    const next = { ...this.document, active: name };
    this.persist(next);
    this.document = next;
    return this.active();
  }
  cycle(): JarProfile {
    const index = this.document.profiles.findIndex((profile) => profile.name === this.document.active);
    return this.activate(this.document.profiles[(index + 1) % this.document.profiles.length]!.name);
  }
}
