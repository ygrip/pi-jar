import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { defaultVisualSettings, MAX_SUBAGENT_CHOICES, type JarVisualSettings } from "../src/settings.ts";
import { openJarSettings } from "../src/settings-ui.ts";

type Pane = {
  render(width: number): string[];
  handleInput(data: string): void;
  handleMouse(event: unknown): unknown;
};
/** Picker tests start from a pool of 4 and gates on so lowering/toggling paths are exercised regardless of defaults. */
const startState = (): JarVisualSettings => ({ ...defaultVisualSettings(), maxSubagents: 4, advisorGates: true });
test("max subagents picker requires deliberate selection and explains retained pool semantics", async () => {
  let state = startState();
  let saves = 0;
  let closed = false;
  const ctx = { hasUI: true, mode: "tui", ui: {
    custom: async (factory: Function) => {
      const pane: Pane = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, () => { closed = true; });
      pane.handleInput("\t"); pane.handleInput("\t");
      for (let i = 0; i < 3; i++) pane.handleInput("\x1b[B");
      const help = pane.render(80).join("\n");
      assert.match(help, /Max subagents \(retained live pool\).*4/);
      assert.match(help, /includes idle\/paused/);
      assert.match(help, /Lowering does not terminate/);
      pane.handleInput("\r");
      assert.equal(saves, 0);
      assert.match(pane.render(80).join("\n"), /MAX SUBAGENTS · RETAINED LIVE POOL/);
      pane.handleInput("\x1b[B");
      assert.equal(state.maxSubagents, 4);
      pane.handleInput("\x1b");
      assert.equal(saves, 0);
      assert.equal(closed, false);
      assert.match(pane.render(80).join("\n"), /PI & WORKFLOWS/);
      pane.handleInput("\r");
      pane.handleInput("\x1b[A"); // choose 2 (lowering)
      pane.handleInput("\r");
      assert.equal(state.maxSubagents, 2);
      assert.equal(saves, 1);
      for (const choice of MAX_SUBAGENT_CHOICES) {
        pane.handleMouse({ type: "click", button: "left", x: 5, y: 8 }); // max-subagents row
        for (const width of [8, 16, 40, 80]) {
          assert.ok(pane.render(width).every((line) => visibleWidth(line) <= width));
        }
        const index = MAX_SUBAGENT_CHOICES.indexOf(choice);
        pane.handleMouse({ type: "click", button: "left", x: 5, y: 5 + index });
        assert.equal(state.maxSubagents, choice);
      }
      // Subsequent toggles retain their original behavior after the added row.
      pane.handleInput("\x1b[B"); pane.handleInput(" ");
      assert.equal(state.advisor, false);
      pane.handleInput("\x1b[B"); pane.handleInput(" ");
      assert.equal(state.advisorGates, false);
      pane.handleInput("\x1b");
      assert.equal(closed, true);
    }
  } };
  await openJarSettings(ctx as never, () => state, (next) => { state = next; saves++; }, []);
});

test("max subagents choice scrolling keeps mouse targets aligned in short terminals", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  Object.defineProperty(process.stdout, "rows", { configurable: true, value: 13 });
  let state = startState();
  try {
    const ctx = { hasUI: true, mode: "tui", ui: {
      custom: async (factory: Function) => {
        const pane: Pane = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, () => {});
        pane.handleInput("\t"); pane.handleInput("\t");
        for (let i = 0; i < 3; i++) pane.handleInput("\x1b[B");
        pane.handleInput("\r");
        for (let i = 0; i < 3; i++) pane.handleInput("\x1b[B");
        const rendered = pane.render(80);
        assert.ok(rendered.length <= 13);
        assert.match(rendered[5]!, /4.*CURRENT/); // scrolled first option is 4, not 2
        assert.match(rendered[8]!, /❯ 16/);
        assert.equal(state.maxSubagents, 4); // navigation alone does not persist
        pane.handleMouse({ type: "click", button: "left", x: 5, y: 8 });
        assert.equal(state.maxSubagents, 16);
        assert.match(pane.render(80).join("\n"), /PI & WORKFLOWS/);
      }
    } };
    await openJarSettings(ctx as never, () => state, (next) => { state = next; }, []);
  } finally {
    if (descriptor) Object.defineProperty(process.stdout, "rows", descriptor);
    else Reflect.deleteProperty(process.stdout, "rows");
  }
});

test("goal rounds shares the explicit picker and cancels without persisting", async () => {
  let state = startState();
  let saves = 0;
  const ctx = { hasUI: true, mode: "tui", ui: {
    custom: async (factory: Function) => {
      const pane: Pane = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, () => {});
      pane.handleInput("\t"); pane.handleInput("\t");
      pane.handleInput("\x1b[B"); pane.handleInput("\x1b[B");
      pane.handleInput("\r");
      assert.match(pane.render(80).join("\n"), /GOAL AUTO ROUNDS/);
      pane.handleInput("\x1b[B"); pane.handleInput("\x1b");
      assert.equal(state.goalRounds, 8);
      assert.equal(saves, 0);
      pane.handleInput("\r"); pane.handleInput("\x1b[B"); pane.handleInput("\r");
      assert.equal(state.goalRounds, 12);
      assert.equal(saves, 1);
      assert.equal(state.maxSubagents, 4);
    }
  } };
  await openJarSettings(ctx as never, () => state, (next) => { state = next; saves++; }, []);
});
