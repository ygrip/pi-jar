import assert from "node:assert/strict";
import test from "node:test";
import { TASK_ENTRY, TodoStore, todoProgress, todoTotals, type TodoEvent } from "../src/tasks.ts";
import { registerTaskTool, todoRow } from "../src/task-tool.ts";

type Result = { content: { text: string }[]; details: { items: { id: string; parentId?: string }[]; total: number; done: number; count: number; truncated?: boolean; current?: string } };

function harness() {
  let tool: { execute(id: string, params: unknown, ...rest: unknown[]): Promise<Result> } | undefined;
  const events: TodoEvent[] = [];
  const store = new TodoStore((event) => { events.push(event); });
  registerTaskTool({ registerTool(definition: unknown) { tool = definition as typeof tool; } } as never, () => store, () => {});
  const run = (params: unknown) => tool!.execute("t", params, undefined, undefined, {});
  const replay = () => {
    const copy = new TodoStore(() => {});
    copy.restore(events.map((data) => ({ type: "custom", customType: TASK_ENTRY, data })));
    return copy.all();
  };
  return { store, events, run, replay };
}
const statuses = (store: TodoStore) => store.all().map((item) => `${item.parentId ? "  " : ""}${item.title}:${item.status}`);
const plan = [
  { content: "Build feature", status: "pending", subtasks: [
    { content: "Write parser", status: "completed" },
    { content: "Wire command", status: "in_progress", activeForm: "Wiring command" },
    { content: "Add docs", status: "pending" }
  ] },
  { content: "Release", status: "pending" }
];

