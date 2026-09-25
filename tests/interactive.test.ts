import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ComposerStyle, composerIcon, roundedInput, sessionDisplayName } from "../src/composer.ts";
import { Mascot, SLEEPY_AFTER_MS } from "../src/mascot.ts";
import { SuggestionState } from "../src/suggest.ts";
import { installCompactBuiltinTools } from "../src/compact-tools.ts";
import piJar from "../extensions/index.ts";
import { promptChoice, promptText, todoView } from "../src/dialogs.ts";
import { TASK_ENTRY, TodoStore, type TodoEvent } from "../src/tasks.ts";
import { registerTaskTool } from "../src/task-tool.ts";
import { WorkingState } from "../src/working.ts";

const theme = { fg: (_color: string, text: string) => text, borderColor: (text: string) => text };
const plainLines = (lines: readonly string[]) => lines.map(stripTerminalSequences);
/** The framed title row (the tip row, when present, sits above it). */
const titleRow = (lines: readonly string[]) => plainLines(lines).find((line) => line.startsWith("╭")) ?? "";

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

test("extension reconstructs pi-jar tasks on session branch navigation without touching other task managers", async () => {
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

test("jar_todo writes the full list like Claude: statuses, one in progress, stable ids, replay", async () => {
  let tool: any;
  const events: unknown[] = [];
  const store = new TodoStore((event) => { events.push(event); });
  registerTaskTool({ registerTool(definition: unknown) { tool = definition; } } as never, () => store, () => {});
  const write = (todos: unknown[]) => tool.execute("w", { todos }, undefined, undefined, {} as never);
  const first = await write([
    { content: "Inspect repo", status: "in_progress", activeForm: "Inspecting repo" },
    { content: "Fix bug", status: "pending", activeForm: "Fixing bug" },
    { content: "Run tests", status: "pending" }
  ]);
  assert.match(first.content[0].text, /0\/3 done · now: Inspect repo/);
  assert.equal(store.current()?.activeForm, "Inspecting repo");
  const id = store.all()[0]!.id;
  await write([
    { content: "Inspect repo", status: "completed" },
    { content: "Fix bug", status: "in_progress", activeForm: "Fixing bug" },
    { content: "Run tests", status: "pending" }
  ]);
  assert.equal(store.all()[0]!.id, id, "same title keeps its id");
  assert.deepEqual(store.all().map((item) => item.status), ["completed", "in_progress", "pending"]);
  assert.equal(store.all()[0]!.done, true);
  const rejected = await write([{ content: "A", status: "in_progress" }, { content: "B", status: "in_progress" }]);
  assert.match(rejected.content[0].text, /Only one task may be in_progress/);
  assert.equal(store.all().length, 3, "invalid writes change nothing");
  // start parks the previous in-progress task.
  await tool.execute("s", { action: "start", id: store.all()[2]!.id }, undefined, undefined, {} as never);
  assert.deepEqual(store.all().map((item) => item.status), ["completed", "pending", "in_progress"]);
  const replay = new TodoStore(() => {});
  replay.restore(events.map((data) => ({ type: "custom", customType: TASK_ENTRY, data })));
  assert.deepEqual(replay.all(), store.all());
  // v1 toggle events still replay as completed.
  const legacy = new TodoStore(() => {});
  legacy.restore([{ type: "custom", customType: TASK_ENTRY, data: { v: 1, op: "add", id: "x1", title: "Old" } },
    { type: "custom", customType: TASK_ENTRY, data: { v: 1, op: "toggle", id: "x1", done: true } }]);
  assert.equal(legacy.get("x1")?.status, "completed");
  // The rendered result is the checklist.
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const text = tool.renderResult({ details: { items: store.all() } }, { expanded: false, isPartial: false }, theme).render(80).join("\n");
  assert.match(text, /✔ .*Inspect repo/);
  assert.match(text, /◼ Run tests/);
  assert.match(text, /☐ Fix bug/);
});

test("working message shows the running task's active form", () => {
  const state = new WorkingState();
  state.start(0);
  assert.match(state.view(false, (_c, t) => t, 1000, undefined, "Running the tests").message ?? "", /^Running the tests… \(1s\)/);
  assert.match(state.view(false, (_c, t) => t, 1000).message ?? "", /A spark remains/);
});

test("task dialog is keyboard-accessible, width bounded and filters without deleting another manager's state", async () => {
  let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
  const ctx = {
    hasUI: true, mode: "tui", ui: { custom(factory: Function) {
      return new Promise((resolve) => { component = factory({ requestRender() {} }, theme, {}, resolve); });
    } }
  };
  const filter = { value: "all" as const } as { value: "all" | "open" | "done" };
  const pending = todoView(ctx as never, () => [{ id: "one", title: "Write tests", done: false, status: "pending" as const }], filter);
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

test("pi-jar dialogs accept mouse clicks on choices and to-do rows", async () => {
  let component: any;
  const ctx = { hasUI: true, mode: "tui", ui: { custom(factory: Function) {
    return new Promise((resolve) => { component = factory({ requestRender() {} }, theme, {}, resolve); });
  } } };
  const choice = promptChoice(ctx as never, "Choice", "A wrapped question about the choice", ["First", "Second"]);
  const rows: string[] = component.render(22);
  const second = rows.findIndex((line) => line.includes("Second"));
  component.handleMouse({ type: "click", button: "left", x: 5, y: second });
  assert.equal(await choice, 1);
  const toggled = todoView(ctx as never, () => [{ id: "a", title: "Clicked", done: false, status: "pending" as const }], { value: "all" });
  component.render(40);
  component.handleMouse({ type: "click", button: "left", x: 4, y: 1 });
  assert.deepEqual(await toggled, { kind: "toggle", id: "a" });
});

test("does not claim Pi's built-in Ctrl+E cursor-line-end shortcut", () => {
  const shortcuts = new Map<string, unknown>();
  piJar({ on() {}, registerCommand() {}, registerShortcut(key: string, options: unknown) {
    shortcuts.set(key, options);
  } } as never);
  assert.equal(shortcuts.has("ctrl+e"), false);
  assert.equal(shortcuts.has("ctrl+alt+s"), true);
});

test("default Pi tools keep native metadata while collapsed cards stay brief", () => {
  const definitions: any[] = [];
  installCompactBuiltinTools({ registerTool(definition: unknown) { definitions.push(definition); } } as never);
  assert.deepEqual(definitions.map((tool) => tool.name), ["read", "bash", "edit", "write"]);
  const colors = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

  for (const tool of definitions) {
    assert.ok(tool.parameters);
    assert.equal(typeof tool.execute, "function");
    assert.ok(tool.promptSnippet, `${tool.name} prompt snippet preserved`);
  }

  const bash = definitions.find((tool) => tool.name === "bash")!;
  const bashResult = { content: [{ type: "text", text: "first log line\nsecond log line" }] };
  const bashCollapsed = bash.renderResult(bashResult, { expanded: false, isPartial: false }, colors, {}).render(120).join("\n");
  assert.match(bashCollapsed, /\[ expand \].*Ctrl\+O/);
  assert.doesNotMatch(bashCollapsed, /second log line/);
  initTheme("dark", false);
  const bashExpanded = bash.renderResult(bashResult, { expanded: true, isPartial: false }, colors, { state: {}, invalidate() {}, showImages: false }).render(120).join("\n");
  assert.match(bashExpanded, /second log line/);
  assert.doesNotMatch(bashExpanded, /\[ expand \]/);

  const edit = definitions.find((tool) => tool.name === "edit")!;
  const editResult = { content: [{ type: "text", text: "Applied" }], details: { diff: "@@\n-old\n+new" } };
  const editCollapsed = edit.renderResult(editResult, { expanded: false, isPartial: false }, colors, {}).render(120).join("\n");
  assert.match(editCollapsed, /\+1.*-1/);
  assert.doesNotMatch(editCollapsed, /\+new/);

  const write = definitions.find((tool) => tool.name === "write")!;
  const writeCollapsed = write.renderCall({ path: "pet.ts", content: "one\ntwo" }, colors, { expanded: false }).render(120).join("\n");
  assert.match(writeCollapsed, /2 lines/);
  assert.doesNotMatch(writeCollapsed, /two/);
});

test("rounded input fits, shows the ember face and exposes a human session label", () => {
  const paint = (text: string) => `\x1b[36m${text}\x1b[0m`;
  const lines = ["────", "draft", "────"];
  const idle = roundedInput(lines, 40, false, theme as never, paint);
  const focused = roundedInput(lines, 40, true, theme as never, paint, composerIcon("idle"), "ember-trail");
  assert.ok(focused[0]?.includes("(•ᴗ•)"));
  assert.ok(focused[0]?.includes("session ember-trail"));
  const widths = new Set<number>();
  for (const phase of ["idle", "generating", "tool", "waiting"] as const) {
    widths.add(visibleWidth(composerIcon(phase, 1)));
    assert.ok(roundedInput(lines, 40, true, theme as never, paint, composerIcon(phase, 1))[0]?.includes(composerIcon(phase, 1)));
  }
  assert.equal(widths.size, 1, "every expression has the same width");
  assert.notEqual(composerIcon("generating", 0), composerIcon("generating", 1), "expressions change while generating");
  assert.notEqual(composerIcon("tool"), composerIcon("idle"));
  assert.equal(sessionDisplayName("Welcome polish", "019a0a2b-f81d-7350-8188-abcdef123456"), "Welcome polish");
  const fallback = sessionDisplayName(undefined, "019a0a2b-f81d-7350-8188-abcdef123456");
  assert.match(fallback, /^[a-z]+-[a-z]+$/);
  assert.equal(fallback, sessionDisplayName(undefined, "019a0a2b-f81d-7350-8188-abcdef123456"));
  assert.doesNotMatch(fallback, /abcdef|123456/);
  assert.match(focused[1] ?? "", /│.*draft.*│/);
  assert.match(focused[0] ?? "", /\x1b\[36m/);
  assert.notDeepEqual(idle, focused);
  for (const width of [4, 8, 16, 28, 40]) {
    assert.ok(roundedInput(lines, width, true, theme as never, paint, composerIcon("idle"), "ember-trail").every((line) => visibleWidth(line) <= width));
  }
});

test("rounded input keeps autocomplete rows below the frame and overflow labels in the borders", () => {
  const lines = ["─── ↑ 2 more ───", "line a", "line b", "─── ↓ 1 more ───", "  /plan   Plan mode", "  /goal   Goal mode"];
  const framed = plainLines(roundedInput(lines, 60, true, theme as never, undefined, composerIcon("idle"), "s", { hint: "⏎ send" }));
  assert.equal(framed.length, 6);
  assert.match(framed[0]!, /^╭─ \(•ᴗ•\) · session s .*↑ 2 more ─╮$/);
  assert.match(framed[1]!, /^│line a\s+│$/);
  assert.match(framed[3]!, /^╰─ ↓ 1 more ─+ ⏎ send ─╯$/);
  assert.equal(framed[4], "   /plan   Plan mode", "autocomplete rows are not wrapped as editor content");
  assert.equal(framed[5], "   /goal   Goal mode");
  assert.ok(framed.every((line) => visibleWidth(line) <= 60));
});

test("empty composer shows a dim ghost suggestion after the cursor", () => {
  const cursor = "\x1b[7m \x1b[0m";
  const dim = (text: string) => `<${text}>`;
  const framed = roundedInput(["────", cursor + " ".repeat(30), "────"], 40, true, theme as never, undefined, composerIcon("idle"), "", { ghost: "Run the full test suite", dim });
  assert.match(framed[1]!, /│\x1b\[7m \x1b\[0m<Run the full test suite …>│|│\x1b\[7m \x1b\[0m<Run the full test suite\s+⇥ tab>\s*│/);
  assert.ok(framed.every((line) => visibleWidth(line) <= 40));
  const typed = roundedInput(["────", "hello" + " ".repeat(20), "────"], 40, true, theme as never, undefined, composerIcon("idle"), "", { ghost: "x", dim });
  assert.doesNotMatch(typed[1]!, /<x/, "no ghost once the cursor row has text without the empty cursor");
});

test("composer enable failure restores a previously installed editor", () => {
  const original = () => ({ render: () => ["editor"], getText: () => "draft", setText() {}, invalidate() {}, handleInput() {} });
  let current: Function | undefined = original;
  const style = new ComposerStyle();
  const ctx = { hasUI: true, mode: "tui", sessionManager: {
    getSessionId: () => "019a0a2b-f81d-7350-8188-abcdef123456",
    getSessionName: () => "Welcome polish"
  }, ui: {
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
  const ctx = { hasUI: true, mode: "tui", sessionManager: {
    getSessionId: () => "019a0a2b-f81d-7350-8188-abcdef123456",
    getSessionName: () => "Welcome polish"
  }, ui: {
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
  assert.ok(titleRow(decorated.render(80)).includes("(•ᴗ•)"));
  assert.ok(titleRow(decorated.render(80)).includes("session Welcome polish"));
  assert.match(plainLines(decorated.render(80))[0]!, /^ {3,5}[▴▲∙*·ˇ★]/, "flame tips perch above the face");
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

test("regular composer never captures terminal mouse reporting or scrollback", () => {
  let factory: Function | undefined = () => ({
    render: () => ["top", "draft", "bottom"],
    getText: () => "draft", setText() {}, handleInput() {}, invalidate() {}
  });
  const writes: string[] = [];
  let listeners = 0;
  const tui = { mode: "regular", terminal: { write(value: string) { writes.push(value); } },
    requestRender() {}, addInputListener() { listeners++; return () => {}; }
  };
  const ctx = { hasUI: true, mode: "tui", sessionManager: {}, ui: {
    getEditorComponent: () => factory, setEditorComponent(value: Function | undefined) { factory = value; },
    getEditorText: () => "draft", setEditorText() {}
  } };
  const style = new ComposerStyle();
  assert.equal(style.enable(ctx as never), true);
  const editor = factory?.(tui, theme, {}) as { render(width: number): string[] };
  assert.ok(titleRow(editor.render(40)).includes("(•ᴗ•)"));
  style.disable(ctx as never);
  assert.equal(listeners, 0);
  assert.deepEqual(writes, [], "terminal owns its mouse wheel and selection");
});

test("composer face tracks observed phases, refreshes session title, honors motion-off and stops after interruption", async () => {
  let current: Function | undefined = () => ({
    onSubmit: undefined, onChange: undefined, focused: true,
    render: () => ["────", "existing draft", "────"],
    getText: () => "existing draft", setText() {}, invalidate() {}, handleInput() {}
  });
  let redraws = 0;
  let sessionName = "Welcome polish";
  const tui = { requestRender() { redraws++; } };
  const ctx = { hasUI: true, mode: "tui", sessionManager: {
    getSessionId: () => "thread-12345678",
    getSessionName: () => sessionName
  }, ui: {
    getEditorComponent: () => current,
    setEditorComponent: (factory: Function | undefined) => { current = factory; },
    getEditorText: () => "existing draft", setEditorText() {}
  } };
  const style = new ComposerStyle();
  assert.equal(style.enable(ctx as never), true);
  const editor = current?.(tui, theme, {}) as { render(width: number): string[] };
  const title = () => titleRow(editor.render(40));
  assert.ok(title().includes("(•ᴗ•)") || title().includes("(-ᴗ-)"));
  assert.ok(title().includes("session Welcome polish"));
  sessionName = "Flame pass";
  style.refreshSession(ctx as never);
  assert.ok(title().includes("session Flame pass"));
  style.setActivity("generating", true);
  await new Promise((resolve) => setTimeout(resolve, 520));
  assert.ok(redraws > 0, "flame tips flicker while generating");
  assert.match(title(), /\((\^ᴗ\^|°ᴗ°)\)/);
  style.setActivity("tool", false);
  assert.ok(title().includes("(•ᴗ•)"), "motion-off shows a calm face");
  const stopped = redraws;
  await new Promise((resolve) => setTimeout(resolve, 520));
  assert.equal(redraws, stopped, "motion-off stops the timer");
  style.setActivity("tool", true);
  assert.ok(title().includes("(>ᴗ<)"));
  style.flash("error", 1000);
  assert.ok(title().includes("(×_×)"));
  style.setMascot(false);
  style.setActivity("idle", true); // interrupted
  const stoppedAfterInterrupt = redraws;
  await new Promise((resolve) => setTimeout(resolve, 520));
  assert.equal(redraws, stoppedAfterInterrupt, "idle without a mascot needs no timer");
  assert.doesNotMatch(title(), /ᴗ/, "mascot off hides the face");
  style.disable(ctx as never);
  assert.match(editor.render(40)[1] ?? "", /existing draft/);
});

test("ember mascot blinks, gets sleepy when idle and shows transient moods", () => {
  const mascot = new Mascot(0, () => 0);
  assert.equal(mascot.mood(10), "idle");
  assert.equal(mascot.mood(3050), "blink");
  assert.equal(mascot.mood(3400), "idle");
  assert.equal(mascot.mood(SLEEPY_AFTER_MS + 1), "sleepy");
  mascot.setPhase("tool", SLEEPY_AFTER_MS + 2);
  assert.equal(mascot.mood(SLEEPY_AFTER_MS + 3), "tool");
  mascot.flash("complete", 100, SLEEPY_AFTER_MS + 4);
  assert.equal(mascot.face(SLEEPY_AFTER_MS + 5), "(★ᴗ★)");
  assert.equal(mascot.mood(SLEEPY_AFTER_MS + 200), "tool");
  for (let frame = 0; frame < 6; frame++) assert.equal(visibleWidth(mascot.tip(0, frame)), 5);
});

test("native composer auto-expands, accepts ghost suggestions with Tab and maps clicks below the perched mascot", () => {
  let current: Function | undefined;
  const suggestions = new SuggestionState();
  const ctx = { hasUI: true, mode: "tui", sessionManager: {}, ui: {
    getEditorComponent: () => current, setEditorComponent(value: Function | undefined) { current = value; },
    getEditorText: () => "", setEditorText() {}
  } };
  const style = new ComposerStyle();
  style.attachSuggestions(suggestions);
  assert.equal(style.enable(ctx as never), true);
  const tui = { requestRender() {}, terminal: { rows: 20, columns: 80 } };
  const keys = { matches: () => false };
  const editor = current?.(tui, { borderColor: (text: string) => text, selectList: {} }, keys) as any;
  suggestions.set("Run the full test suite");
  let lines = plainLines(editor.render(60));
  assert.match(lines.join("\n"), /Run the full test suite/);
  assert.match(lines.join("\n"), /⇥ accept/);
  editor.handleInput("\t");
  assert.equal(editor.getText(), "Run the full test suite");
  assert.equal(suggestions.text, undefined, "accepting clears the ghost");
  editor.setText(Array.from({ length: 12 }, (_, index) => "line " + index).join("\n"));
  lines = plainLines(editor.render(60));
  const content = lines.filter((line) => /^│line \d+/.test(line)).length;
  assert.ok(content > 6, `drafts grow past Pi's 30% cap (${content} rows)`);
  assert.equal(tui.terminal.rows, 20, "the terminal proxy is restored");
  editor.setText("abcdef\nsecond");
  lines = plainLines(editor.render(60));
  const row = lines.findIndex((line) => line.startsWith("│second"));
  const result = editor.handleMouse({ type: "click", button: "left", x: 4, y: row, screenX: 4, screenY: row, width: 60, height: lines.length, shift: false, alt: false, ctrl: false });
  assert.ok(result?.handled);
  editor.handleInput("X");
  assert.equal(editor.getText(), "abcdef\nsecXond", "click places the cursor at the pointed cell");
  const poke = editor.handleMouse({ type: "click", button: "left", x: 4, y: 1, screenX: 4, screenY: 1, width: 60, height: lines.length, shift: false, alt: false, ctrl: false });
  assert.ok(poke?.handled, "clicking the face pokes the mascot");
  assert.match(titleRow(editor.render(60)), /\(\^o\^\)/);
  assert.equal(editor.handleMouse({ type: "drag", button: "left", x: 4, y: row, screenX: 4, screenY: row, width: 60, height: 9, shift: false, alt: false, ctrl: false }), undefined, "drags stay with Pi's selection");
  style.disable(ctx as never);
});

