import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { workspacePathAllowed } from "./delegate-worktree.ts";

export const CHILD_TOOLS_ENV = "PI_JAR_CHILD_TOOLS";
export const WEB_TOOLS = ["web_enable", "web_search", "fetch_content", "get_search_content", "source_check"] as const;
export const RECURSIVE_TOOLS = new Set(["jar_delegate", "jar_subagent", "jar_council"]);
export const SHELL_TOOLS = new Set(["bash", "powershell", "jar_shell"]);

/** User-owned, profile-independent subagent capabilities in the agent directory. */
export const SUBAGENT_CONFIG_FILE = "pi-jar-subagents.json";
/** `+name` (or bare `name`) allows, `-name` disallows. */
export interface RuleList { allow: readonly string[]; deny: readonly string[] }
export interface SubagentConfig {
  /** allow: trusted for `inheritTools` in every mode (e.g. mom_search); deny: never granted to any subagent. */
  tools: RuleList;
  /** allow: always loaded by children (npm:/git:/URL sources, paths, or names); deny: never loaded by children. */
  extensions: RuleList;
  /** allow: added to children's default skills (even if disabled in the parent); deny: never loaded by children. */
  skills: RuleList;
}
export const EMPTY_RULES: RuleList = { allow: [], deny: [] };
export const EMPTY_SUBAGENT_CONFIG: SubagentConfig = { tools: EMPTY_RULES, extensions: EMPTY_RULES, skills: EMPTY_RULES };

/** Splits `+x`/`x`/`-x` entries; throws `${label}: ...` on empty or non-string entries. */
export function parseRules(value: unknown, label: string, map: (entry: string) => string = entry => entry): RuleList {
  if (value === undefined) return EMPTY_RULES;
  if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== "string"))
    throw new Error(`${label} must be an array of at most 64 strings`);
  const allow = new Set<string>();
  const deny = new Set<string>();
  for (const raw of value as string[]) {
    const text = raw.trim();
    const negative = text.startsWith("-");
    const entry = (negative || text.startsWith("+") ? text.slice(1) : text).trim();
    if (!entry) throw new Error(`${label}: empty entry "${raw}"`);
    (negative ? deny : allow).add(map(entry));
  }
  for (const entry of deny) allow.delete(entry); // disallow wins
  return { allow: [...allow], deny: [...deny] };
}

/** `~/x`, absolute, `./x` and `dir/x` are paths (resolved from `directory`); `npm:`/`git:`/URLs and bare names stay as specs. */
export function expandSpec(spec: string, directory: string, home = homedir()): string {
  if (spec === "~" || spec.startsWith("~/")) return join(home, spec.slice(1));
  if (isAbsolute(spec)) return spec;
  if (spec.includes(":") || !spec.includes("/") && !spec.startsWith(".")) return spec;
  return resolve(directory, spec);
}

/** Missing file means no extras; a malformed file is an error, never silently ignored. */
export function loadSubagentConfig(directory: string, home = homedir()): SubagentConfig {
  let text: string;
  try { text = readFileSync(join(directory, SUBAGENT_CONFIG_FILE), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_SUBAGENT_CONFIG;
    throw error;
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (error) { throw new Error(`${SUBAGENT_CONFIG_FILE}: invalid JSON: ${(error as Error).message}`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${SUBAGENT_CONFIG_FILE}: expected a JSON object`);
  const value = raw as Record<string, unknown>;
  const label = (key: string) => `${SUBAGENT_CONFIG_FILE}: "${key}"`;
  const tools = parseRules(value.tools, label("tools"));
  const recursive = tools.allow.filter(name => RECURSIVE_TOOLS.has(name));
  if (recursive.length) throw new Error(`${SUBAGENT_CONFIG_FILE}: recursive delegation tools are never available to subagents: ${recursive.join(", ")}`);
  const extensions = parseRules(value.extensions, label("extensions"), spec => expandSpec(spec, directory, home));
  const skills = parseRules(value.skills, label("skills"), spec => expandSpec(spec, directory, home));
  return { tools, extensions, skills };
}

/** Multi-file tools must validate each effective target, not just the top-level default path. */
export function worktreeToolViolation(root: string, cwd: string, name: string, args: unknown): string | undefined {
  if (SHELL_TOOLS.has(name)) return "Sandboxed worktree subagents cannot run shell tools.";
  const pathTools = new Set(["read", "edit", "write", "grep", "find", "ls", "multi_file_edit"]);
  if (!pathTools.has(name)) return;
  if (!workspacePathAllowed(root, cwd, ".")) return "Sandboxed worktree subagent working directory is outside its workspace.";
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const validate = (value: unknown): string | undefined => {
    if (typeof value !== "string" || !value || !workspacePathAllowed(root, cwd, value, name === "read")) {
      return "Sandboxed worktree subagent cannot access outside its workspace or use an invalid path: " + String(value);
    }
  };
  for (const key of ["path", "file_path", "cwd"]) if (input[key] !== undefined) {
    const violation = validate(input[key]);
    if (violation) return violation;
  }
  if (name === "multi_file_edit") {
    if (!Array.isArray(input.edits) || !input.edits.length) return "multi_file_edit needs a non-empty edits array.";
    for (const raw of input.edits) {
      if (!raw || typeof raw !== "object") return "Invalid multi_file_edit entry.";
      const entry = raw as Record<string, unknown>;
      for (const key of ["path", "file_path", "cwd"]) if (entry[key] !== undefined) {
        const violation = validate(entry[key]);
        if (violation) return violation;
      }
      const violation = validate(entry.path ?? entry.file_path ?? input.path ?? input.file_path);
      if (violation) return violation;
    }
  }
}

export function childToolAllowlist(value: string | undefined): Set<string> | undefined {
  if (value === undefined) return;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 64 || parsed.some(name => typeof name !== "string" || !name || RECURSIVE_TOOLS.has(name))) return new Set();
    return new Set(parsed as string[]);
  } catch { return new Set(); } // invalid capability data fails closed
}
