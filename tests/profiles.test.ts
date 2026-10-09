import { pickPopup } from "./popup-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileStore, PROFILE_FILE } from "../src/profiles.ts";
import { defaultVisualSettings } from "../src/settings.ts";
import { promptNewProfile } from "../src/profile-ui.ts";

function temp(run: (dir: string) => void | Promise<void>) { return async () => { const dir = mkdtempSync(join(tmpdir(), "pi-jar-profile-")); try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }; }

test("context diet is opt-in, profile-specific, and legacy profiles load without rewriting", temp((dir) => {
  new ProfileStore(dir);
  const file = join(dir, PROFILE_FILE);
  const legacy = JSON.parse(readFileSync(file, "utf8"));
  delete legacy.profiles[0].settings.contextDiet;
  const original = JSON.stringify(legacy);
  writeFileSync(file, original);
  const store = new ProfileStore(dir);
  assert.equal(store.active().settings.contextDiet, false);
  assert.equal(readFileSync(file, "utf8"), original);
  store.add("Diet", "dark", { ...defaultVisualSettings(), contextDiet: true });
  const restarted = new ProfileStore(dir);
  assert.equal(restarted.list()[0]!.settings.contextDiet, false);
  assert.equal(restarted.list()[1]!.settings.contextDiet, true);
}));

test("malformed context-diet preferences are rejected rather than enabled", temp((dir) => {
  new ProfileStore(dir);
  const file = join(dir, PROFILE_FILE);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  doc.profiles[0].settings.contextDiet = "on";
  writeFileSync(file, JSON.stringify(doc));
  assert.throws(() => new ProfileStore(dir), /Malformed profile entry/);
}));

test("cache diagnostics are on by default, saved per profile, and older profiles load without rewriting", temp((dir) => {
  new ProfileStore(dir);
  const file = join(dir, PROFILE_FILE);
  const legacy = JSON.parse(readFileSync(file, "utf8"));
  delete legacy.profiles[0].settings.cacheDiagnostics;
  const original = JSON.stringify(legacy);
  writeFileSync(file, original);
  const store = new ProfileStore(dir);
  assert.equal(store.active().settings.cacheDiagnostics, true);
  assert.equal(readFileSync(file, "utf8"), original);
  store.add("Quiet", "dark", { ...defaultVisualSettings(), cacheDiagnostics: false });
  const restarted = new ProfileStore(dir);
  assert.equal(restarted.list()[0]!.settings.cacheDiagnostics, true);
  assert.equal(restarted.list()[1]!.settings.cacheDiagnostics, false);
  restarted.update("Quiet", { settings: { ...restarted.list()[1]!.settings, cacheDiagnostics: true } });
  assert.equal(new ProfileStore(dir).list()[1]!.settings.cacheDiagnostics, true);
}));

test("malformed cache-diagnostics preferences are rejected rather than enabled or disabled", temp((dir) => {
  new ProfileStore(dir);
  const file = join(dir, PROFILE_FILE);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  doc.profiles[0].settings.cacheDiagnostics = "off";
  writeFileSync(file, JSON.stringify(doc));
  assert.throws(() => new ProfileStore(dir), /Malformed profile entry/);
}));

test("profiles persist stable IDs, themes and role maps across restart; cycles safely", temp((dir) => {
  const store = new ProfileStore(dir, "pi-jar-dark-violet", { version: 2, roles: { default: "openai/gpt-test" } });
  assert.equal(store.active().theme, "pi-jar-dark-violet");
  assert.equal(store.active().roles.roles.default, "openai/gpt-test");
  const created = store.add("Writing", "pi-jar-dark-amber", defaultVisualSettings(), { version: 2, roles: { reviewer: "anthropic/claude-test" } });
  assert.equal(store.cycle().name, "Writing");
  assert.equal(store.active().id, created.id);
  const restarted = new ProfileStore(dir);
  assert.equal(restarted.active().name, "Writing");
  assert.equal(restarted.active().theme, "pi-jar-dark-amber");
  assert.equal(restarted.active().roles.roles.reviewer, "anthropic/claude-test");
  assert.equal(restarted.list()[1]!.id, created.id);
  assert.equal(restarted.list()[0]!.id, "default");
}));

test("updating an inactive profile validates, clones and returns that profile", temp((dir) => {
  const store = new ProfileStore(dir);
  store.add("Writing", "dark", defaultVisualSettings());
  const settings = defaultVisualSettings();
  settings.animations = false;
  const changed = store.update("Writing", { settings, theme: "light" });
  assert.equal(changed.name, "Writing");
  settings.animations = true;
  assert.equal(store.list()[1]!.settings.animations, false);
  const before = readFileSync(join(dir, PROFILE_FILE), "utf8");
  assert.throws(() => store.update("Writing", { theme: "" }), /Invalid/);
  assert.equal(readFileSync(join(dir, PROFILE_FILE), "utf8"), before);
  assert.equal(store.activeName, "Default");
}));

