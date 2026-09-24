import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** A read-only snapshot: index only visible entries; never copy large tool outputs. */
export interface HistorySnapshot {
  readonly entries: readonly SessionEntry[];
  readonly visible: readonly number[];
}

export interface HistoryItem {
  readonly entry: SessionEntry;
  readonly sequence: number;
  readonly actor: string;
  readonly time?: string;
  readonly summary: string;
  readonly search: string;
  readonly error: boolean;
  readonly expandable: boolean;
}

export const HISTORY_PAGE_SIZE = 80;
export const HISTORY_CHUNK_SIZE = 2048;

/** Remove terminal escapes, bidi spoofing, zero-width marks and C0/C1 controls. */
export function safeHistoryText(text: string, limit = HISTORY_CHUNK_SIZE): string {
  return text.slice(0, Math.max(0, limit) + 128)
    .replace(/\r/g, "\n")
    .replace(/\x1b(?:\][\s\S]*?(?:\x07|\x1b\\|$)|\[[0-?]*[ -/]*[@-~]|[P_^X][\s\S]*?(?:\x1b\\|$)|.)/g, "")
    .replace(/\x9d[\s\S]*?(?:\x9c|$)|\x9b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, "")
    .replace(/\t/g, "  ")
    .slice(0, limit);
}

function visibleEntry(entry: SessionEntry): boolean {
  if (entry.type === "compaction" || entry.type === "branch_summary") return true;
  if (entry.type === "custom_message") return entry.display === true;
  if (entry.type !== "message") return false; // Skip future entry types and private metadata.
  const role = entry.message?.role;
  return role === "user" || role === "assistant" || role === "toolResult" || role === "bashExecution" || role === "custom" && entry.message.display === true;
}

export function createHistorySnapshot(entries: readonly SessionEntry[]): HistorySnapshot {
  const visible: number[] = [];
  for (let i = 0; i < entries.length; i++) if (visibleEntry(entries[i]!)) visible.push(i);
  return { entries, visible };
}

function* contentParts(content: unknown): Generator<string> {
  if (typeof content === "string") { yield content; return; }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") yield part.text;
    else if (part.type === "image") yield "[image]"; // Never read or render image data.
    else if (part.type === "toolCall") {
      const name = typeof part.name === "string" ? part.name : "tool";
      const args: unknown = part.arguments;
      const details = args && typeof args === "object" ? args as Record<string, unknown> : {};
      const hint = ["command", "path", "file_path"].map((key) => details[key]).find((value) => typeof value === "string");
      yield `\n$ ${name}${typeof hint === "string" ? ` · ${hint.slice(0, 256)}` : ""}`;
    }
    // Thinking blocks, signatures and other private/non-text payloads are deliberately excluded.
  }
}

function* entryParts(entry: SessionEntry): Generator<string> {
  if (entry.type === "compaction" || entry.type === "branch_summary") { yield typeof entry.summary === "string" ? entry.summary : "[unavailable summary]"; return; }
  if (entry.type === "custom_message") { yield* contentParts(entry.content); return; }
  if (entry.type !== "message") return;
  const message = entry.message;
  if (message.role === "bashExecution") {
    yield `$ ${typeof message.command === "string" ? message.command.slice(0, 4096) : "[unknown command]"}\n`;
    if (typeof message.output === "string") yield message.output;
  } else if (message.role === "assistant") {
    yield* contentParts(message.content);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      yield `\n[${message.stopReason}] ${message.errorMessage ?? ""}`;
    }
  } else if (message.role === "user" || message.role === "toolResult" || message.role === "custom") {
    yield* contentParts(message.content);
  }
}

function excerpt(entry: SessionEntry, limit: number, offset = 0): { text: string; raw: string; more: boolean } {
  let remaining = Math.max(0, offset);
  let text = "";
  let more = false;
  for (const part of entryParts(entry)) {
    if (remaining >= part.length) { remaining -= part.length; continue; }
    const from = remaining;
    remaining = 0;
    const available = limit - text.length;
    if (available <= 0) { more = true; break; }
    // Splitting a UTF-16 pair across chunks must never print a stray surrogate.
    let slice = part.slice(from, from + available);
    if (slice.length && /[\ud800-\udbff]/.test(slice.at(-1)!)) slice = slice.slice(0, -1);
    if (slice.length && /[\udc00-\udfff]/.test(slice[0]!)) slice = slice.slice(1);
    text += slice;
    if (from + available < part.length) { more = true; break; }
  }
  return { text: safeHistoryText(text, limit), raw: text, more };
}

