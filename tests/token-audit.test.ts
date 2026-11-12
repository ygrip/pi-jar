import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { auditSession, tokenAuditLines } from "../src/token-audit.ts";

const plain = (_color: string, text: string) => text;
const usage = (input: number, cacheRead: number, output: number, total: number) => ({
  input, cacheRead, cacheWrite: 0, output, cost: { input: input / 1e6, cacheRead: cacheRead / 1e6, cacheWrite: 0, output: output / 1e6, total }
});
const call = (model: string, used: ReturnType<typeof usage>, content: unknown[]) => ({ type: "message", message: { role: "assistant", provider: "p", model, usage: used, content } });
const toolCall = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const toolResult = (id: string, name: string, chars: number) => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "x".repeat(chars) }] } });

function session() {
  return [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    call("m1", usage(30_000, 0, 100, 0.05), [{ type: "thinking", thinking: "t", thinkingSignature: "s".repeat(4000) }, toolCall("r1", "read", { path: "/a.ts" })]),
    toolResult("r1", "read", 40_000),
    call("m1", usage(200, 30_000, 100, 0.01), [toolCall("r2", "read", { path: "/a.ts" }), toolCall("b1", "bash", { command: "ls" })]),
    toolResult("r2", "read", 4000),
    toolResult("b1", "bash", 400),
    { type: "custom_message", customType: "pi-jar.goal-context", content: "g".repeat(400) },
    call("m2", usage(200, 80_000, 100, 0.02), [{ type: "text", text: "done" }])
  ];
}

test("audit totals cost, requests, models, cache misses and context growth", () => {
  const audit = auditSession({ entries: session() });
  assert.equal(audit.calls, 3);
  assert.equal(audit.modelSwitches, 1);
  assert.deepEqual(audit.models.map((entry) => [entry.model, entry.calls]), [["p/m1", 2], ["p/m2", 1]]);
  assert.ok(Math.abs(audit.cost.total - 0.08) < 1e-9);
  assert.deepEqual(audit.usage, { uncached: 30_400, cacheRead: 110_000, output: 300 });
  assert.deepEqual(audit.misses, { count: 0, tokens: 0, largest: 0 }, "a first request and normal cache hits are not shortfalls");
  assert.equal(audit.context.latest, 80_200);
  assert.equal(audit.context.max, 80_200);
  assert.equal(audit.context.growthPerCall, 25_100);
});

test("a cache read that falls far below the previous prompt is a shortfall; the request after a compaction is not", () => {
  const entries = [
    ...session(),
    call("m2", usage(60_000, 20_000, 100, 0.05), [{ type: "text", text: "after a break" }]),
    { type: "compaction", summary: "s" },
    call("m2", usage(15_000, 0, 100, 0.02), [{ type: "text", text: "first after compaction" }])
  ];
  const audit = auditSession({ entries });
  assert.deepEqual(audit.misses, { count: 1, tokens: 60_000, largest: 60_000 });
});

test("uncached input includes cache writes, matching the displayed cost", () => {
  const written = { input: 100, cacheRead: 0, cacheWrite: 900, output: 5, cost: { input: 0, cacheRead: 0, cacheWrite: 0.01, output: 0, total: 0.01 } };
  assert.equal(auditSession({ entries: [call("m", written, [{ type: "text", text: "x" }])] }).usage.uncached, 1000);
});

test("a lazy sweep weighs a replaced result at full size only until the sweep, then as a stub", () => {
  const turns = (count: number) => Array.from({ length: count }, () => call("m1", usage(100, 20_000, 10, 0.01), [{ type: "text", text: "s".repeat(8000) }]));
  const base = [call("m1", usage(100, 20_000, 10, 0.01), [toolCall("r1", "read", { path: "/big.ts" })]), toolResult("r1", "read", 40_000), ...turns(2)];
  const plain = auditSession({ entries: [...base, ...turns(4)] });
  const swept = auditSession({ entries: [...base, { type: "custom", customType: "pi-jar.lazy-output", data: { ids: ["r1"], savedTokens: 9870 } }, ...turns(4)] });
  const read = (audit: typeof plain) => audit.tools.find((tool) => tool.name === "read")!;
  assert.equal(read(swept).stubbed, 1);
  assert.equal(read(plain).stubbed, 0);
  assert.ok(read(swept).share < read(plain).share - 20, `a swept result must not keep its full-size weight (${read(swept).share} vs ${read(plain).share})`);
  assert.ok(plain.estimatedContext - swept.estimatedContext >= 9800, "the live context counts the stub, not the original");
  assert.equal(read(swept).tokens, 10_000, "what the tool produced is still reported");
  assert.deepEqual(swept.lazy, { replaced: 1, savedTokens: 9870 });
});

