import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GOAL_ENTRY, GoalStore } from "../src/goals.ts";
import { GOAL_TOOL, GoalLoop, goalProgress } from "../src/goal-loop.ts";
import { TodoStore } from "../src/tasks.ts";
import type { ModelRoleManager } from "../src/model-roles.ts";

const entry = (data: unknown) => ({ type: "custom", customType: GOAL_ENTRY, data });

test("goal state is append-only and restores the latest branch value", () => {
  const events: unknown[] = [];
  const store = new GoalStore((event) => events.push(entry(event)));
  assert.equal(store.current(), undefined);
  assert.equal(store.set("Ship first-class plan mode"), true);
  assert.equal(store.text(), "Ship first-class plan mode");
  assert.equal(store.set("Ship plan mode safely"), true);
  assert.equal(store.setRound(2, "audit"), true);
  assert.equal(store.setStatus("paused", { reason: "limit" }), true);

  const restored = new GoalStore(() => {});
  restored.restore(events);
  assert.deepEqual({ ...restored.current(), id: "x" }, { id: "x", text: "Ship plan mode safely", status: "paused", phase: "audit", rounds: 2, reason: "limit" });
  assert.equal(restored.setStatus("complete", { evidence: "npm test passed" }), true);
  assert.equal(restored.text(), undefined, "completed goals are no longer worked on");
  assert.equal(restored.current()?.evidence, "npm test passed");
  assert.equal(restored.clear(), true);
  assert.equal(restored.current(), undefined);
});

test("goal state replays v1 entries and ignores malformed or foreign ones", () => {
  const store = new GoalStore(() => {});
  store.restore([
    entry({ v: 3, op: "set", text: "wrong version" }),
    entry({ v: 1, op: "set", text: "x".repeat(2000) }),
    entry({ v: 1, op: "set", text: "valid goal" }),
    entry({ v: 2, op: "status", id: "other", status: "complete" })
  ]);
  assert.equal(store.text(), "valid goal");
  assert.equal(store.current()?.status, "active");
  store.restore([entry({ v: 1, op: "set", text: "a" }), entry({ v: 1, op: "clear" })]);
  assert.equal(store.current(), undefined);
});

function harness(maxRounds = 3) {
  const events = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const sent: string[] = [];
  const notices: string[] = [];
  const roleCalls: string[] = [];
  let planActive = false;
  const pi = {
    on(name: string, handler: (...args: any[]) => any) { events.set(name, handler); },
    registerCommand(name: string, spec: { handler: any }) { commands.set(name, spec.handler); },
    registerTool(tool: { name: string; execute: any }) { tools.set(tool.name, tool); },
    sendUserMessage(text: string) { sent.push(text); }
  } as unknown as ExtensionAPI;
  const ctx = { hasUI: false, mode: "print", ui: { notify(message: string) { notices.push(message); } } } as unknown as ExtensionContext;
  const goals = new GoalStore(() => {});
  const todos = new TodoStore(() => {});
  const roles = { activateTemporary: async (role: string) => { roleCalls.push("on:" + role); return async () => { roleCalls.push("off:" + role); }; } } as unknown as ModelRoleManager;
  const completed: string[] = [];
  new GoalLoop(pi, { goals: () => goals, todos: () => todos, roles, planActive: () => planActive, maxRounds: () => maxRounds,
    completed: (_ctx, goal) => completed.push(goal.text) }).register();
  const settle = (outcome = "completed", extra: object = {}) => events.get("agent_before_settle")!({ outcome, continue: false, entries: [], ...extra }, ctx);
  const tool = (params: object) => tools.get(GOAL_TOOL)!.execute("id", params, undefined, undefined, ctx);
  const guard = (toolName: string, input: object = {}) => events.get("tool_call")!({ toolName, input }, ctx);
  return { events, commands, ctx, goals, todos, sent, notices, roleCalls, completed, settle, tool, guard, setPlan: (value: boolean) => { planActive = value; } };
}

test("goal command starts the loop; edits are blocked until a task is open", async () => {
  const h = harness();
  await h.commands.get("goal")!("Ship the hello command", h.ctx);
  assert.deepEqual(h.sent, ["Work toward the active goal: Ship the hello command"]);
  assert.match((await h.guard("write", { path: "a.ts" }))?.reason, /create jar_todo tasks/);
  assert.equal((await h.guard("bash", { command: "rm -rf x" }))?.block, true);
  assert.equal(await h.guard("bash", { command: "git status" }), undefined, "read-only inspection stays allowed");
  assert.equal(await h.guard("read", { path: "a.ts" }), undefined);
  h.todos.add("Register command");
  assert.equal(await h.guard("write", { path: "a.ts" }), undefined);
  const injected = await h.events.get("before_agent_start")!({}, h.ctx);
  assert.match(injected.message.content, /ACTIVE GOAL[\s\S]*Ship the hello command[\s\S]*\[ \] Register command/);
});

