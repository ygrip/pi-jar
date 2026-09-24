import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { openJarHistory } from "../src/history-ui.ts";
import piJar from "../extensions/index.ts";

const plain = { fg: (_color: string, text: string) => text };
const message = (index: number, content = `Message ${index}`) => ({ type: "message", id: String(index), parentId: null,
  timestamp: "2024-01-01T12:00:00Z", message: { role: index % 2 ? "assistant" : "user", content: index % 2 ? [{ type: "text", text: content }] : content, timestamp: 0 } });

async function setup(entries: unknown[]) {
  let reads = 0;
  let done = false;
  let renders = 0;
  let pane: { render(width: number): string[]; handleInput(data: string): void; handleMouse(event: unknown): unknown } | undefined;
  const ctx = {
    hasUI: true, mode: "tui", sessionManager: { getBranch() { reads++; return entries; } },
    ui: { async custom(factory: Function, options: unknown) {
      assert.deepEqual(options, { overlay: true, overlayOptions: { anchor: "center", width: 92, maxHeight: "80%" } });
      pane = factory({ requestRender() { renders++; } }, plain, {}, () => { done = true; });
    } }
  };
  await openJarHistory(ctx as never);
  return { pane: pane!, get reads() { return reads; }, get done() { return done; }, get renders() { return renders; } };
}
const text = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

test("/jar history uses public active branch once and is unavailable without interactive TUI", async () => {
  let handler: Function | undefined;
  piJar({ on() {}, registerCommand(_name: string, command: { handler: Function }) { handler = command.handler; } } as never);
  let reads = 0;
  let opens = 0;
  const warnings: string[] = [];
  const ctx = {
    hasUI: true, mode: "tui", sessionManager: { getBranch() { reads++; return [message(0, "active branch only")]; } },
    ui: { notify(text: string) { warnings.push(text); }, async custom(factory: Function) {
      opens++;
      const pane = factory({ requestRender() {} }, plain, {}, () => {});
      assert.match(text(pane.render(80)), /active branch only/);
      pane.handleInput("p");
    } }
  };
  await handler?.("history", ctx);
  assert.equal(reads, 1);
  assert.equal(opens, 1);
  await handler?.("history", { ...ctx, hasUI: false, mode: "print" });
  assert.equal(opens, 1);
  assert.deepEqual(warnings, ["History requires the interactive TUI"]);
});

test("history overlay is bounded by current terminal height and width including Unicode/control text", async () => {
  const entries = [message(0, "文🙂\x1b]52;c;secret\x07\u202e" + "x".repeat(10000)),
    { type: "message", id: "tool", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "```js\n\x1b]52;c;clipboard\x07\x1b[2J\x9b2J\tconst x = 2;\r```" }], isError: false } }];
  const view = await setup(entries);
  const prior = process.stdout.rows;
  try {
    for (const rows of [16, 24, 50]) {
      process.stdout.rows = rows;
      for (const width of [12, 16, 40, 80, 120]) {
        const rendered = view.pane.render(width);
        assert.ok(rendered.length <= Math.floor(rows * 0.8), `${rows}: ${rendered.length} lines`);
        assert.ok(rendered.every((line) => visibleWidth(line) <= width), `overflow at width ${width}`);
        // Pi's trusted truncateToWidth may insert ANSI resets; session data must not emit OSC/CSI payloads.
        assert.doesNotMatch(rendered.join("\n"), /\x1b\]|\x1b\[2J|\x9b2J|\u202e/);
        assert.doesNotMatch(text(rendered), /secret|clipboard|\x1b|[\x80-\x9f]/);
      }
    }
  } finally { process.stdout.rows = prior; }
  assert.equal(view.reads, 1);
  assert.ok(!view.done);
});

test("history search captures shortcuts, supports previous/next and Escape exits search first", async () => {
  const view = await setup([message(0, "first needle"), message(1, "second needle"), message(2, "third")]);
  view.pane.render(80);
  view.pane.handleInput("/");
  for (const key of ["n", "e", "p", "o", "[", "]", "N"]) view.pane.handleInput(key);
  assert.match(text(view.pane.render(80)), /Search previews|\/nepo\[\]N/); // input, not navigation
  view.pane.handleInput("\x1b");
  assert.ok(!view.done);
  view.pane.handleInput("/");
  view.pane.handleInput("needle");
  view.pane.handleInput("\r");
  assert.match(text(view.pane.render(80)), /YOU #1|ASSISTANT #2/);
  const before = text(view.pane.render(80));
  view.pane.handleInput("n");
  assert.notEqual(text(view.pane.render(80)), before);
  view.pane.handleInput("N");
  assert.equal(text(view.pane.render(80)), before);
  view.pane.handleInput("\x1b");
  assert.ok(view.done);
  assert.equal(view.reads, 1);
});

test("keyboard pages, detail chunks and fullscreen pointer selection never change branch data", async () => {
  const entries = Array.from({ length: 165 }, (_, i) => message(i, i === 164 ? "line\n".repeat(1000) : `Message ${i}`));
  const view = await setup(entries);
  assert.match(text(view.pane.render(80)), /page 1\/3/);
  view.pane.handleInput("e");
  view.pane.handleInput("]");
  assert.match(text(view.pane.render(80)), /2 segment/);
  view.pane.handleInput("[");
  assert.match(text(view.pane.render(80)), /1 segment/);
  view.pane.handleInput("p");
  assert.match(text(view.pane.render(80)), /page 2\/3/);
  view.pane.handleInput("o");
  assert.match(text(view.pane.render(80)), /page 1\/3/);
  const before = text(view.pane.render(80));
  assert.deepEqual(view.pane.handleMouse({ type: "click", button: "left", x: 4, y: 3 }), { handled: true, focus: true });
  assert.notEqual(text(view.pane.render(80)), before);
  assert.deepEqual(view.pane.handleMouse({ type: "wheel", button: "none", x: 4, y: 4, wheelDelta: 1 }), { handled: true, focus: true });
  assert.equal(view.reads, 1);
  assert.equal(entries.at(-1)?.message.content, "line\n".repeat(1000));
  assert.ok(view.renders > 0);
  view.pane.handleMouse({ type: "click", button: "left", x: 78, y: 0 });
  assert.ok(view.done);
});
