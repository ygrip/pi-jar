import assert from "node:assert/strict";
import test from "node:test";
import { registerAdvisor } from "../src/advisor.ts";
import { SideUsage } from "../src/side-model.ts";

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const answer = (text = "Proceed: verify the edge case.") => ({ content: [{ type: "text", text }], stopReason: "stop", usage: { input: 3, output: 4, cost: { total: 0.01 } } });
function fixture(result: Promise<unknown>, timeoutMs = 60_000) {
  const hooks = new Map<string, Function>(), tools = new Map<string, any>(), commands = new Map<string, Function>();
  const sent: any[] = [], notices: string[] = [], statuses: any[] = [], calls: any[] = [];
  const usage = new SideUsage();
  const ctx: any = { hasUI: true, cwd: "/test", isIdle: () => true, model: { provider: "p", id: "main" },
    sessionManager: { getBranch: () => [] }, ui: { notify: (text: string) => notices.push(text), setStatus: (_key: string, value: unknown) => statuses.push(value) },
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), streamSimple: (model: unknown, prompt: any, options: any) => {
      calls.push({ model, prompt, options }); return { result: () => result };
    } }
  };
  const roles: any = { resolve: () => ({ provider: "p", model: "reviewer", thinking: "high", via: [] }), fallbackSpecs: () => [] };
  const advisor = registerAdvisor({ on: (name: string, handler: Function) => hooks.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, spec: any) => commands.set(name, spec.handler),
    sendMessage: (message: unknown, options: unknown) => sent.push({ message, options })
  } as never, roles, { enabled: () => true, gates: () => true, usage, timeoutMs, processRunner: async () => Buffer.from("") });
  const invoke = (params: unknown, signal?: AbortSignal) => tools.get("jar_advisor").execute("test", params, signal, undefined, ctx);
  return { advisor, hooks, invoke, commands, ctx, sent, notices, statuses, calls, usage, roles };
}

test("start, slash command and automatic gates do not wait for an unresponsive provider", async t => {
  const h = fixture(new Promise(() => {})); t.after(() => h.advisor.dispose());
  const receipt = await h.invoke({ question: "Review?" });
  assert.equal(receipt.details.state, "running");
  assert.match(receipt.content[0].text, /a1 started/);
  await h.commands.get("advisor")!("Check cancellation", h.ctx);
  assert.equal(h.advisor.get("a2")?.state, "running");
  assert.throws(() => h.advisor.start(h.ctx), /busy/);
  h.advisor.cancel("a2");
  const call = { toolName: "grep", input: { pattern: "same" } };
  for (let repeat = 0; repeat < 3; repeat++) h.hooks.get("tool_call")!(call, h.ctx);
  const gate = h.hooks.get("tool_call")!(call, h.ctx);
  assert.equal(gate.block, true);
  assert.match(gate.reason, /reviewing in the background/);
  assert.ok(h.advisor.isBusy());
});

test("wait is bounded and cancellation immediately releases a hung request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = fixture(new Promise(() => {})); t.after(() => h.advisor.dispose());
  const job = h.advisor.start(h.ctx);
  await flush();
  const waiting = h.advisor.wait(job.id, 99_999);
  t.mock.timers.tick(30_000);
  assert.equal((await waiting).state, "running");
  const cancelled = await h.invoke({ action: "cancel", id: job.id });
  assert.equal(cancelled.details.state, "cancelled");
  await flush();
  assert.equal(h.advisor.isBusy(), false);
  assert.equal(h.statuses.at(-1), undefined);
  t.mock.timers.tick(60_000);
  assert.equal(h.sent.length, 0, "cancelled work never wakes the model");
});

test("deadline completes even when the provider ignores its abort signal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = fixture(new Promise(() => {}), 100); t.after(() => h.advisor.dispose());
  const job = h.advisor.start(h.ctx);
  await flush();
  t.mock.timers.tick(100); await flush();
  assert.equal(h.advisor.get(job.id)?.state, "failed");
  assert.match(h.advisor.get(job.id)?.error ?? "", /timed out/);
  assert.equal(h.advisor.isBusy(), false);
  assert.equal(h.statuses.at(-1), undefined);
  assert.ok(h.calls[0].options.signal.aborted);
});

test("completed advice wakes an idle agent once, while get acknowledges it before delivery", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = fixture(Promise.resolve(answer())); t.after(() => h.advisor.dispose());
  const first = h.advisor.start(h.ctx); await flush();
  assert.equal(h.advisor.get(first.id)?.state, "completed");
  t.mock.timers.tick(30);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: "nextTurn" });
  t.mock.timers.tick(1000); assert.equal(h.sent.length, 1);
  const second = h.advisor.start(h.ctx); await flush();
  assert.match((await h.invoke({ action: "get", id: second.id })).content[0].text, /verify the edge case/);
  t.mock.timers.tick(1000); assert.equal(h.sent.length, 1, "observed results do not replay");
});

