import assert from "node:assert/strict";
import test from "node:test";
import { registerContextDiet, stubSupersededReads, trimCompletedThinking, type DietMessage } from "../src/context-diet.ts";

type Message = DietMessage & { [key: string]: unknown };
const thought = (text = "summary", signature = "opaque-provider-state") => ({ type: "thinking", thinking: text, thinkingSignature: signature });
const text = (value: string) => ({ type: "text", text: value });
const user = (value: string): Message => ({ role: "user", content: [text(value)] });
const assistant = (...content: unknown[]): Message => ({ role: "assistant", content, provider: "openai-codex", usage: { output: 42 } });
const call = (id: string) => ({ type: "toolCall", id, name: "write", arguments: { path: "file.ts", content: "const thinking = 'keep exactly';" } });
const result = (id: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "write", content: [text("Saved file.ts")], details: { receipts: [1] } });
const zero = { removedThinkingParts: 0, removedVisibleChars: 0, removedSignatureChars: 0 };
const none = { ...zero, stubbedReads: 0, stubbedReadChars: 0 };
const cwd = "/repo";
const readCall = (id: string, path: string, window: object = {}) => ({ type: "toolCall", id, name: "read", arguments: { path, ...window } });
const fileCall = (id: string, name: "edit" | "write", path: string) => ({ type: "toolCall", id, name, arguments: { path } });
const readResult = (id: string, body = "x".repeat(400), extra: object = {}): Message =>
  ({ role: "toolResult", toolCallId: id, toolName: "read", content: [text(body)], isError: false, ...extra });
const fileResult = (id: string, name: "edit" | "write", isError = false): Message =>
  ({ role: "toolResult", toolCallId: id, toolName: name, content: [text(isError ? "Could not edit" : "ok")], isError });

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test("only completed prior-user-turn thinking is projected away without mutating persisted messages", () => {
  const write = call("write-1");
  const old = assistant(thought(), write);
  const current = assistant(thought("current", "CURRENT SIGNED STATE"), call("write-2"));
  const messages = freeze([user("old task"), old, result("write-1"), assistant(thought("done", "old-final"), text("Done")), user("new task"), current]);
  const before = JSON.stringify(messages);
  const diet = trimCompletedThinking(messages);
  assert.notEqual(diet.messages, messages);
  assert.deepEqual(diet.stats, { removedThinkingParts: 2, removedVisibleChars: 11, removedSignatureChars: 30 });
  assert.equal(JSON.stringify(messages), before);
  assert.deepEqual(diet.messages[1]!.content, [write]);
  assert.equal((diet.messages[1]!.content as unknown[])[0], write, "tool call arguments and IDs retain identity");
  assert.equal(diet.messages[2], messages[2], "tool output and receipts retain identity");
  assert.equal(diet.messages[4], messages[4]);
  assert.equal(diet.messages[5], current, "complete current signed chain retains identity");
  assert.equal(diet.messages[1]!.usage, old.usage, "historic accounting metadata is not rewritten");
  const again = trimCompletedThinking(diet.messages);
  assert.equal(again.messages, diet.messages);
  assert.deepEqual(again.stats, zero);
});

test("no user boundary or only a current user turn returns the original messages", () => {
  for (const messages of [[], [assistant(thought(), text("hello"))], [assistant(thought(), text("before first known user")), user("current")], [user("current"), assistant(thought(), text("hello"))]]) {
    const diet = trimCompletedThinking(messages);
    assert.equal(diet.messages, messages);
    assert.deepEqual(diet.stats, zero);
  }
});

test("thinking-only prior assistant rows remain intact instead of becoming invalid empty messages", () => {
  const messages = [user("old"), assistant(thought()), user("new")];
  const diet = trimCompletedThinking(messages);
  assert.equal(diet.messages, messages);
  assert.deepEqual(diet.stats, zero);
});

test("boundary-crossing or unresolved old calls preserve the entire originating reasoning chain", () => {
  for (const suffix of [[], [result("old-call")]]) {
    const messages = [user("old"), assistant(thought(), call("old-call")), user("new"), ...suffix];
    const diet = trimCompletedThinking(messages);
    assert.equal(diet.messages, messages);
    assert.deepEqual(diet.stats, zero);
  }
});

