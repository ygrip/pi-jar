import assert from "node:assert/strict";
import test from "node:test";
import { registerTodoGate, TODO_GATE_MAX_NUDGES } from "../src/todo-gate.ts";

const todo = (id: string, status: "pending" | "in_progress" | "completed", parentId?: string) =>
  ({ id, title: id, status, done: status === "completed", ...(parentId ? { parentId } : {}) });
function fixture(items: any[], suspended = false) {
  const hooks = new Map<string, Function>();
  registerTodoGate({ on: (name: string, fn: Function) => hooks.set(name, fn) } as never,
    { todos: () => ({ all: () => items }) as never, suspended: () => suspended });
  return (name: string, event: unknown = {}) => hooks.get(name)?.(event);
}
const done = { outcome: "completed", context: { canContinue: true } };

test("open tasks force a bounded continuation", () => {
  const hook = fixture([todo("a", "in_progress")]);
  for (let i = 0; i < TODO_GATE_MAX_NUDGES; i++) {
    const result = hook("agent_before_settle", done);
    assert.equal(result.continue, true);
    assert.match(result.entries[0].content, /a/);
  }
  assert.equal(hook("agent_before_settle", done), undefined);
  hook("input", { source: "interactive" });
  assert.equal(hook("agent_before_settle", done).continue, true);
});

test("no nudge when done, parent-only open, suspended, aborted or already continuing", () => {
  assert.equal(fixture([todo("a", "completed")])("agent_before_settle", done), undefined);
  assert.equal(fixture([todo("p", "in_progress"), todo("k", "completed", "p")])("agent_before_settle", done), undefined);
  assert.equal(fixture([todo("a", "pending")], true)("agent_before_settle", done), undefined);
  assert.equal(fixture([todo("a", "pending")])("agent_before_settle", { outcome: "aborted" }), undefined);
  assert.equal(fixture([todo("a", "pending")])("agent_before_settle", { ...done, continue: true }), undefined);
});
