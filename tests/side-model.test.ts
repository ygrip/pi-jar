import assert from "node:assert/strict";
import test from "node:test";
import { askRole, SideUsage } from "../src/side-model.ts";

function harness(outcomes: Record<string, unknown>, fallbacks = ["backup", "last"]) {
  const calls: string[] = [];
  const usage = new SideUsage();
  const assignment = (model: string) => ({ provider: "p", model, thinking: "high", via: [] });
  const roles = { resolve: () => assignment("primary"), fallbackSpecs: () => fallbacks, resolveSpec: assignment };
  const ctx = { modelRegistry: {
    find: (provider: string, id: string) => id === "missing" ? undefined : { provider, id },
    streamSimple: (model: any, context: any, options: any) => {
      calls.push(model.id);
      assert.equal(context.messages[0].content, "question");
      assert.equal(options.reasoning, "high");
      return { result: async () => {
        const outcome = outcomes[model.id];
        if (outcome instanceof Error) throw outcome;
        return outcome ?? { stopReason: "stop", content: [{ type: "text", text: "advice" }], usage: { input: 2, output: 3, cost: { total: 0.1 } } };
      } };
    }
  } };
  const run = (signal?: AbortSignal) => askRole(ctx as never, roles as never, usage, "advisor", "system", "question", signal);
  return { calls, usage, run };
}

test("side calls advance after rate limits and report the successful fallback", async () => {
  const h = harness({ primary: new Error("429 rate limit") });
  assert.deepEqual(await h.run(), { text: "advice", model: "p/backup" });
  assert.deepEqual(h.calls, ["primary", "backup"]);
  assert.equal(h.usage.all()[0].model, "p/backup");
});

test("missing, duplicate and empty fallback candidates do not prevent later success", async () => {
  const h = harness({ primary: { stopReason: "error", errorMessage: "auth failed", content: [] }, backup: { stopReason: "stop", content: [] } }, ["missing", "primary", "backup", "last"]);
  assert.equal((await h.run()).model, "p/last");
  assert.deepEqual(h.calls, ["primary", "backup", "last"]);
  assert.equal(h.usage.all().length, 3, "returned failed attempts are also accounted for");
});

test("fallback exhaustion identifies each failed model", async () => {
  const h = harness({ primary: new Error("rate limit"), backup: new Error("offline"), last: new Error("auth") });
  await assert.rejects(h.run(), /All models for role advisor failed:[\s\S]*p\/primary: rate limit[\s\S]*p\/backup: offline[\s\S]*p\/last: auth/);
});

test("no fallbacks preserves the original error", async () => {
  const error = new Error("original");
  const h = harness({ primary: error }, []);
  await assert.rejects(h.run(), (actual) => actual === error);
});

test("cancellation never starts a fallback", async () => {
  const h = harness({ primary: { stopReason: "aborted", content: [], errorMessage: "cancelled" } });
  await assert.rejects(h.run(), /cancelled/);
  assert.deepEqual(h.calls, ["primary"]);
  const controller = new AbortController();
  controller.abort();
  const pre = harness({});
  await assert.rejects(pre.run(controller.signal), { name: "AbortError" });
  assert.deepEqual(pre.calls, []);
  const thrown = harness({ primary: new DOMException("cancelled", "AbortError") });
  await assert.rejects(thrown.run(), { name: "AbortError" });
  assert.deepEqual(thrown.calls, ["primary"]);
});
