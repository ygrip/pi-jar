import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSuggestions, SUGGEST_TOOL, SuggestionState } from "../src/suggest.ts";

function harness(options: { enabled?: boolean } = {}) {
  const events = new Map<string, (...args: any[]) => any>();
  let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
  let active = ["read"];
  let enabled = options.enabled ?? true;
  const pi = {
    on(name: string, handler: (...args: any[]) => any) { events.set(name, handler); },
    registerTool(definition: { name: string; execute: any }) { if (definition.name === SUGGEST_TOOL) tool = definition; },
    getActiveTools: () => [...active],
    getAllTools: () => [{ name: "read" }, { name: SUGGEST_TOOL }],
    setActiveTools(names: string[]) { active = [...names]; }
  } as unknown as ExtensionAPI;
  const state = new SuggestionState();
  const control = registerSuggestions(pi, state, { enabled: () => enabled });
  const settle = (extra: object = {}) => events.get("agent_before_settle")!({ outcome: "completed", continue: false, entries: [], ...extra });
  return { events, state, control, settle, active: () => active, suggest: (text: string) => tool!.execute("id", { suggestion: text }),
    setEnabled: (value: boolean) => { enabled = value; } };
}

test("jar_suggest stores one sanitized line and ends the turn", async () => {
  const h = harness();
  h.control.sync();
  assert.ok(h.active().includes(SUGGEST_TOOL));
  const result = await h.suggest("  Run the\nfull   test suite \x1b[31m ");
  assert.equal(result.terminate, true);
  assert.equal(h.state.text, "Run the full test suite");
  assert.equal(h.settle(), undefined, "no reminder once suggested");
  assert.equal((await h.suggest("   ")).content[0].text, "Suggestion was empty; skipped.");
  assert.equal(h.state.text, "Run the full test suite");
});

test("a finished turn never forces another provider turn just for a suggestion", () => {
  const h = harness();
  h.control.sync();
  assert.equal(h.settle(), undefined);
  h.events.get("input")!({ source: "interactive", text: "next" });
  assert.equal(h.settle({ outcome: "aborted" }), undefined);
  assert.equal(h.settle({ continue: true }), undefined);
});

test("suggestions clear on new input, new runs and branch changes; disabling removes the tool", async () => {
  const h = harness();
  h.control.sync();
  let changes = 0;
  h.state.onChange(() => changes++);
  await h.suggest("Commit the change");
  h.events.get("input")!({ source: "interactive", text: "x" });
  assert.equal(h.state.text, undefined);
  await h.suggest("Commit the change");
  h.events.get("agent_start")!({});
  assert.equal(h.state.text, undefined);
  await h.suggest("Commit the change");
  h.events.get("session_tree")!({});
  assert.equal(h.state.text, undefined);
  assert.equal(changes, 6);
  h.setEnabled(false);
  h.control.sync();
  assert.equal(h.active().includes(SUGGEST_TOOL), false);
  assert.equal(h.settle(), undefined);
  assert.equal(h.events.has("context"), false, "best-effort suggestions add no context-filter pass");
});
