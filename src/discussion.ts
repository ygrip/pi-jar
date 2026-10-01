import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { cleanText } from "./status.ts";

export const DISCUSSION_FILE_ENV = "PI_JAR_DISCUSSION_FILE";
export const SUBAGENT_KEY_ENV = "PI_JAR_SUBAGENT_KEY";
export const SUBAGENT_NAME_ENV = "PI_JAR_SUBAGENT_NAME";
export const MAX_DISCUSSION_ENTRIES = 64;
export const MAX_DISCUSSION_TEXT = 1600;
const MAX_DISCUSSION_BYTES = 64 * 1024;

export interface DiscussionEntry {
  id: string;
  kind: "question" | "answer";
  from: string;
  to?: string;
  questionId?: string;
  text: string;
  at: string;
}
interface DiscussionPaper { version: 1; seq: number; entries: DiscussionEntry[] }

const empty = (): DiscussionPaper => ({ version: 1, seq: 0, entries: [] });
const safeActor = (value: string | undefined) => cleanText(value || "moderator", 48) || "moderator";

function readPaper(file: string): DiscussionPaper {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<DiscussionPaper>;
    if (raw.version !== 1 || !Array.isArray(raw.entries)) return empty();
    const entries = raw.entries.filter((item): item is DiscussionEntry => !!item && typeof item === "object"
      && (item.kind === "question" || item.kind === "answer") && typeof item.id === "string"
      && typeof item.from === "string" && typeof item.text === "string" && typeof item.at === "string")
      .slice(-MAX_DISCUSSION_ENTRIES);
    return { version: 1, seq: typeof raw.seq === "number" && Number.isFinite(raw.seq) ? Math.max(0, raw.seq) : entries.length, entries };
  } catch { return empty(); }
}

function writePaper(file: string, paper: DiscussionPaper): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + "." + process.pid + ".tmp";
  // Compact JSON: indentation only cost bytes against the cap and evicted entries earlier.
  let data = JSON.stringify(paper) + "\n";
  // Entry count/character caps are not byte caps (CJK, emoji and JSON escaping cost
  // more). Evict oldest entries until the actual serialized UTF-8 paper fits.
  while (Buffer.byteLength(data, "utf8") > MAX_DISCUSSION_BYTES && paper.entries.length) {
    paper.entries.shift();
    data = JSON.stringify(paper) + "\n";
  }
  writeFileSync(temp, data);
  renameSync(temp, file);
}

export function createDiscussionPaper(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-discussion-"));
  const file = join(root, "paper.json");
  writePaper(file, empty());
  return file;
}

export function disposeDiscussionPaper(file: string | undefined): void {
  if (!file) return;
  try { rmSync(dirname(file), { recursive: true, force: true }); } catch { /* best effort */ }
}

export function discussionEntries(file: string | undefined): DiscussionEntry[] {
  return file ? readPaper(file).entries : [];
}

/** Waits by yielding to the event loop, never blocking it: the moderator's UI keeps painting. */
async function withPaperLock<T>(file: string, run: () => T): Promise<T> {
  const lock = file + ".lock";
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      mkdirSync(lock);
      try { return run(); }
      finally { rmSync(lock, { recursive: true, force: true }); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) { rmSync(lock, { recursive: true, force: true }); continue; }
      } catch { /* another process may have released it */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("discussion paper is busy");
}

/** Append under the lock; `accept` validates against the same snapshot, so there is one read per write.
 *  The written snapshot is returned too, so the caller can piggyback unseen entries without a second read. */
function append(file: string, actor: string, entry: Omit<DiscussionEntry, "id" | "from" | "at">,
  accept: (paper: DiscussionPaper) => string | undefined = () => undefined): Promise<{ entry: DiscussionEntry; paper: DiscussionPaper } | string> {
  return withPaperLock(file, () => {
    const paper = readPaper(file);
    const rejected = accept(paper);
    if (rejected) return rejected;
    paper.seq++;
    const next: DiscussionEntry = {
      id: "d" + paper.seq,
      from: safeActor(actor),
      at: new Date().toISOString(),
      ...entry,
      text: cleanText(entry.text, MAX_DISCUSSION_TEXT)
    };
    paper.entries.push(next);
    if (paper.entries.length > MAX_DISCUSSION_ENTRIES) paper.entries.splice(0, paper.entries.length - MAX_DISCUSSION_ENTRIES);
    writePaper(file, paper);
    return { entry: next, paper };
  });
}

