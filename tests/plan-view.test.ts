import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { openPlanView, type PlanViewResult } from "../src/plan-view.ts";

initTheme();
const PLAN = "# Ship it\nIntro\n## Context\nWhy we ship.\n## Approach\n1. Build\n2. Test\n### Detail\nMore\n## Verification\n- npm test\n";

function mount(width: number) {
  let component: (Component & { handleMouse?: (event: TuiMouseEvent) => unknown }) | undefined;
  let result: PlanViewResult | undefined;
  const ctx = {
    hasUI: true, mode: "tui",
    ui: { custom: (factory: any) => new Promise((resolve) => {
      component = factory({ requestRender() {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, (value: PlanViewResult) => { result = value; resolve(value); });
    }) }
  } as unknown as ExtensionContext;
  const pending = openPlanView(ctx, { title: "Ship it", text: PLAN, path: "/tmp/ship-plan.md", roles: ["smol", "slow"] });
  return { pending, render: () => component!.render(width).map(stripTerminalSequences), input: (data: string) => component!.handleInput!(data),
    mouse: (event: Partial<TuiMouseEvent>) => component!.handleMouse!({ button: "left", type: "click", x: 0, y: 0, screenX: 0, screenY: 0, width, height: 30, shift: false, alt: false, ctrl: false, ...event } as TuiMouseEvent),
    result: () => result };
}

test("plan view shows headings on the left and the selected section on the right at every width", () => {
  for (const width of [40, 64, 100, 160]) {
    const view = mount(width);
    const lines = view.render();
    assert.ok(lines.every((line) => visibleWidth(line) === Math.max(24, width)), `${width}: exact width`);
    const text = lines.join("\n");
    assert.match(text, /PLAN · Ship it/);
    assert.match(text, /Approve & execute/);
    if (width >= 64) {
      assert.match(text, /▌Overview/);
      assert.match(text, /Verification/);
    } else assert.match(text, /‹ 1\/5 Overview ›/);
  }
});

test("keyboard navigation selects sections, cycles the role chip and chooses actions", async () => {
  const view = mount(100);
  view.render();
  view.input("\x1b[B"); view.input("\x1b[B");
  let text = view.render().join("\n");
  assert.match(text, /▌Approach/);
  assert.match(text, /1\. Build/);
  view.input("r");
  assert.match(view.render().join("\n"), /continue with: smol/);
  view.input("1");
  assert.deepEqual(await view.pending, { action: "implement", role: "smol" });
});

test("mouse clicks pick headings and actions; drags stay with Pi for text selection", async () => {
  const view = mount(100);
  const lines = view.render();
  const row = lines.findIndex((line) => line.includes("Verification") && line.startsWith("│"));
  view.mouse({ x: 4, y: row });
  assert.match(view.render().join("\n"), /npm test/);
  assert.equal(view.mouse({ type: "drag", x: 40, y: 3 }), undefined, "drag is not captured");
  assert.equal(view.mouse({ type: "press", x: 40, y: 3 }), undefined, "press is not captured");
  // Actions are a vertical, numbered list: one row each.
  const rendered = view.render();
  const approve = rendered.findIndex((line) => /1\s+▶ Approve & execute/.test(line));
  const stop = rendered.findIndex((line) => /4\s+■ Stop/.test(line));
  assert.ok(approve > 0 && stop === approve + 3, "four actions on consecutive rows");
  assert.match(rendered[stop + 1]!, /continue with: current/);
  view.mouse({ x: 6, y: stop });
  assert.deepEqual(await view.pending, { action: "stop" });
});
