import { pickPopup } from "./popup-fixture.ts";
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

const createViaCommand = async (h: any, answers: string[]) => {
  const screens: string[] = [];
  h.ctx.ui.input = async () => answers.shift();
  h.ctx.ui.select = async () => answers.shift();
  h.ctx.ui.custom = async (factory: Function) => {
    if (answers.length) return pickPopup(factory, answers.shift());
    screens.push("roles"); return undefined;
  };
  await h.commands.get("profiles")("new", h.ctx);
  return screens;
};

test("/profiles new asks name and theme, switches a fresh session to it, then opens roles", () => fixture(async (h) => {
  const screens = await createViaCommand(h, ["Research", "custom-sunset"]);
  const store = new ProfileStore(h.directory);
  const created = store.list().find((profile) => profile.name === "Research");
  assert.equal(created?.theme, "custom-sunset");
  assert.deepEqual(created?.roles.roles, { default: "p/main" }, "roles start as a copy of the previous profile");
  assert.equal(store.activeName, "Research");
  assert.equal(h.ctx.ui.theme.name, "custom-sunset");
  assert.match(h.title(), /\(Research\) My session/);
  assert.deepEqual(screens, ["roles"], "the roles UI opens for the new profile");
  assert.ok(h.notices.some((message: string) => /Created profile Research[\s\S]*set them now in Roles/.test(message)));
}));

test("creating a profile in a locked session keeps the session's profile and explains how to set roles", () => fixture(async (h) => {
  h.entries.push({ type: "message", message: { role: "user", content: "Hello" } });
  const screens = await createViaCommand(h, ["Research", "dark"]);
  const store = new ProfileStore(h.directory);
  assert.ok(store.list().some((profile) => profile.name === "Research"));
  assert.equal(store.activeName, "Default");
  assert.deepEqual(screens, [], "roles would edit the wrong profile, so they are not opened");
  assert.ok(h.notices.some((message: string) => /fresh session with \/profiles[\s\S]*\/roles/.test(message)));
}));

test("/profiles <name> switches and unknown names are reported", () => fixture(async (h) => {
  await h.commands.get("profiles")("writing", h.ctx);
  assert.equal(new ProfileStore(h.directory).activeName, "Writing");
  await h.commands.get("profiles")("Nope", h.ctx);
  assert.ok(h.notices.some((message: string) => /Unknown profile: Nope/.test(message)));
}));

test("the settings Profiles tab only switches or creates, and creation does not reopen settings", async () => {
  const opened: string[] = [];
  let screens = 0;
  const keys = [["\r"], ["\x1b[B", "\r"]];
  const ctx: any = { hasUI: true, mode: "tui", ui: {
    custom: async (factory: Function) => {
      let result: unknown;
      const component = factory({ requestRender() {} }, { fg: (_c: string, text: string) => text }, {}, (value: unknown) => { result = value; });
      const text = component.render(80).join("\n");
      if (screens++ === 0) {
        for (let i = 0; i < 3; i++) component.handleInput("\t");
        const rows = component.render(80).join("\n");
        assert.match(rows, /Switch profile…\s+Writing/);
        assert.match(rows, /Create profile…/);
        assert.doesNotMatch(rows, /Theme/);
      } else assert.match(text, /PROFILES/, "the tab is remembered after a switch");
      for (const key of keys.shift() ?? ["\x1b"]) component.handleInput(key);
      return result;
    }, notify() {}
  } };
  await openJarSettings(ctx, () => defaultVisualSettings(), () => {}, [], undefined, { activeName: () => "Writing", open: async (action) => { opened.push(action); } });
  assert.deepEqual(opened, ["switch", "create"]);
  assert.equal(screens, 2);
});
