import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import piJar from "../extensions/index.ts";
import { renderFooter, type FooterView } from "../src/footer.ts";
import { HOPEFUL_WELCOME_MESSAGES, fullwidth, heroMessage, hopefulWelcomeMessage, welcomeHit, welcomeLines } from "../src/welcome.ts";
import { formatCost, sessionCost } from "../src/usage.ts";

const plain = { fg: (_color: string, value: string) => value };
const initialAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-jar-ui-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
after(() => {
  if (initialAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = initialAgentDir;
  rmSync(testAgentDir, { recursive: true, force: true });
});

test("pixel flame sits above π; welcome and footer fit terminal widths", () => {
  const info = { project: "pi-jar", model: "test-model", context: "ctx 82%", cost: "cost $1.23", managers: ["tasks"] as const, quotaEnabled: false };
  for (const width of [12, 16, 24, 40, 64, 80, 120]) {
    for (const frame of [0, 1, 2, 3, 4, 5, 6, 7]) assert.ok(welcomeLines(width, frame, plain.fg, info).every((line) => visibleWidth(line) <= width), `${width}/${frame}`);
    const text = welcomeLines(width, 0, plain.fg, info).map(stripTerminalSequences).join(" ");
    assert.ok(text.includes("pi-jar"));
    assert.doesNotMatch(text, /π/); // no second, literal symbol beneath the pixel artwork
    if (width >= 64) assert.match(text, /quota off/);
    if (width >= 40) {
      assert.match(text, /welcome to pi-jar/i);
      assert.match(text, /PROJECT\s+pi-jar · git unavailable/);
      assert.match(text, /\/tasks/);
    }
    if (width >= 80) {
      const before = welcomeLines(width, 0, plain.fg, info);
      const after = welcomeLines(width, 1, plain.fg, info);
      const left = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).slice(0, 28).trimEnd());
      const flameRows = (lines: string[]) => left(lines).findIndex((line) => line.includes("██"));
      assert.notDeepEqual(before.slice(0, 14).map((line) => line.slice(0, 400)), after.slice(0, 14).map((line) => line.slice(0, 400)), "flame animates");
      assert.ok(flameRows(before) > 0, "π sits beneath the flame");
      assert.ok(before.join("").includes("▀") || before.join("").includes("▄"), "half-block pixels");
      assert.equal(stripTerminalSequences(before.at(-1) ?? ""), "");
    }
  }
});

test("welcome flame is stable per frame and seed, and the π never moves", () => {
  const pi = new Set<string>();
  for (let frame = 0; frame < 40; frame++) {
    const rows = welcomeLines(80, frame, plain.fg, { flameSeed: 4 }).map((line) => stripTerminalSequences(line).slice(0, 28));
    const start = rows.findIndex((row) => row.includes("▄▄▄▄▄▄▄▄▄▄▄"));
    pi.add(rows.slice(start, start + 7).join("\n"));
  }
  assert.equal(pi.size, 1, "the π never moves");
  assert.deepEqual(welcomeLines(80, 9, plain.fg, { flameSeed: 4 }), welcomeLines(80, 9, plain.fg, { flameSeed: 4 }));
  assert.notDeepEqual(welcomeLines(80, 9, plain.fg, { flameSeed: 4 }), welcomeLines(80, 9, plain.fg, { flameSeed: 5 }));
});

test("hopeful welcome copy is varied, bounded, refreshable and injectable per render", () => {
  assert.equal(hopefulWelcomeMessage(() => 0), HOPEFUL_WELCOME_MESSAGES[0]);
  assert.equal(hopefulWelcomeMessage(() => 0.999999), HOPEFUL_WELCOME_MESSAGES.at(-1));
  let calls = 0;
  assert.notEqual(hopefulWelcomeMessage(() => (calls++ ? 0.5 : 0), HOPEFUL_WELCOME_MESSAGES[0]), HOPEFUL_WELCOME_MESSAGES[0], "refresh changes the message");
  assert.ok(new Set(HOPEFUL_WELCOME_MESSAGES).size >= 6);
  for (const message of HOPEFUL_WELCOME_MESSAGES) {
    assert.match(message, /light|spark|step|path|work|begin|night/i);
    const text = welcomeLines(120, 0, plain.fg, { project: "pi-jar", message }).map(stripTerminalSequences).join(" ");
    for (const word of message.split(" ")) assert.ok(text.includes(fullwidth(word)), `${message}: ${word}`);
  }
});

