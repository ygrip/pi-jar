import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { openActivityView, type ActivitySources, type ActivityTarget } from "../src/activity-view.ts";
import { DelegateRegistry, registerDelegate } from "../src/delegate.ts";
import { ShellManager } from "../src/shells.ts";
import { emit, fakeChild, fakeSpawn, say, settle, taskOf, type FakeChild } from "./fake-rpc.ts";

/** jar_delegate with two subagents: "api" keeps working, "docs" finishes with a report. */
async function subagents() {
  const registry = new DelegateRegistry();
  let tool: { execute(id: string, params: object, signal: AbortSignal, onUpdate: undefined, ctx: object): Promise<{ content: Array<{ text: string }> }> } | undefined;
  const { spawn, children } = fakeSpawn((child, prompt) => {
    emit(child, { type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "npm test" } });
    emit(child, { type: "tool_execution_update", toolCallId: "b1", toolName: "bash", partialResult: { content: [{ type: "text", text: "3 passing\nall green" }] } });
    if (taskOf(prompt).includes("docs")) { say(child, "Docs are fine."); settle(child); }
  });
  registerDelegate({ registerTool(definition: typeof tool & { name?: string }) { if (definition?.name === "jar_delegate") tool = definition; } } as never,
    { resolve: () => undefined } as never, registry, { spawnProcess: spawn as never });
  const controller = new AbortController();
  const pending = tool!.execute("d", { tasks: [{ task: "scan the api", name: "api" }, { task: "check the docs", name: "docs" }] }, controller.signal, undefined, { cwd: "/repo", hasUI: false });
  await tick(); await tick();
  return { registry, children, pending, abort: () => controller.abort() };
}

