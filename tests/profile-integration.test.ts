import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import piJar from "../extensions/index.ts";
import { ProfileStore, PROFILE_FILE, PROFILE_ENTRY } from "../src/profiles.ts";
import { defaultVisualSettings, saveVisualSettings, SETTINGS_FILE } from "../src/settings.ts";
import { openJarSettings } from "../src/settings-ui.ts";

async function fixture(run: (h: any) => Promise<void>, active = "Default", initialEntries: any[] = [], legacyAccent?: "azure") {
  const directory = mkdtempSync(join(tmpdir(), "pi-jar-profile-integration-"));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const events = new Map<string, Function[]>();
  const commands = new Map<string, Function>();
  const shortcuts = new Map<string, Function>();
  const entries = [...initialEntries];
  const notices: string[] = [];
  const widgets = new Map<string, Function>();
  const themes = new Set(["system", "dark", "light", "custom-sunset"]);
  const makeTheme = (name: string) => ({ name, fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t, borderColor: (t: string) => t });
  let editor: Function | undefined = () => ({ render: () => ["────", "draft", "────"], invalidate() {}, getText: () => "draft", setText() {} });
  let idle = true, failModel = false;
  const settings = { ...defaultVisualSettings(), animations: false };
  saveVisualSettings(directory, settings);
  writeFileSync(join(directory, "pi-jar-roles.json"), JSON.stringify({ version: 2, roles: { default: "p/main" } }));
  const store = new ProfileStore(directory, "dark", { version: 2, roles: { default: "p/main" } });
  store.add("Writing", "custom-sunset", settings, { version: 2, roles: { default: "p/writer" } });
  store.activate(active);
  if (legacyAccent) {
    themes.add(`pi-jar-dark-${legacyAccent}`);
    saveVisualSettings(directory, { ...settings, accent: legacyAccent });
    unlinkSync(join(directory, PROFILE_FILE));
  }
  const legacyBefore = readFileSync(join(directory, SETTINGS_FILE), "utf8");
  const ctx: any = {
    hasUI: true, mode: "tui", cwd: directory, isIdle: () => idle, model: { provider: "p", id: "initial" },
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
    getContextUsage: () => ({ percent: 0 }),
    sessionManager: { getBranch: () => entries, getEntries: () => entries, getSessionId: () => "profiles-test", getSessionName: () => "My session", getSessionFile: () => undefined },
    ui: {
      theme: makeTheme("dark"), notify: (text: string) => notices.push(text),
      getAllThemes: () => [...themes].map((name) => ({ name })), getTheme: (name: string) => themes.has(name) ? makeTheme(name) : undefined,
      setTheme: (name: string) => { if (!themes.has(name)) return { success: false, error: "missing" }; ctx.ui.theme = makeTheme(name); return { success: true }; },
      getEditorComponent: () => editor, setEditorComponent: (value: Function | undefined) => { editor = value; }, getEditorText: () => "draft", setEditorText() {},
      setWidget: (key: string, value?: Function) => { if (typeof value === "function") widgets.set(key, value); else widgets.delete(key); },
      setFooter() {}, setHeader() {}, setStatus() {}, setWorkingIndicator() {}, setWorkingMessage() {}
    }
  };
  const emit = async (name: string, event = {}) => { for (const handler of events.get(name) ?? []) await handler(event, ctx); };
  piJar({ on: (name: string, handler: Function) => events.set(name, [...(events.get(name) ?? []), handler]),
    registerCommand: (name: string, options: any) => commands.set(name, options.handler),
    registerShortcut: (name: string, options: any) => shortcuts.set(name, options.handler), registerTool() {}, getCommands: () => [],
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    setModel: async (model: any) => { ctx.model = model; await emit("model_select", { source: "set" }); if (failModel && model.id === "writer") throw new Error("Model activation failed"); return true; },
    getThinkingLevel: () => "off", setThinkingLevel() {}
  } as never);
  const title = () => editor?.({ requestRender() {} }, ctx.ui.theme, {}).render(100).map(stripTerminalSequences).join("\n") ?? "";
  const welcome = () => widgets.get("pi-jar.welcome")?.({ requestRender() {}, mode: "regular" }, ctx.ui.theme).render(100).map(stripTerminalSequences).join("\n") ?? "";
  try {
    await emit("session_start");
    await run({ ctx, directory, entries, notices, themes, commands, emit, title, welcome, legacyBefore, failModel: () => { failModel = true; }, busy: (value: boolean) => { idle = !value; }, cycle: () => shortcuts.get("ctrl+shift+tab")!(ctx) });
  } finally {
    await emit("session_shutdown");
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("startup and fresh-session cycling apply profile theme, default role and both live labels", () => fixture(async (h) => {
  assert.equal(h.ctx.model.id, "writer");
  assert.equal(h.ctx.ui.theme.name, "custom-sunset");
  assert.match(h.title(), /\(Writing\) My session/);
  assert.match(h.welcome(), /PROFILE\s+Writing/);
  await h.cycle();
  assert.equal(h.ctx.model.id, "main");
  assert.equal(h.ctx.ui.theme.name, "dark");
  assert.match(h.title(), /\(Default\) My session/);
  assert.match(h.welcome(), /PROFILE\s+Default/);
  assert.doesNotMatch(h.welcome(), /writer/, "welcome model follows the active profile rather than a cached startup model");
  await h.cycle();
  assert.equal(h.ctx.ui.theme.name, "custom-sunset");
}, "Writing"));

test("migration preserves the legacy accent as Default's actual theme without rewriting legacy preferences", () => fixture(async (h) => {
  assert.equal(new ProfileStore(h.directory).active().theme, "pi-jar-dark-azure");
  assert.equal(h.ctx.ui.theme.name, "pi-jar-dark-azure");
  assert.equal(readFileSync(join(h.directory, SETTINGS_FILE), "utf8"), h.legacyBefore);
}, "Default", [], "azure"));

test("busy agents and conversations lock profile switching; resume restores the pinned profile", () => fixture(async (h) => {
  h.busy(true); await h.cycle(); h.busy(false);
  assert.equal(new ProfileStore(h.directory).activeName, "Writing");
  await h.emit("input", { source: "interactive" });
  assert.ok(h.entries.some((entry: any) => entry.customType === PROFILE_ENTRY), "pin before the first agent turn, including failed starts");
  h.entries.push({ type: "message", message: { role: "user", content: "Hello" } });
  await h.emit("agent_start"); await h.emit("agent_end");
  assert.ok(h.entries.some((entry: any) => entry.customType === PROFILE_ENTRY));
  await h.cycle();
  assert.equal(new ProfileStore(h.directory).activeName, "Writing");
  assert.ok(h.notices.some((message: string) => /new session/.test(message)));
  new ProfileStore(h.directory).activate("Default");
  await h.emit("session_start");
  assert.equal(new ProfileStore(h.directory).activeName, "Writing");
  assert.match(h.title(), /\(Writing\) My session/);
}, "Writing"));

test("assistant-only automatic turns lock and restore their pinned profile", () => fixture(async (h) => {
  await h.emit("agent_start");
  h.entries.push({ type: "message", message: { role: "assistant", content: "Automatic advice response" } });
  await h.emit("agent_end");
  await h.cycle();
  assert.equal(new ProfileStore(h.directory).activeName, "Writing");
  assert.ok(h.notices.some((message: string) => /new session/.test(message)));
  new ProfileStore(h.directory).activate("Default");
  await h.emit("session_start");
  assert.equal(new ProfileStore(h.directory).activeName, "Writing");
  assert.match(h.title(), /\(Writing\) My session/);
}, "Writing"));

test("legacy conversations use Default rather than the globally selected custom profile", () => fixture(async (h) => {
  assert.equal(new ProfileStore(h.directory).activeName, "Default");
  await h.cycle();
  assert.equal(new ProfileStore(h.directory).activeName, "Default");
}, "Writing", [{ type: "message", message: { role: "user", content: "Existing conversation" } }]));

test("missing themes and failed writes leave selection, theme and labels unchanged", () => fixture(async (h) => {
  h.themes.delete("custom-sunset"); await h.cycle();
  assert.equal(new ProfileStore(h.directory).activeName, "Default");
  assert.equal(h.ctx.ui.theme.name, "dark");
  h.themes.add("custom-sunset");
  const path = join(h.directory, PROFILE_FILE);
  const backup = readFileSync(path, "utf8"); unlinkSync(path); mkdirSync(path);
  await h.cycle();
  assert.equal(h.ctx.ui.theme.name, "dark");
  assert.match(h.title(), /\(Default\) My session/);
  rmSync(path, { recursive: true }); writeFileSync(path, backup);
}));

test("a partial model activation failure restores the exact previous runtime and persisted profile", () => fixture(async (h) => {
  h.failModel();
  await h.cycle();
  assert.equal(new ProfileStore(h.directory).activeName, "Default");
  assert.equal(h.ctx.model.id, "main");
  assert.equal(h.ctx.ui.theme.name, "dark");
  assert.match(h.title(), /\(Default\) My session/);
  assert.ok(h.notices.some((message: string) => /Model activation failed/.test(message)));
}));

test("custom profile preferences never overwrite legacy Default preferences", () => fixture(async (h) => {
  const path = join(h.directory, SETTINGS_FILE);
  const before = readFileSync(path, "utf8");
  await h.commands.get("jar")("animations on", h.ctx);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(new ProfileStore(h.directory).active().settings.animations, true);
}, "Writing"));

test("settings disposes its screen before wizard dialogs and saves only after confirmation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-jar-profile-wizard-ui-"));
  const store = new ProfileStore(directory, "dark");
  let modal = false, screens = 0, confirmations = 0;
  const answers = ["Writing", "default=p/writer"];
  const ctx: any = { hasUI: true, mode: "tui", ui: {
    custom: async (factory: Function) => {
      assert.equal(modal, false); modal = true;
      let result: unknown;
      const component = factory({ requestRender() {} }, { fg: (_c: string, text: string) => text }, {}, (value: unknown) => { result = value; });
      component.render(80);
      if (screens++ === 0) { for (let i = 0; i < 3; i++) component.handleInput("\t"); component.handleInput("\x1b[B"); component.handleInput("\x1b[B"); component.handleInput("\r"); }
      else component.handleInput("\x1b");
      modal = false; return result;
    },
    input: async () => { assert.equal(modal, false); return answers.shift(); },
    select: async () => { assert.equal(modal, false); return "dark"; },
    confirm: async (_title: string, summary: string) => { assert.equal(modal, false); assert.equal(store.list().length, 1); assert.match(summary, /default → p\/writer/); confirmations++; return true; }, notify() {}
  } };
  try {
    await openJarSettings(ctx, () => ({ ...defaultVisualSettings(), accent: "amber" }), () => {}, [], undefined, {
      store, themes: ["dark"], roles: () => ({ version: 2, roles: {} }), create: (name, theme, settings, roles) => store.add(name, theme, settings, roles), select: async () => {}, setTheme() {}
    });
    assert.equal(confirmations, 1);
    assert.equal(store.list()[1]!.settings.accent, "follow");
    assert.equal(screens, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