test("nested writes roll parent status up from subtasks and count leaf tasks", async () => {
  const h = harness();
  const written = await h.run({ todos: plan });
  assert.match(written.content[0]!.text, /1\/4 done · now: Build feature › Wire command/);
  assert.deepEqual(statuses(h.store), ["Build feature:in_progress", "  Write parser:completed", "  Wire command:in_progress", "  Add docs:pending", "Release:pending"]);
  assert.equal(h.store.current()?.title, "Wire command", "the running task is the leaf, not its parent");
  const parent = h.store.all()[0]!;
  assert.deepEqual(todoProgress(h.store.all(), parent.id), { done: 1, total: 3 });
  assert.deepEqual(todoTotals(h.store.all()), { done: 1, total: 4 });
  assert.deepEqual(h.store.all().slice(1, 4).map((item) => item.parentId), [parent.id, parent.id, parent.id]);
  const list = (await h.run({ action: "list" })).content[0]!.text;
  assert.match(list, new RegExp(`◼ \\[in_progress\\] Build feature \\(1/3 done\\) \\(${parent.id}\\)\\n  ✔ \\[completed\\] Write parser`));
  assert.match(list, /\n☐ \[pending\] Release \(/);

  // A parent's own status is ignored; it completes only with all subtasks.
  await h.run({ todos: [{ content: "Build feature", status: "completed", subtasks: [
    { content: "Write parser", status: "completed" }, { content: "Wire command", status: "completed" }, { content: "Add docs", status: "pending" }
  ] }] });
  assert.equal(h.store.get(parent.id)?.status, "in_progress", "partly completed parents stay in progress");
  assert.equal(h.store.current(), undefined);
  await h.run({ todos: [{ content: "Build feature", status: "pending", subtasks: [{ content: "Write parser", status: "completed" }] }] });
  assert.equal(h.store.get(parent.id)?.status, "completed");
  assert.deepEqual(h.replay(), h.store.all());
});

test("rewrites keep ids by title, matching subtasks only within the same parent", async () => {
  const h = harness();
  await h.run({ todos: [
    { content: "API", status: "pending", subtasks: [{ content: "Tests", status: "pending" }] },
    { content: "UI", status: "pending", subtasks: [{ content: "Tests", status: "pending" }] }
  ] });
  const [api, apiTests, ui, uiTests] = h.store.all();
  await h.run({ todos: [
    { content: "UI", status: "pending", subtasks: [{ content: "Tests", status: "in_progress" }, { content: "Polish", status: "pending" }] },
    { content: "api", status: "pending", subtasks: [{ content: "tests", status: "completed" }] }
  ] });
  const next = h.store.all();
  assert.deepEqual(next.map((item) => item.id).slice(0, 2), [ui!.id, uiTests!.id]);
  assert.equal(next[3]!.id, api!.id, "title match is case-insensitive");
  assert.equal(next[4]!.id, apiTests!.id);
  assert.equal(next[4]!.parentId, api!.id);
  assert.notEqual(next[2]!.id, apiTests!.id);
  // A top-level task that moves under a parent is a new subtask, not the old top-level id.
  await h.run({ todos: [{ content: "Wrap up", status: "pending", subtasks: [{ content: "UI", status: "pending" }] }] });
  assert.notEqual(h.store.all()[1]!.id, ui!.id);
  assert.deepEqual(h.replay(), h.store.all());
});

test("parent actions cascade to subtasks and exactly one leaf stays in progress", async () => {
  const h = harness();
  await h.run({ todos: plan });
  const [parent, parser, wire, docs, release] = h.store.all();
  await h.run({ action: "start", id: release!.id });
  assert.equal(h.store.get(wire!.id)?.status, "pending", "starting another leaf parks the running one");
  assert.equal(h.store.get(parent!.id)?.status, "in_progress", "a partly completed parent stays in progress");
  assert.equal(h.store.all().filter((item) => item.status === "in_progress" && item.id !== parent!.id).length, 1);

  const started = await h.run({ action: "start", id: parent!.id });
  assert.equal(h.store.current()?.id, wire!.id, "start on a parent runs its first open subtask");
  assert.equal(h.store.get(release!.id)?.status, "pending");
  assert.match(started.content[0]!.text, /◼ \[in_progress\] Build feature \(1\/3 done\)[^\n]*\n  ✔ \[completed\] Write parser[^\n]*\n  ◼ \[in_progress\] Wire command/);

  await h.run({ action: "done", id: parent!.id });
  assert.deepEqual([parent, parser, wire, docs].map((item) => h.store.get(item!.id)?.status), ["completed", "completed", "completed", "completed"]);
  assert.equal(h.store.current(), undefined);
  const blocked = await h.run({ action: "start", id: parent!.id });
  assert.match(blocked.content[0]!.text, /every subtask .* is completed; open it or add a subtask first/);

  await h.run({ action: "open", id: parent!.id });
  assert.deepEqual([parent, parser, wire, docs].map((item) => h.store.get(item!.id)?.status), ["pending", "pending", "pending", "pending"]);
  await h.run({ action: "done", id: parser!.id });
  assert.equal(h.store.get(parent!.id)?.status, "in_progress");

  const added = await h.run({ action: "add", title: "Changelog", parent: release!.id });
  const changelog = h.store.all().find((item) => item.title === "Changelog")!;
  assert.equal(changelog.parentId, release!.id);
  assert.equal(h.store.all().at(-1)?.id, changelog.id, "subtasks are listed under their parent");
  assert.match(added.content[0]!.text, /☐ \[pending\] Release \(0\/1 done\)[^\n]*\n  ☐ \[pending\] Changelog/);
  await h.run({ action: "add", title: "Review", parent: parent!.id });
  assert.deepEqual(h.store.all().map((item) => item.title), ["Build feature", "Write parser", "Wire command", "Add docs", "Review", "Release", "Changelog"]);

  await h.run({ action: "delete", id: parent!.id });
  assert.deepEqual(h.store.all().map((item) => item.title), ["Release", "Changelog"], "deleting a parent deletes its subtasks");
  await h.run({ action: "delete", id: changelog.id });
  assert.equal(h.store.get(release!.id)?.status, "pending");
  assert.deepEqual(h.replay(), h.store.all());
});

test("invalid parents, nesting and running leaves are rejected with clear messages", async () => {
  const h = harness();
  await h.run({ todos: plan });
  const [parent, parser] = h.store.all();
  const before = h.store.all();
  assert.match((await h.run({ action: "add", title: "X", parent: "missing" })).content[0]!.text, /parent missing is not a task id/);
  assert.match((await h.run({ action: "add", title: "X", parent: parser!.id })).content[0]!.text, /is a subtask; subtasks nest only one level/);
  assert.match((await h.run({ todos: [{ content: "A", status: "pending", subtasks: [{ content: "B", status: "pending", subtasks: [{ content: "C", status: "pending" }] }] }] })).content[0]!.text,
    /Subtasks cannot have their own subtasks/);
  assert.match((await h.run({ todos: [{ content: "A", status: "pending", subtasks: [{ content: "B", status: "in_progress" }] }, { content: "C", status: "in_progress" }] })).content[0]!.text,
    /Only one task may be in_progress/);
  const tooMany = [{ content: "Big", status: "pending", subtasks: Array.from({ length: 50 }, (_, index) => ({ content: "Step " + index, status: "pending" })) }];
  assert.match((await h.run({ todos: tooMany })).content[0]!.text, /At most 50 tasks including subtasks/);
  assert.deepEqual(h.store.all(), before, "rejected changes leave the list untouched");
  // Replayed events that reference unknown or nested parents are ignored.
  assert.equal(h.store.apply({ v: 1, op: "add", id: "orphan", title: "Orphan", parentId: "nope" }), false);
  assert.equal(h.store.apply({ v: 1, op: "add", id: "deep", title: "Deep", parentId: parser!.id }), false);
  assert.equal(h.store.apply({ v: 1, op: "write", items: [{ id: "a", title: "A", status: "pending", parentId: "b" }, { id: "b", title: "B", status: "pending" }] }), false,
    "a subtask must follow its parent");
  assert.equal(h.store.apply({ v: 1, op: "write", items: [{ id: "a", title: "A", status: "pending" }, { id: "b", title: "B", status: "pending", parentId: "a" }, { id: "c", title: "C", status: "pending", parentId: "b" }] }), false);
  assert.equal(h.store.apply({ v: 1, op: "write", items: [{ id: "a", title: "A", status: "in_progress" }, { id: "b", title: "B", status: "in_progress", parentId: "a" }] }), true,
    "a parent's in_progress is derived, not a second running task");
  assert.equal(h.store.get(parent!.id), undefined);
});

test("v1 events without parents replay exactly as before", () => {
  const store = new TodoStore(() => {});
  const entry = (data: unknown) => ({ type: "custom", customType: TASK_ENTRY, data });
  store.restore([
    entry({ v: 1, op: "write", items: [{ id: "a", title: "A", status: "completed" }, { id: "b", title: "B", status: "in_progress", activeForm: "Doing B" }] }),
    entry({ v: 1, op: "add", id: "c", title: "C", details: "ctx" }),
    entry({ v: 1, op: "status", id: "c", status: "in_progress" }),
    entry({ v: 1, op: "toggle", id: "a", done: false }),
    entry({ v: 1, op: "delete", id: "b" })
  ]);
  assert.deepEqual(store.all(), [
    { id: "a", title: "A", status: "pending", done: false },
    { id: "c", title: "C", status: "in_progress", done: false, details: "ctx" }
  ]);
});

test("subagents return the full checklist in details; the parent session keeps a bounded preview", async () => {
  const todos = [{ content: "Many", status: "pending", subtasks: Array.from({ length: 11 }, (_, index) => ({ content: "Step " + index, status: index ? "pending" : "in_progress" })) }];
  const previous = process.env.PI_JAR_CHILD;
  try {
    delete process.env.PI_JAR_CHILD;
    const parent = await harness().run({ todos });
    assert.equal(parent.details.items.length, 8);
    assert.equal(parent.details.truncated, true);
    assert.deepEqual([parent.details.done, parent.details.total, parent.details.count], [0, 11, 12]);
    process.env.PI_JAR_CHILD = "1";
    const child = await harness().run({ todos });
    assert.equal(child.details.items.length, 12);
    assert.equal(child.details.truncated, undefined);
    assert.equal(child.details.items[5]!.parentId, child.details.items[0]!.id);
    assert.equal(child.details.current, "Many › Step 0");
  } finally {
    if (previous === undefined) delete process.env.PI_JAR_CHILD;
    else process.env.PI_JAR_CHILD = previous;
  }
});

test("checklist rows indent subtasks and show parent progress", () => {
  const plain = (_color: string, text: string) => text;
  assert.equal(todoRow({ id: "p", title: "Parent", status: "in_progress", done: false }, plain, undefined, { done: 1, total: 3 }), "  ◼ Parent (1/3)");
  assert.equal(todoRow({ id: "s", title: "Sub", status: "pending", done: false, parentId: "p" }, plain), "    ☐ Sub");
  assert.equal(todoRow({ id: "l", title: "Leaf", status: "pending", done: false }, plain, undefined, { done: 0, total: 0 }), "  ☐ Leaf");
});
