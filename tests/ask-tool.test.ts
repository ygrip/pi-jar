import assert from "node:assert/strict";
import test from "node:test";
import { registerAskTool } from "../src/ask-tool.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const theme = { fg: (_: string, text: string) => text };
function harness(inputs: string[], editorAnswer = "") {
  let tool: any;
  const pi = { registerTool(spec: unknown) { tool = spec; } } as ExtensionAPI;
  registerAskTool(pi);
  const ctx = {
    hasUI: true, mode: "tui", ui: {
      custom: async (factory: Function) => {
        let result: unknown;
        const component = factory({ requestRender() {} }, theme, {}, (value: unknown) => { result = value; });
        assert.ok(component.render(90).some((line: string) => line.includes("QUESTION")));
        for (const key of inputs) component.handleInput(key);
        return result;
      },
      editor: async () => editorAnswer
    }
  } as unknown as ExtensionContext;
  return { tool, ctx };
}

test("jar_ask returns structured single choice and numbered descriptive options", async () => {
  const { tool, ctx } = harness(["2"]);
  const result = await tool.execute("id", { questions: [{ id: "choice", question: "Which?", options: [
    { label: "Alpha", description: "First" }, { label: "Beta", description: "Second" }
  ] }] }, undefined, undefined, ctx);
  assert.deepEqual(result.details.answers, [{ id: "choice", answer: "Beta" }]);
});

test("jar_ask clickable option descriptions and actions produce the intended answer", async () => {
  let tool: any;
  registerAskTool({ registerTool(spec: unknown) { tool = spec; } } as never);
  const ctx = { hasUI: true, mode: "tui", ui: { custom(factory: Function) {
    const component = factory({ requestRender() {} }, theme, {}, (value: unknown) => { result = value; });
    const lines: string[] = component.render(90);
    const row = lines.findIndex((line) => line.includes("Explained choice"));
    assert.ok(row > 0);
    component.handleMouse({ type: "click", button: "left", x: 10, y: row });
    return result;
  } } } as unknown as ExtensionContext;
  let result: unknown;
  const answer = await tool.execute("id", { questions: [{ question: "Select one", options: [
    { label: "Alpha", description: "Explained choice" }, { label: "Beta" }
  ] }] }, undefined, undefined, ctx);
  assert.deepEqual(answer.details.answers, [{ id: "q1", answer: "Alpha" }]);
});

test("long jar_ask questions scroll inside the terminal viewport", async () => {
  let tool: any;
  registerAskTool({ registerTool(spec: unknown) { tool = spec; } } as never);
  let result: unknown;
  const ctx = { hasUI: true, mode: "tui", ui: { custom(factory: Function) {
    const component = factory({ requestRender() {} }, theme, {}, (value: unknown) => { result = value; });
    const before: string[] = component.render(44);
    assert.ok(before.length <= Math.max(3, Math.min(16, (process.stdout.rows ?? 24) - 5)) + 3);
    assert.doesNotMatch(before.join(" "), /Option twelve/);
    for (let i = 0; i < 16; i++) component.handleMouse({ type: "wheel", wheelDelta: 1 });
    const after: string[] = component.render(44);
    const row = after.findIndex((line) => line.includes("Option twelve"));
    assert.ok(row > 0, "wheel reveals the last option");
    component.handleMouse({ type: "click", button: "left", x: 10, y: row });
    return result;
  } } } as unknown as ExtensionContext;
  const answer = await tool.execute("id", { questions: [{ question: "Long question ".repeat(35), options:
    Array.from({ length: 12 }, (_, i) => ({ label: i === 11 ? "Option twelve" : `Option ${i + 1}`, description: "Details" }))
  }] }, undefined, undefined, ctx);
  assert.deepEqual(answer.details.answers, [{ id: "q1", answer: "Option twelve" }]);
});

test("jar_ask treats a dismissed custom UI as cancellation", async () => {
  const { tool, ctx } = harness([]);
  const result = await tool.execute("id", { questions: [{ question: "Choose", options: [{ label: "Yes" }] }] }, undefined, undefined, ctx);
  assert.deepEqual(result.details.answers, [{ id: "q1", cancelled: true }]);
});

test("jar_ask multi-select returns checked values; chat does not masquerade as an answer", async () => {
  const multi = harness(["1", "2", "\x1b[B", "\x1b[B", "\x1b[B", "\r"]);
  // Number keys toggle checkboxes; the last action is Continue with selection.
  const result = await multi.tool.execute("id", { questions: [{ question: "Select", multi: true,
    options: [{ label: "Alpha" }, { label: "Beta" }] }] }, undefined, undefined, multi.ctx);
  assert.deepEqual(result.details.answers[0].selected, ["Alpha", "Beta"]);
  const chat = harness(["\x1b[B", "\r"], "I need context");
  const discussed = await chat.tool.execute("id", { questions: [{ question: "Why?", allowCustom: false,
    options: [{ label: "Yes" }] }, { question: "Unasked" }] }, undefined, undefined, chat.ctx);
  assert.deepEqual(discussed.details.answers, [{ id: "q1", chat: "I need context" }]);
});

test("multi-select shows checkboxes, a selected count and select-all", async () => {
  let component: any;
  const ctx = { hasUI: true, mode: "tui", ui: { notify() {}, custom(factory: Function) {
    return new Promise((resolve) => { component = factory({ requestRender() {} }, { fg: (_c: string, t: string) => t }, {}, resolve); });
  } } };
  let tool: any;
  registerAskTool({ registerTool(definition: unknown) { tool = definition; } } as never);
  const pending = tool.execute("id", { questions: [{ question: "Pick", multi: true, options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }] }] }, undefined, undefined, ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const screen = () => component.render(80).join("\n");
  assert.match(screen(), /MULTI SELECT/);
  assert.match(screen(), /☐ {2}1\. Alpha/);
  assert.match(screen(), /Continue with none selected/);
  component.handleInput("a");
  assert.match(screen(), /☑ {2}1\. Alpha[\s\S]*☑ {2}2\. Beta[\s\S]*☑ {2}3\. Gamma/);
  assert.match(screen(), /Continue with 3 selected/);
  assert.match(screen(), /3\/3 checked/);
  component.handleInput("2"); // uncheck Beta
  assert.match(screen(), /Continue with 2 selected/);
  for (let step = 0; step < 4; step++) component.handleInput("\x1b[B");
  component.handleInput("\r");
  const result = await pending;
  assert.match(result.content[0].text, /Alpha, Gamma/);
});
