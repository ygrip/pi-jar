import { readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve, sep } from "node:path";
import type { RuleList } from "./subagent-tools.ts";

/** One extension or skill the parent's Pi configuration resolves, enabled or filtered out. */
export interface CatalogResource { path: string; enabled: boolean; source: string; packageRoot?: string }
export interface ResourceCatalog { extensions: readonly CatalogResource[]; skills: readonly CatalogResource[] }

/** Pi's built-in extensions; resolved as `builtin:<name>` so an explicit child list keeps the enabled ones. */
export const BUILTIN_EXTENSIONS = ["llama.cpp", "codemode", "tool-search", "mcp"] as const;

/** The parent's resources exactly as Pi resolves them (settings filters, packages, top-level dirs); never installs. */
export async function loadResourceCatalog(cwd: string, agentDir: string): Promise<ResourceCatalog> {
  const { DefaultPackageManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir),
    builtinExtensions: [...BUILTIN_EXTENSIONS] });
  const resolved = await manager.resolve(async () => "skip");
  const map = (item: { path: string; enabled: boolean; metadata: { source: string; packageRoot?: string } }): CatalogResource =>
    ({ path: item.path, enabled: item.enabled, source: item.metadata.source, ...(item.metadata.packageRoot ? { packageRoot: item.metadata.packageRoot } : {}) });
  return { extensions: resolved.extensions.map(map), skills: resolved.skills.map(map) };
}

