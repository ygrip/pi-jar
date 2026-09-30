import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { ChangeTracker } from "./changes.ts";

/** Present only in writable delegated children. The child extension treats this as its filesystem boundary. */
export const CHILD_WORKTREE_ENV = "PI_JAR_WORKTREE_ROOT";
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

export interface DelegateWorktree {
  /** Git repository root in the parent workspace. */
  repoRoot: string;
  /** Disposable worktree root. */
  root: string;
  /** Child cwd matching the parent's relative cwd inside the repository. */
  cwd: string;
  /** Snapshot commit that exactly represents the parent workspace when delegation started. */
  baseline: string;
  /** Temporary directory containing the worktree. */
  tempRoot: string;
}

const gitText = (cwd: string, args: string[], input?: string): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ["pipe", "pipe", "pipe"]
  });

const gitBuffer = (cwd: string, args: string[]): Buffer =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: null,
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ["ignore", "pipe", "pipe"]
  });

const nulList = (value: string): string[] => value.split("\0").filter(Boolean);

const inside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
};

/**
 * Resolve a tool path without trusting lexical ".." checks alone. Existing symlinks and the
 * nearest existing parent of a new file must both remain physically inside the worktree.
 */
export function workspacePathAllowed(root: string, cwd: string, value: string): boolean {
  let physicalRoot: string;
  try { physicalRoot = realpathSync(root); } catch { return false; }
  const lexical = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  if (!inside(physicalRoot, lexical)) return false;
  let probe = lexical;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  try { return inside(physicalRoot, realpathSync(probe)); }
  catch { return false; }
}

const copyInto = (fromRoot: string, toRoot: string, rel: string): void => {
  const from = resolve(fromRoot, rel);
  const to = resolve(toRoot, rel);
  if (!inside(fromRoot, from) || !inside(toRoot, to)) throw new Error("unsafe worktree path: " + rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, force: true, dereference: false });
};

/**
 * Create a detached disposable worktree and commit a private baseline snapshot containing the
 * parent's tracked modifications plus non-ignored untracked files. The parent index/branch is not
 * touched. That baseline lets multiple children run against the exact same starting filesystem.
 */
