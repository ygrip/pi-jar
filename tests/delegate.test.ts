import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { CHILD_ENV, delegateArgs, piInvocation, READ_ONLY_TOOLS, registerDelegate } from "../src/delegate.ts";

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
    registerDelegate({ registerTool() { registered = true; } } as never, roles({}));
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
    roles({ task: { provider: "p", model: "small", thinking: "low" }, default: { provider: "p", model: "big" } }), spawn as never);
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
  registerDelegate({ registerTool(definition: unknown) { tool = definition; } } as never, roles({}), spawn as never);
  const controller = new AbortController();
  const pending = tool.execute("d", { tasks: [{ task: "long" }] }, controller.signal, undefined, { cwd: "/repo", hasUI: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  const result = await pending;
  assert.deepEqual(running?.killed[0], "SIGTERM");
  assert.match(result.content[0].text, /failed: aborted/);
});
