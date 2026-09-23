import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ComposerStyle } from "../src/composer.ts";
import piJar from "../extensions/index.ts";
import { promptChoice, promptText, todoView } from "../src/dialogs.ts";
import { TASK_ENTRY, TodoStore, type TodoEvent } from "../src/tasks.ts";
import { WorkingState } from "../src/working.ts";

const theme = { fg: (_color: string, text: string) => text, borderColor: (text: string) => text };

test("working wording follows observed events, sanitizes tool names and stops on motion-off/idle", () => {
  const state = new WorkingState();
  const paint = (_color: string, text: string) => text;
  assert.equal(state.view(true, paint).message, undefined);
  state.start();
  const generating = state.view(true, paint);
  assert.match(generating.message ?? "", /Considering/);
  assert.ok(generating.frames.length > 1);
  state.toolStart("one", "\u001b[31mbash\u001b[0m");
  assert.match(state.view(true, paint).message ?? "", /bash/);
  state.toolStart("two", "read");
  state.toolEnd("one");
  assert.match(state.view(false, paint).message ?? "", /read/);
  assert.equal(state.view(false, paint).frames.length, 1);
  state.prompt(true);
  assert.match(state.view(false, paint).message ?? "", /Waiting/);
  state.prompt(false);
  state.toolEnd("two");
  assert.match(state.view(false, paint).message ?? "", /Considering/);
  state.end();
  assert.equal(state.view(false, paint).message, undefined);
});

test("pi-jar to-dos replay only valid active-branch entries and persist edits/toggles/deletions", () => {
  const entries: { type: string; customType: string; data: TodoEvent }[] = [];
  const store = new TodoStore((data) => entries.push({ type: "custom", customType: TASK_ENTRY, data }));
  const first = store.add("Ship UI");
  const second = store.add("Review API");
  assert.ok(first && second && first.id !== second.id);
  assert.equal(store.toggle(first.id), true);
  assert.equal(store.edit(second.id, "Review public API"), true);
  assert.equal(store.delete(second.id), true);
  assert.deepEqual(store.all().map(({ title, done }) => [title, done]), [["Ship UI", true]]);
  const fork = new TodoStore(() => {});
  fork.restore([...entries.slice(0, 2), { type: "custom", customType: TASK_ENTRY, data: { v: 99, op: "add", id: "bad", title: "injected" } }]);
  assert.deepEqual(fork.all().map((item) => item.title), ["Ship UI", "Review API"]);
  const reload = new TodoStore(() => {});
  reload.restore([...entries, { type: "custom", customType: "other-tasks", data: entries[0]!.data }]);
  assert.deepEqual(reload.all().map(({ title, done }) => [title, done]), [["Ship UI", true]]);
  assert.equal(reload.toggle("nonexistent"), false);
  const broken = new TodoStore(() => { throw new Error("persistence unavailable"); });
  assert.equal(broken.add("Should not appear"), undefined);
  assert.deepEqual(broken.all(), []);
});

test("extension reconstructs pi-jar tasks on session branch navigation without touching Team Mode", async () => {
  const events = new Map<string, Function>();
  let command: Function | undefined;
  let branch: { type: string; customType: string; data: TodoEvent }[] = [];
  const notices: string[] = [];
  piJar({
    on: (name: string, handler: Function) => { events.set(name, handler); },
    appendEntry: (kind: string, event: TodoEvent) => { branch.push({ type: "custom", customType: kind, data: event }); },
    registerCommand: (_name: string, options: { handler: Function }) => { command = options.handler; }
  } as unknown as Parameters<typeof piJar>[0]);
  const ctx = {
    mode: "rpc", hasUI: true,
    sessionManager: { getBranch: () => branch },
    ui: { notify: (text: string) => { notices.push(text); } }
  };
  events.get("session_start")?.({}, ctx);
  await command?.("tasks add First", ctx);
  const original = [...branch];
  await command?.("tasks list", ctx);
  assert.match(notices.at(-1) ?? "", /First/);
  branch = [];
  events.get("session_tree")?.({}, ctx);
  await command?.("tasks list", ctx);
  assert.match(notices.at(-1) ?? "", /empty/);
  branch = original;
  events.get("session_tree")?.({}, ctx);
  await command?.("tasks list", ctx);
  assert.match(notices.at(-1) ?? "", /First/);
  events.get("session_shutdown")?.({}, ctx);
});