/** A list reply never exceeds this, however many entries match; each listed entry is clipped too. */
export const MAX_LIST_CHARS = 4000;
const MAX_LISTED_TEXT = 400;
const seqOf = (id: string | undefined) => { const match = /^d(\d+)$/.exec(id ?? ""); return match ? Number(match[1]) : undefined; };
const entryLine = (entry: DiscussionEntry, limit: number) => {
  const text = entry.text.length > limit ? entry.text.slice(0, limit) + "…" : entry.text;
  return entry.kind === "question"
    ? `[${entry.id}] Q · ${entry.from}${entry.to ? " → " + entry.to : ""}: ${text}`
    : `[${entry.id}] A · ${entry.from} → ${entry.questionId ?? "?"}: ${text}`;
};
/** Newest entries first into the budget, rendered oldest first; omissions are stated, never silent. */
const render = (entries: readonly DiscussionEntry[], limit: number): string => {
  if (!entries.length) return "(no discussion entries)";
  const lines: string[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const line = entryLine(entries[index]!, limit);
    if (lines.length && used + line.length + 1 > MAX_LIST_CHARS) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  const omitted = entries.length - lines.length;
  return (omitted ? `(${omitted} older entries omitted; use questionId to read one thread)\n` : "") + lines.join("\n")
    + `\n(latest ${entries.at(-1)!.id})`;
};

/** Unseen entries piggybacked on an ask/answer reply never exceed this. */
const MAX_PIGGYBACK_CHARS = 1000;

export function registerDiscussionTool(pi: ExtensionAPI, file: () => string | undefined,
  actor: () => string = () => safeActor(process.env[SUBAGENT_NAME_ENV] ?? process.env[SUBAGENT_KEY_ENV])): void {
  // Every Pi process (moderator or child) registers its own tool, so this closure is one actor's read
  // cursor: the highest seq it has been shown on the current paper. A different path, or a paper whose
  // seq went backwards (recreated), starts over at zero.
  let cursor = { path: "", seq: 0 };
  const unseen = (path: string, paper: DiscussionPaper, me: string) => {
    if (cursor.path !== path || paper.seq < cursor.seq) cursor = { path, seq: 0 };
    const after = cursor.seq;
    return paper.entries.filter((entry) => (seqOf(entry.id) ?? 0) > after && entry.from !== me);
  };
  const advance = (seq: number) => { cursor.seq = Math.max(cursor.seq, seq); };
  // The cursor is one max-seq, so it may only move past everything unseen. An ask/answer reply therefore
  // attaches unseen entries (and advances) only when every unseen non-own entry is relevant to the caller
  // (a question addressed to it, or an answer to one of its questions) and all of them fit
  // MAX_PIGGYBACK_CHARS; otherwise it adds a one-line count and leaves them for `list`. The question being
  // answered (`known`) counts as seen: the caller already has it.
  const piggyback = (path: string, paper: DiscussionPaper, me: string, known?: string): string => {
    const fresh = unseen(path, paper, me).filter((entry) => entry.id !== known);
    if (!fresh.length) { advance(paper.seq); return ""; }
    const asked = new Set(paper.entries.filter((entry) => entry.kind === "question" && entry.from === me).map((entry) => entry.id));
    const relevant = fresh.filter((entry) => entry.kind === "question" ? entry.to === me : asked.has(entry.questionId ?? ""));
    const shown = relevant.map((entry) => entryLine(entry, MAX_LISTED_TEXT)).join("\n");
    if (relevant.length === fresh.length && shown.length <= MAX_PIGGYBACK_CHARS) { advance(paper.seq); return "\n" + shown; }
    return `\n(${fresh.length} new ${fresh.length === 1 ? "entry" : "entries"}${relevant.length ? `, ${relevant.length} for you` : ""}; list to read)`;
  };
  const parameters = Type.Object({
    action: Type.Union([Type.Literal("list"), Type.Literal("ask"), Type.Literal("answer")]),
    text: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    questionId: Type.Optional(Type.String({ description: "answer: the question being answered. list: read only that question and its answers, in full." })),
    since: Type.Optional(Type.String({ description: "list: entries newer than this id (e.g. d12) instead of only unseen ones; \"d0\" rereads everything." }))
  });
  pi.registerTool?.<typeof parameters, { path?: string; entry?: DiscussionEntry }>({
    name: "jar_discuss",
    label: "discuss",
    description: `Shared bounded Q/A paper between this session's agents; not a transcript. ask/answer reply with the new id only. list returns only entries you have not seen (≤${MAX_LIST_CHARS} chars).`,
    promptSnippet: "Ask or answer one concrete cross-agent question on the shared discussion paper.",
    promptGuidelines: [
      "jar_discuss: one precise question or answer per call; answer only the given questionId. Replies never echo your text.",
      "Answers to your questions also arrive on your next ask/answer. list shows only unseen entries; questionId reads one thread. Don't poll."
    ],
    parameters,
    async execute(_id, params) {
      const path = file();
      if (!path) return { content: [{ type: "text", text: "No shared discussion paper is active." }], details: {} };
      const me = safeActor(actor());
      if (params.action === "list") {
        const paper = readPaper(path);
        const thread = params.questionId ? cleanText(params.questionId, 24) : undefined;
        if (thread) {
          const items = paper.entries.filter((entry) => entry.id === thread || entry.questionId === thread);
          return { content: [{ type: "text", text: render(items, MAX_DISCUSSION_TEXT) }], details: { path } };
        }
        const since = seqOf(params.since);
        const fresh = unseen(path, paper, me);
        advance(paper.seq);
        if (since !== undefined) {
          const newer = paper.entries.filter((entry) => (seqOf(entry.id) ?? 0) > since);
          const text = newer.length ? render(newer, MAX_LISTED_TEXT) : `No entries newer than ${params.since}.`;
          return { content: [{ type: "text", text }], details: { path } };
        }
        const latest = paper.entries.at(-1)?.id;
        const text = fresh.length ? render(fresh, MAX_LISTED_TEXT) : `No new entries${latest ? ` (latest ${latest})` : ""}.`;
        return { content: [{ type: "text", text }], details: { path } };
      }
      const text = cleanText(params.text ?? "", MAX_DISCUSSION_TEXT);
      if (!text) return { content: [{ type: "text", text: "Discussion text is required." }], details: {}, isError: true };
      if (params.action === "ask") {
        const added = await append(path, me, { kind: "question", text, ...(params.to ? { to: safeActor(params.to) } : {}) });
        if (typeof added === "string") return { content: [{ type: "text", text: added }], details: {}, isError: true };
        const { entry, paper } = added;
        const reply = `Added ${entry.id}${entry.to ? ` (→ ${entry.to})` : ""}.` + piggyback(path, paper, me);
        return { content: [{ type: "text", text: reply }], details: { path, entry } };
      }
      const questionId = cleanText(params.questionId ?? "", 24);
      if (!questionId) return { content: [{ type: "text", text: "questionId is required for an answer." }], details: {}, isError: true };
      const added = await append(path, me, { kind: "answer", questionId, text }, (paper) =>
        paper.entries.some((item) => item.kind === "question" && item.id === questionId) ? undefined : "Unknown discussion question: " + questionId);
      if (typeof added === "string") return { content: [{ type: "text", text: added }], details: {}, isError: true };
      const { entry, paper } = added;
      return { content: [{ type: "text", text: `Answered ${questionId} as ${entry.id}.` + piggyback(path, paper, me, questionId) }], details: { path, entry } };
    }
  });
}
