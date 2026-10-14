import assert from "node:assert/strict";
import test from "node:test";
import { ComposerStyle, roundedInput } from "../src/composer.ts";
import { icon, iconSet, setIconSet } from "../src/icons.ts";

test("task widget owns the perch only while tasks are visible", () => {
  const style = new ComposerStyle();
  style.setActivity("idle", false);
  let factory: any = () => ({
    getText: () => "", handleInput() {}, invalidate() {},
    render: (width: number) => ["─".repeat(width), "\x1b[7m \x1b[0m", "─".repeat(width)]
  });
  const ctx = {
    hasUI: true, mode: "tui", ui: {
      getEditorComponent: () => factory, setEditorComponent: (next: any) => { factory = next; },
      getEditorText: () => "", setEditorText() {}, theme: { fg: (_color: string, text: string) => text }
    }
  };
  assert.equal(style.enable(ctx as never), true);
  const editor = factory({ terminal: { rows: 24 }, requestRender() {} }, { borderColor: (text: string) => text }, {});
  assert.equal(editor.render(80).length, 9);
  style.setTasksVisible(true);
  assert.equal(editor.render(80).length, 3, "mascot must not be duplicated above the composer");
  assert.equal(style.renderMascot(80)?.length, 6, "widget can still render the shared mascot");
  style.setTasksVisible(false);
  assert.equal(editor.render(80).length, 9, "perch returns when the task widget disappears");
  style.setMascot(false);
  assert.equal(style.renderMascot(80), undefined);
  style.disable(ctx as never);
});

test("ghost suggestions use the selected icon set without changing the suggestion", () => {
  const previous = iconSet();
  try {
    for (const set of ["unicode", "nerd", "ascii"] as const) {
      setIconSet(set);
      const lines = roundedInput(["─".repeat(58), "\x1b[7m \x1b[0m", "─".repeat(58)], 60, false,
        { borderColor: (text: string) => text } as never, undefined, "pi", "", {
          ghost: "Run the full test suite", hint: `${icon("tab")} accept`
        });
      assert.ok(lines[1]!.includes("Run the full test suite"));
      assert.ok(lines[1]!.includes(set === "ascii" ? "tab" : `${icon("tab")} tab`));
      assert.ok(lines.at(-1)!.includes(`${icon("tab")} accept`));
    }
  } finally { setIconSet(previous); }
});

test("ghost suggestions follow pi-tui 1.2 fake-cursor markers", () => {
  const cursor = "\x1b_pi:c\x07\x1b_pi:fc\x07 \x1b_pi:/fc\x07";
  const lines = roundedInput(["".padEnd(58, "\u2500"), cursor + " ".repeat(57), "".padEnd(58, "\u2500")], 60, false,
    { borderColor: (text: string) => text } as never, undefined, "pi", "", { ghost: "Run the full test suite" });
  assert.ok(lines[1]!.includes(cursor + "Run the full test suite"));
});
