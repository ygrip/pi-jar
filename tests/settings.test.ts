import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { saveFooterSettings, DEFAULT_FOOTER_SETTINGS } from "../src/footer-settings.ts";
import { defaultVisualSettings, loadVisualSettings, migrateLegacySettings, saveVisualSettings, SETTINGS_FILE } from "../src/settings.ts";
import { openJarSettings } from "../src/settings-ui.ts";

test("visual preferences migrate legacy footer once, validate fields and preserve legacy file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jar-visual-"));
  try {
    saveFooterSettings(dir, { ...DEFAULT_FOOTER_SETTINGS, cwd: false, effort: false });
    const legacy = readFileSync(join(dir, "pi-jar-footer.json"), "utf8");
    assert.equal(loadVisualSettings(dir).footer.cwd, false);
    assert.equal(migrateLegacySettings(dir), true);
    assert.equal(migrateLegacySettings(dir), false); // import exactly once
    const chosen = { ...loadVisualSettings(dir), animations: false, accent: "violet" as const };
    saveVisualSettings(dir, chosen);
    assert.deepEqual(loadVisualSettings(dir), chosen);
    assert.equal(readFileSync(join(dir, "pi-jar-footer.json"), "utf8"), legacy);
    writeFileSync(join(dir, "pi-jar-footer.json"), '{"cwd":true}');
    assert.equal(loadVisualSettings(dir).footer.cwd, false); // new file wins after migration
    writeFileSync(join(dir, "pi-jar-footer.json"), '{"cwd":false}');
    writeFileSync(join(dir, SETTINGS_FILE), '{"version":1,"accent":"bad","animations":"bad","footer":{"model":false}}');
    const partial = loadVisualSettings(dir);
    assert.equal(partial.accent, "follow");
    assert.equal(partial.animations, true);
    assert.equal(partial.footer.model, false);
    assert.equal(partial.footer.cwd, true); // missing new field uses defaults, never re-imports legacy
    assert.equal(partial.footer.memory, true); // older saved preferences acquire the new RSS field
    writeFileSync(join(dir, SETTINGS_FILE), "malformed");
    assert.equal(loadVisualSettings(dir).footer.cwd, true);
    assert.throws(() => saveVisualSettings(dir, chosen), /malformed/);
    assert.equal(readFileSync(join(dir, SETTINGS_FILE), "utf8"), "malformed");
    writeFileSync(join(dir, SETTINGS_FILE), '{"version":2,"accent":"violet"}');
    assert.throws(() => saveVisualSettings(dir, chosen), /unknown pi-jar settings version/);
    assert.equal(readFileSync(join(dir, SETTINGS_FILE), "utf8"), '{"version":2,"accent":"violet"}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("malformed legacy preferences are never rewritten during migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jar-invalid-legacy-"));
  try {
    writeFileSync(join(dir, "pi-jar-footer.json"), "not-json");
    assert.equal(migrateLegacySettings(dir), false);
    assert.equal(readFileSync(join(dir, "pi-jar-footer.json"), "utf8"), "not-json");
    assert.equal(loadVisualSettings(dir).footer.model, true);
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
