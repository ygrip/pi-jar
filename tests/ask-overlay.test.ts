import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { askOne } from "../src/ask-tool.ts";
import { popup } from "../src/popup.ts";
import { popupTheme } from "./popup-fixture.ts";

function harness() {
  const screens: { component: any; options: any; focused: boolean; focusCalls: number }[] = [];
  const terminal = { rows: 10 };
  const ctx = { hasUI: true, mode: "tui", ui: { custom(factory: Function, options: any) {
    return new Promise((resolve) => {
      const screen = { component: factory({ requestRender() {}, terminal }, popupTheme, {}, resolve), options, focused: false, focusCalls: 0 };
      screens.push(screen);
      options.onHandle?.({ focus() { screen.focused = true; screen.focusCalls++; }, isFocused: () => screen.focused });
    });
  } } };
  return { screens, terminal, ctx };
}

test("questions anchor to bottom, take visual/focus precedence, and restore other jar overlays on completion", async () => {
  const h = harness();
  const other = popup(h.ctx as never, (_tui, _theme, _keys, done) => ({ invalidate() {}, render: () => ["Roles"], handleInput: () => done(undefined) }));
  assert.equal(h.screens[0]!.options.overlayOptions.visible(), true);
  const pending = askOne(h.ctx as never, { question: "Choose", options: [{ label: "Yes" }] });
  const ask = h.screens[1]!;
  assert.equal(ask.options.overlayOptions.anchor, "bottom-center");
  assert.equal(ask.options.overlayOptions.margin, 0);
  assert.equal(h.screens[0]!.options.overlayOptions.visible(), false);
  assert.equal(ask.focusCalls, 1);
  ask.focused = false;
  ask.component.render(40);
  assert.equal(ask.focusCalls, 2, "a competing overlay cannot leave the question behind it");
  ask.component.handleInput("1");
  assert.equal((await pending).answer, "Yes");
  assert.equal(h.screens[0]!.options.overlayOptions.visible(), true);
  h.screens[0]!.component.handleInput("\x1b");
  await other;
});

test("question option viewport pages, reveals keyboard selection, wraps selected details and resizes", async () => {
  const h = harness();
  const pending = askOne(h.ctx as never, { header: "Deployment", question: "Choose the target", options: Array.from({ length: 12 }, (_, i) => ({ label: `Target ${i + 1}`, description: `Detail ${i + 1} ` + "readable explanation ".repeat(6) })) });
  const ask = h.screens[0]!;
  const render = () => {
    const lines: string[] = ask.component.render(32);
    assert.ok(lines.length <= h.terminal.rows);
    assert.ok(lines.every((line) => visibleWidth(line) <= 32));
    return lines;
  };
  const before = render().join("\n");
  assert.match(before, /QUESTION.*Deployment/);
  assert.match(before, /Detail 1/);
  assert.doesNotMatch(before, /Detail 2/);
  ask.component.handleInput("\x1b[6~");
  assert.doesNotMatch(render().join("\n"), /Choose the target/);
  for (let i = 0; i < 11; i++) ask.component.handleInput("\x1b[B");
  assert.match(render().join("\n"), /Target 12/);
  h.terminal.rows = 5;
  render();
  ask.component.handleInput("\r");
  assert.equal((await pending).answer, "Target 12");
});

test("abort restores ordinary popup visibility", async () => {
  const h = harness();
  const other = popup(h.ctx as never, (_tui, _theme, _keys, done) => ({ invalidate() {}, render: () => [], handleInput: () => done(undefined) }));
  const controller = new AbortController();
  const pending = askOne(h.ctx as never, { question: "Wait?" }, 0, 1, controller.signal);
  assert.equal(h.screens[0]!.options.overlayOptions.visible(), false);
  controller.abort();
  assert.equal((await pending).cancelled, true);
  assert.equal(h.screens[0]!.options.overlayOptions.visible(), true);
  h.screens[0]!.component.handleInput("\x1b"); await other;
});
