import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import {
  createDiscussionPaper,
  discussionEntries,
  disposeDiscussionPaper,
  MAX_DISCUSSION_ENTRIES,
  MAX_DISCUSSION_TEXT,
  registerDiscussionTool
} from "../src/discussion.ts";

interface Tool {
  name: string;
  execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; details?: unknown; isError?: boolean }>;
}

test("discussion paper keeps structured bounded questions and answers", async () => {
  const file = createDiscussionPaper();
  let tool: Tool | undefined;
  try {
    registerDiscussionTool({ registerTool(definition: Tool) { tool = definition; } } as never, () => file, () => "scout-a");
    assert.equal(tool!.name, "jar_discuss");
    const asked = await tool!.execute("1", { action: "ask", text: "Where is auth?", to: "worker-b" });
    assert.match(asked.content[0]!.text, /Added d1/);
    const answered = await tool!.execute("2", { action: "answer", questionId: "d1", text: "middleware.ts" });
    assert.match(answered.content[0]!.text, /Answered d1/);
    const listed = await tool!.execute("3", { action: "list" });
    assert.match(listed.content[0]!.text, /\[d1\] Q · scout-a → worker-b: Where is auth\?/);
    assert.match(listed.content[0]!.text, /\[d2\] A · scout-a → d1: middleware\.ts/);
    assert.deepEqual(discussionEntries(file).map((entry) => entry.kind), ["question", "answer"]);

    for (let i = 0; i < MAX_DISCUSSION_ENTRIES + 8; i++) {
      await tool!.execute("x" + i, { action: "ask", text: "x".repeat(MAX_DISCUSSION_TEXT + 200) });
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

test("discussion UTF-8 cap holds after every multibyte append and preserves newest entries", async () => {
  const file = createDiscussionPaper();
  let tool: Tool | undefined;
  try {
    registerDiscussionTool({ registerTool(definition: Tool) { tool = definition; } } as never, () => file, () => "worker");
    for (let i = 0; i < MAX_DISCUSSION_ENTRIES + 8; i++) {
      await tool!.execute("x" + i, { action: "ask", text: "界".repeat(MAX_DISCUSSION_TEXT) });
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
  let tool: Tool | undefined;
  try {
    registerDiscussionTool({ registerTool(definition: Tool) { tool = definition; } } as never, () => file, () => "reviewer");
    const result = await tool!.execute("1", { action: "answer", questionId: "missing", text: "nope" });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /Unknown discussion question/);
  } finally { disposeDiscussionPaper(file); }
});
