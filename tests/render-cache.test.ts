import assert from "node:assert/strict";
import test from "node:test";
import { roundedInput } from "../src/composer.ts";
import { installCompactBuiltinTools } from "../src/compact-tools.ts";
import { renderFooter, type FooterView } from "../src/footer.ts";
import { setIconSet } from "../src/icons.ts";
import { splitFrame } from "../src/split-view.ts";
import { welcomeLines } from "../src/welcome.ts";

// Pi mutates its theme in place on /theme, so a painter with the same identity can change its output.
const livePainter = () => {
  let code = 31;
  return { recolor: (next: number) => { code = next; }, paint: (text: string) => `\x1b[${code}m${text}\x1b[39m` };
};
const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

test("cached chrome repaints after an in-place theme change and hands callers their own copy", () => {
  const view: FooterView = { model: "claude", context: "ctx 5%", branch: "main", sessionName: "audit", roles: [], extras: [], demo: false, animations: false, frame: 0 };
  const live = livePainter();
  const theme = { fg: (_color: string, text: string) => live.paint(text) };
  const first = renderFooter(view, 80, theme);
  first.push("changed by a caller");
  assert.deepEqual(renderFooter(view, 80, theme), first.slice(0, -1));
  live.recolor(34);
  const recolored = renderFooter(view, 80, theme).join("");
  assert.ok(recolored.includes("\x1b[34m") && !recolored.includes("\x1b[31m"));

  const border = { borderColor: (text: string) => live.paint(text) };
  const draft = ["─".repeat(38), "draft", "─".repeat(38)];
  live.recolor(31);
  assert.ok(roundedInput(draft, 40, false, border as never).join("").includes("\x1b[31m"));
  live.recolor(34);
  assert.ok(!roundedInput(draft, 40, false, border as never).join("").includes("\x1b[31m"));

  const info = { message: "A small spark is enough to begin.", flameSeed: 3 };
  const fg = (_color: string, text: string) => live.paint(text);
  live.recolor(31);
  assert.ok(welcomeLines(100, 2, fg, info).join("").includes("\x1b[31m"));
  live.recolor(34);
  assert.ok(!welcomeLines(100, 2, fg, info).join("").includes("\x1b[31m"));
  assert.ok(welcomeLines(100, 2, fg, { ...info, model: "fresh-model" }).join("").includes("fresh-model"), "new inputs are drawn");
});

test("cached footer follows the icon set", () => {
  const view: FooterView = { model: "claude", context: "ctx 5%", branch: "main", roles: [], extras: [], demo: false, animations: false, frame: 0 };
  try {
    setIconSet("unicode");
    assert.ok(renderFooter(view, 80, plain).join("").includes("⬢ claude"));
    setIconSet("ascii");
    assert.ok(!renderFooter(view, 80, plain).join("").includes("⬢"));
  } finally { setIconSet("unicode"); }
});

test("row reuse redraws exactly what changed while typing and scrolling", () => {
  const theme = { borderColor: (text: string) => `<${text}>` };
  const rows = Array.from({ length: 10 }, (_, index) => `row ${index}`.padEnd(38));
  const before = roundedInput(["─".repeat(38), ...rows, "─".repeat(38)], 40, false, theme as never);
  const edited = rows.slice();
  edited[4] = "row 4 edited".padEnd(38);
  const after = roundedInput(["─".repeat(38), ...edited, "─".repeat(38)], 40, false, theme as never);
  assert.match(after[5]!, /row 4 edited/);
  assert.deepEqual(after.filter((_, index) => index !== 5), before.filter((_, index) => index !== 5));

  const body = ["alpha", "beta", "gamma", "delta"];
  const top = splitFrame(plain, 40, "t", [], body.slice(0, 3), ["footer"], 3, 0).lines;
  const scrolled = splitFrame(plain, 40, "t", [], body.slice(1), ["footer"], 3, 0).lines;
  assert.match(scrolled[1]!, /beta/);
  assert.match(scrolled[3]!, /delta/);
  assert.deepEqual(splitFrame(plain, 40, "t", [], body.slice(0, 3), ["footer"], 3, 0).lines, top);
});

test("collapsed tool cards follow each display update and compact huge commands exactly", () => {
  const tools: { name: string; renderCall: Function; renderResult: Function }[] = [];
  installCompactBuiltinTools({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); } } as never);
  const bash = tools.find((tool) => tool.name === "bash")!;
  const card = (component: { render(width: number): string[] }) => component.render(200).join("\n").trimEnd();
  // Pi re-wraps `{ content, details }` on every update; streaming swaps in a new content array.
  const partial = [{ type: "text", text: "one\ntwo" }];
  assert.match(card(bash.renderResult({ content: partial }, { expanded: false, isPartial: true }, plain, {})), /^running · 2 lines · one/);
  assert.match(card(bash.renderResult({ content: partial }, { expanded: false, isPartial: false }, plain, {})), /^done · 2 lines · one/);
  const final = [{ type: "text", text: "\n  \nthree\nfour\nfive" }];
  assert.match(card(bash.renderResult({ content: final }, { expanded: false, isPartial: false }, plain, {})), /^done · 5 lines · three/);

  const edit = tools.find((tool) => tool.name === "edit")!;
  const details = { diff: "@@\n-a\n+b\n+c" };
  assert.match(card(edit.renderResult({ content: [], details }, { expanded: false, isPartial: false }, plain, {})), /^\+2 \/ -1/);
  details.diff = "@@\n-a";
  assert.match(card(edit.renderResult({ content: [], details }, { expanded: false, isPartial: false }, plain, {})), /^\+0 \/ -1/);

  // Call cards re-render on every streamed argument delta, so only a bounded prefix is scanned.
  const collapse = (text: string, max: number) => {
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length <= max ? clean : clean.slice(0, max - 1) + "…";
  };
  for (const command of ["x".repeat(87) + " ".repeat(500) + "y", "x".repeat(88) + "   ", "x".repeat(88) + " ".repeat(500), "x".repeat(89) + " ".repeat(300), "x".repeat(90) + " ".repeat(400),
    " ".repeat(10_000) + "echo hi", "a ".repeat(5000), "cat <<EOF\n" + "line\n".repeat(20_000) + "EOF", "x".repeat(240) + " \n\t ".repeat(1000) + "z", "\u00a0".repeat(300) + "é"]) {
    assert.equal(card(bash.renderCall({ command }, plain, { expanded: false })), "$ " + collapse(command, 88));
  }
});
