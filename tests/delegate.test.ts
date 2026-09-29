import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import { CHILD_ENV, DelegateRegistry, delegateArgs, piInvocation, READ_ONLY_TOOLS, registerDelegate } from "../src/delegate.ts";

interface FakeChild extends EventEmitter { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; killed: string[]; kill(signal: string): void }
function fakeSpawn(script: (child: FakeChild, args: string[]) => void) {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawn = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null; child.killed = [];
    child.kill = (signal: string) => { child.killed.push(signal); child.exitCode = 143; queueMicrotask(() => child.emit("close", 143)); };
    calls.push({ command, args, env: options.env ?? {} });
    queueMicrotask(() => script(child, args));
    return child as never;
  };
  return { spawn, calls };
}
const emit = (child: FakeChild, event: object) => child.stdout.emit("data", JSON.stringify(event) + "\n");
const roles = (map: Record<string, { provider: string; model: string; thinking?: string }>) => ({ resolve: (role: string) => map[role] }) as never;
type Result = { content: Array<{ text: string }>; details: { runs: Array<Record<string, unknown>> } };
interface Tool { execute(id: string, params: object, signal: AbortSignal | undefined, onUpdate: ((update: Result) => void) | undefined, ctx: object): Promise<Result> }
const register = (registry: DelegateRegistry, spawn: unknown): Tool => {
  let tool: Tool | undefined;
  registerDelegate({ registerTool(definition: Tool) { tool = definition; } } as never, roles({}), registry, spawn as never);
  return tool!;
};
const quiet = { cwd: "/repo", hasUI: false };

test("subagent args are one-shot JSON, read-only by default, and never recurse", () => {
  const args = delegateArgs("Find the auth code", "anthropic/claude-haiku", "low", false);
  assert.deepEqual(args.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);
  assert.deepEqual(args.slice(4, 10), ["--model", "anthropic/claude-haiku", "--thinking", "low", "--tools", READ_ONLY_TOOLS.join(",")]);
  assert.match(args.at(-1)!, /read-only[\s\S]*Task: Find the auth code/);
  assert.ok(!delegateArgs("x", undefined, undefined, true).includes("--tools"), "write mode keeps the default tools");
  assert.deepEqual(piInvocation(["-p"], ["node", "/definitely/missing.js"], "/usr/bin/node"), { command: "pi", args: ["-p"] });
  assert.deepEqual(piInvocation(["-p"], ["pi"], "/opt/pi/bin/pi"), { command: "/opt/pi/bin/pi", args: ["-p"] });
  process.env[CHILD_ENV] = "1";
  try {
    let registered = false;
    registerDelegate({ registerTool() { registered = true; } } as never, roles({}), new DelegateRegistry());
    assert.equal(registered, false, "children do not get jar_delegate");
  } finally { delete process.env[CHILD_ENV]; }
});

test("jar_delegate runs tasks in parallel on roles, streams progress and publishes teammates", async () => {
  const { spawn, calls } = fakeSpawn((child, args) => {
    const task = args.at(-1)!;
    emit(child, { type: "tool_execution_start", toolName: "grep" });
    emit(child, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: task.includes("fail") ? "partial" : "Report: " + task.split("Task: ")[1] }], usage: { cost: { total: 0.01 } } } });
    child.emit("close", task.includes("fail") ? 1 : 0);
  });
  let tool: any;
  registerDelegate({ registerTool(definition: unknown) { tool = definition; } } as never,
    roles({ task: { provider: "p", model: "small", thinking: "low" }, default: { provider: "p", model: "big" } }), new DelegateRegistry(), spawn as never);
  const statuses = new Map<string, string | undefined>();
  const updates: string[] = [];
  const ctx = { cwd: "/repo", hasUI: true, model: { provider: "p", id: "current" }, ui: { setStatus(key: string, value?: string) { statuses.set(key, value); } } };
  const result = await tool.execute("d", { tasks: [{ task: "scan api", name: "api" }, { task: "please fail", role: "review" }] }, undefined,
    (update: { content: { text: string }[] }) => updates.push(update.content[0]!.text), ctx);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.env[CHILD_ENV] === "1"));
  assert.ok(calls[0]!.args.includes("p/small") && calls[0]!.args.includes("low"), "task role resolves");
  assert.ok(calls[1]!.args.includes("p/big"), "unknown role falls back to default");
  const text = result.content[0].text;
  assert.match(text, /\[1\] api \(task · p\/small\) — done\nReport: scan api/);
  assert.match(text, /\[2\] agent 2 \(review · p\/big\) — failed: exited 1\npartial/);
  assert.ok(updates.some((update) => /api: working/.test(update)));
  assert.ok([...statuses.keys()].every((key) => key.startsWith("pi-jar.role.delegate-")));
  assert.ok([...statuses.values()].every((value) => value === undefined), "teammates are cleared when finished");
  const rendered = tool.renderResult(result, { expanded: false }, { fg: (_c: string, t: string) => t }).render(100).join("\n");
  assert.match(rendered, /✔ api · task · 1 tools · \$0\.010/);
  assert.match(rendered, /✖ agent 2/);
});

