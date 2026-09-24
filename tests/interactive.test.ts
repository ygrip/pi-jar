import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ComposerStyle, composerIcon, roundedInput, shortSessionId } from "../src/composer.ts";
import piJar from "../extensions/index.ts";
import { promptChoice, promptText, todoView } from "../src/dialogs.ts";
import { TASK_ENTRY, TodoStore, type TodoEvent } from "../src/tasks.ts";
import { registerTaskTool } from "../src/task-tool.ts";
import { WorkingState } from "../src/working.ts";

const theme = { fg: (_color: string, text: string) => text, borderColor: (text: string) => text };

test("working wording follows observed events, sanitizes tool names and stops on motion-off/idle", () => {
  const state = new WorkingState();
  const paint = (_color: string, text: string) => text;
  assert.equal(state.view(true, paint).message, undefined);
  state.start();
  const generating = state.view(true, paint);
  assert.match(generating.message ?? "", /^A spark remains… \(0s\)/);
  assert.match(state.view(true, paint).message ?? "", /A spark remains…/);
  assert.ok(generating.frames.length > 1);
  state.toolStart("one", "\u001b[31mbash\u001b[0m");
  assert.match(state.view(true, paint).message ?? "", /bash/);
  state.toolStart("two", "read");
  state.toolEnd("one");
  assert.match(state.view(false, paint).message ?? "", /read/);
  assert.equal(state.view(false, paint).frames.length, 1);
  state.prompt(true);
  assert.match(state.view(false, paint).message ?? "", /Holding the lantern/);
  state.prompt(false);
  state.toolEnd("two");
  assert.match(state.view(false, paint).message ?? "", /A spark remains…/);
  state.end();
  assert.equal(state.view(false, paint).message, undefined);
  state.start(1_000);
  state.reportOutputTokens(1_700);
  assert.match(state.view(false, paint, 89_000, "medium").message ?? "",
    /There is a way through… \(1m 28s · ↓ 1\.7k tokens · medium effort\)/);
  assert.match(state.view(false, paint, 126_000).message ?? "", /The horizon is clearer now…/);
  state.end();
  state.start(2_000);
  assert.doesNotMatch(state.view(false, paint, 3_000).message ?? "", /tokens/);
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

test("native jar_todo tool tells the agent to track multi-step work and updates branch-aware state", async () => {
  let tool: any;
  let changes = 0;
  const store = new TodoStore(() => {});
  registerTaskTool({ registerTool(definition: unknown) { tool = definition; } } as never, () => store, () => { changes++; });
  assert.ok(tool);
  assert.match(tool.promptGuidelines.join(" "), /without waiting for the user/);
  const added = await tool.execute("one", { action: "add", title: "Inspect repo" }, undefined, undefined, {} as never);
  assert.match(added.content[0].text, /Inspect repo/);
  const id = store.all()[0]!.id;
  await tool.execute("two", { action: "done", id }, undefined, undefined, {} as never);
  assert.equal(store.get(id)?.done, true);
  assert.equal(changes, 2);
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

test("rounded input fits, shows the pet sprite and exposes the short session id", () => {
  const paint = (text: string) => `\x1b[36m${text}\x1b[0m`;
  const lines = ["top", "draft", "bottom"];
  const idle = roundedInput(lines, 40, false, theme as never, paint);
  const focused = roundedInput(lines, 40, true, theme as never, paint, composerIcon("idle"), "abcdef12");
  assert.ok(focused[0]?.includes("▟•ᴗ•▙"));
  assert.ok(focused[0]?.includes("session abcdef12"));
  const widths = new Set<number>();
  for (const phase of ["idle", "generating", "tool", "waiting"] as const) {
    widths.add(visibleWidth(composerIcon(phase, 2)));
    assert.ok(roundedInput(lines, 40, true, theme as never, paint, composerIcon(phase, 2))[0]?.includes(composerIcon(phase, 2)));
  }
  assert.equal(widths.size, 1);
  assert.ok([...widths][0]! > 1);
  assert.equal(shortSessionId("019a0a2b-f81d-7350-8188-abcdef123456"), "abcdef12");
  assert.match(focused[1] ?? "", /│.*draft.*│/);
  assert.match(focused[0] ?? "", /\x1b\[36m/);
  assert.notDeepEqual(idle, focused);
  for (const width of [4, 8, 16, 28, 40]) {
    assert.ok(roundedInput(lines, width, true, theme as never, paint, composerIcon("idle"), "abcdef12").every((line) => visibleWidth(line) <= width));
  }
});

test("composer enable failure restores a previously installed editor", () => {
  const original = () => ({ render: () => ["editor"], getText: () => "draft", setText() {}, invalidate() {}, handleInput() {} });
  let current: Function | undefined = original;
  const style = new ComposerStyle();
  const ctx = { hasUI: true, mode: "tui", sessionManager: { getSessionId: () => "019a0a2b-f81d-7350-8188-abcdef123456" }, ui: {
    getEditorComponent: () => current,
    setEditorComponent: (factory: Function | undefined) => { current = factory; },
    getEditorText: () => "draft",
    setEditorText: () => { throw new Error("test injection"); }
  } };
  assert.equal(style.enable(ctx as never), false);
  assert.equal(current, original);
  assert.equal(style.enabled, false);
});

test("composer restores previous editor and draft, respects later editor owners, and replaces native with rounded input", () => {
  let draft = "keep this draft";
  let current: ((tui: unknown, theme: unknown, keys: unknown) => unknown) | undefined;
  const original = (_tui: unknown, _theme: unknown, _keys: unknown) => ({
    onSubmit: undefined, onChange: undefined, focused: false,
    render: (_width: number) => ["────", "native input", "────"],
    invalidate() {}, handleInput() {}, getText: () => draft, setText: (text: string) => { draft = text; }
  });
  current = original;
  const widgets = new Map<string, Function>();
  const ctx = { hasUI: true, mode: "tui", sessionManager: { getSessionId: () => "019a0a2b-f81d-7350-8188-abcdef123456" }, ui: {
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
  assert.ok(decorated.render(80)[0]?.includes("▟•ᴗ•▙"));
  assert.ok(decorated.render(80)[0]?.includes("session abcdef12"));
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
  assert.notEqual(current, undefined); // CustomEditor preserves Pi's application keybindings
  assert.equal(widgets.size, 0);
  style.disable(ctx as never);
  assert.equal(widgets.size, 0);
});

test("composer icon tracks observed phases, honors motion-off and stops after interruption", async () => {
  let current: Function | undefined = () => ({
    onSubmit: undefined, onChange: undefined, focused: true,
    render: () => ["top", "existing draft", "bottom"],
    getText: () => "existing draft", setText() {}, invalidate() {}, handleInput() {}
  });
  let redraws = 0;
  const tui = { requestRender() { redraws++; } };
  const ctx = { hasUI: true, mode: "tui", sessionManager: { getSessionId: () => "thread-12345678" }, ui: {
    getEditorComponent: () => current,
    setEditorComponent: (factory: Function | undefined) => { current = factory; },
    getEditorText: () => "existing draft", setEditorText() {}
  } };
  const style = new ComposerStyle();
  assert.equal(style.enable(ctx as never), true);
  const editor = current?.(tui, theme, {}) as { render(width: number): string[] };
  const icon = () => editor.render(40)[0] ?? "";
  assert.ok(icon().includes("▟•ᴗ•▙"));
  assert.ok(icon().includes("session 12345678"));
  style.setActivity("generating", true);
  await new Promise((resolve) => setTimeout(resolve, 270));
  assert.ok(redraws > 0);
  assert.ok(icon().includes("▟•o•▙"));
  style.setActivity("tool", false);
  assert.ok(icon().includes("▟>ᴗ<▙"));
  const stopped = redraws;
  await new Promise((resolve) => setTimeout(resolve, 270));
  assert.equal(redraws, stopped);
  style.setActivity("generating", true);
  style.setActivity("idle", true); // interrupted
  assert.ok(icon().includes("▟•ᴗ•▙"));
  const stoppedAfterInterrupt = redraws;
  await new Promise((resolve) => setTimeout(resolve, 270));
  assert.equal(redraws, stoppedAfterInterrupt);
  style.disable(ctx as never);
  assert.match(editor.render(40)[1] ?? "", /existing draft/);
});
