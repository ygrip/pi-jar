import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAN_SUBMIT_TOOL, PlanMode, planDirectory, resolvePlanPath } from "../src/plan.ts";
import { TodoStore } from "../src/tasks.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRoleManager } from "../src/model-roles.ts";

const root = mkdtempSync(join(tmpdir(), "pi-jar-plan-"));
after(() => rmSync(root, { recursive: true, force: true }));

const GOOD_PLAN = [
  "# Add hello command", "", "## Context", "Users want /hello.", "", "## Approach",
  "1. Register the hello command", "2. Add a test", "", "## Critical files", "- `extensions/index.ts`", "",
  "## Verification", "- npm test", ""
].join("\n");

type Tool = { execute: (...args: any[]) => Promise<any> };

function harness(options: { reviewAction?: string; role?: string } = {}) {
  const events = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const tools = new Map<string, Tool>();
  const sent: { text: string; options?: { deliverAs?: string } }[] = [];
  const notices: string[] = [];
  const entries: unknown[] = [];
  let active = ["read", "bash", "write", "edit", "jar_ask", "remote_get", PLAN_SUBMIT_TOOL];
  let branch: unknown[] = [];
  let compactOptions: { onComplete: () => void; onError: (error: Error) => void } | undefined;
  let reviewAction = options.reviewAction ?? "compact";
  const cwd = mkdtempSync(join(root, "cwd-"));
  const pi = {
    on(name: string, handler: (...args: any[]) => any) { events.set(name, handler); },
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, command.handler); },
    registerTool(tool: Tool & { name: string }) { tools.set(tool.name, tool); },
    registerShortcut() {},
    getActiveTools: () => [...active],
    getAllTools: () => ["read", "bash", "write", "edit", "jar_ask", "remote_get", PLAN_SUBMIT_TOOL].map((name) => ({ name })),
    setActiveTools(names: string[]) { active = [...names]; },
    appendEntry(_type: string, data: unknown) { entries.push(data); },
    sendUserMessage(text: string, opts?: { deliverAs?: string }) { sent.push({ text, options: opts }); }
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true, mode: "tui", cwd,
    sessionManager: { getBranch: () => branch, getSessionId: () => "session-1" },
    ui: { theme: { fg: (_color: string, text: string) => text }, setStatus() {}, notify(message: string) { notices.push(message); },
      custom: async () => ({ action: reviewAction, ...(options.role ? { role: options.role } : {}) }) },
    compact(opts: typeof compactOptions) { compactOptions = opts; }
  } as unknown as ExtensionContext;
  const activated: string[] = [];
  const roles = {
    activateTemporary: async () => async () => {}, cycleOrder: () => ["default"], resolve: () => undefined,
    activate: async (role: string) => { activated.push(role); return true; }
  } as unknown as ModelRoleManager;
  const todos = new TodoStore(() => {});
  const plan = new PlanMode(pi, () => todos, roles, () => {}, root);
  plan.register();
  const dir = planDirectory("session-1", root);
  const writePlan = (name: string, text: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), text); return join(dir, name); };
  const submit = (path: string) => tools.get(PLAN_SUBMIT_TOOL)!.execute("id", { path }, undefined, undefined, ctx);
  return { events, commands, ctx, sent, notices, entries, todos, plan, dir, writePlan, submit, activated, cwd,
    active: () => active, setBranch: (next: unknown[]) => { branch = next; },
    compact: () => compactOptions, setReviewAction: (action: string) => { reviewAction = action; } };
}