test("aborting stops running subagents", async () => {
  let running: FakeChild | undefined;
  const { spawn } = fakeSpawn((child) => { running = child; });
  let tool: any;
  registerDelegate({ registerTool(definition: unknown) { tool = definition; } } as never, roles({}), new DelegateRegistry(), spawn as never);
  const controller = new AbortController();
  const pending = tool.execute("d", { tasks: [{ task: "long" }] }, controller.signal, undefined, { cwd: "/repo", hasUI: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  const result = await pending;
  assert.deepEqual(running?.killed[0], "SIGTERM");
  assert.match(result.content[0].text, /failed: aborted/);
});

test("the registry shows each run live with a bounded transcript that never reaches tool details", async () => {
  const gate = new EventEmitter();
  const { spawn } = fakeSpawn(async (child) => {
    emit(child, { type: "tool_execution_start", toolName: "bash", args: { command: "npm test", path: "ignored" } });
    emit(child, { type: "tool_execution_start", toolName: "read", args: { path: "src/a.ts" } });
    emit(child, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Found it.\n\n\x1b[31mred\x1b[0m " + "y".repeat(400) }] } });
    await once(gate, "open");
    for (let index = 0; index < 250; index++) emit(child, { type: "tool_execution_start", toolName: "grep", args: { pattern: `p${index}` } });
    child.emit("close", 0);
  });
  const registry = new DelegateRegistry();
  let notified = 0;
  const unsubscribe = registry.subscribe(() => notified++);
  const updates: Result[] = [];
  const pending = register(registry, spawn).execute("d", { tasks: [{ task: "look", name: "scout" }] }, undefined, (update) => updates.push(update), quiet);
  await tick();
  const records = registry.records();
  assert.deepEqual(records.map((record) => record.key), ["delegate-1-1"]);
  const { run } = records[0]!;
  assert.equal(run.state, "working");
  assert.equal(registry.running(), 1);
  assert.equal(typeof run.startedAt, "number");
  assert.equal(run.endedAt, undefined);
  assert.deepEqual(run.log.slice(0, 3), ["▸ bash npm test", "▸ read src/a.ts", "Found it."], "the command wins over other args; blank lines are skipped");
  assert.equal(run.log[3], "red " + "y".repeat(236), "escapes are stripped and lines clipped to 240 chars");
  assert.ok(notified >= 4, "listeners hear about the add and every event");
  gate.emit("open");
  const result = await pending;
  assert.equal(run.state, "done");
  assert.ok(run.endedAt! >= run.startedAt!);
  assert.equal(run.log.length, 200);
  assert.equal(run.log.at(-1), "▸ grep p249");
  assert.ok(updates.length > 0);
  assert.ok([result.details, ...updates.map((update) => update.details)].every((details) => details.runs.every((run) => !("log" in run))));
  unsubscribe();
  const before = notified;
  registry.clear();
  assert.equal(notified, before, "unsubscribed listeners are not called");
  assert.deepEqual(registry.records(), []);
});

test("stopping one subagent from the registry leaves the rest of its batch running", async () => {
  const children: FakeChild[] = [];
  const { spawn } = fakeSpawn((child) => { children.push(child); });
  const registry = new DelegateRegistry();
  const pending = register(registry, spawn).execute("d", { tasks: [{ task: "one", name: "first" }, { task: "two", name: "second" }] }, undefined, undefined, quiet);
  await tick();
  const [first, second] = registry.records();
  assert.equal(registry.running(), 2);
  assert.equal(registry.stop(first!.key), true);
  assert.equal(registry.stop(first!.key), false, "already finished");
  assert.equal(registry.stop("delegate-9-9"), false, "unknown key");
  assert.deepEqual(children.map((child) => child.killed), [["SIGTERM"], []]);
  assert.equal(first!.run.error, "stopped");
  assert.equal(registry.running(), 1);
  assert.deepEqual(registry.records().map((record) => record.key), [second!.key, first!.key], "live runs first, finished after");
  emit(children[1]!, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "two done" }] } });
  children[1]!.emit("close", 0);
  const text = (await pending).content[0]!.text;
  assert.match(text, /\[1\] first \(task\) — failed: stopped/);
  assert.match(text, /\[2\] second \(task\) — done\ntwo done/);
});

test("clearing a session stops its live subagents and removes their details", async () => {
  const children: FakeChild[] = [];
  const { spawn } = fakeSpawn((child) => { children.push(child); });
  const registry = new DelegateRegistry();
  const pending = register(registry, spawn).execute("d", { tasks: [{ task: "one" }, { task: "two" }] }, undefined, undefined, quiet);
  await tick();
  registry.clear();
  assert.deepEqual(children.map((child) => child.killed), [["SIGTERM"], ["SIGTERM"]]);
  assert.deepEqual(registry.records(), []);
  await pending;
  assert.deepEqual(registry.records(), [], "old process events cannot repopulate a new session");
});

test("the registry keeps only the newest eight finished subagents", async () => {
  const { spawn } = fakeSpawn((child) => child.emit("close", 0));
  const registry = new DelegateRegistry();
  const tool = register(registry, spawn);
  for (let batch = 0; batch < 3; batch++) await tool.execute("d", { tasks: [1, 2, 3, 4].map((n) => ({ task: `t${n}` })) }, undefined, undefined, quiet);
  assert.equal(registry.running(), 0);
  assert.deepEqual(registry.records().map((record) => record.key),
    ["delegate-3-4", "delegate-3-3", "delegate-3-2", "delegate-3-1", "delegate-2-4", "delegate-2-3", "delegate-2-2", "delegate-2-1"], "newest first; the oldest batch dropped off");
});
