import assert from "node:assert/strict";
import test from "node:test";
import { registerContextDiet, trimCompletedThinking, type DietMessage } from "../src/context-diet.ts";

type Message = DietMessage & { [key: string]: unknown };
const thought = (text = "summary", signature = "opaque-provider-state") => ({ type: "thinking", thinking: text, thinkingSignature: signature });
const text = (value: string) => ({ type: "text", text: value });
const user = (value: string): Message => ({ role: "user", content: [text(value)] });
const assistant = (...content: unknown[]): Message => ({ role: "assistant", content, provider: "openai-codex", usage: { output: 42 } });
const call = (id: string) => ({ type: "toolCall", id, name: "write", arguments: { path: "file.ts", content: "const thinking = 'keep exactly';" } });
const result = (id: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "write", content: [text("Saved file.ts")], details: { receipts: [1] } });
const zero = { removedThinkingParts: 0, removedVisibleChars: 0, removedSignatureChars: 0 };

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
  assert.equal(hooks.get("context")!(event), undefined);
  assert.deepEqual(controller.stats(), zero);
  enabled = true;
  const projected = hooks.get("context")!(event);
  assert.equal(projected.messages[0], messages[0]);
  assert.deepEqual(projected.messages[1].content, [text("done")]);
  assert.equal(event.messages, messages);
  assert.equal(controller.stats().removedThinkingParts, 1);
  const snapshot = controller.stats(); snapshot.removedThinkingParts = 999;
  assert.equal(controller.stats().removedThinkingParts, 1);
  enabled = false;
  assert.equal(hooks.get("context")!(event), undefined);
  assert.deepEqual(controller.stats(), zero);
  enabled = true; hooks.get("context")!(event);
  hooks.get("session_start")!();
  assert.deepEqual(controller.stats(), zero);
});