test("task dialog is keyboard-accessible, width bounded and filters without deleting another manager's state", async () => {
  let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
  const ctx = {
    hasUI: true, mode: "tui", ui: { custom(factory: Function) {
      return new Promise((resolve) => { component = factory({ requestRender() {} }, theme, {}, resolve); });
    } }
  };
  const filter = { value: "all" as const } as { value: "all" | "open" | "done" };
  const pending = todoView(ctx as never, () => [{ id: "one", title: "Write tests", done: false }], filter);
  assert.ok(component?.render(16).every((line) => visibleWidth(line) <= 16));
  assert.match(component?.render(80).join(" ") ?? "", /☐ Write tests/);
  component?.handleInput("f");
  assert.equal(filter.value, "open");
  component?.handleInput(" ");
  assert.deepEqual(await pending, { kind: "toggle", id: "one" });
  const cancelled = promptChoice(ctx as never, "Delete?", "Write tests", ["Delete", "Keep"], 1);
  assert.match(component?.render(40).join(" ") ?? "", /Keep/);
  component?.handleInput("\u001b");
  assert.equal(await cancelled, undefined);
  const answer = promptText(ctx as never, "Question", "Your answer?");
  component?.handleInput("y");
  component?.handleInput("e");
  component?.handleInput("s");
  component?.handleInput("\r");
  assert.equal(await answer, "yes");
});

test("composer enable failure restores a previously installed editor", () => {
  const original = () => ({ render: () => ["editor"], getText: () => "draft", setText() {}, invalidate() {}, handleInput() {} });
  let current: Function | undefined = original;
  const style = new ComposerStyle();
  const ctx = { hasUI: true, mode: "tui", ui: {
    getEditorComponent: () => current,
    setEditorComponent: (factory: Function | undefined) => { current = factory; },
    getEditorText: () => "draft",
    setEditorText: () => { throw new Error("test injection"); }
  } };
  assert.equal(style.enable(ctx as never), false);
  assert.equal(current, original);
  assert.equal(style.enabled, false);
});

test("composer restores previous editor and draft, respects later editor owners, and keeps native fallback", () => {
  let draft = "keep this draft";
  let current: ((tui: unknown, theme: unknown, keys: unknown) => unknown) | undefined;
  const original = (_tui: unknown, _theme: unknown, _keys: unknown) => ({
    onSubmit: undefined, onChange: undefined, focused: false,
    render: (_width: number) => ["native input"],
    invalidate() {}, handleInput() {}, getText: () => draft, setText: (text: string) => { draft = text; }
  });
  current = original;
  const widgets = new Map<string, Function>();
  const ctx = { hasUI: true, mode: "tui", ui: {
    getEditorComponent: () => current,
    setEditorComponent: (factory: typeof current) => { current = factory; },
    getEditorText: () => draft,
    setEditorText: (value: string) => { draft = value; },
    setWidget: (key: string, factory: Function | undefined) => {
      if (factory) widgets.set(key, factory); else widgets.delete(key);
    }
  } };
  const style = new ComposerStyle();
  assert.equal(style.enable(ctx as never), true);
  assert.notEqual(current, original);
  assert.equal(draft, "keep this draft");
  const decorated = current?.({}, theme, {}) as { render(width: number): string[]; setText(text: string): void };
  assert.ok(decorated.render(80).join(" ").includes("pi-jar"));
  decorated.setText("editing");
  style.disable(ctx as never);
  assert.equal(current, original);
  assert.equal(draft, "editing");
  style.enable(ctx as never);
  const newer = () => original({}, theme, {});
  current = newer;
  style.disable(ctx as never);
  assert.equal(current, newer); // do not clobber another extension
  current = undefined;
  assert.equal(style.enable(ctx as never), true);
  assert.equal(current, undefined); // never replace Pi's unexposed built-in editor
  assert.ok(widgets.has("pi-jar.composer"));
  style.disable(ctx as never);
  assert.equal(widgets.size, 0);
});
