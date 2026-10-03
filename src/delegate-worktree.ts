import { runProcess } from "./async-process.ts";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  renameSync,
  rmdirSync,
  writeFileSync,
  unlinkSync,
  type Stats
} from "node:fs";
import { chmod, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { MAX_TRACKED_BYTES, type ChangeTracker } from "./changes.ts";

/** Present only in writable delegated children. The child extension treats this as its filesystem boundary. */
export const CHILD_WORKTREE_ENV = "PI_JAR_WORKTREE_ROOT";
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
/** Set PI_JAR_GIT_PATH to bypass wrappers such as git-ai for pi-jar's internal plumbing. */
export const GIT_EXECUTABLE_ENV = "PI_JAR_GIT_PATH";
const gitExecutable = () => process.env[GIT_EXECUTABLE_ENV]?.trim() || "git";

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

const safeGitArgs = (cwd: string, args: string[]) => ["-C", cwd, "--literal-pathspecs", "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false", ...args];

const gitText = async (cwd: string, args: string[], input?: string | Buffer, signal?: AbortSignal): Promise<string> =>
  (await runProcess(gitExecutable(), safeGitArgs(cwd, args), {
    cwd, input, signal, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: MAX_GIT_OUTPUT
  })).toString("utf8");

const gitBuffer = (cwd: string, args: string[], signal?: AbortSignal): Promise<Buffer> =>
  runProcess(gitExecutable(), safeGitArgs(cwd, args), {
    cwd, signal, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: MAX_GIT_OUTPUT
  });

const nulList = (value: string): string[] => value.split("\0").filter(Boolean);

const inside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
};