test("active advice is visible immediately but enters model context only at a safe boundary", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = fixture(Promise.resolve(answer())); t.after(() => h.advisor.dispose());
  h.hooks.get("agent_start")!({}, h.ctx);
  h.advisor.start(h.ctx); await flush(); t.mock.timers.tick(1000);
  assert.equal(h.sent.length, 0);
  assert.ok(h.notices.some(text => /completed; result available/.test(text)));
  const boundary = h.hooks.get("turn_end")!({ outcome: "completed", context: { canContinue: true } });
  assert.equal(boundary.continue, true);
  assert.match(boundary.entries[0].content, /Advisor a1/);
  assert.equal(h.hooks.get("agent_before_settle")!({ outcome: "completed", context: { canContinue: true } }), undefined);
  h.hooks.get("agent_settled")!(); t.mock.timers.tick(1000);
  assert.equal(h.sent.length, 0);
});

test("session replacement cancels old advice and suppresses late usage, notifications and status clears", async t => {
  const old = deferred<unknown>();
  const h = fixture(old.promise); t.after(() => h.advisor.dispose());
  h.advisor.start(h.ctx); await flush();
  h.hooks.get("session_start")!({}, h.ctx);
  const current = h.advisor.start(h.ctx); await flush();
  // The old provider's result arrives after the shared session usage was cleared.
  old.resolve(answer()); await flush();
  assert.equal(h.advisor.get("a1"), undefined);
  assert.equal(h.advisor.get(current.id)?.state, "completed");
  assert.equal(h.usage.all().length, 1, "only the new session's result is recorded");
  assert.equal(h.notices.filter(text => /a1/.test(text)).length, 0);
  const result = await h.invoke({ action: "get", id: current.id });
  assert.equal(result.details.state, "completed");
});

test("request/model choices and prompt/output budgets are bounded", async t => {
  const pending = deferred<unknown>();
  const h = fixture(pending.promise); t.after(() => h.advisor.dispose());
  h.ctx.sessionManager.getBranch = () => [{ type: "message", message: { role: "user", content: "x".repeat(100_000) } }];
  const job = h.advisor.start(h.ctx, { question: "q".repeat(20_000), draft: "d".repeat(100_000) });
  await flush();
  assert.ok(h.calls[0].prompt.messages[0].content.length < 25_000);
  assert.equal(h.calls[0].options.reasoning, "high", "explicit advisor effort is not silently lowered");
  pending.resolve(answer("a".repeat(50_000))); await flush();
  assert.equal(h.advisor.get(job.id)?.text?.length, 8000);
});

for (const outcome of ["resolve", "reject"] as const) test(`cancelled advisor ${outcome} cannot affect a newer pending request`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests = [deferred<unknown>(), deferred<unknown>()];
  const h = fixture(Promise.resolve(answer())); t.after(() => h.advisor.dispose());
  let count = 0;
  h.ctx.modelRegistry.streamSimple = () => ({ result: () => requests[count++]!.promise });
  const old = h.advisor.start(h.ctx); await flush();
  t.mock.timers.tick(50_000);
  assert.equal(h.advisor.cancel(old.id)?.state, "cancelled");
  await h.invoke({ action: "get", id: old.id });
  const current = h.advisor.start(h.ctx); await flush();
  const noticesBefore = h.notices.length;
  if (outcome === "resolve") requests[0].resolve(answer("obsolete advice"));
  else requests[0].reject(new Error("obsolete provider failure"));
  await flush();
  t.mock.timers.tick(10_001); await flush();
  assert.equal(h.advisor.get(current.id)?.state, "running");
  assert.equal(h.advisor.isBusy(), true);
  assert.ok(h.statuses.at(-1));
  assert.equal(h.usage.all().length, outcome === "resolve" ? 1 : 0, "actual returned costs remain accounted within the same session");
  assert.equal(h.notices.length, noticesBefore);
  assert.equal(h.sent.length, 0);
  requests[1].resolve(answer()); await flush();
  assert.equal(h.advisor.get(current.id)?.state, "completed");
});

test("late completions cannot clear a newer request's working status", async t => {
  const requests = [deferred<unknown>(), deferred<unknown>()];
  const h = fixture(Promise.resolve(answer())); t.after(() => h.advisor.dispose());
  let count = 0;
  h.ctx.modelRegistry.streamSimple = (_model: unknown, _prompt: unknown, options: any) => {
    h.calls.push({ options }); return { result: () => requests[count++]!.promise };
  };
  h.advisor.start(h.ctx); await flush();
  h.advisor.start(h.ctx); await flush();
  requests[0].resolve(answer()); await flush();
  assert.ok(h.statuses.at(-1), "remaining request keeps advisor status working");
  requests[1].resolve(answer()); await flush();
  assert.equal(h.statuses.at(-1), undefined);
});