test("profile name validation is case-insensitive and rejects control characters", temp((dir) => {
  const store = new ProfileStore(dir);
  assert.throws(() => store.add("default", "theme", defaultVisualSettings()), /already exists/);
  assert.throws(() => store.add("bad\nname", "theme", defaultVisualSettings()), /control/);
  assert.throws(() => store.add("../escape", "theme", defaultVisualSettings()), /slashes/);
  assert.throws(() => store.add("bad\u0001name", "theme", defaultVisualSettings()), /control/);
  assert.equal(store.list().length, 1);
}));

test("corrupt and unsupported profile state is never overwritten", temp((dir) => {
  const file = join(dir, PROFILE_FILE);
  writeFileSync(file, JSON.stringify({ version: 9 }));
  assert.throws(() => new ProfileStore(dir), /Unsupported/);
  assert.equal(readFileSync(file, "utf8"), JSON.stringify({ version: 9 }));
  writeFileSync(file, JSON.stringify({ version: 1, active: "Default", profiles: [{ name: "Default", id: "default", theme: "x", settings: {}, roles: {} }] }));
  assert.throws(() => new ProfileStore(dir), /Malformed/);
  const missingDefault = { version: 1, active: "Only", profiles: [{ id: "profile-12345678", name: "Only", theme: "pi-jar-dark", settings: defaultVisualSettings(), roles: { version: 2, roles: {} } }] };
  writeFileSync(file, JSON.stringify(missingDefault));
  assert.throws(() => new ProfileStore(dir), /Default/);
  assert.equal(readFileSync(file, "utf8"), JSON.stringify(missingDefault));
}));

test("stale stores and externally corrupted files are never overwritten", temp((dir) => {
  const first = new ProfileStore(dir);
  const stale = new ProfileStore(dir);
  first.add("First", "dark", defaultVisualSettings());
  assert.throws(() => stale.add("Lost update", "dark", defaultVisualSettings()), /reload/);
  assert.equal(stale.list().length, 1);
  assert.equal(new ProfileStore(dir).list()[1]!.name, "First");
  const file = join(dir, PROFILE_FILE);
  writeFileSync(file, '{"version":9}');
  assert.throws(() => first.activate("First"), /reload/);
  assert.equal(readFileSync(file, "utf8"), '{"version":9}');
  assert.equal(first.activeName, "Default");
}));

test("profile mutations are transactional when persistence fails", temp((dir) => {
  const store = new ProfileStore(dir);
  const candidate = store.add("Candidate", "theme", defaultVisualSettings());
  const file = join(dir, PROFILE_FILE);
  unlinkSync(file); mkdirSync(file);
  assert.throws(() => store.add("Fail", "theme", defaultVisualSettings()), /directory|EISDIR|file exists/i);
  assert.equal(store.list().length, 2);
  assert.throws(() => store.activate(candidate.name), /directory|EISDIR|file exists/i);
  assert.equal(store.activeName, "Default", "failed disk write leaves active profile unchanged");
}));

test("new profiles ask only name and theme; cancellation and invalid names leave the store untouched", temp(async (dir) => {
  const store = new ProfileStore(dir);
  const asked: string[] = [];
  const makeCtx = (answers: unknown[]) => ({ hasUI: true, mode: "tui", ui: {
    input: async (title: string) => { asked.push(title); return answers.shift(); },
    custom: async (factory: Function) => { asked.push("theme"); return pickPopup(factory, answers.shift()); },
    confirm: async () => assert.fail("creation needs no confirmation step"),
    notify() {}
  } });
  const options = { store, themes: ["pi-jar-dark", "pi-jar-dark-teal"],
    create: (name: string, theme: string) => store.add(name, theme, defaultVisualSettings(), { version: 2 as const, roles: { default: "openai/old" } }) };
  assert.equal(await promptNewProfile(makeCtx([undefined]) as never, options), undefined);
  assert.equal(await promptNewProfile(makeCtx(["New\u0001bad"]) as never, options), undefined);
  assert.equal(await promptNewProfile(makeCtx(["default"]) as never, options), undefined, "names are unique case-insensitively");
  assert.equal(await promptNewProfile(makeCtx(["New", undefined]) as never, options), undefined);
  assert.equal(store.list().length, 1);
  asked.length = 0;
  const profile = await promptNewProfile(makeCtx(["  New   one ", "pi-jar-dark-teal"]) as never, options);
  assert.deepEqual(asked.length, 2, "exactly a name and a theme question");
  assert.equal(profile?.name, "New one");
  assert.equal(profile?.theme, "pi-jar-dark-teal");
  assert.equal((await promptNewProfile(makeCtx(["Plain", "Follow Pi"]) as never, options))?.theme, "follow");
  assert.equal(store.list().length, 3);
}));
