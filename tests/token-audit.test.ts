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
  assert.deepEqual(audit.misses, { count: 1, tokens: 30_000, largest: 30_000 });
  assert.equal(audit.context.latest, 80_200);
  assert.equal(audit.context.max, 80_200);
  assert.equal(audit.context.growthPerCall, 25_100);
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