/** `npm:@a/b@1` → `npm:@a/b`; git/URL forms → `git:host/path` without ref or `.git`; others unchanged. */
export function normalizeSource(spec: string): string {
  const value = spec.trim();
  if (value.startsWith("npm:")) {
    const name = value.slice(4);
    const at = name.indexOf("@", 1);
    return "npm:" + (at > 0 ? name.slice(0, at) : name);
  }
  let git: string;
  if (value.startsWith("git:")) git = value.slice(4);
  else if (/^https?:\/\//.test(value)) git = value.replace(/^https?:\/\//, "");
  else if (/^git@[^:]+:/.test(value)) git = value.slice(4).replace(":", "/");
  else return value;
  return "git:" + git.replace(/@[^/]*$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
}

const stem = (path: string) => basename(path, extname(path));
/** Short name: npm package, git repo, builtin name, or a top-level file/directory name. */
export function extensionName(resource: CatalogResource): string {
  if (resource.path.startsWith("builtin:")) return resource.path.slice(8);
  const source = normalizeSource(resource.source);
  if (source.startsWith("npm:")) return source.slice(4);
  if (source.startsWith("git:")) return source.slice(source.lastIndexOf("/") + 1);
  const file = stem(resource.path);
  return file === "index" ? basename(dirname(resource.path)) : file;
}
/** Agent Skills names match their directory; standalone Markdown skills use the file name. */
export function skillName(resource: CatalogResource): string {
  return basename(resource.path) === "SKILL.md" ? basename(dirname(resource.path)) : stem(resource.path);
}

const isPathSpec = (spec: string) => isAbsolute(spec);
const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

function extensionMatches(resource: CatalogResource, spec: string): boolean {
  if (spec === resource.path) return true;
  if (isPathSpec(spec)) {
    const target = resolve(spec);
    return within(resource.path, target) || (!!resource.packageRoot && resolve(resource.packageRoot) === target);
  }
  if (spec.includes(":")) return normalizeSource(spec) === normalizeSource(resource.source);
  return extensionName(resource) === spec;
}
function skillMatches(resource: CatalogResource, spec: string): boolean {
  if (spec === resource.path) return true;
  if (isPathSpec(spec)) return within(resource.path, resolve(spec));
  return skillName(resource) === spec;
}

const packageNames = new Map<string, string | undefined>();
const packageName = (root: string): string | undefined => {
  if (!packageNames.has(root)) {
    let name: string | undefined;
    try { name = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { name?: unknown }).name as string | undefined; }
    catch { name = undefined; } // a package root without a readable manifest simply is not pi-jar
    packageNames.set(root, typeof name === "string" ? name : undefined);
  }
  return packageNames.get(root);
};
/** Children always load the running pi-jar explicitly; never a second (possibly older) pi-jar copy. */
const isPiJar = (resource: CatalogResource, ownExtension: string) => resource.path === ownExtension
  || (!!resource.packageRoot && packageName(resource.packageRoot) === "pi-jar");

const unique = (paths: Iterable<string>) => [...new Set(paths)];

export interface ExtensionPlan {
  /** Loaded by lean (`--no-extensions`) children besides pi-jar. */
  lean: string[];
  /** Added with `--extension` to children that keep normal discovery. */
  add: string[];
  /** Set when something is disallowed: the complete list for `--no-extensions` children (pi-jar excluded). */
  explicit?: string[];
}

/** Applies `+`/`-` extension rules to the parent's resolved extensions. Unknown allowed specs pass through to Pi. */
export function planExtensions(rules: RuleList, catalog: ResourceCatalog, ownExtension: string): ExtensionPlan {
  const denied = (resource: CatalogResource) => rules.deny.some(spec => extensionMatches(resource, spec));
  const allowed: string[] = [];
  const added: string[] = [];
  for (const spec of rules.allow) {
    const matched = catalog.extensions.filter(resource => extensionMatches(resource, spec) && !isPiJar(resource, ownExtension) && !denied(resource));
    if (!matched.length) {
      if (!rules.deny.some(deny => deny === spec)) { allowed.push(spec); added.push(spec); }
      continue;
    }
    const enabled = matched.filter(resource => resource.enabled);
    allowed.push(...(enabled.length ? enabled : matched).map(resource => resource.path));
    if (!enabled.length) added.push(...matched.map(resource => resource.path));
  }
  const plan: ExtensionPlan = { lean: unique(allowed), add: unique(added) };
  if (rules.deny.length) {
    plan.explicit = unique([...catalog.extensions.filter(resource => resource.enabled && !denied(resource) && !isPiJar(resource, ownExtension))
      .map(resource => resource.path), ...allowed]);
  }
  return plan;
}

/**
 * Child skill paths for `--no-skills --skill ...`, or undefined to keep Pi's normal discovery.
 * Defaults are the parent's enabled skills plus config allows minus config denies. A task list with any
 * allowed entry (or an empty list) is exact; a list of only `-` entries subtracts from the defaults.
 * Config denies always win: a task that explicitly asks for one is rejected.
 */
export function planSkills(config: RuleList, task: RuleList | undefined, catalog: ResourceCatalog, configLabel: string): string[] | undefined {
  if (!config.allow.length && !config.deny.length && !task) return undefined;
  const find = (spec: string, label: string): string[] => {
    const resources = catalog.skills.filter(resource => skillMatches(resource, spec));
    // A name picks one skill (enabled copy first), like Pi's own first-wins collision rule; a directory path keeps all.
    const matched = (isPathSpec(spec) ? resources : resources.filter(resource => resource.enabled).concat(resources).slice(0, 1))
      .map(resource => resource.path);
    if (matched.length) return matched;
    if (isPathSpec(spec)) return [spec];
    throw new Error(`${label}: unknown skill "${spec}"`);
  };
  const configDenied = (path: string) => config.deny.some(spec => {
    const resource = catalog.skills.find(item => item.path === path) ?? { path, enabled: true, source: "explicit" };
    return skillMatches(resource, spec);
  });
  const defaults = unique([...catalog.skills.filter(resource => resource.enabled).map(resource => resource.path),
    ...config.allow.flatMap(spec => find(spec, configLabel))]).filter(path => !configDenied(path));
  if (!task) return defaults;
  const subtract = new Set(task.deny.flatMap(spec => find(spec, "skills")));
  if (task.allow.length || !task.deny.length) {
    const requested = unique(task.allow.flatMap(spec => find(spec, "skills")));
    const blocked = requested.filter(configDenied);
    if (blocked.length) throw new Error(`skills disallowed by ${configLabel}: ${blocked.map(path => skillName({ path, enabled: true, source: "" })).join(", ")}`);
    return requested.filter(path => !subtract.has(path));
  }
  return defaults.filter(path => !subtract.has(path));
}
