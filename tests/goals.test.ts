import assert from "node:assert/strict";
import test from "node:test";
import { GOAL_ENTRY, GoalStore } from "../src/goals.ts";

test("goal state is append-only and restores the latest branch value", () => {
  const events: unknown[] = [];
  const store = new GoalStore((event) => events.push({ type: "custom", customType: GOAL_ENTRY, data: event }));
  assert.equal(store.current(), undefined);
  assert.equal(store.set("Ship first-class plan mode"), true);
  assert.equal(store.current(), "Ship first-class plan mode");
  assert.equal(store.set("Ship plan mode safely"), true);
  assert.equal(store.current(), "Ship plan mode safely");

  const restored = new GoalStore(() => {});
  restored.restore(events);
  assert.equal(restored.current(), "Ship plan mode safely");
  assert.equal(restored.clear(), true);
  assert.equal(restored.current(), undefined);
});

test("goal state ignores malformed and oversized entries", () => {
  const store = new GoalStore(() => {});
  store.restore([
    { type: "custom", customType: GOAL_ENTRY, data: { v: 2, op: "set", text: "wrong version" } },
    { type: "custom", customType: GOAL_ENTRY, data: { v: 1, op: "set", text: "x".repeat(2000) } },
    { type: "custom", customType: GOAL_ENTRY, data: { v: 1, op: "set", text: "valid goal" } }
  ]);
  assert.equal(store.current(), "valid goal");
});
