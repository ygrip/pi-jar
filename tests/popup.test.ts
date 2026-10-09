import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { promptChoice, todoView } from "../src/dialogs.ts";
import { popup } from "../src/popup.ts";
import { TodoStore } from "../src/tasks.ts";
import { popupTheme } from "./popup-fixture.ts";

function harness(rows = 12) {
  let component: any;
  let options: any;
  const terminal = { rows };
  const ctx = { hasUI: true, mode: "tui", ui: { custom(factory: Function, opts: unknown) {
    options = opts;
    return new Promise((resolve) => { component = factory({ requestRender() {}, terminal }, popupTheme, {}, resolve); });
  } } };
  return { ctx, terminal, get component() { return component; }, get options() { return options; } };
}

test("choice popup searches the entire list, scrolls/pages/resizes and returns the original index", async () => {
  const h = harness();
  const choices = Array.from({ length: 100 }, (_, i) => `provider/model-${i} 界`);
  const result = promptChoice(h.ctx as never, "Models", "Choose a model", choices);
  const render = () => {
    const lines = h.component.render(30);
    assert.ok(lines.length <= h.terminal.rows);
    assert.ok(lines.every((line: string) => visibleWidth(line) <= 30));
    return lines;
  };
  render();
  h.component.handleInput("\x1b[6~");
  assert.match(render().join("\n"), /model-8/);
  h.component.handleInput("model-99");
  assert.match(render().join("\n"), /model-99/);
  h.terminal.rows = 5;
  const rows = render();
  const at = rows.findIndex((line: string) => line.startsWith("❯ ") && line.includes("model-99"));
  assert.ok(at >= 0);
  h.component.handleMouse({ type: "click", button: "left", x: 3, y: at });
  assert.equal(await result, 99);
  assert.equal(h.options.overlay, true);
});

test("no-match Enter cannot choose a hidden item; Escape cancels", async () => {
  const h = harness();
  let settled = false;
  const result = promptChoice(h.ctx as never, "Models", "", ["one", "two"]).then((value) => { settled = true; return value; });
  h.component.handleInput("missing");
  assert.match(h.component.render(50).join("\n"), /No matches/);
  h.component.handleInput("\r");
  await Promise.resolve();
  assert.equal(settled, false);
  h.component.handleInput("\x1b");
  assert.equal(await result, undefined);
});

test("oversized popup chrome is scrollable and filtered mouse coordinates map back to the child", async () => {
  const h = harness(6);
  const source = Array.from({ length: 50 }, (_, i) => `row-${i} ${"界".repeat(30)}`);
  let clicked = -1;
  const result = popup(h.ctx as never, (_tui, _theme, _keys, done) => ({
    invalidate() {}, render: () => source,
    handleMouse(event) { clicked = event.y; done(undefined); return { handled: true }; }
  }));
  let lines = h.component.render(20);
  assert.equal(lines.length, 6);
  assert.ok(lines.every((line: string) => visibleWidth(line) <= 20));
  h.component.handleMouse({ type: "wheel", wheelDelta: 1 });
  lines = h.component.render(20);
  assert.match(lines[1], /row-3/);
  h.component.handleInput("/");
  h.component.handleInput("row-49");
  lines = h.component.render(20);
  const at = lines.findIndex((line: string) => line.startsWith("row-49"));
  assert.ok(at >= 0);
  h.component.handleMouse({ type: "click", button: "left", x: 1, y: at });
  await result;
  assert.equal(clicked, 49);
});

test("task popup folds parents and searches tasks outside the current viewport", async () => {
  const h = harness(8);
  const store = new TodoStore(() => {});
  assert.equal(store.write([{ title: "Parent", status: "pending", subtasks: [{ title: "Child", status: "pending" }] },
    ...Array.from({ length: 30 }, (_, i) => ({ title: `Task ${i}`, status: "pending" as const }))]), undefined);
  const result = todoView(h.ctx as never, () => store.all(), { value: "all" });
  h.component.render(60);
  h.component.handleInput("\x1b[D");
  assert.doesNotMatch(h.component.render(60).map(stripTerminalSequences).join("\n"), /Child/);
  h.component.handleInput("\x1b[C");
  assert.match(h.component.render(60).join("\n"), /Child/);
  h.component.handleInput("/"); h.component.handleInput("Task 29"); h.component.handleInput("\r");
  assert.match(h.component.render(60).join("\n"), /Task 29/);
  h.component.handleInput("\r");
  assert.equal((await result)?.id, store.all().find((item) => item.title === "Task 29")!.id);
});
