import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { openRolesUi } from "../src/roles-ui.ts";

test("role actions are listed one per row and a click runs the action", async () => {
  const rows = [{ role: "default", label: "Default", custom: false, usedBy: "session start" }, { role: "plan", label: "Plan", custom: false }];
  const activated: string[] = [];
  const roles = { list: () => rows, activeRole: () => undefined, activate: async (role: string) => { activated.push(role); return true; } };
  let component: any;
  let screens = 0;
  const ctx = { hasUI: true, mode: "tui", ui: { notify() {}, custom(factory: Function) {
    screens++;
    return new Promise((resolve) => { component = factory({ requestRender() {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, resolve); });
  } } };
  const open = openRolesUi(ctx as never, roles as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const lines = component.render(100).map(stripTerminalSequences);
  const first = lines.findIndex((line: string) => line.includes("⏎  Activate this role now"));
  const labels = ["m  Assign a model", "a  Alias another role", "t  Set thinking effort", "s  Move between global and project", "c  Clear the assignment", "n  New custom role", "d  Delete this custom role"];
  labels.forEach((label, index) => assert.ok(lines[first + 1 + index]!.includes(label), label));
  component.handleMouse({ type: "click", button: "left", x: lines[first]!.indexOf("Activate"), y: first });
  await new Promise((resolve) => setTimeout(resolve, 0));
  component.handleInput("\x1b");
  await open;
  assert.deepEqual(activated, ["default"]);
  assert.ok(screens >= 2);
});
