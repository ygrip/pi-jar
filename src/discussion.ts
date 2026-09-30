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

/** Append under the lock; `accept` validates against the same snapshot, so there is one read per write. */
function append(file: string, actor: string, entry: Omit<DiscussionEntry, "id" | "from" | "at">,
  accept: (paper: DiscussionPaper) => string | undefined = () => undefined): Promise<DiscussionEntry | string> {
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
    return next;
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
    + `\n(newest: ${entries.at(-1)!.id}; pass since=${entries.at(-1)!.id} to read only newer entries)`;
};

export function registerDiscussionTool(pi: ExtensionAPI, file: () => string | undefined,
  actor: () => string = () => safeActor(process.env[SUBAGENT_NAME_ENV] ?? process.env[SUBAGENT_KEY_ENV])): void {
  const parameters = Type.Object({
    action: Type.Union([Type.Literal("list"), Type.Literal("ask"), Type.Literal("answer")]),
    text: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    questionId: Type.Optional(Type.String({ description: "answer: the question being answered. list: read only that question and its answers, in full." })),
    since: Type.Optional(Type.String({ description: "list: only entries newer than this id (e.g. d12), so rereads cost nothing when nothing changed." }))
  });
  pi.registerTool?.<typeof parameters, { path?: string; entry?: DiscussionEntry }>({
    name: "jar_discuss",
    label: "discuss",
    description: `Use the session's bounded shared discussion paper for terse cross-agent questions and answers. Prefer one precise question or answer per call; do not use it as a transcript or scratchpad. list replies are capped at ${MAX_LIST_CHARS} characters.`,
    promptSnippet: "Use jar_discuss when another subagent needs a concrete question answered without routing a long conversation through the moderator.",
    promptGuidelines: [
      "Keep discussion entries short and decision-oriented. Read the paper before answering if the question id is unfamiliar.",
      "When answering, address only the requested question and cite the question id. Do not continue unrelated task work inside the discussion entry.",
      "Do not poll list while waiting for an answer: continue your task and check again later with since set to the newest id you saw; use questionId to read one thread."
    ],
    parameters,
    async execute(_id, params) {
      const path = file();
      if (!path) return { content: [{ type: "text", text: "No shared discussion paper is active." }], details: {} };
      if (params.action === "list") {
        const entries = discussionEntries(path);
        const thread = params.questionId ? cleanText(params.questionId, 24) : undefined;
        if (thread) {
          const items = entries.filter((entry) => entry.id === thread || entry.questionId === thread);
          return { content: [{ type: "text", text: render(items, MAX_DISCUSSION_TEXT) }], details: { path } };
        }
        const since = seqOf(params.since);
        const newer = since === undefined ? entries : entries.filter((entry) => (seqOf(entry.id) ?? 0) > since);
        if (since !== undefined && !newer.length) return { content: [{ type: "text", text: `No entries newer than ${params.since}.` }], details: { path } };
        return { content: [{ type: "text", text: render(newer, MAX_LISTED_TEXT) }], details: { path } };
      }
      const text = cleanText(params.text ?? "", MAX_DISCUSSION_TEXT);
      if (!text) return { content: [{ type: "text", text: "Discussion text is required." }], details: {}, isError: true };
      if (params.action === "ask") {
        const entry = await append(path, actor(), { kind: "question", text, ...(params.to ? { to: safeActor(params.to) } : {}) });
        if (typeof entry === "string") return { content: [{ type: "text", text: entry }], details: {}, isError: true };
        return { content: [{ type: "text", text: `Added ${entry.id}: ${entry.text}` }], details: { path, entry } };
      }
      const questionId = cleanText(params.questionId ?? "", 24);
      if (!questionId) return { content: [{ type: "text", text: "questionId is required for an answer." }], details: {}, isError: true };
      const entry = await append(path, actor(), { kind: "answer", questionId, text }, (paper) =>
        paper.entries.some((item) => item.kind === "question" && item.id === questionId) ? undefined : "Unknown discussion question: " + questionId);
      if (typeof entry === "string") return { content: [{ type: "text", text: entry }], details: {}, isError: true };
      return { content: [{ type: "text", text: `Answered ${questionId}: ${entry.text}` }], details: { path, entry } };
    }
  });
}
