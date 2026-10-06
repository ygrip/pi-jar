import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { openRolesUi } from "../src/roles-ui.ts";

for (const width of [40, 100]) test(`role actions remain visible at width ${width} and a click runs the action`, async () => {
  const rows = [{ role: "default", label: "Default", custom: false, usedBy: "session start", fallbacks: [] }, { role: "plan", label: "Plan", custom: false, fallbacks: ["p/backup"] }];
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
  const lines = component.render(width).map(stripTerminalSequences);
  assert.ok(lines.length <= (process.stdout.rows ?? 24), "the actions fit within the terminal height");
  const first = lines.findIndex((line: string) => line.includes("⏎  Activate this role now"));
  assert.ok(first >= 0);
  const labels = ["m  Assign a model", "f  Set fallback model", "a  Alias another role", "t  Set thinking effort", "s  Move between global and project", "c  Clear the assignment", "n  New custom role", "d  Delete this custom role"];
  labels.forEach((label, index) => assert.ok(lines[first + 1 + index]!.includes(label), label));
  component.handleMouse({ type: "click", button: "left", x: lines[first]!.indexOf("Activate"), y: first });
  await new Promise((resolve) => setTimeout(resolve, 0));
  component.handleInput("\x1b");
  await open;
  assert.deepEqual(activated, ["default"]);
  assert.ok(screens >= 2);
});

test("the roles screen warns for economy roles that run on the main model", async () => {
  const rows = [{ role: "scout", label: "Scout", custom: false, usedBy: "cheap delegated discovery", fallbacks: [] }];
  const model = (id: string, price: number) => ({ provider: "p", id, cost: { input: price, output: price, cacheRead: 0, cacheWrite: 0 } });
  const render = async (candidates: Record<string, string>) => {
    const roles = { list: () => rows, activeRole: () => undefined,
      resolveCandidates: (role: string) => candidates[role] ? [{ provider: "p", model: candidates[role] }] : [] };
    let component: any;
    const ctx = { hasUI: true, mode: "tui", model: model("big", 10), modelRegistry: { getAvailable: () => [model("big", 10), model("mini", 1)] },
      ui: { notify() {}, custom(factory: Function) {
        return new Promise((resolve) => { component = factory({ requestRender() {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, resolve); });
      } } };
    const open = openRolesUi(ctx as never, roles as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = component.render(200).map(stripTerminalSequences).join("\n");
    component.handleInput("\x1b");
    await open;
    return text;
  };
  const unassigned = await render({});
  assert.match(unassigned, /⚠ scout subagents run on the main model p\/big; use a mini\/haiku-class model/);
  assert.match(unassigned, /⚠ reviewer subagents run on the main model/, "an unassigned reviewer also falls back to the main model");
  const cheapScout = await render({ scout: "mini" });
  assert.doesNotMatch(cheapScout, /scout subagents run on the main model/);
  assert.match(cheapScout, /reviewer subagents run on the main model/);
});
