import assert from "node:assert/strict";
import test from "node:test";
import { branchCalls, CACHE_IDLE_MS, compactForBudget, CONTEXT_CONTINUATION, ContextBudgetGuard, RECENT_CALLS, type ProviderCall } from "../src/context-budget.ts";
import { renderFooter, type FooterView } from "../src/footer.ts";
import type { ContextBudget } from "../src/settings.ts";
import { formatCost } from "../src/usage.ts";

const guardWith = (budget: ContextBudget) => {
  let current = budget;
  return { guard: new ContextBudgetGuard(() => current), set: (next: ContextBudget) => { current = next; } };
};
const call = (tokens: number, cost = 0.01, at = 1_000): ProviderCall => ({ tokens, cost, at });
const turn = (open = 1, extra: Partial<{ interrupted: boolean; blocked: boolean }> = {}) => ({ open: () => open, interrupted: false, blocked: false, ...extra });
const idle = { idle: true, blocked: false };

test("suggest mode notifies once per crossing, only above softTokens, and re-arms after a drop", () => {
  const { guard } = guardWith({ softTokens: 120_000, action: "suggest" });
  assert.equal(guard.call(call(120_000)), undefined, "at the budget is not past it");
  assert.equal(guard.over, false);
  assert.match(guard.call(call(130_000))!, /130k is past the 120k budget — \/compact, or \/new/);
  assert.equal(guard.over, true);
  assert.equal(guard.call(call(140_000)), undefined, "one notice per crossing");
  guard.compacted();
  assert.equal(guard.over, false, "size is unknown after a compaction");
  assert.equal(guard.call(call(40_000)), undefined);
  assert.ok(guard.call(call(125_000)), "a drop below the budget re-arms the notice");
  assert.equal(guard.busy, false, "suggest never compacts");
});

test("off mode neither notifies nor colors the footer", () => {
  const { guard } = guardWith({ softTokens: 120_000, action: "off" });
  assert.equal(guard.call(call(200_000)), undefined);
  assert.equal(guard.over, false);
  assert.equal(guard.prompt(10 * CACHE_IDLE_MS, { done: 2, total: 2 }), undefined);
});

test("compact mode waits for a safe point (completed todo with work left) and compacts once, then resumes", () => {
  const { guard } = guardWith({ softTokens: 120_000, action: "compact" });
  assert.equal(guard.call(call(130_000)), undefined, "compact mode does not notify");
  assert.equal(guard.busy, true);
  assert.equal(guard.turnEnd(turn()), false, "no completed todo: never cut a tool chain");
  guard.todoCompleted();
  assert.equal(guard.turnEnd(turn(1, { interrupted: true })), false, "an interrupted turn is not a safe point");
  guard.todoCompleted();
  assert.equal(guard.turnEnd(turn(0)), false, "nothing left: the run settles by itself");
  guard.todoCompleted();
  assert.equal(guard.turnEnd(turn(1)), true, "stop after the completed item");
  guard.todoCompleted();
  assert.equal(guard.turnEnd(turn(1)), false, "already stopped");
  assert.deepEqual(guard.settle(idle), { compact: true, resume: true });
  assert.equal(guard.busy, false);
  assert.equal(guard.call(call(140_000)), undefined);
  assert.equal(guard.busy, false, "still the same crossing: no second compaction");
});

test("compact mode compacts at settlement when no todo safe point came, unless the session is held", () => {
  const { guard, set } = guardWith({ softTokens: 120_000, action: "compact" });
  guard.call(call(130_000));
  assert.equal(guard.settle({ idle: false, blocked: false }), undefined, "never while something runs");
  assert.deepEqual(guard.settle(idle), { compact: true, resume: false });
  assert.equal(guard.settle(idle), undefined, "once per crossing");
  guard.call(call(10_000)); guard.call(call(130_000));
  set({ softTokens: 120_000, action: "suggest" });
  assert.equal(guard.settle(idle), undefined, "a request made under compact is dropped once the action changed");
});

test("average cost per call covers the last ten calls and survives a branch reseed", () => {
  const { guard } = guardWith({ softTokens: 120_000, action: "suggest" });
  assert.equal(guard.perCall, undefined);
  for (let index = 1; index <= RECENT_CALLS + 2; index++) guard.call(call(1_000, index));
  // Calls 3..12 → mean 7.5.
  assert.equal(guard.perCall, 7.5);
  const message = (tokens: number, cost: number) => ({ type: "message", message: { role: "assistant", timestamp: 5, usage: { input: tokens, cacheRead: 0, cost: { total: cost } } } });
  const seed = branchCalls([message(50_000, 0.2), { type: "compaction" }, message(10_000, 0.4)], 9);
  assert.deepEqual(seed.costs, [0.2, 0.4]);
  assert.equal(seed.last?.tokens, 10_000, "the newest call after a compaction is the current size");
  assert.equal(branchCalls([message(50_000, 0.2), { type: "compaction" }], 9).last, undefined, "a trailing compaction makes the size unknown");
  guard.reset(seed);
  assert.ok(Math.abs(guard.perCall! - 0.3) < 1e-9);
  assert.equal(formatCost(1.234, guard.perCall), "cost $1.23 · $0.30/call");
  assert.equal(formatCost(1.234), "cost $1.23");
});

