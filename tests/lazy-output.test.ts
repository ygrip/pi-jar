import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LAZY_OUTPUT_POLICY, LazyOutputProjector, registerLazyOutput, stubText, type SpillStore } from "../src/lazy-output.ts";

const NOW = 1_000_000_000;
const policy = { ...DEFAULT_LAZY_OUTPUT_POLICY, keepRecentTurns: 2, triggerTokens: 1000, warmMinSavedTokens: 2000, coldMinSavedTokens: 1000 };

function memorySpill(): SpillStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return { files, ensure(file, text) { if (!files.has(file)) files.set(file, text); } };
}

const result = (id: string, text: string, tool = "read") => ({ role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text }] });
const assistant = (at: number) => ({ role: "assistant", timestamp: at, content: [{ type: "text", text: "ok" }] });
const environment = (now: number, contextTokens?: number) => ({ spillDirectory: () => "/spill", now, contextTokens });

/** Four large old results, then a working set of two assistant turns. */
function conversation(at: number) {
  return [
    assistant(at), result("a", "A".repeat(8000)), assistant(at), result("b", "B".repeat(8000), "bash"),
    result("small", "tiny"), assistant(at), result("recent", "R".repeat(8000)), assistant(at)
  ];
}

test("a cold cache is swept at once, keeping the recent working set and small results", () => {
  const spill = memorySpill();
  const projector = new LazyOutputProjector(policy, spill);
  const messages = conversation(NOW - 10 * 60_000);
  const outcome = projector.project(messages, environment(NOW, 5000));
  assert.deepEqual(outcome.newlyReplaced.sort(), ["a", "b"]);
  const texts = outcome.messages!.map((message) => (message as { content?: { text?: string }[] }).content?.[0]?.text ?? "");
  assert.match(texts[1]!, /^\[Tool output removed from context[\s\S]*read, 1 lines, 8000 chars[\s\S]*Preview:\nAAAA/);
  assert.equal(texts[4], "tiny");
  assert.equal(texts[6], "R".repeat(8000), "recent results stay in full");
  assert.deepEqual([...spill.files.keys()].sort(), ["/spill/bash-b.txt", "/spill/read-a.txt"]);
  assert.equal(spill.files.get("/spill/read-a.txt"), "A".repeat(8000), "the full text is kept on disk");
  assert.ok(outcome.savedTokens > 3000);
});

test("a warm cache is left alone unless the saving is a large share of the context", () => {
  const projector = new LazyOutputProjector(policy, memorySpill());
  const messages = conversation(NOW - 1000);
  assert.equal(projector.project(messages, environment(NOW, 100_000)).messages, undefined, "a rewrite costs more than it saves");
  assert.equal(projector.replacedCount, 0);
  const heavy = projector.project(messages, environment(NOW, 5000));
  assert.deepEqual(heavy.newlyReplaced.sort(), ["a", "b"], "the same results are 80% of a small context");
});

test("nothing is swept below the trigger size", () => {
  const projector = new LazyOutputProjector(policy, memorySpill());
  assert.equal(projector.project(conversation(NOW - 10 * 60_000), environment(NOW, 500)).messages, undefined);
});

test("replacements are sticky and identical on every later call, so the prefix is stable", () => {
  const projector = new LazyOutputProjector(policy, memorySpill());
  const messages = conversation(NOW - 10 * 60_000);
  const first = projector.project(messages, environment(NOW, 5000));
  const grown = [...messages, result("later", "L".repeat(8000)), assistant(NOW)];
  const second = projector.project(grown, environment(NOW + 1000, 5000));
  assert.deepEqual(second.newlyReplaced, [], "a warm cache and no new stale results: no second rewrite");
  assert.deepEqual(second.messages!.slice(0, messages.length), first.messages);
});

test("a restored session reapplies earlier decisions and rewrites a missing spill file", () => {
  const spill = memorySpill();
  const projector = new LazyOutputProjector(policy, spill);
  projector.restore(["a"]);
  const outcome = projector.project(conversation(NOW - 1000), environment(NOW, 100_000));
  assert.equal(outcome.newlyReplaced.length, 0);
  assert.deepEqual([...spill.files.keys()], ["/spill/read-a.txt"]);
  assert.match((outcome.messages![1] as { content: { text: string }[] }).content[0]!.text, /^\[Tool output removed/);
});

test("images and failed saves keep the result in full", () => {
  const failing: SpillStore = { ensure() { throw new Error("disk full"); } };
  const projector = new LazyOutputProjector(policy, failing);
  const image = { role: "toolResult", toolCallId: "img", toolName: "read", content: [{ type: "text", text: "x".repeat(9000) }, { type: "image", data: "...", mimeType: "image/png" }] };
  const messages = [assistant(NOW - 600_000), image, result("a", "A".repeat(8000)), assistant(NOW - 600_000), assistant(NOW - 600_000)];
  const outcome = projector.project(messages, environment(NOW, 5000));
  assert.equal(outcome.messages, undefined);
  assert.equal(outcome.failures.length, 1);
  assert.match(outcome.failures[0]!, /disk full/);
});

test("the stub is deterministic and bounded", () => {
  const message = { toolName: "ctx_search", toolCallId: "x" };
  const text = "line\n".repeat(5000);
  const stub = stubText(message, text, "/spill/f.txt", 300);
  assert.equal(stub, stubText(message, text, "/spill/f.txt", 300));
  assert.ok(stub.length < 600);
  assert.match(stub, /ctx_search, 5001 lines, 25000 chars/);
});

test("the hook persists new replacements and restores them for the branch", async () => {
  const handlers = new Map<string, Function>();
  const appended: unknown[] = [];
  const pi = { on: (name: string, fn: Function) => { handlers.set(name, fn); }, appendEntry: (type: string, data: unknown) => { appended.push([type, data]); } };
  let enabled = true;
  registerLazyOutput(pi as never, { enabled: () => enabled, policy, spillRoot: "/nonexistent-root-for-test" });
  const branch: unknown[] = [{ type: "custom", customType: "pi-jar.lazy-output", data: { ids: ["a"] } }];
  const notices: string[] = [];
  const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => "s/1" }, getContextUsage: () => ({ tokens: 100_000 }), ui: { notify: (text: string) => notices.push(text) } };
  await handlers.get("session_start")!({}, ctx);
  // Writing under an unwritable root fails visibly and keeps the output in context.
  const outcome = await handlers.get("context")!({ messages: conversation(Date.now()) }, ctx);
  assert.equal(outcome, undefined);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /could not save large tool output/);
  enabled = false;
  assert.equal(await handlers.get("context")!({ messages: conversation(Date.now()) }, ctx), undefined);
  assert.deepEqual(appended, []);
});
