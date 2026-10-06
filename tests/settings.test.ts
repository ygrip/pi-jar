import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_FOOTER_SETTINGS } from "../src/footer-settings.ts";
import { defaultVisualSettings, loadVisualSettings, saveVisualSettings, SETTINGS_FILE, MAX_SUBAGENT_CHOICES, isMaxSubagents, DEFAULT_CONTEXT_BUDGET } from "../src/settings.ts";
import { openJarSettings } from "../src/settings-ui.ts";

test("visual preferences ignore retired legacy footer files and validate fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jar-visual-"));
  try {
    const legacyFile = join(dir, "pi-jar-footer.json");
    writeFileSync(legacyFile, JSON.stringify({ ...DEFAULT_FOOTER_SETTINGS, cwd: false, effort: false }));
    const legacy = readFileSync(legacyFile, "utf8");

    // The retired file is neither imported nor migrated. A missing unified settings
    // file always starts from current defaults.
    assert.equal(loadVisualSettings(dir).footer.cwd, true);
    assert.equal(existsSync(join(dir, SETTINGS_FILE)), false);

    const chosen = { ...loadVisualSettings(dir), animations: false, accent: "violet" as const,
      footer: { ...DEFAULT_FOOTER_SETTINGS, cwd: false } };
    saveVisualSettings(dir, chosen);
    assert.deepEqual(loadVisualSettings(dir), chosen);
    assert.equal(readFileSync(legacyFile, "utf8"), legacy, "legacy file is never rewritten");

    writeFileSync(legacyFile, '{"cwd":true}');
    assert.equal(loadVisualSettings(dir).footer.cwd, false, "unified settings remain authoritative");

    writeFileSync(join(dir, SETTINGS_FILE), '{"version":1,"accent":"bad","animations":"bad","footer":{"model":false}}');
    const partial = loadVisualSettings(dir);
    assert.equal(partial.accent, "follow");
    assert.equal(partial.animations, true);
    assert.equal(partial.footer.model, false);
    assert.equal(partial.footer.cwd, true);
    assert.equal(partial.footer.memory, true);

    writeFileSync(join(dir, SETTINGS_FILE), "malformed");
    assert.equal(loadVisualSettings(dir).footer.cwd, true);
    assert.throws(() => saveVisualSettings(dir, chosen), /malformed/);
    assert.equal(readFileSync(join(dir, SETTINGS_FILE), "utf8"), "malformed");

    writeFileSync(join(dir, SETTINGS_FILE), '{"version":2,"accent":"violet"}');
    assert.throws(() => saveVisualSettings(dir, chosen), /unknown pi-jar settings version/);
    assert.equal(readFileSync(join(dir, SETTINGS_FILE), "utf8"), '{"version":2,"accent":"violet"}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("max subagents defaults, validates supported choices and persists", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jar-subagent-settings-"));
  try {
    assert.equal(defaultVisualSettings().maxSubagents, 2);
    assert.equal(loadVisualSettings(dir).maxSubagents, 2);
    assert.deepEqual(MAX_SUBAGENT_CHOICES, [2, 4, 6, 8, 16]);
    for (const maxSubagents of MAX_SUBAGENT_CHOICES) {
      assert.equal(isMaxSubagents(maxSubagents), true);
      const settings = { ...defaultVisualSettings(), maxSubagents };
      saveVisualSettings(dir, settings);
      assert.equal(JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8")).maxSubagents, maxSubagents);
      assert.deepEqual(loadVisualSettings(dir), settings);
    }
    for (const invalid of [undefined, null, "8", false, 0, 1, 3, 5, 7, 9, 17, 50, 4.5, {}, []]) {
      assert.equal(isMaxSubagents(invalid), false);
      writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify({ version: 1, maxSubagents: invalid, goalRounds: 12 }));
      assert.equal(loadVisualSettings(dir).maxSubagents, 2);
      assert.equal(loadVisualSettings(dir).goalRounds, 12);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("context budget and read cache fall back on invalid stored values and persist valid ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jar-budget-settings-"));
  try {
    assert.deepEqual(loadVisualSettings(dir).contextBudget, DEFAULT_CONTEXT_BUDGET);
    assert.equal(loadVisualSettings(dir).readCache, false);
    for (const invalid of [null, 120000, { softTokens: 9_999, action: "suggest" }, { softTokens: 120000.5, action: "suggest" },
      { softTokens: 120000, action: "nag" }, { softTokens: "120000", action: "off" }]) {
      writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify({ version: 1, contextBudget: invalid, readCache: "yes" }));
      assert.deepEqual(loadVisualSettings(dir).contextBudget, DEFAULT_CONTEXT_BUDGET);
      assert.equal(loadVisualSettings(dir).readCache, false);
    }
    const settings = { ...defaultVisualSettings(), contextBudget: { softTokens: 150_000, action: "compact" as const }, readCache: true };
    saveVisualSettings(dir, settings);
    assert.deepEqual(loadVisualSettings(dir), settings);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("malformed retired footer files are ignored without being touched", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jar-invalid-legacy-"));
  try {
    const legacyFile = join(dir, "pi-jar-footer.json");
    writeFileSync(legacyFile, "not-json");
    assert.equal(loadVisualSettings(dir).footer.model, true);
    assert.equal(readFileSync(legacyFile, "utf8"), "not-json");
    assert.equal(existsSync(join(dir, SETTINGS_FILE)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("settings pane supports fullscreen clicks, keyboard operation and narrow widths", async () => {
  let state = defaultVisualSettings();
  let pane: { render(width: number): string[]; handleInput(data: string): void; handleMouse(event: unknown): unknown } | undefined;
  let closed = false;
  let renders = 0;
  const ctx = { hasUI: true, mode: "tui", ui: {
    custom: async (factory: Function, options: unknown) => {
      assert.equal(options, undefined);
      pane = factory({ requestRender() { renders++; } }, { fg: (_color: string, text: string) => text }, {}, () => { closed = true; });
      for (const width of [16, 40, 64]) assert.ok(pane!.render(width).every((line) => visibleWidth(line) <= width));
      pane!.render(64);
      pane!.handleInput("\x1b[B");
      pane!.handleInput(" ");
      assert.equal(state.animations, false);
      pane!.handleMouse({ type: "click", button: "left", x: 29, y: 1 });
      assert.match(pane!.render(64).join(" "), /FOOTER VISIBILITY/);
      pane!.handleMouse({ type: "click", button: "left", x: 5, y: 5 });
      assert.equal(state.footer.model, false);
      pane!.handleInput("\x1b");
    }
  } };
  await openJarSettings(ctx as never, () => state, (next) => { state = next; }, ["default", "violet"]);
  assert.equal(closed, true);
  assert.ok(renders >= 3);
});

test("Pi tab toggles fullscreen mouse, copy-on-select and goal rounds", async () => {
  let state = defaultVisualSettings();
  const prefs = { fullscreen: false, copyOnSelect: true };
  const notices: string[] = [];
  const ctx = { hasUI: true, mode: "tui", ui: {
    notify(message: string) { notices.push(message); },
    custom: async (factory: Function) => {
      const pane = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, () => {});
      pane.handleInput("\t"); pane.handleInput("\t");
      assert.match(pane.render(64).join(" "), /PI & WORKFLOWS/);
      assert.match(pane.render(64).join(" "), /Mouse clicks.*OFF/);
      pane.handleInput(" ");
      assert.equal(prefs.fullscreen, true);
      assert.ok(notices.some((notice) => /restart Pi/.test(notice)));
      pane.handleInput("\x1b[B"); pane.handleInput(" ");
      assert.equal(prefs.copyOnSelect, false);
      pane.handleInput("\x1b[B"); pane.handleInput(" ");
      assert.equal(state.goalRounds, 8); // Opening a choice does not save it.
      pane.handleInput("\x1b[B"); pane.handleInput("\r");
      assert.equal(state.goalRounds, 12);
      pane.handleMouse({ type: "click", button: "left", x: 5, y: 1 });
      assert.match(pane.render(64).join(" "), /APPEARANCE/);
      pane.handleInput("\x1b");
    }
  } };
  await openJarSettings(ctx as never, () => state, (next) => { state = next; }, [], {
    get: () => ({ ...prefs }), setFullscreen: (on) => { prefs.fullscreen = on; }, setCopyOnSelect: (on) => { prefs.copyOnSelect = on; }
  });
});