/** Normalize Pi tool path spellings before applying the filesystem boundary. */
export function normalizeWorkspacePath(cwd: string, value: string): string | null {
  try {
    let path = value.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
    if (path.startsWith("@")) path = path.slice(1);
    if (process.platform === "win32" && !path.includes("\\") && !path.startsWith("//")) {
      const drive = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
      if (drive) path = `${drive[1]!.toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
    }
    // Match Pi exactly: single-slash file: spellings are literal relative filenames.
    if (path.startsWith("file://")) path = fileURLToPath(path);
    if (path === "~") path = homedir();
    else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) path = join(homedir(), path.slice(2));
    else if (path.startsWith("~")) return null;
    if (!path || path.includes("\0")) return null;
    return resolve(cwd, path);
  } catch { return null; }
}

const statIfPresent = (path: string): Stats | null => {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const hasGitMetadata = (root: string, path: string) =>
  relative(root, path).split(sep).some(part => part.toLowerCase() === ".git");

// Finalization disallows ancestor symlinks entirely, even aliases back into the tree.
const safeFilePath = (root: string, rel: string): boolean => {
  const target = resolve(root, rel);
  if (!rel || isAbsolute(rel) || !inside(root, target) || target === root || hasGitMetadata(root, target)) return false;
  try {
    if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== resolve(root)) return false;
    let probe = dirname(target);
    while (probe !== root) {
      const stat = statIfPresent(probe);
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) return false;
      probe = dirname(probe);
    }
    return true;
  } catch { return false; }
};

/** Resolve existing and dangling symlinks, and deny Git administrative paths. */
export function workspacePathAllowed(root: string, cwd: string, value: string, readFallbacks = false): boolean {
  if (readFallbacks) {
    const path = normalizeWorkspacePath(cwd, value);
    if (!path) return false;
    // Pi read tries these alternate spellings after a missing exact path. Check every possible
    // target, including dangling links, rather than guarding a spelling the reader won't use.
    const nfd = path.normalize("NFD");
    const variants = new Set([path, path.replace(/ (AM|PM)\./gi, "\u202f$1."), nfd,
      path.replace(/'/g, "\u2019"), nfd.replace(/'/g, "\u2019")]);
    return [...variants].every((variant) => canonicalWorkspacePathAllowed(root, variant));
  }
  const path = normalizeWorkspacePath(cwd, value);
  return path !== null && canonicalWorkspacePathAllowed(root, path);
}

function canonicalWorkspacePathAllowed(root: string, lexical: string): boolean {
  let physicalRoot: string;
  try { physicalRoot = realpathSync(root); } catch { return false; }
  // macOS /var -> /private/var and other trusted root aliases are equivalent.
  if (inside(resolve(root), lexical)) lexical = resolve(physicalRoot, relative(resolve(root), lexical));
  if (!inside(physicalRoot, lexical) || hasGitMetadata(physicalRoot, lexical)) return false;
  try {
    let probe = lexical;
    while (!statIfPresent(probe)) {
      const parent = dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
    const physical = realpathSync(probe);
    return inside(physicalRoot, physical) && !hasGitMetadata(physicalRoot, physical);
  } catch { return false; }
}

const writeSnapshot = async (root: string, rel: string, bytes: Buffer, stat: Stats): Promise<void> => {
  const to = resolve(root, rel);
  if (!safeFilePath(root, rel)) throw new Error("unsafe worktree path: " + rel);
  await mkdir(dirname(to), { recursive: true });
  // Use the bytes we hashed, not a second copy of a source the user may edit during the await.
  if (stat.isSymbolicLink()) await symlink(bytes.toString(), to);
  else {
    await writeFile(to, bytes, { mode: stat.mode & 0o777 });
    await chmod(to, stat.mode & 0o777);
  }
};

// Each git call has its own GIT_TIMEOUT_MS deadline, so bound the work per batched call.
const HASH_BATCH_FILES = 1000;
const HASH_BATCH_BYTES = 128 * 1024 * 1024;

/** Object ids for regular files, in order, from bounded `hash-object --stdin-paths` chunks. */
const hashPaths = async (root: string, files: readonly { path: string; size: number }[], write: boolean,
  signal?: AbortSignal): Promise<string[]> => {
  const oids: string[] = [];
  for (let start = 0; start < files.length;) {
    let end = start;
    let bytes = 0;
    // A file larger than the byte budget still gets its own chunk, matching per-file hashing.
    while (end < files.length && end - start < HASH_BATCH_FILES && (end === start || bytes + files[end]!.size <= HASH_BATCH_BYTES)) {
      bytes += files[end++]!.size;
    }
    const chunk = files.slice(start, end);
    const output = (await gitText(root, ["hash-object", ...(write ? ["-w"] : []), "--no-filters", "--stdin-paths"],
      chunk.map(file => file.path).join("\n") + "\n", signal)).split("\n").filter(Boolean);
    if (output.length !== chunk.length) throw new Error("git hash-object returned incomplete hashes");
    oids.push(...output);
    start = end;
  }
  return oids;
};

/**
 * Create a detached disposable worktree and commit a private baseline snapshot containing the
 * parent's tracked modifications plus non-ignored untracked files. The parent index/branch is not
 * touched. That baseline lets multiple children run against the exact same starting filesystem.
 */
export async function createDelegateWorktree(cwd: string, signal?: AbortSignal): Promise<DelegateWorktree> {
  const requested = realpathSync(cwd);
  const repoRoot = realpathSync((await gitText(requested, ["rev-parse", "--show-toplevel"], undefined, signal)).trim());
  if (!inside(repoRoot, requested)) throw new Error("working directory is outside the git repository");
  const relCwd = relative(repoRoot, requested);
  const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-jar-worktree-")));
  const root = join(tempRoot, "workspace");
  let added = false;
  try {
    // Never checkout/add: they execute clean/smudge filters and alter byte baselines.
    await gitText(repoRoot, ["worktree", "add", "--no-checkout", "--detach", root, "HEAD"], undefined, signal);
    added = true;
    await gitText(root, ["read-tree", "--empty"], undefined, signal);
    const paths = new Set(nulList(await gitText(repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], undefined, signal)));
    // Git process startup (often behind wrappers such as git-ai) dominates setup time, so hash
    // and stage in bounded batches rather than two git processes per repository file.
    const entries: { rel: string; mode: string; oid: string }[] = [];
    const batched: { entry: (typeof entries)[number]; path: string; size: number }[] = [];
    // Small bounded batches overlap independent file I/O without loading an entire repository
    // into memory. All writes settle before failure cleanup removes the disposable worktree.
    const pending: { rel: string; stat: Stats }[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      const chunk = pending.splice(0);
      pendingBytes = 0;
      const results = await Promise.allSettled(chunk.map(async ({ rel, stat }) => {
        signal?.throwIfAborted();
        const source = resolve(repoRoot, rel);
        const bytes = stat.isSymbolicLink() ? Buffer.from(await readlink(source)) : await readFile(source);
        signal?.throwIfAborted();
        await writeSnapshot(root, rel, bytes, stat);
        const entry = { rel, mode: stat.isSymbolicLink() ? "120000" : (stat.mode & 0o111) ? "100755" : "100644", oid: "" };
        // stdin-paths follows symlinks and is line-based: hash those exceptional paths by bytes.
        const path = resolve(root, rel);
        if (stat.isSymbolicLink() || path.includes("\n")) entry.oid = (await gitText(root, ["hash-object", "-w", "--no-filters", "--stdin"], bytes, signal)).trim();
        return { entry, path, size: bytes.length };
      }));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        entries.push(result.value.entry);
        if (!result.value.entry.oid) batched.push(result.value);
      }
    };
    for (const rel of paths) {
      signal?.throwIfAborted();
      if (!safeFilePath(repoRoot, rel)) throw new Error("unsafe snapshot path: " + rel);
      const stat = statIfPresent(resolve(repoRoot, rel));
      if (!stat) continue;
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("unsupported snapshot file: " + rel);
      if (pending.length && (pending.length >= 4 || pendingBytes + stat.size > 32 * 1024 * 1024)) await flush();
      pending.push({ rel, stat });
      pendingBytes += stat.size;
    }
    if (pending.length) await flush();
    const oids = await hashPaths(root, batched, true, signal);
    batched.forEach((item, index) => { item.entry.oid = oids[index]!; });
    if (entries.length) {
      await gitText(root, ["update-index", "-z", "--index-info"],
        entries.map(entry => `${entry.mode} ${entry.oid}\t${entry.rel}\0`).join(""), signal);
    }
    const tree = (await gitText(root, ["write-tree"], undefined, signal)).trim();
    const baseline = (await gitText(root, ["-c", "user.name=pi-jar", "-c", "user.email=pi-jar@local",
      "commit-tree", "--no-gpg-sign", tree, "-p", "HEAD", "-m", "pi-jar delegate baseline"], undefined, signal)).trim();
    await gitText(root, ["update-ref", "HEAD", baseline], undefined, signal);
    const childCwd = relCwd ? resolve(root, relCwd) : root;
    if (!workspacePathAllowed(root, root, childCwd)) throw new Error("unsafe child working directory");
    if (!existsSync(childCwd)) mkdirSync(childCwd, { recursive: true });
    return { repoRoot, root, cwd: childCwd, baseline, tempRoot };
  } catch (error) {
    if (added) {
      try { await gitText(repoRoot, ["worktree", "remove", "--force", root]); } catch { /* best effort */ }
    }
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Files whose final worktree state differs from the snapshot, including new untracked files. */
export async function worktreeChangedFiles(worktree: DelegateWorktree, signal?: AbortSignal): Promise<string[]> {
  const baseline = new Map<string, { mode: string; oid: string }>();
  for (const record of nulList(await gitText(worktree.root, ["ls-tree", "-r", "-z", worktree.baseline], undefined, signal))) {
    const tab = record.indexOf("\t");
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    if (type !== "blob" || !mode || !oid) throw new Error("unsupported baseline entry: " + record.slice(tab + 1));
    baseline.set(record.slice(tab + 1), { mode, oid });
  }
  const currentPaths = nulList(await gitText(worktree.root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], undefined, signal));
  const changed: string[] = [];
  // Compare object ids from bounded hash-object batches instead of two git processes per file.
  const batched: { rel: string; oid: string; path: string; size: number }[] = [];
  const hashBytes = async (bytes: Buffer) => (await gitText(worktree.root, ["hash-object", "--no-filters", "--stdin"], bytes, signal)).trim();
  for (const rel of new Set([...baseline.keys(), ...currentPaths])) {
    const entry = baseline.get(rel);
    const target = resolve(worktree.root, rel);
    if (!safeFilePath(worktree.root, rel)) { changed.push(rel); continue; }
    const stat = statIfPresent(target);
    if (!entry || !stat) {
      if (entry || stat) changed.push(rel);
      continue;
    }
    if (entry.mode === "120000") {
      if (!stat.isSymbolicLink() || await hashBytes(Buffer.from(await readlink(target))) !== entry.oid) changed.push(rel);
      continue;
    }
    if (!stat.isFile() || (entry.mode === "100755") !== ((stat.mode & 0o111) !== 0)) changed.push(rel);
    else if (target.includes("\n")) { if (await hashBytes(await readFile(target)) !== entry.oid) changed.push(rel); }
    else batched.push({ rel, oid: entry.oid, path: target, size: stat.size });
  }
  const oids = await hashPaths(worktree.root, batched, false, signal);
  batched.forEach((item, index) => { if (oids[index] !== item.oid) changed.push(item.rel); });
  return changed.sort();
}

type BaselineEntry = { mode: string; content: Buffer } | null;

const baselineEntry = async (worktree: DelegateWorktree, rel: string, signal?: AbortSignal): Promise<BaselineEntry> => {
  const line = await gitText(worktree.root, ["ls-tree", "-z", worktree.baseline, "--", rel], undefined, signal);
  if (!line || line.slice(line.indexOf("\t") + 1, -1) !== rel) return null;
  const [mode, type, oid] = line.slice(0, line.indexOf("\t")).split(" ");
  if (type !== "blob" || !mode || !oid) throw new Error("unsupported baseline entry: " + rel);
  return { mode, content: await gitBuffer(worktree.root, ["cat-file", "blob", oid], signal) };
};

const matchesBaseline = (baseline: BaselineEntry, parentRoot: string, rel: string): boolean => {
  const target = resolve(parentRoot, rel);
  if (!safeFilePath(parentRoot, rel)) return false;
  const stat = statIfPresent(target);
  if (!baseline) return !stat;
  if (!stat) return false;
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

const reviewableBytes = (bytes: Buffer): boolean => bytes.length <= MAX_TRACKED_BYTES
  && !bytes.includes(0) && Buffer.from(bytes.toString("utf8")).equals(bytes);

/**
 * Copy a completed child's changed files back to the parent only when every target still equals the
 * baseline snapshot. The parent is therefore never overwritten after another actor changed a file.
 */
export async function applyDelegateWorktree(worktree: DelegateWorktree, parentCwd: string, files: readonly string[],
  tracker?: ChangeTracker, signal?: AbortSignal): Promise<string[]> {
  const parentRoot = realpathSync((await gitText(parentCwd, ["rev-parse", "--show-toplevel"], undefined, signal)).trim());
  if (parentRoot !== worktree.repoRoot) throw new Error("parent repository changed while subagent was running");
  // Review identities follow the caller's cwd spelling (e.g. /var rather than /private/var).
  const reviewRoot = resolve(parentCwd, relative(realpathSync(parentCwd), parentRoot));
  const baselines = new Map<string, BaselineEntry>();
  for (const rel of files) {
    if (!safeFilePath(parentRoot, rel) || statIfPresent(resolve(parentRoot, rel))?.isSymbolicLink()) {
      throw new Error("unsafe parent changed path: " + rel);
    }
    const baseline = await baselineEntry(worktree, rel, signal);
    baselines.set(rel, baseline);
    if (!matchesBaseline(baseline, parentRoot, rel)) {
      throw new Error(`parent changed since delegation started: ${rel}`);
    }
    const parentStat = statIfPresent(resolve(parentRoot, rel));
    if (parentStat?.isFile() && !reviewableBytes(readFileSync(resolve(parentRoot, rel)))) {
      throw new Error("cannot add changed file to /diff review: " + rel);
    }
    const source = resolve(worktree.root, rel);
    if (!safeFilePath(worktree.root, rel)) throw new Error("unsafe changed path: " + rel);
    if (statIfPresent(source)) {
      const stat = lstatSync(source);
      if (stat.isSymbolicLink()) throw new Error("refusing to apply symlink change: " + rel);
      if (!stat.isFile()) throw new Error("refusing to apply non-file change: " + rel);
      const bytes = readFileSync(source);
      if (!reviewableBytes(bytes)) {
        throw new Error("cannot add changed file to /diff review: " + rel);
      }
    }
  }

  if (tracker) {
    for (const rel of files) {
      const target = resolve(reviewRoot, rel);
      if (!tracker.capture(target)) throw new Error("cannot add changed file to /diff review: " + rel);
    }
  }

  const staged: Array<{ rel: string; target: string; directory: string; replacement?: string; backup?: string }> = [];
  const createdDirectories: string[] = [];
  const applied: typeof staged = [];
  try {
    // Prepare every replacement and rollback backup before modifying any parent file.
    // Permission/disk failures in later files therefore cannot leave earlier files half-applied.
    for (const rel of files) {
      const source = resolve(worktree.root, rel);
      const target = resolve(parentRoot, rel);
      if (!safeFilePath(parentRoot, rel) || !safeFilePath(worktree.root, rel)
        || statIfPresent(target)?.isSymbolicLink() || statIfPresent(source)?.isSymbolicLink()) {
        throw new Error("unsafe changed path: " + rel);
      }
      const missing: string[] = [];
      for (let path = dirname(target); !statIfPresent(path); path = dirname(path)) missing.push(path);
      mkdirSync(dirname(target), { recursive: true });
      createdDirectories.push(...missing.reverse());
      const directory = mkdtempSync(join(dirname(target), ".pi-jar-apply-"));
      const entry: (typeof staged)[number] = { rel, target, directory };
      staged.push(entry);
      const before = statIfPresent(target);
      if (before) {
        entry.backup = join(directory, "before");
        writeFileSync(entry.backup, readFileSync(target), { mode: before.mode & 0o777 });
        chmodSync(entry.backup, before.mode & 0o777);
      }
      const after = statIfPresent(source);
      if (after) {
        entry.replacement = join(directory, "after");
        writeFileSync(entry.replacement, readFileSync(source), { mode: after.mode & 0o777 });
        chmodSync(entry.replacement, after.mode & 0o777);
      }
    }
    // No await after entering the atomic apply/rollback section: asynchronous Git calls between
    // replacements would let parent edits or a session switch interleave with partial application.
    signal?.throwIfAborted();
    for (const entry of staged) {
      if (!safeFilePath(parentRoot, entry.rel) || !matchesBaseline(baselines.get(entry.rel)!, parentRoot, entry.rel)) {
        throw new Error("parent changed while preparing finalization: " + entry.rel);
      }
    }
    for (const entry of staged) {
      if (entry.replacement) renameSync(entry.replacement, entry.target);
      else if (statIfPresent(entry.target)) unlinkSync(entry.target);
      applied.push(entry);
    }
    for (const entry of applied) tracker?.markDirty(resolve(reviewRoot, entry.rel));
    return applied.map((entry) => entry.rel);
  } catch (error) {
    const unrestored: string[] = [];
    for (const entry of [...applied].reverse()) {
      try {
        if (!safeFilePath(parentRoot, entry.rel)) throw new Error("unsafe rollback path");
        if (entry.backup) renameSync(entry.backup, entry.target);
        else if (statIfPresent(entry.target)) unlinkSync(entry.target);
      } catch { unrestored.push(entry.rel); tracker?.markDirty(resolve(reviewRoot, entry.rel)); }
    }
    if (unrestored.length) throw new WorktreeApplyError(String(error) + "; rollback failed for: " + unrestored.join(", "), unrestored);
    throw error;
  } finally {
    for (const entry of staged) { try { rmSync(entry.directory, { recursive: true, force: true }); } catch { /* best effort */ } }
    for (const directory of createdDirectories.reverse()) { try { rmdirSync(directory); } catch { /* keep non-empty/successfully applied directories */ } }
  }
}

/** Exceptional rollback failure: expose any actual parent mutations in the moderator handoff. */
export class WorktreeApplyError extends Error {
  readonly appliedFiles: string[];
  constructor(message: string, appliedFiles: string[]) { super(message); this.appliedFiles = appliedFiles; }
}

/** Remove a disposable worktree and its dangling snapshot commit reference. */
export async function disposeDelegateWorktree(worktree: DelegateWorktree, signal?: AbortSignal): Promise<void> {
  try { await gitText(worktree.repoRoot, ["worktree", "remove", "--force", worktree.root], undefined, signal); }
  catch {
    await rm(worktree.tempRoot, { recursive: true, force: true });
    try { await gitText(worktree.repoRoot, ["worktree", "prune"], undefined, signal); } catch { /* best effort */ }
    return;
  }
  await rm(worktree.tempRoot, { recursive: true, force: true });
}
