import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { taskWidget, type TaskWidgetState } from "../src/task-widget.ts";
import { TodoStore } from "../src/tasks.ts";
import { popupTheme } from "./popup-fixture.ts";

test("tasks render alone with a clickable heading and width-safe rows", () => {
  const store = new TodoStore(() => {});
  store.write([{ title: "Fix layout", status: "in_progress" }]);
  const state: TaskWidgetState = { expanded: false, scroll: undefined };
  const widget = taskWidget({ requestRender() {}, terminal: { rows: 24 } } as never,
    popupTheme as never, () => store.all(), state);
  const wide = widget.render(80);
  assert.equal(wide.length, 2, "heading plus spacer only; the mascot lives in the composer");
  assert.match(wide[0]!, /▸ Tasks/);
  assert.ok(wide.every((line) => visibleWidth(line) <= 80));
  widget.handleMouse({ type: "click", button: "left", x: 3, y: 0 } as never);
  assert.equal(state.expanded, true);
  assert.match(widget.render(80)[1]!, /Fix layout/);
  widget.handleMouse({ type: "click", button: "left", x: 0, y: 0 } as never);
  assert.equal(state.expanded, false);
  assert.ok(widget.render(20).every((line) => visibleWidth(line) <= 20));
});

test("task widget is compact by default, folds/expands, scrolls, and retains state on refresh", () => {
  const store = new TodoStore(() => {});
  store.write(Array.from({ length: 30 }, (_, index) => ({ title: `Task ${index}`, status: "pending" as const })));
  const state: TaskWidgetState = { expanded: false, scroll: undefined };
  const terminal = { rows: 24 };
  const tui = { requestRender() {}, terminal };
  let widget = taskWidget(tui as never, popupTheme as never, () => store.all(), state);
  assert.equal(widget.render(120).length, 2);
  assert.match(widget.render(120)[0]!, /▸ Tasks.*Task 0/);
  widget.handleMouse({ type: "click", button: "left", y: 0 } as never);
  assert.equal(state.expanded, true);
  assert.equal(widget.render(120).length, 6);
  assert.match(widget.render(120).join("\n"), /Task 3/);
  widget.handleMouse({ type: "wheel", wheelDelta: 1 } as never);
  assert.match(widget.render(120).join("\n"), /Task 6/);
  widget = taskWidget(tui as never, popupTheme as never, () => store.all(), state);
  assert.match(widget.render(120).join("\n"), /Task 6/);
  widget.handleInput("\x1b[6~");
  assert.match(widget.render(120).join("\n"), /Task 10/);
  terminal.rows = 8;
  assert.ok(widget.render(10).length <= 2);
  assert.ok(widget.render(10).every((line) => visibleWidth(line) <= 10));
  widget.handleInput("\r");
  assert.equal(state.expanded, false);
});
