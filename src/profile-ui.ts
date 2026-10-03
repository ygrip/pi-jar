import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JarProfile, ProfileStore } from "./profiles.ts";

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

const CREATE = "+ Create profile…";
const FOLLOW = "Follow Pi";

/** Name and theme are the only creation questions; roles are configured afterwards in the roles UI. */
export async function promptNewProfile(ctx: ExtensionContext, options: Pick<ProfileUiOptions, "store" | "themes" | "create">): Promise<JarProfile | undefined> {
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
  try { return options.create(normalized, selected === FOLLOW ? "follow" : selected); }
  catch (error) { ctx.ui.notify("Could not create profile: " + (error as Error).message, "error"); return undefined; }
}

/** /profiles and the settings Profiles tab: create a profile or switch to one, nothing else. */
export async function openProfiles(ctx: ExtensionContext, options: ProfileUiOptions, action?: ProfileAction): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  const active = options.store.activeName;
  if (action !== "create") {
    const labels = new Map(options.store.list().map((profile) => [profile.name === active ? `${profile.name} (active)` : profile.name, profile.name]));
    const choice = await ctx.ui.select(action === "switch" ? "Switch profile" : "Profiles", action === "switch" ? [...labels.keys()] : [CREATE, ...labels.keys()]);
    if (!choice) return;
    if (choice !== CREATE) { await options.select(labels.get(choice)!); return; }
  }
  const profile = await promptNewProfile(ctx, options);
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