test("repeats of the goal and moderator messages that the hooks drop cost nothing", () => {
  const message = (type: string, text: string) => ({ type: "custom_message", customType: type, content: text.repeat(400) });
  const entries = [message("pi-jar.goal-context", "g"), call("m", usage(10, 100, 1, 0.01), [{ type: "text", text: "a" }]),
    message("pi-jar.goal-context", "g"), message("pi-jar.subagent", "s"), message("pi-jar.subagent", "s"), call("m", usage(10, 100, 1, 0.01), [{ type: "text", text: "b" }])];
  const audit = auditSession({ entries });
  const goal = audit.extension.find((item) => item.name === "pi-jar.goal-context")!;
  const subagent = audit.extension.find((item) => item.name === "pi-jar.subagent")!;
  assert.equal(goal.count, 2);
  assert.equal(goal.tokens, 100, "only the first copy is sent");
  assert.equal(subagent.tokens, 200, "subagent events are never deduplicated");
});

test("tools rank by re-read cost: an early large result outweighs a later one", () => {
  const audit = auditSession({ entries: session() });
  assert.deepEqual(audit.tools.map((tool) => tool.name), ["read", "bash"]);
  const read = audit.tools[0]!;
  assert.equal(read.calls, 2);
  assert.equal(read.tokens, 11_000);
  assert.equal(read.max, 10_000);
  assert.equal(read.average, 5500);
  assert.ok(read.share > 80, `read share ${read.share}`);
  assert.ok(audit.assistant.thinking.tokens >= 1000, "encrypted reasoning counts toward the context");
  assert.deepEqual(audit.extension.map((item) => [item.name, item.count]), [["pi-jar.goal-context", 1]]);
});

test("repeated reads are grouped by path", () => {
  const audit = auditSession({ entries: session() });
  assert.deepEqual(audit.repeatedReads, [{ path: "/a.ts", reads: 2, tokens: 11_000 }]);
});

test("only entries after the last compaction are in the live context", () => {
  const entries = [...session(), { type: "compaction", summary: "s".repeat(800) }, toolResult("n", "grep", 800), call("m2", usage(100, 5000, 50, 0.01), [{ type: "text", text: "ok" }])];
  const audit = auditSession({ entries });
  assert.equal(audit.calls, 4, "requests and cost still cover the whole session");
  assert.deepEqual(audit.tools.map((tool) => tool.name), ["grep"]);
});

test("lazy replacements recorded in the session are reported", () => {
  const entries = [...session(), { type: "custom", customType: "pi-jar.lazy-output", data: { ids: ["a", "b"], savedTokens: 9000 } }];
  assert.deepEqual(auditSession({ entries }).lazy, { replaced: 2, savedTokens: 9000 });
});

test("lines stay inside the width and lead with the biggest contributor", () => {
  const audit = auditSession({ entries: session(), side: { calls: 2, cost: 0.03 }, breaks: { count: 1, rewritten: 30_000, cost: 0.04 } });
  for (const width of [60, 100]) {
    const lines = tokenAuditLines(audit, width, plain);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
  }
  const text = tokenAuditLines(audit, 100, plain).join("\n");
  assert.match(text, /Cost[\s\S]*Cache reads[\s\S]*Context per request[\s\S]*Top tool results\n[\s\S]*read[\s\S]*Assistant content[\s\S]*Thinking/);
  assert.match(text, /Repeated reads\n\s+\/a\.ts\s+2×/);
  assert.match(text, /Side models\s+\$0\.03/);
  assert.match(tokenAuditLines(auditSession({ entries: [] }), 80, plain).join("\n"), /No model call/);
});