test("plan blocks unknown tools, shell mutations and writes outside the plan directory", async () => {
  const h = harness();
  await h.commands.get("plan")!("", h.ctx);
  assert.deepEqual(h.active(), ["read", "bash", "jar_ask", "write", "edit", PLAN_SUBMIT_TOOL]);
  const guard = h.events.get("tool_call")!;
  const call = (toolName: string, input: unknown) => guard({ toolName, input }, h.ctx);
  assert.equal((await call("remote_get", {}))?.block, true);
  assert.equal((await call("bash", null))?.block, true);
  assert.equal((await call("bash", { command: "git fetch origin" }))?.block, true);
  assert.equal(await call("bash", { command: "git status" }), undefined);
  assert.equal((await call("write", { path: join(h.cwd, "src.ts") }))?.block, true);
  assert.equal((await call("write", { path: join(h.dir, "notes.txt") }))?.block, true, "only markdown");
  assert.equal((await call("write", { path: join(h.dir, "..", "escape-plan.md") }))?.block, true);
  assert.equal(await call("write", { path: join(h.dir, "hello-plan.md") }), undefined);
  assert.equal(await call("edit", { path: join(h.dir, "nested", "deep-plan.md") }), undefined);
  assert.match((await call("write", { path: "README.md" })).reason, /read-only.*-plan\.md/);
  await h.commands.get("plan")!("stop", h.ctx);
  assert.deepEqual(h.active(), ["read", "bash", "write", "edit", "jar_ask", "remote_get", PLAN_SUBMIT_TOOL]);
});

test("symlinks cannot escape the plan directory", () => {
  const dir = mkdtempSync(join(root, "links-"));
  const outside = mkdtempSync(join(root, "outside-"));
  symlinkSync(outside, join(dir, "out"));
  writeFileSync(join(outside, "target.md"), "x");
  symlinkSync(join(outside, "target.md"), join(dir, "file-plan.md"));
  assert.equal(resolvePlanPath(dir, join(dir, "out", "x-plan.md"), "/"), undefined);
  assert.equal(resolvePlanPath(dir, join(dir, "file-plan.md"), "/"), undefined);
  assert.ok(resolvePlanPath(dir, "a-plan.md", dir));
  assert.equal(resolvePlanPath(dir, 42, dir), undefined);
});

test("submit validates structure, then review approval seeds todos and sends the full plan", async () => {
  const h = harness({ reviewAction: "implement" });
  await h.commands.get("plan")!("", h.ctx);
  const bad = await h.submit(h.writePlan("bad-plan.md", "# Title\n\n## Context\nWhy\n"));
  assert.equal(bad.terminate, undefined);
  assert.match(bad.content[0].text, /## Approach[\s\S]*## Verification/);
  const outside = await h.submit(join(h.cwd, "x.md"));
  assert.match(outside.content[0].text, /inside/);
  const good = await h.submit(h.writePlan("hello-plan.md", GOOD_PLAN));
  assert.equal(good.terminate, true);
  assert.match(good.content[0].text, /Add hello command.*2 steps/);
  assert.deepEqual(h.plan.latestSteps(), ["Register the hello command", "Add a test"]);
  await h.events.get("agent_settled")!({}, h.ctx);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]?.options?.deliverAs, "followUp");
  assert.match(h.sent[0]!.text, /<plan path=".*hello-plan\.md">[\s\S]*## Verification[\s\S]*<\/plan>/);
  assert.deepEqual(h.todos.all().map((item) => item.title), ["Register the hello command", "Add a test"]);
  assert.equal(h.plan.isEnabled(), false);
  assert.ok(h.active().includes("remote_get"));
});

test("chosen continuation role activates after approval", async () => {
  const h = harness({ reviewAction: "implement", role: "slow" });
  await h.commands.get("plan")!("", h.ctx);
  await h.submit(h.writePlan("r-plan.md", GOOD_PLAN));
  await h.events.get("agent_settled")!({}, h.ctx);
  assert.deepEqual(h.activated, ["slow"]);
});

test("turns that end without a submission get at most two hidden reminders", async () => {
  const h = harness();
  await h.commands.get("plan")!("", h.ctx);
  const settle = h.events.get("agent_before_settle")!;
  const boundary = { outcome: "completed", continue: false, entries: [] };
  const first = settle(boundary, h.ctx);
  assert.equal(first?.continue, true);
  assert.equal(first?.entries[0].display, false);
  assert.equal(settle(boundary, h.ctx)?.continue, true);
  assert.equal(settle(boundary, h.ctx), undefined);
  assert.ok(h.notices.some((notice) => /has not submitted/.test(notice)));
  assert.equal(settle({ ...boundary, outcome: "aborted" }, h.ctx), undefined);
  h.events.get("input")!({ source: "interactive", text: "go" }, h.ctx);
  assert.equal(settle(boundary, h.ctx)?.continue, true, "a new user prompt resets the budget");
  assert.equal(settle({ ...boundary, continue: true }, h.ctx), undefined, "never stacks on another continuation");
});