test("ambiguous historical tool sequences fail closed", () => {
  const eligible = [user("old"), assistant(thought(), text("done"))];
  const malformed: Message[][] = [
    [assistant(thought(), { type: "toolCall", name: "read" })],
    [assistant(call("same"), call("same")), result("same")],
    [assistant(call("same")), result("same"), result("same")],
    [result("same"), assistant(call("same"))],
    [result("detached")],
    [{ role: "toolResult", content: [text("missing id")] }]
  ];
  for (const sequence of malformed) {
    const messages = [...eligible, ...sequence, user("new")];
    assert.equal(trimCompletedThinking(messages).messages, messages);
  }
});

test("user images, compaction summaries and essential custom state are not removed or rewritten", () => {
  const summary: Message = { role: "compactionSummary", summary: "Keep the user requirements", content: "important" };
  const state: Message = { role: "custom", customType: "pi-jar.goal-context", content: [text("goal + plan + tasks")] };
  const image = { type: "image", data: "base64", mimeType: "image/png" };
  const oldUser: Message = { role: "user", content: [text("request"), image] };
  const messages = [summary, oldUser, state, assistant(thought(), text("answer")), user("next")];
  const diet = trimCompletedThinking(messages);
  for (const index of [0, 1, 2, 4]) assert.equal(diet.messages[index], messages[index]);
  assert.equal((diet.messages[1]!.content as unknown[])[1], image);
  assert.equal(diet.stats.removedThinkingParts, 1);
});

test("unknown parts and text resembling thinking metadata survive unchanged", () => {
  const unknown = { type: "futureProviderPart", thinkingSignature: "do not touch" };
  const literal = text('{"type":"thinking","thinkingSignature":"user-visible source"}');
  const messages = [user("old"), assistant(thought(), unknown, literal), user("new")];
  assert.deepEqual(trimCompletedThinking(messages).messages[1]!.content, [unknown, literal]);
});

test("signature diagnostics do not parse, estimate tokens, or expose ciphertext", () => {
  const signature = "not valid JSON: " + "x".repeat(10000);
  const messages = [user("old"), assistant(thought("short", signature), text("answer")), user("new")];
  const diet = trimCompletedThinking(messages);
  assert.equal(diet.stats.removedSignatureChars, signature.length);
  assert.equal(diet.stats.removedVisibleChars, 5);
  assert.doesNotMatch(JSON.stringify(diet.stats), /not valid JSON|xxxx/);
  assert.equal("tokens" in diet.stats, false);
});

test("context registration is opt-in, returns fresh diagnostic snapshots, and resets on sessions", () => {
  const hooks = new Map<string, Function>();
  let enabled = false;
  const controller = registerContextDiet({ on: (name: string, fn: Function) => hooks.set(name, fn) } as never, () => enabled);
  const messages = [user("old"), assistant(thought(), text("done")), user("new")];
  const event = { messages };
  const ctx = { cwd };
  assert.equal(hooks.get("context")!(event, ctx), undefined);
  assert.deepEqual(controller.stats(), none);
  enabled = true;
  const projected = hooks.get("context")!(event, ctx);
  assert.equal(projected.messages[0], messages[0]);
  assert.deepEqual(projected.messages[1].content, [text("done")]);
  assert.equal(event.messages, messages);
  assert.equal(controller.stats().removedThinkingParts, 1);
  const snapshot = controller.stats(); snapshot.removedThinkingParts = 999;
  assert.equal(controller.stats().removedThinkingParts, 1);
  enabled = false;
  assert.equal(hooks.get("context")!(event, ctx), undefined);
  assert.deepEqual(controller.stats(), none);
  enabled = true; hooks.get("context")!(event, ctx);
  hooks.get("session_start")!();
  assert.deepEqual(controller.stats(), none);
});

