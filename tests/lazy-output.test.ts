import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeSync } from "node:fs";

const writeFromDescriptor = (descriptor: number, bytes: Buffer) => writeSync(descriptor, bytes);
import { createDiskSpill, DEFAULT_LAZY_OUTPUT_POLICY, diskSpill, writeFully, LazyOutputProjector, pruneSpill, registerLazyOutput, stubText, type ProjectionEnvironment, type SpillStore } from "../src/lazy-output.ts";

const NOW = 1_000_000_000_000;
const MINUTE = 60_000;
const policy = { ...DEFAULT_LAZY_OUTPUT_POLICY, keepRecentTurns: 2, triggerTokens: 1000, coldMinSavedTokens: 1000, warmMinSavedTokens: 2000, warmCooldownCalls: 3 };

function memorySpill(): SpillStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return { files, ensure(file, text) { files.set(file, text); } };
}

const result = (id: string, text: string, tool = "read") => ({ role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text }] });
/** Only the cold-cache gate can fire: the warm break-even path is switched off. */
const coldOnly = { ...policy, warmMinSavedTokens: Number.POSITIVE_INFINITY };
const WARM = { input: 500, cacheRead: 90_000, cacheWrite: 0 };
const assistant = (at: number, usage: object = WARM) => ({ role: "assistant", timestamp: at, usage, content: [{ type: "text", text: "ok" }] });
const environment = (now: number, contextTokens?: number, sweep = true, directory = "/spill", lastWarmAt?: number): ProjectionEnvironment => ({ spillDirectory: () => directory, now, contextTokens, sweep, lastWarmAt });
const textOf = (message: unknown) => (message as { content?: { text?: string }[] }).content?.[0]?.text ?? "";

/** Two large old results, a small one, then a working set of two assistant turns. */
function conversation(at: number, usage: object = WARM) {
  return [
    assistant(at, usage), result("a", "A".repeat(8000)), assistant(at, usage), result("b", "B".repeat(8000), "bash"),
    result("small", "tiny"), assistant(at, usage), result("recent", "R".repeat(8000)), assistant(at, usage)
  ];
}