test("implementor continues while tasks are open, then an auditor pass must complete with evidence", async () => {
  const h = harness(5);
  await h.commands.get("goal")!("Ship it", h.ctx);
  const first = await h.settle();
  assert.equal(first.continue, true);
  assert.match(first.entries[0].content, /implementor · round 1\/5[\s\S]*no tasks yet/);
  const task = h.todos.add("Build")!;
  const second = await h.settle();
  assert.match(second.entries[0].content, /implementor · round 2\/5[\s\S]*\[ \] Build/);
  assert.match((await h.tool({ action: "complete", evidence: "done" })).content[0].text, /still open/);
  h.todos.setDone(task.id, true);
  assert.match((await h.tool({ action: "complete", evidence: "done" })).content[0].text, /audit pass/, "cannot skip the audit");
  const audit = await h.settle();
  assert.match(audit.entries[0].content, /auditor · round 3\/5/);
  assert.deepEqual(h.roleCalls, ["on:advisor"]);
  assert.equal(h.goals.current()?.phase, "audit");
  assert.match((await h.guard("edit", { path: "a.ts" }))?.reason, /do not edit during the audit/);
  assert.equal(await h.guard("bash", { command: "npm test" }), undefined, "auditor may run verification");
  assert.match((await h.tool({ action: "complete", evidence: " " })).content[0].text, /evidence/);
  const done = await h.tool({ action: "complete", evidence: "npm test: 12 passed" });
  assert.equal(done.terminate, true);
  assert.equal(h.goals.current()?.status, "complete");
  assert.deepEqual(h.completed, ["Ship it"]);
  assert.equal(await h.settle(), undefined, "a completed goal never continues");
  await h.events.get("agent_settled")!({}, h.ctx);
  assert.deepEqual(h.roleCalls, ["on:advisor", "off:advisor"]);
});

test("auditor gaps send work back to the implementor on the previous role", async () => {
  const h = harness(5);
  await h.commands.get("goal")!("Ship it", h.ctx);
  h.todos.setDone(h.todos.add("Build")!.id, true);
  await h.settle();
  h.todos.add("Fix missed edge case");
  const back = await h.settle();
  assert.match(back.entries[0].content, /implementor[\s\S]*Fix missed edge case/);
  assert.deepEqual(h.roleCalls, ["on:advisor", "off:advisor"]);
});

test("the loop pauses on interruption, errors, the round limit, plan mode and blocks", async () => {
  const h = harness(2);
  await h.commands.get("goal")!("Ship it", h.ctx);
  assert.equal(await h.settle("aborted"), undefined);
  assert.equal(h.goals.current()?.status, "paused");
  assert.equal(h.goals.current()?.reason, "interrupted");
  await h.commands.get("goal")!("resume", h.ctx);
  assert.equal(h.goals.current()?.status, "active");
  assert.ok((await h.settle())?.continue);
  assert.ok((await h.settle())?.continue);
  assert.equal(await h.settle(), undefined);
  assert.match(h.goals.current()?.reason ?? "", /2 automatic rounds/);
  await h.commands.get("goal")!("resume", h.ctx);
  h.events.get("input")!({ source: "interactive", text: "keep going" }, h.ctx);
  assert.equal(h.goals.current()?.rounds, 0, "user input resets the round budget");
  assert.equal(await h.settle("completed", { continue: true }), undefined, "never stacks on another continuation");
  h.setPlan(true);
  assert.equal(await h.settle(), undefined);
  h.setPlan(false);
  const blocked = await h.tool({ action: "block", reason: "need API key" });
  assert.equal(blocked.terminate, true);
  assert.equal(h.goals.current()?.reason, "need API key");
  assert.equal(await h.settle(), undefined);
  await h.commands.get("goal")!("clear", h.ctx);
  assert.equal(h.goals.current(), undefined);
});

test("goal progress summarizes tasks, rounds and phase", () => {
  const goal = { id: "g", text: "Ship", status: "active" as const, phase: "audit" as const, rounds: 2 };
  const todos = [{ id: "a", title: "A", done: true, status: "completed" as const }, { id: "b", title: "B", done: false, status: "pending" as const }];
  assert.equal(goalProgress(goal, todos, 8), "Ship · 1/2 tasks · round 2/8 · auditing");
  assert.equal(goalProgress({ ...goal, status: "paused", reason: "limit" }, [], 8), "Ship · paused (limit)");
  assert.equal(goalProgress(undefined, [], 8), undefined);
});