test("welcome message is a large hero at the top of the card", () => {
  const message = "Steady hands, warm light, good work ahead.";
  for (const width of [30, 46, 86]) {
    const lines = heroMessage(message, width, plain.fg, false);
    assert.ok(lines.every((line) => visibleWidth(line) === width), `${width} fixed width`);
    const text = lines.map(stripTerminalSequences).join(" ");
    const big = width >= 46;
    for (const word of message.split(" ")) assert.ok(text.includes(big ? fullwidth(word) : word), `${width}: ${word}`);
    assert.ok(lines.every((line) => line.includes("\x1b[1m")), "bold");
  }
  // The hero sits right under the header, above the workspace rows.
  const rows = welcomeLines(120, 0, plain.fg, { project: "jar", message }).map(stripTerminalSequences);
  const hero = rows.findIndex((row) => row.includes(fullwidth("Steady")));
  assert.ok(hero > 0 && hero < rows.findIndex((row) => row.includes("PROJECT")));
});

test("welcome shows workspace, workflow state, roles and live teammates", () => {
  const info = { project: "jar", version: "v1.2.3", model: "model-x", effort: "high", activeRole: "plan", roles: [
    { name: "assistant", state: "working", task: "Ship feature" },
    { name: "builder", state: "waiting" },
    { name: "reviewer", state: "working" }
  ], quota: 76, branch: "main", dirty: true, managers: ["tasks", "subagents"] as const,
  plan: { enabled: false, title: "Add hello", steps: 3 }, goal: "Ship · 1/2 tasks", tasks: 1, nextTask: "Write docs",
  rolesSummary: "default→sonnet · plan→@slow" };
  for (const width of [40, 80, 120]) {
    const lines = welcomeLines(width, 0, plain.fg, info);
    const text = lines.map(stripTerminalSequences).join(" ");
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    const labels = width >= 120 ? ["pi-jar v1.2.3", "model-x", "role:plan", "quota 76%", "git main · dirty", "Add hello (3 steps)", "Ship · 1/2 tasks",
      "next: Write docs", "plan→@slow", "assistant working · 2 subagents · Ship feature", "welcome to pi-jar"]
      : width >= 80 ? ["pi-jar v1.2.3", "role:plan", "quota 76%", "git main · dirty", "Add hello (3 steps)", "Ship · 1/2 tasks", "2 subagents"]
      : ["pi-jar v1.2.3", "git main", "Add hello", "Ship", "welcome"];
    for (const label of labels) assert.ok(text.includes(label), `${width}: ${label}`);
    assert.match(text, /╭─.*├─.*╰─/);
  }
});

test("session cost counts only Pi-reported assistant messages on the active branch", () => {
  const branch = [
    { type: "message", message: { role: "assistant", usage: { cost: { total: 0.125 } } } },
    { type: "message", message: { role: "toolResult" } },
    { type: "message", message: { role: "assistant", usage: { cost: { total: 0.375 } } } }
  ];
  assert.equal(sessionCost({ sessionManager: { getBranch: () => branch } } as never), 0.5);
  assert.equal(formatCost(0.5), "cost $0.50");
});

test("hub dispatches only installed native managers and never invents unavailable commands", async () => {
  const handlers = new Map<string, Function>();
  const events = new Map<string, Function>();
  const sent: { message: string; expand?: boolean }[] = [];
  const pi = {
    on(name: string, fn: Function) { events.set(name, fn); },
    registerCommand(name: string, command: { handler: Function }) { handlers.set(name, command.handler); },
    getCommands: () => [{ name: "tasks", source: "extension" }],
    sendUserMessage(message: string, opts: { expandPromptTemplates: boolean }) { sent.push({ message, expand: opts.expandPromptTemplates }); }
  };
  const widgets = new Map<string, { render(width: number): string[] }>();
  const welcome = () => widgets.get("pi-jar.welcome");
  let selectChoices: string[] = [];
  const ctx = {
    hasUI: true, mode: "tui", isIdle: () => true, cwd: "/tmp/pi-jar",
    model: { provider: "openai-codex", id: "model" },
    modelRegistry: { getProviderAuth: async () => undefined },
    sessionManager: { getBranch: () => [] },
    getContextUsage: () => ({ percent: 30 }),
    ui: {
      setWorkingIndicator() {}, setFooter() {}, notify() {},
      setWidget(key: string, factory: Function | undefined) {
        if (factory) widgets.set(key, factory({ requestRender() {} }, plain));
        else widgets.delete(key);
      },
      select(_prompt: string, choices: string[]) { selectChoices = choices; return Promise.resolve(choices[0]); }
    }
  };
  piJar(pi as unknown as Parameters<typeof piJar>[0]);
  events.get("session_start")?.({}, ctx);
  const rendered = () => welcome()?.render(120).map(stripTerminalSequences).join(" ") ?? "";
  assert.match(rendered(), /PROJECT\s+pi-jar/);
  assert.match(rendered(), /welcome to pi-jar/i);
  assert.match(rendered(), /TEAM.*\/tasks/);
  await handlers.get("jar")?.("hub", ctx);
  assert.deepEqual(selectChoices, ["Tasks (/tasks)"]);
  assert.deepEqual(sent, [{ message: "/tasks", expand: true }]);
  await handlers.get("jar")?.("animations off", ctx);
  assert.ok(welcome()?.render(40).join(" ").includes("pi-jar"));
  events.get("session_shutdown")?.({}, ctx);
  assert.equal(welcome(), undefined);
});

