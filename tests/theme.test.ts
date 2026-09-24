import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { ACCENTS, ACCENT_NAMES, loadedAccents, selectAccent } from "../src/accent.ts";
import piJar from "../extensions/index.ts";

interface ThemeFile {
  name: string;
  vars: Record<string, string>;
  colors: Record<string, string>;
  export: Record<string, string>;
}
const readTheme = (name: string): ThemeFile => JSON.parse(readFileSync(new URL(`../themes/${name}.json`, import.meta.url), "utf8")) as ThemeFile;
const base = readTheme("pi-jar-dark");
const initialAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-jar-theme-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
after(() => {
  if (initialAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = initialAgentDir;
  rmSync(testAgentDir, { recursive: true, force: true });
});
const toRgb = (hex: string) => [1, 3, 5].map((n) => parseInt(hex.slice(n, n + 2), 16) / 255);
const luminance = (hex: string) => toRgb(hex).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
const contrast = (a: string, b: string) => {
  const light = Math.max(luminance(a), luminance(b));
  const dark = Math.min(luminance(a), luminance(b));
  return (light + 0.05) / (dark + 0.05);
};

test("Setara × Punakawan theme preserves semantic colors across all six dark accents", () => {
  assert.equal(base.vars.accent, "#00C2B8"); // Setara dark teal
  assert.equal(base.export.pageBg, "#0B1018"); // Punakawan dark canvas
  assert.equal(base.colors.accent, "accent");
  const semantic = ["success", "warning", "error", "toolSuccessBg", "toolErrorBg", "toolDiffAdded", "toolDiffRemoved"];
  const expected = Object.fromEntries(semantic.map((key) => [key, base.colors[key]]));
  assert.equal(ACCENT_NAMES.length, 6);
  for (const [name, values] of Object.entries(ACCENTS)) {
    const variant = readTheme(`pi-jar-dark-${name}`);
    assert.equal(variant.name, `pi-jar-dark-${name}`);
    assert.deepEqual(Object.keys(variant.colors), Object.keys(base.colors));
    assert.deepEqual(variant.colors, base.colors);
    assert.deepEqual(variant.export, base.export);
    assert.deepEqual(Object.fromEntries(semantic.map((key) => [key, variant.colors[key]])), expected);
    assert.equal(variant.vars.accent, values.accent);
    assert.equal(variant.vars.selected, values.selected);
    assert.ok(contrast(values.accent, base.export.pageBg) >= 4.5, `${name} accent must remain legible`);
    assert.ok(contrast(base.vars.text, base.vars.userBg) >= 7, "body text must remain legible");
  }
});

test("accent switch uses only complete installed themes and has a safe fallback", () => {
  let active = "not-pi-jar";
  const ctx = { hasUI: true, mode: "tui", ui: {
    getTheme: (name: string) => name.endsWith("-amber") || name === "pi-jar-dark" ? { name } : undefined,
    setTheme: (name: string) => { active = name; return { success: true }; }
  } };
  assert.deepEqual(loadedAccents(ctx as never), ["default", "amber"]);
  assert.equal(selectAccent(ctx as never, "amber"), true);
  assert.equal(active, "pi-jar-dark-amber");
  assert.equal(selectAccent(ctx as never, "pink"), false); // not installed
  assert.equal(active, "pi-jar-dark-amber");
  assert.equal(selectAccent(ctx as never, "../../escape"), false);
  assert.equal(selectAccent(ctx as never, "default"), true);
  assert.equal(active, "pi-jar-dark");
  assert.equal(selectAccent({ ...ctx, mode: "rpc" } as never, "amber"), false);
});

test("accent command distinguishes unknown presets, missing theme registration, and a loaded preset", async () => {
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const notices: { text: string; level: string }[] = [];
  let loaded = false;
  let active = "dark";
  piJar({ on() {}, registerCommand(name: string, value: { handler: typeof command }) {
    if (name === "jar") command = value.handler;
  } } as never);
  const ctx = { hasUI: true, mode: "tui", ui: {
    get theme() { return { name: active }; },
    getTheme: (name: string) => loaded && name.startsWith("pi-jar-dark") ? { name } : undefined,
    setTheme: (name: string) => { active = name; return { success: true }; },
    notify: (text: string, level: string) => notices.push({ text, level }),
    setWorkingIndicator() {}
  } };
  await command!("accent", ctx);
  assert.match(notices.at(-1)!.text, /loaded accents: none/);
  await command!("accent violet", ctx);
  assert.match(notices.at(-1)!.text, /accent violet is not loaded.*pi install.*--theme/);
  assert.equal(notices.at(-1)!.level, "warning");
  await command!("accent invisible", ctx);
  assert.match(notices.at(-1)!.text, /Unknown pi-jar accent/);
  loaded = true;
  await command!("accent violet", ctx);
  assert.equal(active, "pi-jar-dark-violet");
  assert.equal(notices.at(-1)!.text, "pi-jar accent: violet");
  await command!("accent", ctx);
  assert.match(notices.at(-1)!.text, /loaded accents: default, gray, pink, teal, azure, violet, amber/);
});
