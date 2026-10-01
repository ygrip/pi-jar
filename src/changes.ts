import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** Files larger than this, or binary files, are not tracked for review. */
export const MAX_TRACKED_BYTES = 1024 * 1024;
export const MAX_TRACKED_FILES = 200;
/** Bound total retained baselines so a long editing session cannot pin hundreds of MiB. */
export const MAX_TRACKED_TOTAL_BYTES = 8 * 1024 * 1024;
/** Explicit full-review choice supports bounded matrix-free previews beyond the exact-diff budget. */
export const MAX_REVIEW_DIFF_LINES = 100_000;
/** Keep the quadratic fallback small; larger edits render a summary instead of allocating a huge matrix. */
const MAX_DIFF_CELLS = 500_000;
const MAX_DIFF_MIDDLE_LINES = 4_000;

export type ChangeStatus = "added" | "modified" | "deleted";
export interface FileChange { path: string; rel: string; status: ChangeStatus; before: string; after: string; added: number; removed: number; diff?: DiffOp[] | null }
export type DiffOp = { op: " " | "+" | "-"; text: string };
/** `hidden` counts unchanged lines skipped before a hunk; `pair` is the aligned replacement line for intraline diffs. */
export type DiffRow = { kind: "hunk" | "context" | "add" | "remove" | "note"; text: string; oldLine?: number; newLine?: number; hidden?: number; pair?: string };
export type SplitSide = { line: number; text: string; changed: boolean };
/** One aligned Original/Updated row: a replacement run pairs its k-th removed and k-th added line. */
export type SplitRow = { kind: "hunk"; text: string; hidden: number } | { kind: "pair"; left?: SplitSide; right?: SplitSide };

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

export function diffLineCount(text: string): number {
  if (!text) return 0;
  let count = 1;
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count++;
  if (text.endsWith("\n")) count--;
  return count;
}

/** Safe O(n) fallback that preserves common prefix/suffix and clearly marks coarse replacements. */
export function coarseLineDiff(before: string, after: string): DiffOp[] {
  const a = splitLines(before), b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return [
    ...a.slice(0, start).map(text => ({ op: " " as const, text })),
    ...a.slice(start, endA).map(text => ({ op: "-" as const, text })),
    ...b.slice(start, endB).map(text => ({ op: "+" as const, text })),
    ...a.slice(endA).map(text => ({ op: " " as const, text }))
  ];
}

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
  return diffRowsWindow(ops, context, 0, Number.MAX_SAFE_INTEGER);
}

const linePositionCache = new WeakMap<readonly DiffOp[], { old: Uint32Array; next: Uint32Array }>();

type DiffHunk = { from: number; end: number; offset: number };
const hunkCache = new WeakMap<readonly DiffOp[], { context: number; offsets: number[]; rows: number; hunks: DiffHunk[] }>();

/** Logical rendered row offsets for hunk navigation, without materializing unchanged rows. */
export function diffHunkOffsets(ops: readonly DiffOp[], context = 3): number[] {
  const cached = hunkCache.get(ops);
  if (cached?.context === context) return cached.offsets.slice();
  const offsets: number[] = [];
  const hunks: DiffHunk[] = [];
  let rendered = 0, index = 0;
  while (index < ops.length) {
    if (ops[index]!.op === " ") { index++; continue; }
    const from = Math.max(0, index - context);
    let to = index;
    while (to < ops.length) {
      let next = to + 1;
      while (next < ops.length && ops[next]!.op === " ") next++;
      // Merge when the unchanged gap fits inside both hunks' context (adjacent changes at context 0).
      if (next < ops.length && next - to - 1 <= context * 2) { to = next; continue; }
      break;
    }
    const end = Math.min(ops.length, to + context + 1);
    offsets.push(rendered);
    hunks.push({ from, end, offset: rendered });
    rendered += 1 + end - from;
    index = end;
  }
  hunkCache.set(ops, { context, offsets, rows: rendered, hunks });
  return offsets.slice();
}

export function diffRowCount(ops: readonly DiffOp[], context = 3): number {
  if (hunkCache.get(ops)?.context !== context) diffHunkOffsets(ops, context);
  return hunkCache.get(ops)!.rows;
}

