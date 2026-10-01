import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import {
  createDiscussionPaper,
  discussionEntries,
  disposeDiscussionPaper,
  MAX_DISCUSSION_ENTRIES,
  MAX_DISCUSSION_TEXT,
  MAX_LIST_CHARS,
  registerDiscussionTool
} from "../src/discussion.ts";

interface Tool {
  name: string;
  execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; details?: unknown; isError?: boolean }>;
}

const register = (file: () => string | undefined, actor: string): Tool => {
  let tool: Tool | undefined;
  registerDiscussionTool({ registerTool(definition: Tool) { tool = definition; } } as never, file, () => actor);
  return tool!;
};
const say = async (tool: Tool, params: Record<string, unknown>) => (await tool.execute("x", params)).content[0]!.text;

test("discussion paper keeps structured bounded questions and answers", async () => {
  const file = createDiscussionPaper();
  try {
    const tool = register(() => file, "scout-a");
    assert.equal(tool.name, "jar_discuss");
    await tool.execute("1", { action: "ask", text: "Where is auth?", to: "worker-b" });
    await tool.execute("2", { action: "answer", questionId: "d1", text: "middleware.ts" });
    const listed = await say(tool, { action: "list", since: "d0" });
    assert.match(listed, /\[d1\] Q · scout-a → worker-b: Where is auth\?/);
    assert.match(listed, /\[d2\] A · scout-a → d1: middleware\.ts/);
    assert.deepEqual(discussionEntries(file).map((entry) => entry.kind), ["question", "answer"]);

    for (let i = 0; i < MAX_DISCUSSION_ENTRIES + 8; i++) {
      await tool.execute("x" + i, { action: "ask", text: "x".repeat(MAX_DISCUSSION_TEXT + 200) });
    }
    const entries = discussionEntries(file);
    assert.ok(entries.length > 0 && entries.length <= MAX_DISCUSSION_ENTRIES);
    assert.ok(entries.every((entry) => entry.text.length <= MAX_DISCUSSION_TEXT));
    assert.ok(Buffer.byteLength(readFileSync(file)) <= 64 * 1024);
  } finally {
    disposeDiscussionPaper(file);
    assert.equal(existsSync(file), false);
  }
});

test("ask and answer replies name the new id without echoing the text", async () => {
  const file = createDiscussionPaper();
  try {
    const tool = register(() => file, "scout-a");
    assert.equal(await say(tool, { action: "ask", text: "Where is auth handled?", to: "worker-b" }), "Added d1 (→ worker-b).");
    assert.equal(await say(tool, { action: "ask", text: "Anyone own the cache?" }), "Added d2.");
    assert.equal(await say(tool, { action: "answer", questionId: "d1", text: "middleware.ts line 40" }), "Answered d1 as d3.");
  } finally { disposeDiscussionPaper(file); }
});

test("default list shows only unseen entries by others; since d0 rereads everything", async () => {
  const file = createDiscussionPaper();
  try {
    const scout = register(() => file, "scout");
    const worker = register(() => file, "worker");
    await scout.execute("1", { action: "ask", text: "scout question" });
    await worker.execute("2", { action: "ask", text: "worker question" });

    const first = await say(scout, { action: "list" });
    assert.match(first, /\[d2\] Q · worker: worker question/);
    assert.doesNotMatch(first, /scout question/, "own entries are not listed back");
    assert.equal(await say(scout, { action: "list" }), "No new entries (latest d2).");

    await worker.execute("3", { action: "answer", questionId: "d1", text: "worker answer" });
    const next = await say(scout, { action: "list" });
    assert.match(next, /\[d3\] A · worker → d1: worker answer/);
    assert.doesNotMatch(next, /\[d2\]/);

    const all = await say(scout, { action: "list", since: "d0" });
    for (const id of ["d1", "d2", "d3"]) assert.match(all, new RegExp(`\\[${id}\\]`));
    assert.equal(await say(scout, { action: "list" }), "No new entries (latest d3).");
  } finally { disposeDiscussionPaper(file); }
});

test("answers to my questions are piggybacked on my next ask or answer and not listed again", async () => {
  const file = createDiscussionPaper();
  try {
    const scout = register(() => file, "scout");
    const worker = register(() => file, "worker");
    await scout.execute("1", { action: "ask", text: "Where is auth?", to: "worker" });
    assert.equal(await say(worker, { action: "answer", questionId: "d1", text: "middleware.ts" }), "Answered d1 as d2.");
    assert.equal(await say(worker, { action: "list" }), "No new entries (latest d2).", "answering does not re-list the question");

    assert.equal(await say(scout, { action: "ask", text: "Which tests cover it?", to: "worker" }),
      "Added d3 (→ worker).\n[d2] A · worker → d1: middleware.ts");
    assert.equal(await say(scout, { action: "list" }), "No new entries (latest d3).");
    assert.equal(await say(worker, { action: "answer", questionId: "d1", text: "also session.ts" }),
      "Answered d1 as d4.\n[d3] Q · scout → worker: Which tests cover it?", "questions addressed to me are piggybacked too");
  } finally { disposeDiscussionPaper(file); }
});