test("task list leaves a blank row before the composer", async () => {
  const events = new Map<string, Function>();
  const widgets = new Map<string, Component>();
  let tool: any;
  const ctx = {
    hasUI: true, mode: "tui", cwd: "/not-a-real-pi-jar-project", isIdle: () => true,
    model: { id: "test" }, sessionManager: { getBranch: () => [] },
    getContextUsage: () => ({ percent: 0 }),
    ui: {
      setWorkingIndicator() {}, setFooter() {}, notify() {},
      setWidget(key: string, factory?: Function) {
        if (factory) widgets.set(key, factory({ requestRender() {} }, plain));
        else widgets.delete(key);
      }
    }
  };
  piJar({
    on: (name: string, handler: Function) => events.set(name, handler),
    registerTool: (definition: unknown) => { if ((definition as { name?: string }).name === "jar_todo") tool = definition; },
    appendEntry() {}, getCommands: () => [], registerCommand() {}
  } as never);
  events.get("session_start")?.({}, ctx);
  assert.equal(widgets.has("pi-jar.todos"), false, "empty list adds no spacer");
  await tool.execute("task", { action: "add", title: "Make room" }, undefined, undefined, ctx);
  const rows = widgets.get("pi-jar.todos")?.render(40);
  assert.ok(rows?.some((row) => stripTerminalSequences(row).includes("Make room")));
  assert.equal(rows?.at(-1), " ");
  assert.equal(widgets.get("pi-jar.todos")?.render(0).at(-1), "");
  events.get("session_shutdown")?.({}, ctx);
});

test("late asynchronous Git samples do not repaint a dismissed welcome", async () => {
  const events = new Map<string, Function>();
  let renders = 0;
  const ctx = {
    hasUI: true, mode: "tui", cwd: process.cwd(), isIdle: () => true,
    model: { id: "test" }, sessionManager: { getBranch: () => [] },
    getContextUsage: () => ({ percent: 0 }),
    ui: {
      setWorkingIndicator() {}, setFooter() {}, notify() {},
      setWidget(_key: string, factory?: Function) {
        if (factory) factory({ requestRender() { renders++; } }, plain);
      }
    }
  };
  piJar({ on: (name: string, fn: Function) => events.set(name, fn), getCommands: () => [], registerCommand() {} } as never);
  events.get("session_start")?.({}, ctx);
  const before = renders;
  events.get("session_shutdown")?.({}, ctx);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(renders, before);
});

test("welcome actions open settings, refresh, roles, plan and goal on press without submitting a prompt", async () => {
  const events = new Map<string, Function>();
  const widgets = new Map<string, Component>();
  let opened = 0;
  const pasted: string[] = [];
  const editors: string[] = [];
  const ctx = {
    hasUI: true, mode: "tui", cwd: "/not-a-real-pi-jar-project", isIdle: () => true,
    model: { id: "test" }, sessionManager: { getBranch: () => [], getSessionId: () => "s" },
    getContextUsage: () => ({ percent: 0 }),
    ui: {
      setWorkingIndicator() {}, setFooter() {}, notify() {}, setStatus() {},
      theme: { fg: (_c: string, text: string) => text },
      pasteToEditor(text: string) { pasted.push(text); },
      async editor(title: string) { editors.push(title); return undefined; },
      setWidget(key: string, factory?: Function) {
        if (factory) widgets.set(key, factory({ requestRender() {} }, plain));
        else widgets.delete(key);
      },
      async custom(factory: Function) {
        opened++;
        const pane = factory({ requestRender() {} }, plain, {}, () => {});
        assert.ok(pane.render(64).join(" ").match(/settings|roles/));
        pane.handleInput("\\x1b");
      }
    }
  };
  piJar({
    on: (name: string, handler: Function) => events.set(name, handler),
    getCommands: () => [], registerCommand() {}
  } as never);
  events.get("session_start")?.({}, ctx);
  const press = async (label: string, width = 100) => {
    const widget = widgets.get("pi-jar.welcome")!;
    const lines = widget.render(width);
    const y = lines.findIndex((line) => stripTerminalSequences(line).includes(label));
    assert.ok(y >= 0, label);
    const text = stripTerminalSequences(lines[y]!);
    const x = visibleWidth(text.slice(0, text.indexOf(label))) + 2;
    // Dispatch through a container at a nonzero origin, like Pi's fullscreen layout.
    const root = new Container();
    root.addChild({ render: () => ["above"], invalidate() {} });
    root.addChild(widget);
    root.render(width);
    const pointer = (type: "press" | "click", localX: number) => root.handleMouse({
      type, button: "left", x: localX, y: y + 1, screenX: localX + 5, screenY: y + 8, width, height: lines.length + 1
    } as never);
    assert.equal(pointer("press", width - 1), undefined, "empty space is not captured");
    const result = pointer("press", x);
    assert.ok(result?.handled && result.capture, `${label}: press handled and captured`);
    assert.ok(pointer("click", x)?.handled, "the echo click is swallowed");
    await new Promise((resolve) => setImmediate(resolve));
  };
  await press("[ ▤ Plan ]");
  assert.deepEqual(pasted, ["/plan "], "without a plan, Plan pre-fills the command");
  await press("[ ◎ Goal ]");
  assert.deepEqual(editors, ["◎ New goal"]);
  await press("[ ◆ Roles ]");
  assert.equal(opened, 1);
  const before = widgets.get("pi-jar.welcome")!.render(100).map(stripTerminalSequences).join("\\n");
  await press("[ ↻ Refresh ]");
  assert.notEqual(widgets.get("pi-jar.welcome")!.render(100).map(stripTerminalSequences).join("\\n"), before, "refresh changes the message or flame");
  await press("[ ⚙ Settings ]", 40);
  assert.equal(opened, 2, "each action runs exactly once");
  assert.equal(widgets.has("pi-jar.welcome"), false, "settings replaces the welcome");
  events.get("session_shutdown")?.({}, ctx);
});

