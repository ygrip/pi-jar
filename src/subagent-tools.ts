import { workspacePathAllowed } from "./delegate-worktree.ts";

export const CHILD_TOOLS_ENV = "PI_JAR_CHILD_TOOLS";
export const WEB_TOOLS = ["web_enable", "web_search", "fetch_content", "get_search_content", "source_check"] as const;
export const RECURSIVE_TOOLS = new Set(["jar_delegate", "jar_subagent", "jar_democracy"]);

/** Multi-file tools must validate each effective target, not just the top-level default path. */
export function worktreeToolViolation(root: string, cwd: string, name: string, args: unknown): string | undefined {
  if (["bash", "powershell", "jar_shell"].includes(name)) return "Sandboxed worktree subagents cannot run shell tools.";
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