test("piggyback falls back to a count when unrelated entries are unseen and leaves them for list", async () => {
  const file = createDiscussionPaper();
  try {
    const scout = register(() => file, "scout");
    const worker = register(() => file, "worker");
    await scout.execute("1", { action: "ask", text: "Where is auth?" });
    await worker.execute("2", { action: "answer", questionId: "d1", text: "middleware.ts" });
    await worker.execute("3", { action: "ask", text: "Unrelated broadcast" });
    assert.equal(await say(scout, { action: "ask", text: "Next question" }), "Added d4.\n(2 new entries, 1 for you; list to read)");
    const listed = await say(scout, { action: "list" });
    assert.match(listed, /\[d2\] A · worker → d1: middleware\.ts/);
    assert.match(listed, /\[d3\] Q · worker: Unrelated broadcast/);
  } finally { disposeDiscussionPaper(file); }
});

test("the read cursor resets when the paper path changes", async () => {
  const first = createDiscussionPaper();
  const second = createDiscussionPaper();
  try {
    let path = first;
    const scout = register(() => path, "scout");
    await register(() => first, "worker").execute("1", { action: "ask", text: "first paper question" });
    await register(() => second, "worker").execute("2", { action: "ask", text: "second paper question" });
    assert.match(await say(scout, { action: "list" }), /\[d1\] Q · worker: first paper question/);
    assert.equal(await say(scout, { action: "list" }), "No new entries (latest d1).");
    path = second;
    assert.match(await say(scout, { action: "list" }), /\[d1\] Q · worker: second paper question/);
  } finally { disposeDiscussionPaper(first); disposeDiscussionPaper(second); }
});

test("discussion UTF-8 cap holds after every multibyte append and preserves newest entries", async () => {
  const file = createDiscussionPaper();
  try {
    const tool = register(() => file, "worker");
    for (let i = 0; i < MAX_DISCUSSION_ENTRIES + 8; i++) {
      await tool.execute("x" + i, { action: "ask", text: "界".repeat(MAX_DISCUSSION_TEXT) });
      assert.ok(Buffer.byteLength(readFileSync(file)) <= 64 * 1024, "paper exceeds actual UTF-8 byte cap at append " + i);
    }
    const entries = discussionEntries(file);
    assert.ok(entries.length > 0 && entries.length < 32, "even 32 multibyte entries exceed the byte cap");
    assert.equal(entries.at(-1)?.id, "d" + (MAX_DISCUSSION_ENTRIES + 8));
    assert.ok(entries.every((entry) => entry.text === "界".repeat(MAX_DISCUSSION_TEXT)));
  } finally { disposeDiscussionPaper(file); }
});

test("discussion answers require a known question id", async () => {
  const file = createDiscussionPaper();
  try {
    const result = await register(() => file, "reviewer").execute("1", { action: "answer", questionId: "missing", text: "nope" });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /Unknown discussion question/);
  } finally { disposeDiscussionPaper(file); }
});

test("list replies stay bounded, reread only newer entries, and read one thread in full", async () => {
  const file = createDiscussionPaper();
  try {
    const worker = register(() => file, "worker");
    const reader = register(() => file, "reader");
    for (let i = 0; i < 20; i++) await worker.execute("q" + i, { action: "ask", text: `question ${i} ` + "x".repeat(MAX_DISCUSSION_TEXT) });
    const listed = await say(reader, { action: "list" });
    assert.ok(listed.length <= MAX_LIST_CHARS + 200, "the reply budget holds however large the paper is");
    assert.match(listed, /older entries omitted/);
    assert.match(listed, /\[d20\] Q/, "the newest entries are kept");
    assert.doesNotMatch(listed, /x{500}/, "listed entries are clipped");

    assert.match(await say(reader, { action: "list", since: "d20" }), /No entries newer than d20/);
    await worker.execute("a", { action: "answer", questionId: "d3", text: "answer for three" });
    const thread = await say(reader, { action: "list", questionId: "d3" });
    assert.match(thread, new RegExp(`\\[d3\\] Q · worker: question 2 x{${MAX_DISCUSSION_TEXT - 11}}`), "a thread reads its question in full");
    assert.match(thread, /\[d21\] A/);
    assert.doesNotMatch(thread, /\[d4\]/);

    const newer = await say(reader, { action: "list" });
    assert.match(newer, /\[d21\] A · worker → d3: answer for three/, "a thread read does not move the cursor");
    assert.doesNotMatch(newer, /\[d20\]/);
  } finally { disposeDiscussionPaper(file); }
});
