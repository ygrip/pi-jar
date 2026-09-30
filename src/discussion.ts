import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  let data = JSON.stringify(paper, null, 2) + "\n";
  if (Buffer.byteLength(data, "utf8") > MAX_DISCUSSION_BYTES) {
    paper.entries = paper.entries.slice(-Math.max(8, Math.floor(MAX_DISCUSSION_ENTRIES / 2)));
    data = JSON.stringify(paper, null, 2) + "\n";
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

function append(file: string, actor: string, entry: Omit<DiscussionEntry, "id" | "from" | "at">): DiscussionEntry {
  const paper = readPaper(file);
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
}

const render = (entries: readonly DiscussionEntry[]): string => {
  if (!entries.length) return "(discussion paper is empty)";
  return entries.map((entry) => entry.kind === "question"
    ? `[${entry.id}] Q · ${entry.from}${entry.to ? " → " + entry.to : ""}: ${entry.text}`
    : `[${entry.id}] A · ${entry.from} → ${entry.questionId ?? "?"}: ${entry.text}`).join("\n");
};

export function registerDiscussionTool(pi: ExtensionAPI, file: () => string | undefined,
  actor: () => string = () => safeActor(process.env[SUBAGENT_NAME_ENV] ?? process.env[SUBAGENT_KEY_ENV])): void {
  pi.registerTool({
    name: "jar_discuss",
    label: "discuss",
    description: "Use the session's bounded shared discussion paper for terse cross-agent questions and answers. Prefer one precise question or answer per call; do not use it as a transcript or scratchpad.",
    promptSnippet: "Use jar_discuss when another subagent needs a concrete question answered without routing a long conversation through the moderator.",
    promptGuidelines: [
      "Keep discussion entries short and decision-oriented. Read the paper before answering if the question id is unfamiliar.",
      "When answering, address only the requested question and cite the question id. Do not continue unrelated task work inside the discussion entry."
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("ask"), Type.Literal("answer")]),
      text: Type.Optional(Type.String()),
      to: Type.Optional(Type.String()),
      questionId: Type.Optional(Type.String())
    }),
    async execute(_id, params) {
      const path = file();
      if (!path) return { content: [{ type: "text", text: "No shared discussion paper is active." }] };
      if (params.action === "list") {
        return { content: [{ type: "text", text: render(discussionEntries(path).slice(-24)) }], details: { path } };
      }
      const text = cleanText(params.text ?? "", MAX_DISCUSSION_TEXT);
      if (!text) return { content: [{ type: "text", text: "Discussion text is required." }], isError: true };
      if (params.action === "ask") {
        const entry = append(path, actor(), { kind: "question", text, ...(params.to ? { to: safeActor(params.to) } : {}) });
        return { content: [{ type: "text", text: `Added ${entry.id}: ${entry.text}` }], details: { path, entry } };
      }
      const questionId = cleanText(params.questionId ?? "", 24);
      if (!questionId) return { content: [{ type: "text", text: "questionId is required for an answer." }], isError: true };
      const exists = discussionEntries(path).some((entry) => entry.kind === "question" && entry.id === questionId);
      if (!exists) return { content: [{ type: "text", text: "Unknown discussion question: " + questionId }], isError: true };
      const entry = append(path, actor(), { kind: "answer", questionId, text });
      return { content: [{ type: "text", text: `Answered ${questionId}: ${entry.text}` }], details: { path, entry } };
    }
  });
}