test("a cache idle for over an hour is swept at once, keeping the recent working set and small results", () => {
  const spill = memorySpill();
  const projector = new LazyOutputProjector(policy, spill);
  const outcome = projector.project(conversation(NOW - 70 * MINUTE), environment(NOW, 5000));
  assert.deepEqual(outcome.newlyReplaced.sort(), ["a", "b"]);
  const texts = outcome.messages!.map(textOf);
  assert.match(texts[1]!, /^\[Tool output removed from context[\s\S]*read, 1 lines, 8000 chars[\s\S]*Preview:\nAAAA/);
  assert.equal(texts[4], "tiny");
  assert.equal(texts[6], "R".repeat(8000), "recent results stay in full");
  assert.equal([...spill.files.keys()].length, 2);
  assert.deepEqual([...spill.files.values()].sort(), ["A".repeat(8000), "B".repeat(8000)], "the full text is kept on disk");
  assert.ok(outcome.savedTokens > 3000);
});

test("a short idle gap with cache reads is warm: no sweep, however small the context", () => {
  const projector = new LazyOutputProjector(coldOnly, memorySpill());
  for (const idle of [1, 10, 30, 64]) {
    const outcome = projector.project(conversation(NOW - idle * MINUTE), environment(NOW, 5000));
    assert.equal(outcome.messages, undefined, `idle ${idle}m`);
  }
  assert.equal(projector.replacedCount, 0);
});

test("two recent large prompts that read nothing from the cache prove it is not working: sweep", () => {
  const dead = { input: 90_000, cacheRead: 0, cacheWrite: 0 };
  const projector = new LazyOutputProjector(coldOnly, memorySpill());
  assert.deepEqual(projector.project(conversation(NOW - MINUTE, dead), environment(NOW, 5000)).newlyReplaced.sort(), ["a", "b"]);
  const oneMiss = conversation(NOW - MINUTE);
  oneMiss[2] = assistant(NOW - MINUTE, dead);
  assert.equal(new LazyOutputProjector(coldOnly, memorySpill()).project(oneMiss, environment(NOW, 5000)).messages, undefined, "one miss is not evidence");
});

test("a recent keep-warm request keeps an idle cache warm; a stale one does not", () => {
  const idle = conversation(NOW - 120 * MINUTE);
  assert.equal(new LazyOutputProjector(coldOnly, memorySpill()).project(idle, environment(NOW, 5000, true, "/spill", NOW - 5 * MINUTE)).messages, undefined);
  assert.equal(new LazyOutputProjector(coldOnly, memorySpill()).project(idle, environment(NOW, 5000, true, "/spill", NOW - 80 * MINUTE)).newlyReplaced.length, 2);
});

test("a warm partial success is judged again on what reached the disk", () => {
  const big = (id: string, ch: string) => result(id, ch.repeat(50_000));
  // Two results save ~24k tokens together (passes the 2k floor and the horizon); only one is written.
  const messages = [assistant(NOW), big("one", "1"), big("two", "2"), assistant(NOW), assistant(NOW)];
  let writes = 0;
  const flaky: SpillStore = { ensure() { writes++; if (writes === 2) throw new Error("ENOSPC"); } };
  const strict = { ...policy, warmMinSavedTokens: 20_000 };
  const outcome = new LazyOutputProjector(strict, flaky).project(messages, environment(NOW, 80_000));
  assert.deepEqual(outcome.newlyReplaced, [], "one 12k-token saving no longer clears the 20k floor");
  assert.equal(outcome.messages, undefined, "nothing is rewritten");
  assert.equal(outcome.failures.length, 1);

  const relaxed = { ...policy, warmMinSavedTokens: 5_000 };
  writes = 0;
  const kept = new LazyOutputProjector(relaxed, flaky).project(messages, environment(NOW, 80_000));
  assert.deepEqual(kept.newlyReplaced, ["one"], "a subset that still pays is committed on its own");
});

test("a budget that stops a sweep halfway leaves no replacement when the remainder is not worth it", () => {
  const messages = [assistant(NOW), result("one", "1".repeat(50_000)), result("two", "2".repeat(50_000)), assistant(NOW), assistant(NOW)];
  const capped = { ...policy, warmMinSavedTokens: 20_000, maxSessionBytes: 60_000 };
  const outcome = new LazyOutputProjector(capped, memorySpill()).project(messages, environment(NOW, 80_000));
  assert.deepEqual(outcome.newlyReplaced, []);
  assert.match(outcome.failures[0]!, /session spill limit/);
});

test("nothing is swept below the trigger size", () => {
  const projector = new LazyOutputProjector(policy, memorySpill());
  assert.equal(projector.project(conversation(NOW - 90 * MINUTE), environment(NOW, 500)).messages, undefined);
});

test("a warm sweep must pay back its measured rewrite within the horizon", () => {
  const tail = [assistant(NOW), result("big", "X".repeat(80_000)), assistant(NOW), assistant(NOW)];
  const cheap = new LazyOutputProjector(policy, memorySpill());
  assert.deepEqual(cheap.project(tail, environment(NOW, 80_000)).newlyReplaced, ["big"], "a late result: rewriting little, saving much");

  // The same result with a long suffix behind it would rewrite far more than it saves.
  const long = [assistant(NOW), result("big", "X".repeat(80_000)), assistant(NOW), ...Array.from({ length: 6 }, () => ({ role: "user", content: "u".repeat(80_000) })), assistant(NOW), assistant(NOW)];
  const costly = new LazyOutputProjector(policy, memorySpill());
  assert.equal(costly.project(long, environment(NOW, 200_000)).messages, undefined);
});

test("warm sweeps cool down so ageing outputs cannot cause a rewrite loop", () => {
  const projector = new LazyOutputProjector(policy, memorySpill());
  const first = [assistant(NOW), result("one", "X".repeat(80_000)), assistant(NOW), assistant(NOW)];
  assert.deepEqual(projector.project(first, environment(NOW, 80_000)).newlyReplaced, ["one"]);
  const second = [...first, result("two", "Y".repeat(80_000)), assistant(NOW), assistant(NOW)];
  assert.deepEqual(projector.project(second, environment(NOW, 80_000)).newlyReplaced, [], "inside the cooldown");
  projector.project(second, environment(NOW, 80_000));
  assert.deepEqual(projector.project(second, environment(NOW, 80_000)).newlyReplaced, ["two"], "after the cooldown");
});

test("a failed save is never recorded as a replacement and the result stays in full", () => {
  let failing = true;
  const flaky: SpillStore = { ensure() { if (failing) throw new Error("disk full"); } };
  const projector = new LazyOutputProjector(policy, flaky);
  const messages = conversation(NOW - 90 * MINUTE);
  const outcome = projector.project(messages, environment(NOW, 5000));
  assert.deepEqual(outcome.newlyReplaced, [], "nothing is persisted for an unverified spill");
  assert.equal(outcome.messages, undefined);
  assert.equal(outcome.failures.length, 2);
  assert.match(outcome.failures[0]!, /disk full/);
  assert.equal(projector.replacedCount, 0);
  failing = false;
  const retried = projector.project(messages, environment(NOW, 5000));
  assert.deepEqual(retried.newlyReplaced, [], "a result that failed once is not retried, so history cannot change later by surprise");
  assert.equal(retried.failures.length, 0);
});

test("replacements are sticky and identical on every later call, so the prefix is stable", () => {
  const projector = new LazyOutputProjector(policy, memorySpill());
  const messages = conversation(NOW - 90 * MINUTE);
  const first = projector.project(messages, environment(NOW, 5000));
  const grown = [...messages, result("later", "L".repeat(8000)), assistant(NOW)];
  const second = projector.project(grown, environment(NOW + 1000, 5000));
  assert.deepEqual(second.newlyReplaced, [], "a warm cache and no new stale results: no second rewrite");
  assert.deepEqual(second.messages!.slice(0, messages.length), first.messages);
});

test("turning the feature off keeps earlier stubs, so on → off → on never rewrites the prefix", () => {
  const projector = new LazyOutputProjector(policy, memorySpill());
  const messages = conversation(NOW - 90 * MINUTE);
  const on = projector.project(messages, environment(NOW, 5000)).messages;
  const off = projector.project(messages, environment(NOW + 1, 5000, false)).messages;
  const again = projector.project(messages, environment(NOW + 2, 5000)).messages;
  assert.deepEqual(off, on);
  assert.deepEqual(again, on);
  const fresh = new LazyOutputProjector(policy, memorySpill());
  assert.equal(fresh.project(messages, environment(NOW, 5000, false)).messages, undefined, "off from the start sweeps nothing");
});

test("a restored session reapplies earlier decisions, rewrites a missing copy, and degrades honestly when it cannot", () => {
  const spill = memorySpill();
  const projector = new LazyOutputProjector(policy, spill);
  projector.restore(["a"]);
  const outcome = projector.project(conversation(NOW - MINUTE), environment(NOW, 100_000));
  assert.equal(outcome.newlyReplaced.length, 0);
  assert.equal(spill.files.size, 1);
  assert.match(textOf(outcome.messages![1]), /^\[Tool output removed/);

  const lost = new LazyOutputProjector(policy, { ensure() { throw new Error("read-only"); } });
  lost.restore(["a"]);
  assert.match(textOf(lost.project(conversation(NOW - MINUTE), environment(NOW, 100_000)).messages![1]), /saved copy is unavailable: run the tool again/);
});

test("images and results over the size bound keep their full content", () => {
  const bounded = { ...policy, maxResultBytes: 9000 };
  const image = { role: "toolResult", toolCallId: "img", toolName: "read", content: [{ type: "text", text: "x".repeat(9000) }, { type: "image", data: "...", mimeType: "image/png" }] };
  const huge = result("huge", "H".repeat(20_000));
  const messages = [assistant(NOW - 90 * MINUTE), image, huge, assistant(NOW - 90 * MINUTE), assistant(NOW - 90 * MINUTE)];
  assert.equal(new LazyOutputProjector(bounded, memorySpill()).project(messages, environment(NOW, 5000)).messages, undefined);
});

test("the session spill budget stops further replacements", () => {
  const projector = new LazyOutputProjector({ ...policy, maxSessionBytes: 9000 }, memorySpill());
  const outcome = projector.project(conversation(NOW - 90 * MINUTE), environment(NOW, 5000));
  assert.equal(outcome.newlyReplaced.length, 1);
  assert.match(outcome.failures[0]!, /session spill limit/);
});

test("a short write is completed, a stalled write fails, and a truncated file is never trusted", () => {
  const sink: Buffer[] = [];
  const stingy = (_descriptor: number, bytes: Buffer, offset: number) => { const take = Math.min(3, bytes.length - offset); sink.push(bytes.subarray(offset, offset + take)); return take; };
  writeFully(0, Buffer.from("hello world"), stingy);
  assert.equal(Buffer.concat(sink).toString(), "hello world");
  assert.throws(() => writeFully(0, Buffer.from("abc"), () => 0), /write stopped after 0 of 3 bytes/);

  const root = mkdtempSync(join(tmpdir(), "pi-jar-short-test-"));
  try {
    // A writer that claims success but drops the tail: the verification after the write rejects it.
    const lying = createDiskSpill((descriptor, bytes, offset) => { const half = Math.ceil((bytes.length - offset) / 2); return writeFromDescriptor(descriptor, bytes.subarray(offset, offset + half)) && bytes.length - offset; });
    assert.throws(() => lying.ensure(join(root, "d", "f.txt"), "x".repeat(1000)), /does not hold the saved text/);
    // A writer that is only slow (short writes) still produces a complete, verified file.
    const slow = createDiskSpill((descriptor, bytes, offset) => writeFromDescriptor(descriptor, bytes.subarray(offset, offset + 7)));
    slow.ensure(join(root, "d", "g.txt"), "y".repeat(1000));
    assert.equal(readFileSync(join(root, "d", "g.txt"), "utf8"), "y".repeat(1000));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the stub is deterministic and bounded", () => {
  const message = { toolName: "ctx_search", toolCallId: "x" };
  const text = "line\n".repeat(5000);
  const stub = stubText(message, text, "/spill/f.txt", 300);
  assert.equal(stub, stubText(message, text, "/spill/f.txt", 300));
  assert.ok(stub.length < 600);
  assert.match(stub, /ctx_search, 5001 lines, 25000 chars/);
});

test("a 4,000 message history is projected quickly on every call", () => {
  const history = Array.from({ length: 1000 }, (_unused, index) => [assistant(NOW), result("r" + index, "z".repeat(5000)), { role: "user", content: "u" }, result("s" + index, "tiny")]).flat();
  const projector = new LazyOutputProjector(policy, memorySpill());
  projector.project(history, environment(NOW, 5000, false));
  const started = performance.now();
  for (let call = 0; call < 5; call++) projector.project(history, environment(NOW, undefined));
  assert.ok(performance.now() - started < 1500, "estimates are cached per message, no full serialization");
});

test("disk spill: private directory, owner-only exclusive files, verified reuse, planted links and collisions", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-spill-test-"));
  try {
    const directory = join(root, "session");
    const file = join(directory, "read-1.txt");
    diskSpill.ensure(file, "secret output");
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, "utf8"), "secret output");

    writeFileSync(file, "tampered");
    diskSpill.ensure(file, "secret output");
    assert.equal(readFileSync(file, "utf8"), "secret output", "stale or corrupt content is replaced, never trusted");

    const outside = join(root, "outside.txt");
    writeFileSync(outside, "keep me");
    const planted = join(directory, "read-2.txt");
    symlinkSync(outside, planted);
    diskSpill.ensure(planted, "new text");
    assert.equal(lstatSync(planted).isSymbolicLink(), false, "a planted link is removed, not followed");
    assert.equal(readFileSync(outside, "utf8"), "keep me");
    assert.equal(readFileSync(planted, "utf8"), "new text");

    // Ids that a character filter would merge ("a:b", "a/b", and long ids sharing a prefix) get distinct files.
    const spillRoot = join(root, "projector");
    const projector = new LazyOutputProjector(policy, diskSpill);
    const ids = ["a:b", "a/b", "x".repeat(100) + "1", "x".repeat(100) + "2"];
    const messages = [assistant(NOW - 90 * MINUTE), ...ids.map((id, index) => result(id, String(index).repeat(8000))), assistant(NOW - 90 * MINUTE), assistant(NOW - 90 * MINUTE)];
    const outcome = projector.project(messages, environment(NOW, 5000, true, spillRoot));
    assert.equal(outcome.newlyReplaced.length, 4);
    const files = readdirSync(spillRoot);
    assert.equal(new Set(files).size, 4);
    assert.deepEqual(files.map((name) => readFileSync(join(spillRoot, name), "utf8")[0]).sort(), ["0", "1", "2", "3"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("old spill directories are pruned, recent ones kept", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-prune-test-"));
  try {
    mkdirSync(join(root, "old")); mkdirSync(join(root, "fresh"));
    const longAgo = new Date(NOW - 10 * 24 * 3_600_000);
    utimesSync(join(root, "old"), longAgo, longAgo);
    const removed = pruneSpill(root, 7 * 24 * 3_600_000, NOW);
    assert.deepEqual(removed, [join(root, "old")]);
    assert.equal(existsSync(join(root, "old")), false);
    assert.equal(existsSync(join(root, "fresh")), true);
    assert.deepEqual(pruneSpill(join(root, "missing"), 1, NOW), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function hook(spillRoot: string, enabled: { value: boolean }) {
  const handlers = new Map<string, Function>();
  const appended: { type: string; data: { ids: string[] } }[] = [];
  const pi = { on: (name: string, fn: Function) => { handlers.set(name, fn); }, appendEntry: (type: string, data: { ids: string[] }) => { appended.push({ type, data }); } };
  const projector = registerLazyOutput(pi as never, { enabled: () => enabled.value, policy, spillRoot });
  const notices: string[] = [];
  let branch: unknown[] = [];
  const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => "s/1" }, getContextUsage: () => ({ tokens: 100_000 }), ui: { notify: (text: string) => notices.push(text) } };
  return { handlers, appended, projector, notices, ctx, setBranch: (next: unknown[]) => { branch = next; } };
}

test("the hook reports an unwritable spill once and persists nothing for it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-hook-test-"));
  try {
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "a file, not a directory");
    const h = hook(join(blocker, "inside"), { value: true });
    await h.handlers.get("session_start")!({}, h.ctx);
    const old = conversation(Date.now() - 90 * MINUTE);
    assert.equal(await h.handlers.get("context")!({ messages: old }, h.ctx), undefined);
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0]!, /could not save large tool output/);
    await h.handlers.get("context")!({ messages: old }, h.ctx);
    assert.equal(h.notices.length, 1, "reported once");
    assert.deepEqual(h.appended, [], "no decision is persisted without a verified copy");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the hook persists verified replacements, keeps them when disabled and restores a branch's own decisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-hook-test-"));
  try {
    const enabled = { value: true };
    const h = hook(join(root, "ok"), enabled);
    await h.handlers.get("session_start")!({}, h.ctx);
    const old = conversation(Date.now() - 90 * MINUTE);
    const swept = await h.handlers.get("context")!({ messages: old }, h.ctx);
    assert.deepEqual(h.appended.map((entry) => [entry.type, entry.data.ids.sort()]), [["pi-jar.lazy-output", ["a", "b"]]]);
    enabled.value = false;
    assert.deepEqual(await h.handlers.get("context")!({ messages: old }, h.ctx), swept, "disabling does not bring the old outputs back");
    enabled.value = true;
    assert.deepEqual(await h.handlers.get("context")!({ messages: old }, h.ctx), swept, "nor does enabling again flip them");
    assert.equal(h.appended.length, 1);
    h.setBranch([{ type: "custom", customType: "pi-jar.lazy-output", data: { ids: ["a"] } }]);
    await h.handlers.get("session_tree")!({}, h.ctx);
    assert.equal(h.projector.replacedCount, 1, "a switched branch reapplies its own decisions");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
