import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** Files larger than this, or binary files, are not tracked for review. */
export const MAX_TRACKED_BYTES = 1024 * 1024;
export const MAX_TRACKED_FILES = 200;
/** Bound total retained baselines so a long editing session cannot pin hundreds of MiB. */
export const MAX_TRACKED_TOTAL_BYTES = 8 * 1024 * 1024;
/** Keep the quadratic fallback small; larger edits render a summary instead of allocating a huge matrix. */
const MAX_DIFF_CELLS = 500_000;
const MAX_DIFF_MIDDLE_LINES = 4_000;

export type ChangeStatus = "added" | "modified" | "deleted";
export interface FileChange { path: string; rel: string; status: ChangeStatus; before: string; after: string; added: number; removed: number; diff?: DiffOp[] | null }
export type DiffOp = { op: " " | "+" | "-"; text: string };
export type DiffRow = { kind: "hunk" | "context" | "add" | "remove" | "note"; text: string; oldLine?: number; newLine?: number };

/** Text content, `null` when the file is missing, or `undefined` when it cannot be tracked. */
function readText(path: string): string | null | undefined {
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (!info.isFile() || info.size > MAX_TRACKED_BYTES) return undefined;
  const buffer = readFileSync(path);
  if (buffer.subarray(0, 8000).includes(0)) return undefined;
  return buffer.toString("utf8");
}

const splitLines = (text: string) => text === "" ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");

/** Line diff: trims the common prefix/suffix, then an LCS over the changed middle. */
export function lineDiff(before: string, after: string): DiffOp[] | undefined {
  const a = splitLines(before), b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  if (midA.length + midB.length > MAX_DIFF_MIDDLE_LINES || midA.length * midB.length > MAX_DIFF_CELLS) return undefined;
  const n = midA.length, m = midB.length;
  // lcs[i][j] = LCS length of midA[i..] and midB[j..], flattened. The matrix is
  // intentionally capped above and Uint16 is enough because the capped middle is < 65k lines.
  const lcs = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i * (m + 1) + j] = midA[i] === midB[j] ? lcs[(i + 1) * (m + 1) + j + 1]! + 1
      : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!);
  }
  const ops: DiffOp[] = a.slice(0, start).map((text) => ({ op: " ", text }));
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) { ops.push({ op: " ", text: midA[i]! }); i++; j++; }
    else if (j < m && (i >= n || lcs[i * (m + 1) + j + 1]! > lcs[(i + 1) * (m + 1) + j]!)) ops.push({ op: "+", text: midB[j++]! });
    else ops.push({ op: "-", text: midA[i++]! });
  }
  for (const text of a.slice(endA)) ops.push({ op: " ", text });
  return ops;
}

/** Unified hunks with `context` lines around each change. */
export function diffRows(ops: readonly DiffOp[], context = 3): DiffRow[] {
  const rows: DiffRow[] = [];
  const changed = ops.map((op) => op.op !== " ");
  let oldLine = 1, newLine = 1;
  const positions = ops.map((op) => {
    const at = { oldLine, newLine };
    if (op.op !== "+") oldLine++;
    if (op.op !== "-") newLine++;
    return at;
  });
  let index = 0;
  while (index < ops.length) {
    if (!changed[index]) { index++; continue; }
    const from = Math.max(0, index - context);
    let to = index;
    // Extend the hunk while the next change is within 2 × context lines.
    while (to < ops.length) {
      let next = to + 1;
      while (next < ops.length && !changed[next]) next++;
      if (next < ops.length && next - to <= context * 2) { to = next; continue; }
      break;
    }
    const end = Math.min(ops.length, to + context + 1);
    const slice = ops.slice(from, end);
    const oldCount = slice.filter((op) => op.op !== "+").length;
    const newCount = slice.filter((op) => op.op !== "-").length;
    rows.push({ kind: "hunk", text: `@@ -${positions[from]!.oldLine},${oldCount} +${positions[from]!.newLine},${newCount} @@` });
    for (let at = from; at < end; at++) {
      const op = ops[at]!;
      rows.push({ kind: op.op === "+" ? "add" : op.op === "-" ? "remove" : "context", text: op.text,
        ...(op.op !== "+" ? { oldLine: positions[at]!.oldLine } : {}), ...(op.op !== "-" ? { newLine: positions[at]!.newLine } : {}) });
    }
    index = end;
  }
  return rows;
}