test("a prompt after a long idle with a large context warns that the cache is cold; otherwise nothing", () => {
  const { guard } = guardWith({ softTokens: 200_000, action: "suggest" });
  guard.call(call(150_000, 0.1, 1_000));
  assert.equal(guard.prompt(1_000 + CACHE_IDLE_MS, { done: 0, total: 0 }), undefined, "exactly five minutes is still warm");
  assert.match(guard.prompt(1_000 + CACHE_IDLE_MS + 60_000, { done: 0, total: 0 })!, /6m ago: the provider cache has likely expired.*150k uncached.*\/compact first/);
  guard.warmed(1_000 + 4 * 60_000);
  assert.equal(guard.prompt(1_000 + CACHE_IDLE_MS + 60_000, { done: 0, total: 0 }), undefined, "Pi's cache warming restarts the lifetime");
  const small = guardWith({ softTokens: 200_000, action: "suggest" }).guard;
  small.call(call(90_000, 0.1, 1_000));
  assert.equal(small.prompt(1_000 + 60 * 60_000, { done: 0, total: 0 }), undefined, "≤100k context: not worth a notice");
});

test("a new prompt after a finished task list in a large context suggests /new once per list", () => {
  const { guard } = guardWith({ softTokens: 120_000, action: "suggest" });
  guard.call(call(50_000, 0.1, 1_000));
  assert.equal(guard.prompt(2_000, { done: 3, total: 3 }), undefined, "under half the budget: keep going");
  guard.call(call(70_000, 0.1, 1_000));
  assert.equal(guard.prompt(2_000, { done: 2, total: 3 }), undefined, "open tasks: same topic");
  assert.match(guard.prompt(2_000, { done: 3, total: 3 })!, /All tasks are done \(context 70k\).*\/new starts fresh/);
  assert.equal(guard.prompt(2_000, { done: 3, total: 3 }), undefined, "once per finished list");
  guard.todoCompleted();
  assert.ok(guard.prompt(2_000, { done: 4, total: 4 }), "a newly finished list hints again");
});

test("budget compaction resumes a stopped run unless the user cancelled or the session changed", async () => {
  const run = async (outcome: "ok" | "cancel" | "fail", current = true) => {
    const sent: unknown[] = [];
    const notices: string[] = [];
    const ctx = { ui: { notify: (text: string) => notices.push(text) }, compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => {
      if (outcome === "ok") options.onComplete();
      else options.onError(Object.assign(new Error(outcome === "cancel" ? "Compaction cancelled" : "provider down"), outcome === "cancel" ? { name: "AbortError" } : {}));
    } };
    await compactForBudget({ sendMessage: (message: unknown) => { sent.push(message); } } as never, ctx as never,
      { resume: true, tokens: 130_000, softTokens: 120_000, open: ["Write tests"] }, () => current);
    return { sent: sent as { customType: string; content: string }[], notices };
  };
  const ok = await run("ok");
  assert.equal(ok.sent.length, 1);
  assert.equal(ok.sent[0]!.customType, CONTEXT_CONTINUATION);
  assert.match(ok.sent[0]!.content, /Write tests/);
  assert.equal((await run("cancel")).sent.length, 0, "Esc on compaction leaves the user in control");
  const failed = await run("fail");
  assert.equal(failed.sent.length, 1, "a failed compaction still continues the work");
  assert.ok(failed.notices.some((text) => /compaction failed: provider down/.test(text)));
  assert.equal((await run("ok", false)).sent.length, 0, "a replaced session resumes nothing");
});

test("the footer colors only the context metric when over budget and shows the per-call average", () => {
  const colored = { fg: (color: string, text: string) => color === "warning" ? `<w>${text}</w>` : text };
  const view: FooterView = { model: "m", context: "ctx 64%", branch: "", roles: [], extras: [], demo: false, animations: false, frame: 0, cost: "cost $1.23 · $0.04/call" };
  const over = renderFooter({ ...view, overBudget: true }, 120, colored).join("\n");
  assert.match(over, /<w>[^<]*64%<\/w>/);
  assert.match(over, /\$1\.23 · \$0\.04\/call/);
  assert.doesNotMatch(over, /<w>[^<]*\$0\.04/, "cost stays dim");
  assert.doesNotMatch(renderFooter(view, 120, colored).join("\n"), /<w>/);
});
