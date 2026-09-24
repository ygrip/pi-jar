import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createHistorySnapshot, historyChunk, historyPage, safeHistoryText } from "../src/history.ts";

const entry = (id: string, message: unknown, time?: string) => ({
  id, parentId: null, type: "message", ...(time ? { timestamp: time } : {}), message
});
const snapshot = (items: unknown[]) => createHistorySnapshot(items as SessionEntry[]);
const deepFreeze = (value: unknown): void => {
  if (!value || typeof value !== "object") return;
  for (const nested of Object.values(value)) deepFreeze(nested);
  Object.freeze(value);
};

test("timeline projects only visible active-branch entries and never mutates them", () => {
  const source = [
    entry("user", { role: "user", content: [{ type: "text", text: "hello" }, { type: "image", data: "PRIVATE" }], timestamp: 0 }, "2024-01-02T01:02:00.000Z"),
    { type: "custom_message", display: false, content: "secret" },
    entry("assistant", { role: "assistant", content: [{ type: "thinking", thinking: "SECRET REASONING" }, { type: "toolCall", name: "bash", arguments: { command: "git status" } }, { type: "text", text: "done" }], stopReason: "stop" }),
    { type: "model_change", modelId: "demo" },
    { type: "compaction", summary: "Compacted earlier turns", timestamp: "invalid" },
    { type: "branch_summary", summary: "Returned to the main branch" },
    { type: "usage", inputTokens: 5 }, // a newer Pi version's metadata must be safe to skip
    entry("tool", { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "failed" }] })
  ];
  deepFreeze(source);
  const view = snapshot(source);
  assert.deepEqual(view.visible, [0, 2, 4, 5, 7]);
  const page = historyPage(view);
  assert.deepEqual(page.items.map((item) => item.actor), ["YOU", "ASSISTANT", "COMPACT", "BRANCH", "TOOL bash"]);
  assert.equal(page.items[0]?.time, "2024-01-02 01:02Z");
  assert.equal(page.items[2]?.time, undefined);
  assert.ok(page.items[4]?.error);
  assert.match(page.items[0]!.summary, /\[image\]/);
  assert.doesNotMatch(page.items.map((item) => item.summary).join(" "), /SECRET|PRIVATE/);
  assert.match(page.items[1]!.summary, /bash.*git status/);
  assert.equal(source.length, 8);
});

test("history paging works by visible entries even with sparse metadata and empty sessions", () => {
  const source = Array.from({ length: 1200 }, (_, i) => i % 240 === 0 ? entry(String(i), { role: "user", content: `item ${i}` }) : { type: "label", label: "x" });
  const view = snapshot(source);
  assert.equal(view.visible.length, 5);
  assert.deepEqual(historyPage(view, 0, 2).items.map((item) => item.summary), ["item 720", "item 960"]);
  assert.deepEqual(historyPage(view, 1, 2).items.map((item) => item.summary), ["item 240", "item 480"]);
  assert.equal(historyPage(view, 2, 2).items[0]?.summary, "item 0");
  assert.equal(historyPage(view, 99, 2).page, 2);
  assert.deepEqual(historyPage(snapshot([])).items, []);
});

test("unsafe terminal control sequences are inert and huge tool output is fetched by small contiguous chunks", () => {
  const malicious = "\x1b]52;c;clipboard\x07\x1b]8;;https://bad\x07link\x1b]8;;\x07\x1b[31mred\x1b[0m\u202e\u200b\tline\rnext";
  assert.equal(safeHistoryText(malicious), "linkred  line\nnext");
  const output = `${Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n")}\n${"x".repeat(5_000_000)}`;
  const view = historyPage(snapshot([entry("tool", { role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: output }] })]));
  const item = view.items[0]!;
  assert.ok(item.summary.length <= 240);
  const first = historyChunk(item);
  assert.equal(first.lines.length, 30);
  assert.equal(first.lines[0], "line 0");
  assert.equal(first.lines.at(-1), "line 29");
  const second = historyChunk(item, first.nextOffset);
  assert.equal(second.lines[0], "line 30");
  assert.equal(second.lines.at(-1), "line 59");
  assert.ok(second.more);
  assert.ok(first.nextOffset < 2048);
  const unicode = historyPage(snapshot([entry("unicode", { role: "user", content: "文".repeat(3000) })])).items[0]!;
  const section = historyChunk(unicode);
  assert.ok(Buffer.byteLength(section.lines.join("\n"), "utf8") <= 2048);
  assert.ok(section.more);
  assert.ok(section.nextOffset < 2048);
});

test("output chunks cover every UTF-16 position without duplicates across ASCII, CJK and emoji boundaries", () => {
  for (const original of ["abc\n".repeat(1800), "文".repeat(2100), "a".repeat(2046) + "🙂".repeat(800) + "end"]) {
    const item = historyPage(snapshot([entry("content", { role: "user", content: original })])).items[0]!;
    let offset = 0;
    let reconstructed = "";
    for (let i = 0; i < 100 && offset < original.length; i++) {
      const part = historyChunk(item, offset);
      assert.ok(part.nextOffset > offset, `no progress at ${offset}`);
      assert.ok(Buffer.byteLength(original.slice(offset, part.nextOffset), "utf8") <= 2048);
      reconstructed += part.lines.join("\n") + (part.trailingNewline ? "\n" : "");
      offset = part.nextOffset;
      assert.equal(part.more, offset < original.length);
    }
    assert.equal(offset, original.length);
    assert.equal(reconstructed, original);
  }
});

test("malformed messages, absent timestamps, user strings and assistant failures remain safe", () => {
  const view = historyPage(snapshot([
    entry("bad", { role: "user", content: null }),
    entry("text", { role: "user", content: "hello world", timestamp: 1712200000000 }),
    entry("failure", { role: "assistant", content: [], stopReason: "aborted", errorMessage: "cancelled" }),
    entry("bad-role", null)
  ]));
  assert.equal(view.items.length, 3);
  assert.equal(view.items[0]?.summary, "[empty]");
  assert.equal(view.items[0]?.time, undefined);
  assert.match(view.items[1]!.summary, /hello world/);
  assert.ok(view.items[1]?.time?.endsWith("Z"));
  assert.equal(view.items[2]?.error, true);
  assert.match(view.items[2]!.summary, /aborted.*cancelled/);
});
