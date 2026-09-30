import assert from "node:assert/strict";
import test from "node:test";
import { roundedInput } from "../src/composer.ts";
import { icon, iconSet, setIconSet } from "../src/icons.ts";

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