const linePositions = (ops: readonly DiffOp[]) => {
  let positions = linePositionCache.get(ops);
  if (!positions) {
    const old = new Uint32Array(ops.length + 1), next = new Uint32Array(ops.length + 1);
    let oldLine = 1, newLine = 1;
    for (let at = 0; at < ops.length; at++) {
      const op = ops[at]!;
      old[at] = oldLine; next[at] = newLine;
      if (op.op !== "+") oldLine++;
      if (op.op !== "-") newLine++;
    }
    old[ops.length] = oldLine;
    next[ops.length] = newLine;
    positions = { old, next };
    linePositionCache.set(ops, positions);
  }
  return positions;
};

/**
 * Replacement runs (maximal non-context spans) as flat typed arrays, independent of context:
 * `order[start..start+removes)` lists the run's removed ops and the rest its added ops, so the
 * k-th removal pairs with the k-th addition. `split` prefixes aligned rows (a run takes max(r, a)).
 */
type RunLayout = { start: Uint32Array; removes: Uint32Array; length: Uint32Array; order: Uint32Array; ordinal: Uint32Array; split: Uint32Array };
const runCache = new WeakMap<readonly DiffOp[], RunLayout>();

const runLayout = (ops: readonly DiffOp[]): RunLayout => {
  const cached = runCache.get(ops);
  if (cached) return cached;
  const n = ops.length;
  const layout: RunLayout = { start: new Uint32Array(n), removes: new Uint32Array(n), length: new Uint32Array(n),
    order: new Uint32Array(n), ordinal: new Uint32Array(n), split: new Uint32Array(n + 1) };
  const { start, removes, length, order, ordinal, split } = layout;
  for (let at = 0; at < n;) {
    if (ops[at]!.op === " ") { order[at] = at; split[at + 1] = split[at]! + 1; at++; continue; }
    let end = at;
    while (end < n && ops[end]!.op !== " ") end++;
    let r = 0, a = 0;
    for (let i = at; i < end; i++) if (ops[i]!.op === "-") { ordinal[i] = r; order[at + r++] = i; }
    for (let i = at; i < end; i++) if (ops[i]!.op === "+") { ordinal[i] = a; order[at + r + a++] = i; }
    for (let i = at; i < end; i++) { start[i] = at; removes[i] = r; length[i] = end - at; split[i + 1] = split[at]!; }
    split[at + 1] = split[at]! + Math.max(r, a);
    for (let i = at + 1; i < end; i++) split[i + 1] = split[at + 1]!;
    at = end;
  }
  runCache.set(ops, layout);
  return layout;
};

/** The aligned counterpart of a changed op (k-th removal ↔ k-th addition in its run), if any. */
const partner = (ops: readonly DiffOp[], at: number): number | undefined => {
  const { start, removes, length, order, ordinal } = runLayout(ops);
  const s = start[at]!, r = removes[at]!, a = length[at]! - r, k = ordinal[at]!;
  if (ops[at]!.op === "-") return k < a ? order[s + r + k] : undefined;
  return k < r ? order[s + k] : undefined;
};

/** Compute only the requested output window; diff operations stay indexed without a second full row array. */
export function diffRowsWindow(ops: readonly DiffOp[], context = 3, offset = 0, limit = Number.MAX_SAFE_INTEGER): DiffRow[] {
  const rows: DiffRow[] = [];
  const firstRow = Math.max(0, offset);
  const lastRow = firstRow + Math.max(0, limit);
  if (hunkCache.get(ops)?.context !== context) diffHunkOffsets(ops, context);
  const layout = hunkCache.get(ops)!;
  if (firstRow >= layout.rows || lastRow <= firstRow) return rows;
  const positions = linePositions(ops);
  // Binary-search the first intersecting hunk, then visit only visible operations. In
  // particular, a 100k-line replacement must not slice/filter/allocate 100k rows per frame.
  let lo = 0, hi = layout.hunks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const hunk = layout.hunks[mid]!;
    if (hunk.offset + 1 + hunk.end - hunk.from <= firstRow) lo = mid + 1;
    else hi = mid;
  }
  for (let index = lo; index < layout.hunks.length; index++) {
    const { from, end, offset: start } = layout.hunks[index]!;
    if (start >= lastRow) break;
    if (start >= firstRow) rows.push({ kind: "hunk", text: hunkHeader(positions, from, end), hidden: from - (layout.hunks[index - 1]?.end ?? 0) });
    const visibleFrom = from + Math.max(0, firstRow - start - 1);
    const visibleEnd = Math.min(end, from + lastRow - start - 1);
    for (let at = visibleFrom; at < visibleEnd; at++) {
      const op = ops[at]!;
      const pair = op.op === " " ? undefined : partner(ops, at);
      rows.push({ kind: op.op === "+" ? "add" : op.op === "-" ? "remove" : "context", text: op.text,
        ...(op.op !== "+" ? { oldLine: positions.old[at]! } : {}), ...(op.op !== "-" ? { newLine: positions.next[at]! } : {}),
        ...(pair !== undefined ? { pair: ops[pair]!.text } : {}) });
    }
  }
  return rows;
}

