import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import piJar from "../extensions/index.ts";
import { renderFooter, type FooterView } from "../src/footer.ts";
import { welcomeLines } from "../src/welcome.ts";
import { formatCost, sessionCost } from "../src/usage.ts";

const plain = { fg: (_color: string, value: string) => value };

test("rising fumes and fire animate over a large static π; welcome and footer fit terminal widths", () => {
  const info = { project: "pi-jar", model: "test-model", context: "ctx 82%", cost: "cost $1.23", managers: ["tasks"] as const, quotaEnabled: false };
  for (const width of [12, 16, 24, 40, 64, 80, 120]) {
    for (const frame of [0, 1, 2, 3]) assert.ok(welcomeLines(width, frame, plain.fg, info).every((line) => visibleWidth(line) <= width));
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
      assert.notDeepEqual(before.slice(0, 2), after.slice(0, 2)); // smoke floats
      assert.notDeepEqual(before.slice(2, 6), after.slice(2, 6)); // fiery animation
      assert.deepEqual(before.slice(6), after.slice(6)); // gap, π and details never move
      assert.equal(before[6]?.slice(0, 16).trim(), "");
      assert.ok(before.slice(7, 12).some((line) => line.includes("██")));
      assert.match(text, /PROJECT.*pi-jar/);
      assert.match(text, /role-assistant/);
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