test("reads superseded within a completed turn become stubs; ids, order and later turns stay intact", () => {
  const messages = freeze([
    user("old"),
    assistant(readCall("r1", "src/a.ts")), readResult("r1"),
    assistant(readCall("r2", "./src/a.ts")), readResult("r2"),
    assistant(readCall("r3", "src/a.ts", { offset: 50 })), readResult("r3"),
    assistant(fileCall("e1", "edit", "/repo/src/a.ts")), fileResult("e1", "edit"),
    assistant(readCall("r4", "src/b.ts")), readResult("r4"),
    assistant(readCall("r5", "src/c.ts")), readResult("r5"),
    assistant(readCall("r6", "src/c.ts", { offset: 2 })), readResult("r6"),
    assistant(text("done")),
    user("next"),
    assistant(readCall("r7", "src/b.ts")), readResult("r7"),
    assistant(readCall("r8", "src/b.ts")), readResult("r8"),
    assistant(text("done")),
    user("now"),
    assistant(readCall("r9", "src/b.ts")), readResult("r9"),
    assistant(readCall("r10", "src/b.ts")), readResult("r10")
  ]);
  const before = JSON.stringify(messages);
  const diet = stubSupersededReads(messages, cwd);
  // r4 is superseded only in a later turn and r8 only in the current one, which is never touched: a
  // completed turn is projected once, so earlier prompt prefixes stay cached.
  const stubs = new Map([
    [2, "[superseded by a later read of src/a.ts]"],
    [4, "[superseded by a later edit of ./src/a.ts]"],
    [6, "[superseded by a later edit of src/a.ts]"],
    [18, "[superseded by a later read of src/b.ts]"]
  ]);
  assert.equal(JSON.stringify(messages), before, "stored history is not mutated");
  assert.equal(diet.messages.length, messages.length);
  assert.deepEqual(diet.stats, { stubbedReads: 4, stubbedReadChars: 1600 });
  diet.messages.forEach((message, index) => {
    const stub = stubs.get(index);
    if (stub === undefined) return assert.equal(message, messages[index], `message ${index} retains identity`);
    const { content, ...rest } = message;
    const { content: _original, ...pairing } = messages[index]!;
    assert.deepEqual(rest, pairing, "role, toolCallId, toolName and isError are kept");
    assert.deepEqual(content, [text(stub)]);
  });
  assert.equal(stubSupersededReads(diet.messages, cwd).messages, diet.messages, "the projection is stable");
});

test("read-cache stubs, errors, images, failed and same-message operations never supersede a read", () => {
  const image = { type: "image", data: "base64", mimeType: "image/png" };
  const messages = [
    user("old"),
    assistant(readCall("a1", "a.ts")), readResult("a1"),
    assistant(readCall("a2", "a.ts")), readResult("a2", "[unchanged since read #1 (3 lines); pass force: true to re-read]", { details: { unchangedSinceRead: 1 } }),
    assistant(readCall("a3", "a.ts")), readResult("a3", "ENOENT", { isError: true }),
    assistant(fileCall("a4", "edit", "a.ts")), fileResult("a4", "edit", true),
    assistant(readCall("b1", "b.ts"), fileCall("b2", "write", "b.ts")), readResult("b1"), fileResult("b2", "write"),
    assistant(readCall("c1", "c.png")), readResult("c1", "Read image file [image/png]", { content: [text("Read image file [image/png]"), image] }),
    assistant(readCall("c2", "c.png")), readResult("c2"),
    assistant(readCall("d1", "d.ts")), readResult("d1", "tiny"),
    assistant(readCall("d2", "d.ts")), readResult("d2"),
    user("new")
  ];
  const diet = stubSupersededReads(messages, cwd);
  assert.equal(diet.messages, messages);
  assert.deepEqual(diet.stats, { stubbedReads: 0, stubbedReadChars: 0 });
});

test("superseded-read stubs fail closed on ambiguous tool sequences", () => {
  const superseded = [user("old"), assistant(readCall("r1", "a.ts")), readResult("r1"), assistant(readCall("r2", "a.ts")), readResult("r2")];
  assert.equal(stubSupersededReads([...superseded, user("new")], cwd).stats.stubbedReads, 1);
  for (const tail of [[result("detached")], [assistant(call("same")), result("same"), result("same")], [assistant(call("open"))]]) {
    const messages = [...superseded, ...tail, user("new")];
    assert.equal(stubSupersededReads(messages, cwd).messages, messages);
  }
});

test("the registered diet also stubs superseded reads, resolving paths against the session cwd", () => {
  const hooks = new Map<string, Function>();
  const controller = registerContextDiet({ on: (name: string, fn: Function) => hooks.set(name, fn) } as never, () => true);
  const messages = [user("old"), assistant(thought(), readCall("r1", "src/a.ts")), readResult("r1"),
    assistant(readCall("r2", "/repo/src/a.ts")), readResult("r2"), user("new")];
  const projected = hooks.get("context")!({ messages }, { cwd });
  assert.deepEqual(projected.messages[1].content, [readCall("r1", "src/a.ts")]);
  assert.deepEqual(projected.messages[2].content, [text("[superseded by a later read of src/a.ts]")]);
  assert.deepEqual(controller.stats(), { removedThinkingParts: 1, removedVisibleChars: 7, removedSignatureChars: 21, stubbedReads: 1, stubbedReadChars: 400 });
  const elsewhere = hooks.get("context")!({ messages }, { cwd: "/elsewhere" });
  assert.equal(elsewhere.messages[2], messages[2], "relative and absolute paths match only under the session cwd");
});