/** Git convention: an empty side (pure insertion/deletion) names the line before the change. */
const hunkHeader = (positions: { old: Uint32Array; next: Uint32Array }, from: number, end: number) => {
  const range = (lines: Uint32Array) => {
    const count = lines[end]! - lines[from]!;
    return `${count ? lines[from]! : lines[from]! - 1},${count}`;
  };
  return `@@ -${range(positions.old)} +${range(positions.next)} @@`;
};

type SplitHunk = DiffHunk & { split: number };
const splitCache = new WeakMap<readonly DiffOp[], { context: number; hunks: SplitHunk[]; offsets: number[]; rows: number }>();

const splitLayout = (ops: readonly DiffOp[], context: number) => {
  const cached = splitCache.get(ops);
  if (cached?.context === context) return cached;
  if (hunkCache.get(ops)?.context !== context) diffHunkOffsets(ops, context);
  const { split } = runLayout(ops);
  const hunks: SplitHunk[] = [];
  let rows = 0;
  // Hunks start and end on context ops, so a replacement run never straddles two hunks.
  for (const hunk of hunkCache.get(ops)!.hunks) {
    hunks.push({ ...hunk, split: rows });
    rows += 1 + split[hunk.end]! - split[hunk.from]!;
  }
  const layout = { context, hunks, offsets: hunks.map(hunk => hunk.split), rows };
  splitCache.set(ops, layout);
  return layout;
};

/** Aligned side-by-side row offsets of each hunk header. */
export function diffSplitHunkOffsets(ops: readonly DiffOp[], context = 3): number[] {
  return splitLayout(ops, context).offsets.slice();
}

export function diffSplitRowCount(ops: readonly DiffOp[], context = 3): number {
  return splitLayout(ops, context).rows;
}

