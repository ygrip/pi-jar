import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { taskWidget, type TaskWidgetState } from "../src/task-widget.ts";
import { TodoStore } from "../src/tasks.ts";
import { popupTheme } from "./popup-fixture.ts";

test("tasks share the mascot perch, with correct mouse targets and narrow fallback", () => {
  const store = new TodoStore(() => {});
  store.write([{ title: "Fix layout", status: "in_progress" }]);
  const state: TaskWidgetState = { expanded: false, scroll: undefined };
  let pokes = 0;
  const widget = taskWidget({ requestRender() {}, terminal: { rows: 24 } } as never,
    popupTheme as never, () => store.all(), state, {
      render: (width) => width >= 40 ? Array(6).fill("   \x1b[31mEmber sprite\x1b[0m") : undefined,
      poke: () => { pokes++; }
    });
  const wide = widget.render(80);
  assert.equal(wide.length, 6, "tasks must not add rows above the mascot");
  assert.match(wide[0]!, /Ember sprite.*▸ Tasks/);
  assert.ok(wide.every((line) => visibleWidth(line) <= 80));
  widget.handleMouse({ type: "click", button: "left", x: 3, y: 0 } as never);
  assert.equal(pokes, 1);
  assert.equal(state.expanded, false, "mascot clicks must not expand tasks");
  widget.handleMouse({ type: "click", button: "left", x: 17, y: 0 } as never);
  assert.equal(state.expanded, true);
  assert.match(widget.render(80)[1]!, /Fix layout/);
  widget.render(40);
  widget.handleMouse({ type: "click", button: "left", x: 0, y: 6 } as never);
  assert.equal(state.expanded, false, "stacked heading uses the mascot row offset");
  assert.equal(widget.render(20).length, 2, "no mascot on very narrow terminals");
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