export function createDelegateWorktree(cwd: string): DelegateWorktree {
  const requested = realpathSync(cwd);
  const repoRoot = realpathSync(gitText(requested, ["rev-parse", "--show-toplevel"]).trim());
  if (!inside(repoRoot, requested)) throw new Error("working directory is outside the git repository");
  const relCwd = relative(repoRoot, requested);
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-jar-worktree-"));
  const root = join(tempRoot, "workspace");
  let added = false;
  try {
    gitText(repoRoot, ["worktree", "add", "--detach", root, "HEAD"]);
    added = true;

    const patch = gitText(repoRoot, ["diff", "--binary", "HEAD", "--", "."]);
    if (patch.trim()) gitText(root, ["apply", "--binary", "--whitespace=nowarn", "-"], patch);
    for (const rel of nulList(gitText(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]))) {
      copyInto(repoRoot, root, rel);
    }

    gitText(root, ["add", "-A"]);
    gitText(root, [
      "-c", "user.name=pi-jar",
      "-c", "user.email=pi-jar@local",
      "commit", "--allow-empty", "--no-verify", "--no-gpg-sign", "-m", "pi-jar delegate baseline"
    ]);
    const baseline = gitText(root, ["rev-parse", "HEAD"]).trim();
    const childCwd = relCwd ? resolve(root, relCwd) : root;
    if (!existsSync(childCwd)) mkdirSync(childCwd, { recursive: true });
    return { repoRoot, root, cwd: childCwd, baseline, tempRoot };
  } catch (error) {
    if (added) {
      try { gitText(repoRoot, ["worktree", "remove", "--force", root]); } catch { /* best effort */ }
    }
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Files whose final worktree state differs from the snapshot, including new untracked files. */
export function worktreeChangedFiles(worktree: DelegateWorktree): string[] {
  const changed = nulList(gitText(worktree.root, ["diff", "--name-only", "-z", "--no-renames", worktree.baseline, "--", "."]));
  const untracked = nulList(gitText(worktree.root, ["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...changed, ...untracked])].sort();
}

type BaselineEntry = { mode: string; content: Buffer } | null;

const baselineEntry = (worktree: DelegateWorktree, rel: string): BaselineEntry => {
  let line = "";
  try { line = gitText(worktree.root, ["ls-tree", worktree.baseline, "--", rel]).trim(); }
  catch { return null; }
  if (!line) return null;
  const mode = line.split(/\s+/, 1)[0] ?? "";
  try { return { mode, content: gitBuffer(worktree.root, ["show", `${worktree.baseline}:${rel}`]) }; }
  catch { return null; }
};

const parentMatchesBaseline = (worktree: DelegateWorktree, parentRoot: string, rel: string): boolean => {
  const target = resolve(parentRoot, rel);
  if (!inside(parentRoot, target)) return false;
  const baseline = baselineEntry(worktree, rel);
  if (!baseline) return !existsSync(target);
  if (!existsSync(target)) return false;
  const stat = lstatSync(target);
  if (baseline.mode === "120000") {
    return stat.isSymbolicLink() && Buffer.from(readlinkSync(target)).equals(baseline.content);
  }
  if (!stat.isFile()) return false;
  if (baseline.mode === "100644" || baseline.mode === "100755") {
    const expectedExecutable = baseline.mode === "100755";
    const actualExecutable = (stat.mode & 0o111) !== 0;
    if (expectedExecutable !== actualExecutable) return false;
  }
  return readFileSync(target).equals(baseline.content);
};

/**
 * Copy a completed child's changed files back to the parent only when every target still equals the
 * baseline snapshot. The parent is therefore never overwritten after another actor changed a file.
 */
export function applyDelegateWorktree(worktree: DelegateWorktree, parentCwd: string, files: readonly string[],
  tracker?: ChangeTracker): string[] {
  const parentRoot = realpathSync(gitText(parentCwd, ["rev-parse", "--show-toplevel"]).trim());
  if (parentRoot !== worktree.repoRoot) throw new Error("parent repository changed while subagent was running");
  for (const rel of files) {
    if (!parentMatchesBaseline(worktree, parentRoot, rel)) {
      throw new Error(`parent changed since delegation started: ${rel}`);
    }
    const source = resolve(worktree.root, rel);
    if (!inside(worktree.root, source)) throw new Error("unsafe changed path: " + rel);
    if (existsSync(source)) {
      const stat = lstatSync(source);
      if (stat.isSymbolicLink()) throw new Error("refusing to apply symlink change: " + rel);
      if (!stat.isFile()) throw new Error("refusing to apply non-file change: " + rel);
    }
  }

  if (tracker) {
    for (const rel of files) {
      const target = resolve(parentRoot, rel);
      if (!tracker.capture(target)) throw new Error("cannot add changed file to /diff review: " + rel);
    }
  }

  const applied: string[] = [];
  for (const rel of files) {
    const source = resolve(worktree.root, rel);
    const target = resolve(parentRoot, rel);
    if (!inside(parentRoot, target)) throw new Error("unsafe changed path: " + rel);

    if (!existsSync(source)) {
      if (existsSync(target)) unlinkSync(target);
    } else {
      const stat = lstatSync(source);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { force: true, dereference: true });
      chmodSync(target, stat.mode & 0o777);
    }
    tracker?.markDirty(target);
    applied.push(rel);
  }
  return applied;
}

/** Remove a disposable worktree and its dangling snapshot commit reference. */
export function disposeDelegateWorktree(worktree: DelegateWorktree): void {
  try { gitText(worktree.repoRoot, ["worktree", "remove", "--force", worktree.root]); }
  catch {
    rmSync(worktree.tempRoot, { recursive: true, force: true });
    try { gitText(worktree.repoRoot, ["worktree", "prune"]); } catch { /* best effort */ }
    return;
  }
  rmSync(worktree.tempRoot, { recursive: true, force: true });
}
