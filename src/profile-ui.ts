import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JarProfile, ProfileStore } from "./profiles.ts";
import type { JarVisualSettings } from "./settings.ts";

export type ProfileAction = "create" | "switch";

export interface ProfileUiOptions {
  store: ProfileStore;
  themes: readonly string[];
  /** Copies the active profile's settings and roles into a new profile. */
  create(name: string, theme: string): JarProfile;
  /** Why the current session cannot switch profiles, or undefined when it can. */
  switchBlocked(): string | undefined;
  select(name: string): Promise<void>;
  openRoles(): Promise<void>;
}

/** Opt-in preset for heavy parallel work: the current settings with a larger retained subagent pool. */
export const SWARM_SETTINGS = { maxSubagents: 4 } as const satisfies Partial<JarVisualSettings>;
const CREATE = "+ Create profile…";
const SWARM = `+ Create Swarm profile (${SWARM_SETTINGS.maxSubagents} subagents)…`;
const FOLLOW = "Follow Pi";

/** Name and theme are the only creation questions; roles are configured afterwards in the roles UI.
 *  A preset patches the copied settings once the copy is saved. */
export async function promptNewProfile(ctx: ExtensionContext, options: Pick<ProfileUiOptions, "store" | "themes" | "create">,
  preset?: Partial<JarVisualSettings>): Promise<JarProfile | undefined> {
  const name = await ctx.ui.input("New profile name (1–32 characters)", "");
  if (name === undefined) return undefined;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) { ctx.ui.notify("Profile name cannot contain control characters", "warning"); return undefined; }
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 32 || /[\\/\0]/.test(normalized)) {
    ctx.ui.notify("Profile name must be 1–32 characters and cannot contain slashes", "warning"); return undefined;
  }
  if (options.store.list().some((profile) => profile.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
    ctx.ui.notify("A profile with that name already exists", "warning"); return undefined;
  }
  const selected = await ctx.ui.select("Choose a theme for " + normalized, [FOLLOW, ...options.themes.filter((item) => item !== "follow")]);
  if (!selected) return undefined;
  let profile: JarProfile;
  try { profile = options.create(normalized, selected === FOLLOW ? "follow" : selected); }
  catch (error) { ctx.ui.notify("Could not create profile: " + (error as Error).message, "error"); return undefined; }
  if (!preset) return profile;
  try { return options.store.update(profile.name, { settings: { ...profile.settings, ...preset } }); }
  catch (error) {
    ctx.ui.notify(`Created profile ${profile.name}, but could not apply its preset: ${(error as Error).message}`, "warning");
    return profile;
  }
}

/** /profiles and the settings Profiles tab: create a profile or switch to one, nothing else. */
export async function openProfiles(ctx: ExtensionContext, options: ProfileUiOptions, action?: ProfileAction): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  const active = options.store.activeName;
  let preset: Partial<JarVisualSettings> | undefined;
  if (action !== "create") {
    const labels = new Map(options.store.list().map((profile) => [profile.name === active ? `${profile.name} (active)` : profile.name, profile.name]));
    const choice = await ctx.ui.select(action === "switch" ? "Switch profile" : "Profiles", action === "switch" ? [...labels.keys()] : [CREATE, SWARM, ...labels.keys()]);
    if (!choice) return;
    if (choice !== CREATE && choice !== SWARM) { await options.select(labels.get(choice)!); return; }
    if (choice === SWARM) preset = SWARM_SETTINGS;
  }
  const profile = await promptNewProfile(ctx, options, preset);
  if (!profile) return;
  if (options.switchBlocked()) {
    ctx.ui.notify(`Created profile ${profile.name} with ${active}'s model roles. Switch to it in a fresh session with /profiles, then set its roles with /roles.`, "info");
    return;
  }
  await options.select(profile.name);
  if (options.store.activeName !== profile.name) return;
  ctx.ui.notify(`Created profile ${profile.name}. Its model roles start as a copy of ${active}'s; set them now in Roles (later: /roles).`, "info");
  await options.openRoles();
}