function shells(lines = 1) {
  const children: FakeChild[] = [];
  const manager = new ShellManager(() => {}, (() => { const child = fakeChild(); children.push(child); return child; }) as never);
  manager.start({ command: "npm run dev", cwd: "/repo", name: "dev" });
  children[0]!.stdout.emit("data", Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
  return { manager, children };
}

interface View { render(width: number): string[]; handleInput(data: string): void; handleMouse(event: TuiMouseEvent): unknown }
function mount(sources: ActivitySources, initial?: ActivityTarget) {
  let view: View | undefined;
  let renders = 0;
  let closed = false;
  let customs = 0;
  const notes: string[] = [];
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const ctx = {
    hasUI: true, mode: "tui",
    ui: {
      notify(message: string) { notes.push(message); },
      custom(factory: (tui: { requestRender(): void }, theme: unknown, keys: unknown, done: () => void) => View) {
        customs++;
        const closing = new EventEmitter();
        view = factory({ requestRender() { renders++; } }, theme, {}, () => { closed = true; closing.emit("done"); });
        return once(closing, "done");
      }
    }
  } as unknown as ExtensionContext;
  const opened = openActivityView(ctx, sources, initial);
  const lines = (width = 100) => view!.render(width);
  return {
    opened, notes, lines, customs: () => customs, renders: () => renders, closed: () => closed,
    input: (...data: string[]) => { for (const key of data) view!.handleInput(key); },
    mouse: (event: Partial<TuiMouseEvent>) => view!.handleMouse({ type: "click", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 100, height: 30, shift: false, alt: false, ctrl: false, ...event }),
    text: (width = 100) => lines(width).join("\n"),
    /** Left-pane rows at width 100, trimmed. */
    list: () => lines(100).slice(1).map((line) => line.split("│")).filter((parts) => parts.length === 4).map((parts) => parts[1]!.slice(1).trimEnd()),
    row: (pattern: RegExp) => lines(100).findIndex((line) => pattern.test(line))
  };
}

const EXTERNAL = [{ id: "reviewer", name: "Reviewer", state: "working", task: "review the PR" }, { id: "delegate-1-1", name: "api", state: "working" }];

test("the activity view groups work under headers, stays bounded at every width, and moves past headers", async () => {
  const agents = await subagents();
  const shell = shells();
  try {
    const view = mount({ subagents: agents.registry, shells: shell.manager, roles: () => EXTERNAL });
    for (const width of [24, 80, 140]) {
      const lines = view.lines(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}: every line fits`);
      if (width > 24) assert.match(lines[0]!, /ACTIVITY · 3 running/);
    }
    assert.match(view.text(24), /‹ 1\/4 ● api ›/, "narrow terminals get a pager row instead of the list");
    assert.deepEqual(view.list().filter(Boolean), ["⧉ SUBAGENTS", "▌● api", " ○ docs", "⚙ SHELLS", " ● s1 dev", "⇄ ROLES", " ● Reviewer"],
      "working and idle retained agents stay together; our own subagent's role status is not listed twice");
    const body = view.text();
    assert.match(body, /api · scout/);
    assert.match(body, /● working · \ds · 1 tool · 0 turns · \$0\.000/);
    assert.match(body, /▸ TASK  scan the api/, "the task starts collapsed to one line");
    assert.match(body, /▸ ● bash npm test · running/, "tool calls start collapsed");
    assert.doesNotMatch(body, /3 passing/, "collapsed output is not rendered");
    view.input("j");
    assert.match(view.text(), /▾ REPORT[\s\S]*Docs are fine\./);
    assert.doesNotMatch(view.text(), /◆ Docs are fine/, "the final message is shown once, as the report");
    view.input("\x1b[B");
    assert.equal(view.list()[4], "▌● s1 dev", "down skips the SHELLS header");
    assert.match(view.text(), /\$ npm run dev[\s\S]*line 1/);
    view.input("j", "j");
    assert.equal(view.list()[6], "▌● Reviewer", "the last row stays selected");
    assert.match(view.text(), /review the PR/);
    for (let press = 0; press < 5; press++) view.input("k");
    assert.equal(view.list()[1], "▌● api", "up stops at the first entry, never on a header");
    view.input("q");
    await view.opened;
  } finally { agents.abort(); shell.manager.dispose(); }
});

test("each transcript entry expands and collapses on its own, by keyboard or click", async () => {
  const agents = await subagents();
  try {
    const view = mount({ subagents: agents.registry });
    view.lines();
    view.input("\t");
    assert.match(view.text(), /❯ ▸ ● bash npm test/, "tab moves into the transcript with the newest entry selected");
    assert.match(view.text(), /↑↓ step/);
    view.input("\r");
    let body = view.text();
    assert.match(body, /▾ ● bash npm test[\s\S]*"command": "npm test"[\s\S]*3 passing[\s\S]*all green/, "Enter shows the arguments and output");
    assert.match(body, /▸ TASK/, "other entries stay collapsed");
    view.input("k", " ");
    body = view.text();
    assert.match(body, /❯ ▾ TASK[\s\S]*scan the api/);
    assert.match(body, /3 passing/, "the tool call stays expanded");
    view.input("j", "\r");
    assert.doesNotMatch(view.text(), /3 passing/, "Enter again collapses it");
    const header = view.row(/▸ TASK|▾ TASK/);
    view.mouse({ x: 40, y: header });
    assert.match(view.text(), /▸ TASK  scan the api/, "a click on an entry's first row toggles it");
    view.input("\x1b");
    assert.match(view.text(), /↑↓ select/, "Esc leaves the transcript before it closes the view");
    view.input("\x1b");
    await view.opened;
  } finally { agents.abort(); }
});

test("a working subagent is steered from its details; typing never triggers view keys", async () => {
  const agents = await subagents();
  try {
    const view = mount({ subagents: agents.registry });
    assert.match(view.text(), /› s {2}steer this subagent/);
    view.input("s");
    assert.match(view.text(), /› steer: █/);
    view.input("q", "x", " ", "f", "o", "c", "u", "s");
    assert.equal(view.closed(), false, "q is typed, not a close");
    assert.deepEqual(agents.children[0]!.killed, [], "x is typed, not a stop");
    view.input("\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "look at auth\nfirst");
    assert.match(view.text(), /› steer: look at auth first█/, "pasted line breaks become spaces");
    view.input("\r");
    assert.deepEqual(agents.children[0]!.stdin.commands.at(-1), { type: "steer", message: "look at auth first" });
    assert.match(view.text(), /› you: look at auth first/);
    assert.match(view.text(), /steered 1×/);
    view.input("s", "never mind", "\x1b");
    assert.equal(agents.children[0]!.stdin.commands.filter((command) => command.type === "steer").length, 1, "Esc cancels the draft");
    view.mouse({ x: 10, y: view.row(/› s {2}steer/) });
    assert.match(view.text(), /› steer: never mind█/, "clicking the input row focuses it and keeps the draft");
    view.input("\x1b", "\x1b");
    view.input("j");
    assert.match(view.text(), /steering works while a subagent is running/, "finished subagents cannot be steered");
    view.input("s");
    assert.doesNotMatch(view.text(), /› steer:/);
    view.input("q");
    await view.opened;
  } finally { agents.abort(); }
});

test("a subagent's own checklist shows with subtasks and per-task progress", async () => {
  const registry = new DelegateRegistry();
  let tool: { execute(id: string, params: object, signal: undefined, onUpdate: undefined, ctx: object): Promise<unknown> } | undefined;
  const { spawn } = fakeSpawn((child) => {
    emit(child, { type: "tool_execution_start", toolCallId: "t", toolName: "jar_todo", args: {} });
    emit(child, { type: "tool_execution_end", toolCallId: "t", toolName: "jar_todo", isError: false, result: { content: [], details: { items: [
      { id: "p", title: "Audit routes", status: "in_progress", done: false },
      { id: "c1", title: "List handlers", status: "completed", done: true, parentId: "p" },
      { id: "c2", title: "Check guards", status: "in_progress", done: false, parentId: "p" },
      { id: "w", title: "Write report", status: "pending", done: false }
    ] } } });
  });
  registerDelegate({ registerTool(definition: typeof tool & { name?: string }) { if (definition?.name === "jar_delegate") tool = definition; } } as never,
    { resolve: () => undefined } as never, registry, { spawnProcess: spawn as never });
  const pending = tool!.execute("d", { tasks: [{ task: "audit", name: "auditor" }] }, undefined, undefined, { cwd: "/repo", hasUI: false });
  await tick(); await tick();
  const view = mount({ subagents: registry });
  assert.match(view.text(), /▾ TASKS 1\/3 done\n?[\s\S]*◼ Audit routes \(1\/2\)[\s\S]*✔ .*List handlers[\s\S]*◼ Check guards[\s\S]*☐ Write report/);
  const indent = (title: string) => view.lines().find((line) => line.includes(title))!.split(title)[0]!.length;
  assert.ok(indent("List handlers") > indent("Audit routes"), "subtasks are indented under their task");
  registry.clear();
  await pending;
});

test("the initial target is selected, and nothing to show is a notice instead of an empty overlay", async () => {
  const agents = await subagents();
  const shell = shells();
  try {
    const view = mount({ subagents: agents.registry, shells: shell.manager }, { kind: "shell", id: "s1" });
    assert.equal(view.list()[4], "▌● s1 dev");
    view.input("\x1b");
    await view.opened;
  } finally { agents.abort(); shell.manager.dispose(); }
  const empty = mount({ subagents: new DelegateRegistry() });
  await empty.opened;
  assert.equal(empty.customs(), 0);
  assert.deepEqual(empty.notes, ["pi-jar: nothing running (subagents come from jar_delegate, shells from jar_shell)"]);
});

test("x stops the selected subagent through the registry and kills the selected shell", async () => {
  const agents = await subagents();
  const shell = shells();
  try {
    const view = mount({ subagents: agents.registry, shells: shell.manager });
    view.lines();
    view.input("x");
    await tick(); await tick();
    assert.deepEqual(agents.children.map((child) => child.killed), [[], []], "stop uses RPC abort then retires the selected child cleanly");
    // The initial batch report can resolve as idle while asynchronous stop retires the child.
    const stopped = await agents.registry.resolve("api")!.stop();
    await agents.pending;
    assert.equal(stopped?.state, "stopped");
    assert.equal(agents.registry.resolve("api")?.run.state, "stopped");
    assert.deepEqual(view.list().slice(0, 3), ["⧉ SUBAGENTS", " ○ docs", "▌■ api"], "the selection follows the stopped run after retained agents");
    assert.match(view.text(), /▸ ✖ bash npm test/, "a call cut short by stop is closed as failed");
    view.input("x");
    await tick();
    assert.deepEqual(agents.children[0]!.killed, [], "retired runs are left alone");
    view.input("j", "j");
    assert.equal(view.list()[4], "▌● s1 dev");
    view.mouse({ x: 6, y: view.row(/Kill the selected shell/) });
    assert.deepEqual(shell.children[0]!.killed, ["SIGTERM"], "clicking the action row kills the shell");
    await tick();
    assert.equal(shell.manager.get("s1")!.status, "killed");
    assert.match(view.lines()[0]!, /ACTIVITY · 0 running/);
    view.input("\x1b");
    await view.opened;
  } finally { agents.abort(); shell.manager.dispose(); }
  const broken = { onChange: undefined, running: () => 1, output: () => [], kill() { throw new Error("no shell s9"); },
    summaries: () => [{ id: "s9", name: "gone", command: "sleep 9", cwd: "/", startedAt: Date.now(), status: "running", notify: false, dropped: 0 }] };
  const view = mount({ subagents: new DelegateRegistry(), shells: broken as unknown as ShellManager });
  view.lines();
  view.input("x");
  assert.deepEqual(view.notes, ["pi-jar: no shell s9"], "kill errors are reported");
  view.input("q");
  await view.opened;
});

test("asynchronous subagent stop failures are reported without rejecting the UI", async () => {
  const agents = await subagents();
  try {
    agents.registry.stop = async () => { throw new Error("could not retire api"); };
    const view = mount({ subagents: agents.registry });
    view.lines();
    view.input("x");
    await tick();
    assert.deepEqual(view.notes, ["pi-jar: could not retire api"]);
    view.input("q");
    await view.opened;
  } finally { agents.abort(); }
});

test("mouse picks rows, scrolls with the wheel (pausing follow), passes drags through and closes on ×", async () => {
  const shell = shells(60);
  try {
    const view = mount({ subagents: new DelegateRegistry(), shells: shell.manager });
    let lines = view.lines();
    assert.match(lines.join("\n"), /line 60/, "follows the newest output");
    assert.deepEqual(view.mouse({ type: "wheel", wheelDelta: -1 }), { handled: true });
    lines = view.lines();
    assert.match(lines[0]!, /paused/);
    assert.doesNotMatch(lines.join("\n"), /line 60/);
    view.input("f");
    assert.doesNotMatch(view.lines()[0]!, /paused/);
    view.input("\r");
    assert.match(view.lines()[0]!, /paused/, "Enter toggles follow for shells");
    view.input("G");
    assert.equal(view.mouse({ type: "drag", x: 40, y: 3 }), undefined, "drags stay with Pi");
    assert.equal(view.mouse({ x: 4, y: view.row(/SHELLS/) }), undefined, "headers are not selectable");
    assert.deepEqual(view.mouse({ x: 4, y: view.row(/s1 dev/) }), { handled: true, focus: true });
    assert.deepEqual(view.mouse({ x: 98, y: 0 }), { handled: true });
    assert.equal(view.closed(), true);
    await view.opened;
  } finally { shell.manager.dispose(); }
});

test("live sources repaint the view; the elapsed tick runs only while something runs and everything is released on close", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const ticks = new Set<unknown>();
  let created = 0;
  globalThis.setInterval = ((handler: () => void, ms?: number) => {
    const handle = realSet(handler, ms);
    if (ms === 1000) { ticks.add(handle); created++; }
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle?: NodeJS.Timeout) => { ticks.delete(handle); realClear(handle); }) as typeof clearInterval;
  const agents = await subagents();
  const shell = shells();
  try {
    let chained = 0;
    shell.manager.onChange = () => { chained++; };
    const previous = shell.manager.onChange;
    const view = mount({ subagents: agents.registry, shells: shell.manager });
    view.lines();
    assert.equal(ticks.size, 1, "one tick while subagents and shells run");
    view.lines();
    assert.equal(created, 1, "renders reuse the tick");
    let renders = view.renders();
    emit(agents.children[0]!, { type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "src/a.ts" } });
    assert.equal(view.renders(), renders, "stream bursts coalesce instead of repainting per event");
    t.mock.timers.tick(100);
    assert.equal(view.renders(), renders + 1, "registry changes repaint once per burst");
    assert.match(view.text(), /▸ ● read src\/a\.ts/);
    emit(agents.children[0]!, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Looking at the router" } });
    assert.match(view.text(), /✎ writing…[\s\S]*Looking at the router/, "streaming text shows before the message ends");
    renders = view.renders();
    shell.manager.onChange!();
    assert.equal(chained, 1, "the previous shell listener still runs");
    t.mock.timers.tick(100);
    assert.ok(view.renders() > renders, "shell changes repaint");
    view.input("\x1b");
    await view.opened;
    assert.equal(ticks.size, 0, "closing clears the tick");
    assert.equal(shell.manager.onChange, previous, "the shell listener is restored");
    renders = view.renders();
    emit(agents.children[0]!, { type: "tool_execution_start", toolCallId: "g1", toolName: "grep", args: { pattern: "x" } });
    t.mock.timers.tick(100);
    assert.equal(view.renders(), renders, "the registry listener is gone");
    const again = mount({ subagents: agents.registry, shells: shell.manager });
    again.lines();
    assert.equal(ticks.size, 1);
    agents.abort();
    shell.manager.kill("s1");
    await tick();
    again.lines();
    assert.equal(ticks.size, 0, "the tick stops once nothing runs, even with the view open");
    again.input("q");
    await again.opened;
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
    agents.abort();
    shell.manager.dispose();
  }
});