function stamp(value: unknown): string | undefined {
  const date = typeof value === "string" ? new Date(value) : typeof value === "number" ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return undefined;
  return date.toISOString().slice(0, 16).replace("T", " ") + "Z";
}

export function historyItem(entry: SessionEntry, sequence: number): HistoryItem {
  let actor = "NOTE";
  let error = false;
  if (entry.type === "compaction") actor = "COMPACT";
  else if (entry.type === "branch_summary") actor = "BRANCH";
  else if (entry.type === "message") {
    const message = entry.message;
    if (message.role === "user") actor = "YOU";
    else if (message.role === "assistant") {
      actor = "ASSISTANT";
      error = message.stopReason === "error" || message.stopReason === "aborted";
    } else if (message.role === "toolResult") { actor = `TOOL ${message.toolName}`; error = message.isError; }
    else if (message.role === "bashExecution") { actor = "SHELL"; error = message.exitCode !== undefined && message.exitCode !== 0; }
  }
  const raw = excerpt(entry, 1024);
  const search = raw.text.replace(/\s+/g, " ").trim();
  const summary = search.slice(0, 240) || (entry.type === "message" && entry.message.role === "assistant" ? "[no visible text]" : "[empty]");
  const time = stamp(entry.timestamp) ?? (entry.type === "message" ? stamp(entry.message.timestamp) : undefined);
  return { entry, sequence, actor: safeHistoryText(actor, 48), time, summary, search, error, expandable: raw.more || search.length > 240 || entry.type === "message" && (entry.message.role === "toolResult" || entry.message.role === "bashExecution") };
}

export function historyPage(snapshot: HistorySnapshot, page = 0, size = HISTORY_PAGE_SIZE): { items: HistoryItem[]; page: number; totalPages: number } {
  const count = snapshot.visible.length;
  const pageSize = Math.max(1, Math.min(400, Math.floor(size) || HISTORY_PAGE_SIZE));
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const at = Math.max(0, Math.min(totalPages - 1, Math.floor(page) || 0));
  const start = Math.max(0, count - (at + 1) * pageSize);
  const end = count - at * pageSize;
  const items = snapshot.visible.slice(start, end).map((index, i) => historyItem(snapshot.entries[index]!, start + i + 1));
  return { items, page: at, totalPages };
}

/** Fetch only the requested 2 KiB / 30-line segment; nextOffset never skips hidden lines. */
export function historyChunk(item: HistoryItem, offset = 0): { lines: string[]; more: boolean; nextOffset: number; trailingNewline: boolean } {
  const at = Math.max(0, Math.min(200_000_000, Math.floor(offset) || 0));
  const { raw, more } = excerpt(item.entry, HISTORY_CHUNK_SIZE, at);
  // Limit UTF-8 bytes as well as UTF-16 code units (CJK/emoji can exceed 2 KiB).
  let end = raw.length;
  if (Buffer.byteLength(raw, "utf8") > HISTORY_CHUNK_SIZE) {
    let low = 0;
    let high = raw.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(raw.slice(0, middle), "utf8") <= HISTORY_CHUNK_SIZE) low = middle;
      else high = middle - 1;
    }
    end = low;
    if (end && /[\ud800-\udbff]/.test(raw[end - 1]!)) end--;
  }
  let linesSeen = 0;
  for (let i = 0; i < end; i++) {
    if (raw[i] === "\n" && ++linesSeen === 30) { end = i + 1; break; }
  }
  const safe = safeHistoryText(raw.slice(0, end), HISTORY_CHUNK_SIZE);
  const trailingNewline = safe.endsWith("\n");
  const lines = safe.split("\n");
  if (trailingNewline) lines.pop();
  return { lines, more: more || end < raw.length, nextOffset: at + end, trailingNewline };
}
