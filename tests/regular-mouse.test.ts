import assert from "node:assert/strict";
import test from "node:test";
import { acquireRegularMouse } from "../src/regular-mouse.ts";

test("regular mouse owners share one terminal mode and release it exactly once", () => {
  const writes: string[] = [];
  const tui = { mode: "regular", terminal: { write(value: string) { writes.push(value); } } } as never;
  const releaseComposer = acquireRegularMouse(tui);
  const releaseWelcome = acquireRegularMouse(tui);
  assert.equal(writes.length, 1);
  releaseWelcome();
  assert.equal(writes.length, 1);
  releaseComposer();
  releaseComposer();
  assert.equal(writes.length, 2);
  assert.match(writes[1]!, /\?1000l/);
  assert.match(writes[1]!, /\?1006l/);
});

test("release after switching to fullscreen does not disable Pi's mouse reporting", () => {
  const writes: string[] = [];
  const tui = { mode: "regular", terminal: { write(value: string) { writes.push(value); } } };
  const release = acquireRegularMouse(tui as never);
  tui.mode = "fullscreen";
  release();
  assert.equal(writes.length, 1);
});
