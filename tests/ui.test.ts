import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import piJar from "../extensions/index.ts";
import { renderFooter, type FooterView } from "../src/footer.ts";
import { welcomeLines } from "../src/welcome.ts";
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

test("layered standalone flame animates above π; welcome and footer fit terminal widths", () => {
  const info = { project: "pi-jar", model: "test-model", context: "ctx 82%", cost: "cost $1.23", managers: ["tasks"] as const, quotaEnabled: false };
  for (const width of [12, 16, 24, 40, 64, 80, 120]) {
    for (const frame of [0, 1, 2, 3, 4, 5, 6, 7]) assert.ok(welcomeLines(width, frame, plain.fg, info).every((line) => visibleWidth(line) <= width));
    const text = welcomeLines(width, 0, plain.fg, info).join(" ");
    assert.ok(text.includes("pi-jar"));
    assert.doesNotMatch(text, /π/); // no second, literal symbol beneath the pixel artwork
    if (width >= 40) {
      if (width >= 72) { assert.match(text, /test-model/); assert.match(text, /ctx 82%/); }
      assert.match(text, /quota off/);
      if (width >= 72) assert.match(text, /\/tasks/);
      assert.doesNotMatch(text, /\/subagents-fleet/);
    }
    if (width === 40) assert.ok(welcomeLines(width, 0, plain.fg, info).length <= 28);
    if (width >= 80) {
      const before = welcomeLines(width, 0, plain.fg, info);
      const after = welcomeLines(width, 1, plain.fg, info);
      assert.notDeepEqual(before.slice(0, 3), after.slice(0, 3)); // flickering tongues
      assert.deepEqual(before.slice(3), after.slice(3)); // flame body, π and details stay put
      assert.ok(before.slice(0, 9).some((line) => line.includes("░▓██████████▓░")));
      assert.ok(before.slice(9, 14).some((line) => line.includes("██")));
      assert.doesNotMatch(before.join(" "), /\\_+|\|\||\.\-\\/); // no grail
      assert.match(text, /PROJECT.*pi-jar/);
      assert.match(text, /role-assistant/);
    }
    if (width === 24) {
      for (const frame of [0, 1, 2, 3, 4, 5, 6, 7]) {
        const flame = welcomeLines(width, frame, plain.fg, info).slice(0, 7);
        assert.ok(flame.every((row) => visibleWidth(row) === 21), "fixed flame cell footprint");
      }
    }
    const view: FooterView = {
      model: "provider-model", context: "ctx 82%", cost: formatCost(1.23),
      quota: { fiveHour: { used: 14 }, week: { used: 50 } }, branch: null,
      roles: [{ id: "dev-1", name: "Developer", label: "DEV", state: "working" }],
      extras: [], demo: false, animations: false, frame: 0
    };
    const lines = renderFooter(view, width, plain);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    if (width >= 52) assert.match(lines.join(" "), /5h 14%.*week 50%/);
    if (width >= 52) assert.match(lines.join(" "), /cost \$1\.23/);
    if (width < 52) assert.doesNotMatch(lines.join(" "), /5h 14%/);
  }
});

test("welcome emphasizes published roles, task, advisor and git state in rounded cells", () => {
  const info = { project: "jar", roles: [
    { name: "assistant", state: "working", task: "Ship feature" },
    { name: "builder", state: "waiting" },
    { name: "reviewer", state: "working" }
  ], advisor: "on", quota: 76, branch: "main", dirty: true, managers: ["tasks", "subagents"] as const };
  for (const width of [40, 80]) {
    const lines = welcomeLines(width, 0, plain.fg, info);
    const text = lines.join(" ");
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    for (const label of ["role-assistant", "advisor on", "subagents 2", "quota 76%", "git main", "dirty", "Ship feature"]) assert.ok(text.includes(label), `${width}: ${label}`);
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
  assert.match(welcome()?.render(80).join(" ") ?? "", /PROJECT.*pi-jar/);
  assert.match(welcome()?.render(80).join(" ") ?? "", /model/);
  assert.match(welcome()?.render(80).join(" ") ?? "", /MANAGERS.*\/tasks/);
  await handlers.get("jar")?.("hub", ctx);
  assert.deepEqual(selectChoices, ["Tasks · Team Mode (/tasks)"]);
  assert.deepEqual(sent, [{ message: "/tasks", expand: true }]);
  await handlers.get("jar")?.("animations off", ctx);
  assert.ok(welcome()?.render(40).join(" ").includes("pi-jar"));
  events.get("session_shutdown")?.({}, ctx);
  assert.equal(welcome(), undefined);
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

test("welcome Settings action opens the pointer-accessible pane without submitting a prompt", async () => {
  const events = new Map<string, Function>();
  const widgets = new Map<string, Component>();
  let opened = 0;
  const ctx = {
    hasUI: true, mode: "tui", cwd: "/not-a-real-pi-jar-project", isIdle: () => true,
    model: { id: "test" }, sessionManager: { getBranch: () => [] },
    getContextUsage: () => ({ percent: 0 }),
    ui: {
      setWorkingIndicator() {}, setFooter() {}, notify() {},
      setWidget(key: string, factory?: Function) {
        if (factory) widgets.set(key, factory({ requestRender() {} }, plain));
        else widgets.delete(key);
      },
      async custom(factory: Function) {
        opened++;
        const pane = factory({ requestRender() {} }, plain, {}, () => {});
        assert.ok(pane.render(64).join(" ").includes("settings"));
        pane.handleInput("\x1b");
      }
    }
  };
  piJar({
    on: (name: string, handler: Function) => events.set(name, handler),
    getCommands: () => [], registerCommand() {}
  } as never);
  events.get("session_start")?.({}, ctx);
  // Simulate fullscreen dispatch through a container at a nonzero screen origin.
  // Pi only synthesizes click when the target handled press first.
  for (const width of [24, 40, 80]) {
    const widget = widgets.get("pi-jar.welcome")!;
    const lines = widget.render(width);
    const y = lines.findIndex((line) => stripTerminalSequences(line).includes(width < 32 ? "/jar settings" : "[ Settings ↗ ]"));
    assert.ok(y >= 0);
    const text = stripTerminalSequences(lines[y]!);
    const label = width < 32 ? "/jar settings" : "[ Settings ↗ ]";
    const x = visibleWidth(text.slice(0, text.indexOf(label))) + 3;
    const root = new Container();
    root.addChild({ render: () => ["above"], invalidate() {} });
    root.addChild(widget);
    root.render(width);
    const pointer = (type: "press" | "click", localX: number) => root.handleMouse({
      type, button: "left", x: localX, y: y + 1, screenX: localX + 5, screenY: y + 8,
      width, height: lines.length + 1
    } as never);
    assert.equal(pointer("press", width - 1), undefined);
    assert.ok(pointer("press", x)?.handled, `${width}: press captured`);
    assert.equal(opened, width === 24 ? 0 : width === 40 ? 1 : 2, "press alone does not open settings");
    assert.equal(widget.handleMouse?.({ type: "release", button: "left", x, y } as never), undefined);
    assert.ok(pointer("click", x)?.handled, `${width}: click delivered`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(opened, width === 24 ? 1 : width === 40 ? 2 : 3);
    if (width !== 80) events.get("session_start")?.({}, ctx);
  }
  assert.equal(widgets.has("pi-jar.welcome"), false);
  events.get("session_shutdown")?.({}, ctx);
});
