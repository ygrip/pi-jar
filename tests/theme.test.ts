import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ACCENTS, ACCENT_NAMES, selectAccent } from "../src/accent.ts";

interface ThemeFile {
  name: string;
  vars: Record<string, string>;
  colors: Record<string, string>;
  export: Record<string, string>;
}
const readTheme = (name: string): ThemeFile => JSON.parse(readFileSync(new URL(`../themes/${name}.json`, import.meta.url), "utf8")) as ThemeFile;
const base = readTheme("pi-jar-dark");
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
  assert.equal(selectAccent(ctx as never, "amber"), true);
  assert.equal(active, "pi-jar-dark-amber");
  assert.equal(selectAccent(ctx as never, "pink"), false); // not installed
  assert.equal(active, "pi-jar-dark-amber");
  assert.equal(selectAccent(ctx as never, "../../escape"), false);
  assert.equal(selectAccent(ctx as never, "default"), true);
  assert.equal(active, "pi-jar-dark");
  assert.equal(selectAccent({ ...ctx, mode: "rpc" } as never, "amber"), false);
});