/** Window of aligned Original/Updated rows; like `diffRowsWindow`, it visits only visible operations. */
export function diffSplitRowsWindow(ops: readonly DiffOp[], context = 3, offset = 0, limit = Number.MAX_SAFE_INTEGER): SplitRow[] {
  const rows: SplitRow[] = [];
  const firstRow = Math.max(0, offset);
  const lastRow = firstRow + Math.max(0, limit);
  const layout = splitLayout(ops, context);
  if (firstRow >= layout.rows || lastRow <= firstRow) return rows;
  const positions = linePositions(ops);
  const { split, order, removes, length } = runLayout(ops);
  const size = (hunk: SplitHunk) => 1 + split[hunk.end]! - split[hunk.from]!;
  let lo = 0, hi = layout.hunks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (layout.hunks[mid]!.split + size(layout.hunks[mid]!) <= firstRow) lo = mid + 1;
    else hi = mid;
  }
  for (let index = lo; index < layout.hunks.length; index++) {
    const hunk = layout.hunks[index]!;
    if (hunk.split >= lastRow) break;
    if (hunk.split >= firstRow) rows.push({ kind: "hunk", text: hunkHeader(positions, hunk.from, hunk.end), hidden: hunk.from - (layout.hunks[index - 1]?.end ?? 0) });
    const visibleFrom = Math.max(0, firstRow - hunk.split - 1);
    const visibleEnd = Math.min(size(hunk) - 1, lastRow - hunk.split - 1);
    for (let row = visibleFrom; row < visibleEnd; row++) {
      const target = split[hunk.from]! + row;
      // First op whose aligned-row interval contains target; only run starts carry run rows.
      let low = hunk.from, high = hunk.end - 1;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (split[mid + 1]! > target) high = mid; else low = mid + 1;
      }
      const op = ops[low]!;
      if (op.op === " ") {
        rows.push({ kind: "pair", left: { line: positions.old[low]!, text: op.text, changed: false }, right: { line: positions.next[low]!, text: op.text, changed: false } });
        continue;
      }
      const k = target - split[low]!, r = removes[low]!, a = length[low]! - r;
      const removed = k < r ? order[low + k]! : undefined;
      const added = k < a ? order[low + r + k]! : undefined;
      rows.push({ kind: "pair",
        ...(removed !== undefined ? { left: { line: positions.old[removed]!, text: ops[removed]!.text, changed: true } } : {}),
        ...(added !== undefined ? { right: { line: positions.next[added]!, text: ops[added]!.text, changed: true } } : {}) });
    }
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
  private baselineBytes = 0;
  private readonly cwd: () => string;
  constructor(cwd: () => string) { this.cwd = cwd; }

  /** Resolve like every other tracker method; baselines are keyed by this absolute path. */
  absolute(path: string): string { return isAbsolute(path) ? resolve(path) : resolve(this.cwd(), path); }
  private bytes(content: string | null): number { return content === null ? 0 : Buffer.byteLength(content, "utf8"); }
  private drop(target: string): void {
    if (this.baselines.has(target)) this.baselineBytes = Math.max(0, this.baselineBytes - this.bytes(this.baselines.get(target)!));
    this.baselines.delete(target);
    this.dirty.delete(target);
  }

  /**
   * Store a baseline when the file is inside the project (plan files and scratch space elsewhere are
   * not reviewed) and within the file/byte caps. `content` is lazy so outside files are never read.
   */
  private admit(target: string, content: () => string | null | undefined): boolean {
    const rel = relative(this.cwd(), target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
    if (this.baselines.size >= MAX_TRACKED_FILES) return false;
    const before = content();
    if (before === undefined) return false;
    const bytes = this.bytes(before);
    if (bytes > MAX_TRACKED_BYTES || this.baselineBytes + bytes > MAX_TRACKED_TOTAL_BYTES) return false;
    this.baselines.set(target, before);
    this.baselineBytes += bytes;
    return true;
  }

  /** Record the pre-change content once; returns false when the file cannot be tracked. */
  capture(path: string): boolean {
    const target = this.absolute(path);
    return this.baselines.has(target) || this.admit(target, () => readText(target));
  }

  /** Captured pre-change content (`null` = file did not exist), or `undefined` when untracked. */
  baseline(path: string): string | null | undefined {
    const target = this.absolute(path);
    return this.baselines.has(target) ? this.baselines.get(target)! : undefined;
  }

  /**
   * Take over a baseline captured elsewhere (a subagent's first-edit content) and mark the file
   * dirty. An existing baseline is older and wins, so each absolute path counts once.
   */
  adopt(path: string, baseline: string | null): boolean {
    const target = this.absolute(path);
    if (!this.baselines.has(target) && !this.admit(target, () => baseline)) return false;
    this.dirty.add(target);
    return true;
  }

  /**
   * Mark one captured file after a successful edit/write. Do not synchronously re-read the file on
   * every tool result; the review UI reconciles content lazily when /diff is actually opened.
   */
  markDirty(path: string): boolean {
    const target = this.absolute(path);
    if (!this.baselines.has(target)) return false;
    this.dirty.add(target);
    return true;
  }

  /** Materialize detailed diffs lazily for the review UI only. */
  changes(): FileChange[] {
    const result: FileChange[] = [];
    for (const path of [...this.dirty]) {
      const before = this.baselines.get(path);
      if (before === undefined) { this.dirty.delete(path); continue; }
      const now = readText(path);
      if (now === undefined) { this.drop(path); continue; }
      if (now === before) { this.dirty.delete(path); continue; }
      const ops = lineDiff(before ?? "", now ?? "");
      const summaryOps = ops ?? coarseLineDiff(before ?? "", now ?? "");
      let added = 0, removed = 0;
      for (const op of summaryOps) { if (op.op === "+") added++; else if (op.op === "-") removed++; }
      const rel = relative(this.cwd(), path);
      const change: FileChange = {
        path, rel: rel && !rel.startsWith("..") ? rel : path,
        status: before === null ? "added" : now === null ? "deleted" : "modified",
        before: before ?? "", after: now ?? "", added, removed, diff: ops ?? null
      };
      result.push(change);
    }
    return result.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  /** O(1): the footer never calculates file diffs just to show its badge. */
  count(): number { return this.dirty.size; }
  trackedBytes(): number { return this.baselineBytes; }
  /** Keep the current content: stop tracking the file. */
  accept(path: string): void { this.drop(this.absolute(path)); }
  acceptAll(): void { this.baselines.clear(); this.dirty.clear(); this.baselineBytes = 0; }
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
