import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { openActivityView, type ActivitySources, type ActivityTarget } from "../src/activity-view.ts";
import { DelegateRegistry, registerDelegate } from "../src/delegate.ts";
import { ShellManager } from "../src/shells.ts";

interface FakeChild extends EventEmitter { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; killed: string[]; kill(signal: string): void }
// No pid on purpose: ShellManager.kill() then signals the fake instead of a real process group.
function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null; child.killed = [];
  child.kill = (signal: string) => { child.killed.push(signal); child.exitCode = 143; queueMicrotask(() => child.emit("close", null, signal)); };
  return child;
}
const emit = (child: FakeChild, event: object) => child.stdout.emit("data", JSON.stringify(event) + "\n");
const report = (text: string) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });

/** jar_delegate with two subagents: "api" keeps working, "docs" finishes with a report. */
async function subagents() {
  const registry = new DelegateRegistry();
  const children: FakeChild[] = [];
  let tool: { execute(id: string, params: object, signal: AbortSignal, onUpdate: undefined, ctx: object): Promise<{ content: Array<{ text: string }> }> } | undefined;
  const spawn = (_command: string, args: string[]) => {
    const child = fakeChild();
    children.push(child);
    queueMicrotask(() => {
      emit(child, { type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } });
      if (args.at(-1)!.includes("docs")) { emit(child, report("Docs are fine.")); child.emit("close", 0); }
    });
    return child;
  };
  registerDelegate({ registerTool(definition: typeof tool) { tool = definition; } } as never, { resolve: () => undefined } as never, registry, spawn as never);
  const controller = new AbortController();
  const pending = tool!.execute("d", { tasks: [{ task: "scan the api", name: "api" }, { task: "check the docs", name: "docs" }] }, controller.signal, undefined, { cwd: "/repo", hasUI: false });
  await tick();
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
    input: (data: string) => view!.handleInput(data),
    mouse: (event: Partial<TuiMouseEvent>) => view!.handleMouse({ type: "click", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 100, height: 30, shift: false, alt: false, ctrl: false, ...event }),
    text: (width = 100) => lines(width).join("\n"),
    /** Left-pane rows at width 100, trimmed. */
    list: () => lines(100).slice(1).map((line) => line.split("│")).filter((parts) => parts.length === 4).map((parts) => parts[1]!.slice(1).trimEnd())
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
    assert.deepEqual(view.list().filter(Boolean), ["⧉ SUBAGENTS", "▌● api", " ✔ docs", "⚙ SHELLS", " ● s1 dev", "⇄ ROLES", " ● Reviewer"],
      "running first, finished after; our own subagent's role status is not listed twice");
    const body = view.text();
    assert.match(body, /api · task/);
    assert.match(body, /● working · \ds · 1 tool · 0 turns · \$0\.000/);
    assert.match(body, /TASK[\s\S]*scan the api/);
    assert.match(body, /── transcript ──[\s\S]*▸ bash npm test/);
    view.input("j");
    assert.match(view.text(), /── report ──[\s\S]*Docs are fine\./);
    view.input("\x1b[B");
    assert.equal(view.list()[4], "▌● s1 dev", "down skips the SHELLS header");
    assert.match(view.text(), /\$ npm run dev[\s\S]*line 1/);
    view.input("j"); view.input("j");
    assert.equal(view.list()[6], "▌● Reviewer", "the last row stays selected");
    assert.match(view.text(), /review the PR/);
    for (let press = 0; press < 5; press++) view.input("k");
    assert.equal(view.list()[1], "▌● api", "up stops at the first entry, never on a header");
    view.input("q");
    await view.opened;
  } finally { agents.abort(); shell.manager.dispose(); }
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
    assert.deepEqual(agents.children.map((child) => child.killed), [["SIGTERM"], []], "only the selected run is stopped");
    assert.match((await agents.pending).content[0]!.text, /\[1\] api \(task\) — failed: stopped/);
    assert.deepEqual(view.list().slice(0, 3), ["⧉ SUBAGENTS", "▌■ api", " ✔ docs"], "the selection follows the run as it becomes the newest finished one");
    view.input("x");
    assert.deepEqual(agents.children[0]!.killed, ["SIGTERM"], "finished runs are left alone");
    view.input("j"); view.input("j");
    assert.equal(view.list()[4], "▌● s1 dev");
    const kill = view.lines().findIndex((line) => line.includes("Kill the selected shell"));
    view.mouse({ x: 6, y: kill });
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

test("mouse picks rows, scrolls with the wheel (pausing follow), passes drags through and closes on ×", async () => {
  const shell = shells(60);
  try {
    const registry = new DelegateRegistry();
    const view = mount({ subagents: registry, shells: shell.manager });
    let lines = view.lines();
    assert.match(lines.join("\n"), /line 60/, "follows the newest output");
    assert.deepEqual(view.mouse({ type: "wheel", wheelDelta: -1 }), { handled: true });
    lines = view.lines();
    assert.match(lines[0]!, /paused/);
    assert.doesNotMatch(lines.join("\n"), /line 60/);
    view.input("f");
    assert.doesNotMatch(view.lines()[0]!, /paused/);
    view.input("\r");
    assert.match(view.lines()[0]!, /paused/, "Enter toggles follow");
    view.input("G");
    assert.equal(view.mouse({ type: "drag", x: 40, y: 3 }), undefined, "drags stay with Pi");
    const header = view.lines().findIndex((line) => line.includes("SHELLS"));
    assert.equal(view.mouse({ x: 4, y: header }), undefined, "headers are not selectable");
    const row = view.lines().findIndex((line) => line.includes("s1 dev"));
    assert.deepEqual(view.mouse({ x: 4, y: row }), { handled: true, focus: true });
    assert.deepEqual(view.mouse({ x: 98, y: 0 }), { handled: true });
    assert.equal(view.closed(), true);
    await view.opened;
  } finally { shell.manager.dispose(); }
});

test("live sources repaint the view; the elapsed tick runs only while something runs and everything is released on close", async () => {
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
    emit(agents.children[0]!, { type: "tool_execution_start", toolName: "read", args: { path: "src/a.ts" } });
    assert.ok(view.renders() > renders, "registry changes repaint");
    assert.match(view.text(), /▸ read src\/a\.ts/);
    renders = view.renders();
    shell.manager.onChange!();
    assert.equal(chained, 1, "the previous shell listener still runs");
    assert.ok(view.renders() > renders, "shell changes repaint");
    view.input("\x1b");
    await view.opened;
    assert.equal(ticks.size, 0, "closing clears the tick");
    assert.equal(shell.manager.onChange, previous, "the shell listener is restored");
    renders = view.renders();
    emit(agents.children[0]!, { type: "tool_execution_start", toolName: "grep", args: { pattern: "x" } });
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
