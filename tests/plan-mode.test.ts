import assert from "node:assert/strict";
import test from "node:test";
import { PlanMode } from "../src/plan.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRoleManager } from "../src/model-roles.ts";

function harness() {
  const events = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const sent: string[] = [];
  let active = ["read", "bash", "write", "jar_ask", "remote_get"];
  let branch: unknown[] = [];
  let compactOptions: { onComplete: () => void; onError: (error: Error) => void } | undefined;
  let reviewAction: string = "compact";
  const pi = {
    on(name: string, handler: (...args: any[]) => any) { events.set(name, handler); },
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, command.handler); },
    getActiveTools: () => [...active],
    getAllTools: () => ["read", "bash", "write", "jar_ask", "remote_get"].map((name) => ({ name })),
    setActiveTools(names: string[]) { active = [...names]; },
    appendEntry() {},
    sendUserMessage(text: string) { sent.push(text); }
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true, mode: "tui", sessionManager: { getBranch: () => branch },
    ui: { theme: { fg: (_color: string, text: string) => text }, setStatus() {}, notify() {},
      custom: async () => reviewAction },
    compact(options: typeof compactOptions) { compactOptions = options; }
  } as unknown as ExtensionContext;
  const roles = { activateTemporary: async () => async () => {} } as unknown as ModelRoleManager;
  new PlanMode(pi, () => undefined, roles, () => {}).register();
  return { events, commands, ctx, sent, active: () => active, setBranch: (entries: unknown[]) => { branch = entries; },
    compact: () => compactOptions, setReviewAction: (action: string) => { reviewAction = action; } };
}

test("plan blocks unknown tools and shell mutations even if another extension invokes them", async () => {
  const h = harness();
  await h.commands.get("plan")!("", h.ctx);
  assert.deepEqual(h.active(), ["read", "bash", "jar_ask"]);
  const guard = h.events.get("tool_call")!;
  assert.equal((await guard({ toolName: "remote_get", input: {} }))?.block, true);
  assert.equal((await guard({ toolName: "write", input: {} }))?.block, true);
  assert.equal((await guard({ toolName: "bash", input: null }))?.block, true);
  assert.equal((await guard({ toolName: "bash", input: { command: "git fetch origin" } }))?.block, true);
  assert.equal(await guard({ toolName: "bash", input: { command: "git status" } }), undefined);
  await h.commands.get("plan")!("stop", h.ctx);
  assert.deepEqual(h.active(), ["read", "bash", "write", "jar_ask", "remote_get"]);
});

test("branch restoration preserves original tool set; cancelled compaction never implements", async () => {
  const h = harness();
  await h.commands.get("plan")!("", h.ctx);
  h.setBranch([{ type: "custom", customType: "pi-jar.plan", data: { v: 1, enabled: true, steps: ["Inspect behavior"] } }]);
  await h.events.get("session_tree")!({}, h.ctx);
  assert.deepEqual(h.active(), ["read", "bash", "jar_ask"]);
  await h.events.get("message_end")!({ message: { role: "assistant", content: "Plan:\n1. Inspect behavior" } }, h.ctx);
  await h.events.get("agent_end")!({}, h.ctx);
  assert.ok(h.compact());
  await h.commands.get("plan")!("stop", h.ctx);
  h.compact()!.onComplete();
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.active(), ["read", "bash", "write", "jar_ask", "remote_get"]);
});

test("stopping from review restores the exact original tool set", async () => {
  const h = harness();
  h.setReviewAction("stop");
  await h.commands.get("plan")!("", h.ctx);
  await h.events.get("message_end")!({ message: { role: "assistant", content: "Plan:\n1. Inspect behavior" } }, h.ctx);
  await h.events.get("agent_end")!({}, h.ctx);
  assert.deepEqual(h.active(), ["read", "bash", "write", "jar_ask", "remote_get"]);
  assert.deepEqual(h.sent, []);
});

test("compaction callback implements at most once", async () => {
  const h = harness();
  await h.commands.get("plan")!("", h.ctx);
  await h.events.get("message_end")!({ message: { role: "assistant", content: "Plan:\n1. Inspect behavior" } }, h.ctx);
  await h.events.get("agent_end")!({}, h.ctx);
  await h.events.get("agent_end")!({}, h.ctx);
  h.compact()!.onComplete();
  await new Promise((resolve) => setImmediate(resolve));
  h.compact()!.onComplete();
  assert.equal(h.sent.length, 1);
});
