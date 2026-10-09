import assert from "node:assert/strict";
import test from "node:test";
import { openRolesUi } from "../src/roles-ui.ts";
import { popupTheme } from "./popup-fixture.ts";

test("role filtering finds an offscreen role and activates the original role, not the filtered index", async () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({ role: `role-${index}`, label: `Role ${index}`, custom: true, fallbacks: [] }));
  const activated: string[] = [];
  let screens = 0;
  const roles = { list: () => rows, activeRole: () => undefined, activate: async (name: string) => { activated.push(name); return true; } };
  const ctx = { hasUI: true, mode: "tui", ui: { notify() {}, custom(factory: Function) {
    let result: unknown;
    const component = factory({ requestRender() {}, terminal: { rows: 24 } }, popupTheme, {}, (value: unknown) => { result = value; });
    component.render(80);
    if (screens++ === 0) {
      component.handleInput("/"); component.handleInput("role-59"); component.handleInput("\r");
      assert.match(component.render(80).join("\n"), /role-59/);
      component.handleInput("\r");
    } else component.handleInput("\x1b");
    return Promise.resolve(result);
  } } };
  await openRolesUi(ctx as never, roles as never);
  assert.deepEqual(activated, ["role-59"]);
});
