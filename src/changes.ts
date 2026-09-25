import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** Files larger than this, or binary files, are not tracked for review. */
export const MAX_TRACKED_BYTES = 1024 * 1024;
export const MAX_TRACKED_FILES = 200;
/** Above this many (old × new) changed lines the inline diff is replaced by a summary. */
const MAX_DIFF_CELLS = 4_000_000;

export type ChangeStatus = "added" | "modified" | "deleted";
export interface FileChange { path: string; rel: string; status: ChangeStatus; before: string; after: string; added: number; removed: number }
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
  if (midA.length * midB.length > MAX_DIFF_CELLS) return undefined;
  const n = midA.length, m = midB.length;
  // lcs[i][j] = LCS length of midA[i..] and midB[j..], flattened.
  const lcs = new Uint32Array((n + 1) * (m + 1));
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
  private readonly cwd: () => string;
  constructor(cwd: () => string) { this.cwd = cwd; }

  private absolute(path: string): string { return isAbsolute(path) ? resolve(path) : resolve(this.cwd(), path); }

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
    this.baselines.set(target, content);
    return true;
  }

  changes(): FileChange[] {
    const result: FileChange[] = [];
    for (const [path, before] of this.baselines) {
      const now = readText(path);
      if (now === undefined || now === before) continue;
      const ops = lineDiff(before ?? "", now ?? "");
      const added = ops ? ops.filter((op) => op.op === "+").length : splitLines(now ?? "").length;
      const removed = ops ? ops.filter((op) => op.op === "-").length : splitLines(before ?? "").length;
      const rel = relative(this.cwd(), path);
      result.push({ path, rel: rel && !rel.startsWith("..") ? rel : path, status: before === null ? "added" : now === null ? "deleted" : "modified",
        before: before ?? "", after: now ?? "", added, removed });
    }
    return result.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  count(): number { return this.changes().length; }
  /** Keep the current content: stop tracking the file. */
  accept(path: string): void { this.baselines.delete(this.absolute(path)); }
  acceptAll(): void { this.baselines.clear(); }
  /** Restore the pre-change content (or remove a file the agent created). */
  revert(path: string): void {
    const target = this.absolute(path);
    if (!this.baselines.has(target)) throw new Error("not a tracked change: " + path);
    const before = this.baselines.get(target)!;
    if (before === null) { if (existsSync(target)) unlinkSync(target); }
    else writeFileSync(target, before);
    this.baselines.delete(target);
  }
  clear(): void { this.baselines.clear(); }
}