test("regular welcome leaves terminal mouse reporting and scrollback untouched", () => {
  const events = new Map<string, Function>();
  let widget: Component | undefined;
  let listeners = 0;
  const writes: string[] = [];
  const tui = {
    mode: "regular", requestRender() {},
    terminal: { write(data: string) { writes.push(data); } },
    addInputListener() { listeners++; return () => {}; }
  };
  const ctx = {
    hasUI: true, mode: "tui", cwd: "/not-a-real-pi-jar-project", isIdle: () => true,
    model: { id: "test" }, sessionManager: { getBranch: () => [] },
    getContextUsage: () => ({ percent: 0 }),
    ui: {
      setWorkingIndicator() {}, setFooter() {}, notify() {},
      setWidget(_key: string, factory?: Function) { widget = factory ? factory(tui, plain) : undefined; }
    }
  };
  piJar({ on: (name: string, handler: Function) => events.set(name, handler),
    getCommands: () => [], registerCommand() {} } as never);
  events.get("session_start")?.({}, ctx);
  const rendered = widget?.render(120).map(stripTerminalSequences).join(" ") ?? "";
  assert.match(rendered, /ctrl\+alt\+s settings · ctrl\+alt\+r refresh/);
  assert.doesNotMatch(rendered, /\[ ⚙ Settings \]/, "regular mode must not advertise an unclickable button");
  events.get("session_shutdown")?.({}, ctx);
  assert.equal(listeners, 0);
  assert.deepEqual(writes, [], "terminal owns its mouse wheel and selection");
});


test("welcome hit-testing finds every action at wide, medium and narrow widths", () => {
  const labels = { settings: "[ ⚙ Settings ]", refresh: "[ ↻ Refresh ]", roles: "[ ◆ Roles ]", plan: "[ ▤ Plan ]", goal: "[ ◎ Goal ]" } as const;
  for (const width of [24, 50, 80, 140]) {
    const lines = welcomeLines(width, 0, plain.fg, { project: "jar" });
    for (const [action, label] of Object.entries(labels)) {
      const y = lines.findIndex((line) => stripTerminalSequences(line).includes(label));
      if (width < 32 && action !== "settings") { assert.equal(y, -1); continue; }
      assert.ok(y >= 0, `${width}: ${label}`);
      const text = stripTerminalSequences(lines[y]!);
      const start = visibleWidth(text.slice(0, text.indexOf(label)));
      assert.equal(welcomeHit(lines, start, y), action);
      assert.equal(welcomeHit(lines, start + visibleWidth(label) - 1, y), action);
      assert.notEqual(welcomeHit(lines, start + visibleWidth(label), y), action);
    }
    assert.equal(welcomeHit(lines, 0, 0), undefined);
  }
  const regular = welcomeLines(100, 0, plain.fg, { settingsClickable: false });
  assert.ok(regular.every((_, y) => regular.every((__, x) => welcomeHit(regular, x, y) === undefined)), "regular mode exposes no click targets");
});
