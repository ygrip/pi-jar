import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileStore, PROFILE_FILE } from "../src/profiles.ts";
import { defaultVisualSettings } from "../src/settings.ts";
import { createProfileWizard } from "../src/profile-wizard.ts";

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

test("wizard cancellation at each selection leaves store untouched; final confirmation commits", temp(async (dir) => {
  const store = new ProfileStore(dir);
  const settings = defaultVisualSettings();
  const makeCtx = (answers: unknown[]) => ({ hasUI: true, mode: "tui", ui: {
    input: async () => answers.shift(), select: async () => answers.shift(), confirm: async () => answers.shift(),
    notify() {}
  } });
  const options = { themes: ["pi-jar-dark", "pi-jar-dark-teal"], settings, roles: { version: 2 as const, roles: { default: "openai/old" } },
    create: (name: string, theme: string, value: typeof settings, roles: { version: 2; roles: Record<string, string> }) => store.add(name, theme, value, roles) };
  assert.equal(await createProfileWizard(makeCtx(["New\u0001bad"]) as never, store, options), undefined);
  assert.equal(await createProfileWizard(makeCtx(["New", undefined]) as never, store, options), undefined);
  assert.equal(await createProfileWizard(makeCtx(["New", "pi-jar-dark-teal", undefined]) as never, store, options), undefined);
  assert.equal(await createProfileWizard(makeCtx(["New", "Follow Pi", "", false]) as never, store, options), undefined);
  assert.equal(store.list().length, 1);
  const profile = await createProfileWizard(makeCtx(["New", "pi-jar-dark-teal", "default=openai/new", true]) as never, store,
    { ...options, roleManager: undefined });
  assert.equal(profile?.theme, "pi-jar-dark-teal");
  assert.equal(profile?.roles.roles.default, "openai/new");
  assert.equal(store.list().length, 2);
  let confirmation = "";
  const wizardAnswers = ["Nested", "reviewer=openrouter/anthropic/claude,plan=@default"];
  const wizardCtx = { hasUI: true, mode: "tui", ui: {
    input: async () => wizardAnswers.shift(),
    select: async () => "Follow Pi", confirm: async (_title: string, message: string) => { confirmation = message; return true; }, notify() {}
  } };
  const nested = await createProfileWizard(wizardCtx as never, store, { ...options, create: (name, theme, value, roles) => store.add(name, theme, value, roles) });
  assert.equal(nested?.theme, "follow");
  assert.equal(nested?.roles.roles.reviewer, "openrouter/anthropic/claude");
  assert.equal(nested?.roles.roles.plan, "@default");
  assert.match(confirmation, /reviewer → openrouter\/anthropic\/claude/);
  assert.match(confirmation, /Theme: Follow Pi/);
}));