test("branch restoration handles v1 and v2 entries; cancelled compaction never implements", async () => {
  const h = harness();
  h.setBranch([{ type: "custom", customType: "pi-jar.plan", data: { v: 1, enabled: true, steps: ["Inspect behavior"] } }]);
  await h.events.get("session_tree")!({}, h.ctx);
  assert.equal(h.plan.isEnabled(), true);
  assert.deepEqual(h.plan.latestSteps(), ["Inspect behavior"]);
  await h.submit(h.writePlan("c-plan.md", GOOD_PLAN));
  await h.events.get("agent_settled")!({}, h.ctx);
  assert.ok(h.compact());
  await h.commands.get("plan")!("stop", h.ctx);
  h.compact()!.onComplete();
  assert.deepEqual(h.sent, []);
  h.setBranch([{ type: "custom", customType: "pi-jar.plan", data: { v: 2, enabled: false, steps: ["A"], text: GOOD_PLAN, title: "Add hello command", path: "/x-plan.md" } }]);
  await h.events.get("session_tree")!({}, h.ctx);
  assert.deepEqual(h.plan.summary(), { enabled: false, title: "Add hello command", steps: 1 });
});

test("stopping from review restores the exact original tool set", async () => {
  const h = harness({ reviewAction: "stop" });
  await h.commands.get("plan")!("", h.ctx);
  await h.submit(h.writePlan("s-plan.md", GOOD_PLAN));
  await h.events.get("agent_settled")!({}, h.ctx);
  assert.deepEqual(h.active(), ["read", "bash", "write", "edit", "jar_ask", "remote_get", PLAN_SUBMIT_TOOL]);
  assert.deepEqual(h.sent, []);
});

test("plan command queues its prompt; compaction callback implements at most once", async () => {
  const h = harness();
  await h.commands.get("plan")!("Describe a plan", h.ctx);
  assert.deepEqual(h.sent, [{ text: "Describe a plan", options: { deliverAs: "followUp" } }]);
  await h.submit(h.writePlan("once-plan.md", GOOD_PLAN));
  await h.events.get("agent_settled")!({}, h.ctx);
  await h.events.get("agent_settled")!({}, h.ctx);
  h.compact()!.onComplete();
  await new Promise((resolve) => setImmediate(resolve));
  h.compact()!.onComplete();
  assert.equal(h.sent.length, 2);
});

test("hidden plan context names the plan directory and required template", async () => {
  const h = harness();
  await h.commands.get("plan")!("", h.ctx);
  const injected = await h.events.get("before_agent_start")!({}, h.ctx);
  assert.equal(injected.message.display, false);
  assert.ok(injected.message.content.includes(h.dir));
  assert.match(injected.message.content, /## Context[\s\S]*## Approach[\s\S]*## Verification/);
  assert.match(injected.message.content, /jar_plan_submit/);
});

test("plan mode refuses a planted symlink as its plan directory", async () => {
  const base = mkdtempSync(join(root, "planted-"));
  const elsewhere = mkdtempSync(join(root, "elsewhere-"));
  mkdirSync(join(base, "pi-jar", "plans"), { recursive: true });
  symlinkSync(elsewhere, join(base, "pi-jar", "plans", "session-1"));
  const notices: string[] = [];
  const pi = { on() {}, registerCommand(_n: string, c: any) { (pi as any).plan = c.handler; }, registerTool() {}, registerShortcut() {},
    getActiveTools: () => ["read"], getAllTools: () => [{ name: "read" }], setActiveTools() {}, appendEntry() {} } as any;
  const ctx = { hasUI: false, mode: "print", cwd: base, sessionManager: { getBranch: () => [], getSessionId: () => "session-1" },
    ui: { theme: { fg: (_c: string, t: string) => t }, setStatus() {}, notify(message: string) { notices.push(message); } } } as unknown as ExtensionContext;
  const plan = new PlanMode(pi, () => undefined, { activateTemporary: async () => async () => {} } as unknown as ModelRoleManager, () => {}, base);
  plan.register();
  await pi.plan("", ctx);
  assert.equal(plan.isEnabled(), false);
  assert.ok(notices.some((notice) => /not a private directory/.test(notice)));
});
