import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JarVisualSettings } from "./settings.ts";
import type { JarProfile, ProfileStore } from "./profiles.ts";
import { isRoleName, normalizeSpec, type RoleConfig, type ModelRoleManager } from "./model-roles.ts";

export interface ProfileWizardOptions {
  themes: readonly string[];
  settings: JarVisualSettings;
  roles: RoleConfig;
  roleManager?: ModelRoleManager;
  create(name: string, theme: string, settings: JarVisualSettings, roles: RoleConfig): JarProfile;
}

/** Every step is cancellable; creation happens only after the final confirmation. */
export async function createProfileWizard(ctx: ExtensionContext, store: ProfileStore, options: ProfileWizardOptions): Promise<JarProfile | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") return undefined;
  const name = await ctx.ui.input("New profile name (1–32 characters)", "");
  if (name === undefined) return undefined;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) { ctx.ui.notify("Profile name cannot contain control characters", "warning"); return undefined; }
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 32 || /[\\/\0]/.test(normalized)) {
    ctx.ui.notify("Profile name must be 1–32 characters and cannot contain slashes", "warning"); return undefined;
  }
  if (store.list().some((profile) => profile.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
    ctx.ui.notify("A profile with that name already exists", "warning"); return undefined;
  }
  if (!options.themes.length) { ctx.ui.notify("No themes are available for profiles", "warning"); return undefined; }
  const selectedTheme = await ctx.ui.select("Choose a theme for " + normalized, ["Follow Pi", ...options.themes.filter((item) => item !== "follow")]);
  if (!selectedTheme) return undefined;
  const theme = selectedTheme === "Follow Pi" ? "follow" : selectedTheme;
  const roles = structuredClone(options.roles);
  const roleNames = options.roleManager?.list().map((role) => role.role) ?? [];
  if (options.roleManager) {
    for (const role of roleNames) {
      const current = roles.roles[role];
      const answer = await ctx.ui.input(`${role} role assignment (blank keeps current${current ? `: ${current}` : ""}; none clears)`, "");
      if (answer === undefined) return undefined;
      if (!answer.trim()) continue;
      if (answer.trim().toLowerCase() === "none") { delete roles.roles[role]; continue; }
      const model = normalizeSpec(answer.trim());
      if (!model) { ctx.ui.notify("Enter a valid provider/model, @role, *, or none for " + role, "warning"); return undefined; }
      roles.roles[role] = model;
    }
  } else {
    const roleInput = await ctx.ui.input("Role assignments as role=provider/model, comma-separated (optional)", "");
    if (roleInput === undefined) return undefined;
    for (const assignment of roleInput.split(",").map((item) => item.trim()).filter(Boolean)) {
    const split = assignment.indexOf("=");
    if (split <= 0) { ctx.ui.notify("Use role=provider/model for each assignment", "warning"); return undefined; }
    const role = assignment.slice(0, split).trim().toLowerCase();
    const model = normalizeSpec(assignment.slice(split + 1).trim());
    if (!isRoleName(role) || !model) { ctx.ui.notify("Invalid role assignment: " + assignment, "warning"); return undefined; }
    roles.roles[role] = model;
    }
  }
  const roleSummary = Object.entries(roles.roles).map(([role, target]) => `${role} → ${target}`).join("\n") || "No roles assigned";
  const confirmed = await ctx.ui.confirm("Create profile", `${normalized}\nTheme: ${theme === "follow" ? "Follow Pi" : theme}\n${roleSummary}`);
  if (!confirmed) return undefined;
  try { return options.create(normalized, theme, options.settings, roles); }
  catch (error) { ctx.ui.notify("Could not create profile: " + (error as Error).message, "error"); return undefined; }
}