/**
 * Remembers each file's content before the agent's first edit/write to it, so the user can
 * review everything changed since and accept or revert per file. Session-local and in memory.
 */
export class ChangeTracker {
  private baselines = new Map<string, string | null>();
  private dirty = new Set<string>();
  private diffCache = new Map<string, FileChange>();
  private baselineBytes = 0;
  private readonly cwd: () => string;
  constructor(cwd: () => string) { this.cwd = cwd; }

  private absolute(path: string): string { return isAbsolute(path) ? resolve(path) : resolve(this.cwd(), path); }
  private bytes(content: string | null): number { return content === null ? 0 : Buffer.byteLength(content, "utf8"); }
  private drop(target: string): void {
    if (this.baselines.has(target)) this.baselineBytes = Math.max(0, this.baselineBytes - this.bytes(this.baselines.get(target)!));
    this.baselines.delete(target);
    this.dirty.delete(target);
    this.diffCache.delete(target);
  }

  /** Record the pre-change content once; returns false when the file cannot be tracked. */
  capture(path: string): boolean {
    const target = this.absolute(path);
    if (this.baselines.has(target)) return true;
    // Only project files: plan files and scratch space elsewhere are not part of the review.
    const rel = relative(this.cwd(), target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
    if (this.baselines.size >= MAX_TRACKED_FILES) return false;
    const content = readText(target);
    if (content === undefined) return false;
    const bytes = this.bytes(content);
    if (this.baselineBytes + bytes > MAX_TRACKED_TOTAL_BYTES) return false;
    this.baselines.set(target, content);
    this.baselineBytes += bytes;
    return true;
  }

  /**
   * Mark one captured file after an edit/write completes. This performs only one cheap file read;
   * no line diff is calculated until the review UI is opened.
   */
  markDirty(path: string): boolean {
    const target = this.absolute(path);
    if (!this.baselines.has(target)) return false;
    const before = this.baselines.get(target)!;
    const now = readText(target);
    this.diffCache.delete(target);
    if (now === undefined) { this.drop(target); return false; }
    if (now === before) {
      this.dirty.delete(target);
      return false;
    }
    this.dirty.add(target);
    return true;
  }

  /** Materialize detailed diffs lazily for the review UI only. */
  changes(): FileChange[] {
    const result: FileChange[] = [];
    for (const path of [...this.dirty]) {
      const before = this.baselines.get(path);
      if (before === undefined) { this.dirty.delete(path); this.diffCache.delete(path); continue; }
      const now = readText(path);
      if (now === undefined) { this.drop(path); continue; }
      if (now === before) { this.dirty.delete(path); this.diffCache.delete(path); continue; }
      const cached = this.diffCache.get(path);
      if (cached) { result.push(cached); continue; }
      const ops = lineDiff(before ?? "", now ?? "");
      const added = ops ? ops.filter((op) => op.op === "+").length : splitLines(now ?? "").length;
      const removed = ops ? ops.filter((op) => op.op === "-").length : splitLines(before ?? "").length;
      const rel = relative(this.cwd(), path);
      const change: FileChange = {
        path, rel: rel && !rel.startsWith("..") ? rel : path,
        status: before === null ? "added" : now === null ? "deleted" : "modified",
        before: before ?? "", after: now ?? "", added, removed, diff: ops ?? null
      };
      this.diffCache.set(path, change);
      result.push(change);
    }
    return result.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  /** O(1): the footer never calculates file diffs just to show its badge. */
  count(): number { return this.dirty.size; }
  trackedBytes(): number { return this.baselineBytes; }
  /** Keep the current content: stop tracking the file. */
  accept(path: string): void { this.drop(this.absolute(path)); }
  acceptAll(): void { this.baselines.clear(); this.dirty.clear(); this.diffCache.clear(); this.baselineBytes = 0; }
  /** Restore the pre-change content (or remove a file the agent created). */
  revert(path: string): void {
    const target = this.absolute(path);
    if (!this.baselines.has(target)) throw new Error("not a tracked change: " + path);
    const before = this.baselines.get(target)!;
    if (before === null) { if (existsSync(target)) unlinkSync(target); }
    else writeFileSync(target, before);
    this.drop(target);
  }
  clear(): void { this.acceptAll(); }
}
