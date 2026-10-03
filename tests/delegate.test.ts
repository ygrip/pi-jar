import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { ChangeTracker } from "../src/changes.ts";
import { CHILD_BASELINE_ENV, writeChildBaseline } from "../src/child-baselines.ts";
import { CHILD_ENV, DelegateRegistry, delegateArgs, delegatePrompt, piInvocation, READ_ONLY_TOOLS, registerDelegate, WORKTREE_TOOLS, type DelegateOptions, type DelegateController, type SubagentStopReport } from "../src/delegate.ts";
import { CHILD_WORKTREE_ENV, GIT_EXECUTABLE_ENV } from "../src/delegate-worktree.ts";
import { emit, fakeSpawn, say, settle, taskOf, type FakeChild } from "./fake-rpc.ts";

const roles = (map: Record<string, { provider: string; model: string; thinking?: string }>) => ({
  resolve: (role: string) => map[role],
  resolveCandidates: (role: string) => map[role] ? [{ ...map[role], via: [role] }] : []
}) as never;
type Result = { isError?: boolean; content: Array<{ text: string }>; details: { runs: Array<Record<string, unknown>> } };
interface Tool {
  name: string;
  execute(id: string, params: object, signal: AbortSignal | undefined, onUpdate: ((update: Result) => void) | undefined, ctx: object): Promise<Result>;
  renderResult(result: Result, options: { expanded: boolean }, theme: { fg(color: string, text: string): string }): { render(width: number): string[] };
}
const register = (registry: DelegateRegistry, spawn: unknown, options: DelegateOptions = {}, map: Parameters<typeof roles>[0] = {}): Tool => {
  let tool: Tool | undefined;
  registerDelegate({ registerTool(definition: Tool) { if (definition.name === "jar_delegate") tool = definition; } } as never, roles(map), registry, { ...options, spawnProcess: spawn as never });
  return tool!;
};
const quiet = { cwd: "/repo", hasUI: false, modelRegistry: { getAvailable: () => [] } };
/** Retained scouts own a private session directory, so finalization includes real filesystem cleanup. */
const until = async (check: () => boolean) => { for (let turn = 0; turn < 1000 && !check(); turn++) await tick(); };

test("subagents run in RPC mode with the parent's extensions, read-only tools plus jar_todo, and never recurse", () => {
  const argv = ["node", "/opt/pi/cli.js", "-ne", "-e", "./extensions", "--extension=/abs/other.ts", "--tui-mode", "fullscreen"];
  const args = delegateArgs("anthropic/claude-haiku", "low", false, argv);
  assert.deepEqual(args.slice(0, 3), ["--mode", "rpc", "--no-session"]);
  assert.deepEqual(args.slice(3, 8), ["-ne", "--extension", join(process.cwd(), "extensions"), "--extension", "/abs/other.ts"], "extension flags are forwarded with absolute paths");
  assert.deepEqual(args.slice(8), ["--model", "anthropic/claude-haiku", "--thinking", "low", "--tools", READ_ONLY_TOOLS.join(",")]);
  assert.ok(READ_ONLY_TOOLS.includes("jar_todo"));
  assert.ok(!delegateArgs(undefined, undefined, true, ["node", "cli"]).includes("--tools"), "legacy write mode keeps the default tools");
  const fork = delegateArgs("p/m", undefined, false, ["node", "cli"], { source: "/tmp/parent.jsonl", sessionDir: "/tmp/forks" });
  assert.deepEqual(fork.slice(0, 8), ["--mode", "rpc", "--fork", "/tmp/parent.jsonl", "--session-dir", "/tmp/forks", "--no-extensions", "--extension"]);
  assert.ok(fork[8]!.endsWith("/extensions/index.ts"), "lean forks explicitly load pi-jar even without parent CLI extension flags");
  assert.ok(!fork.includes("--no-session"));
  assert.equal(fork.at(-1), READ_ONLY_TOOLS.join(","));
  const worktree = delegateArgs("p/m", undefined, true, ["node", "cli"], {
    source: "/tmp/parent.jsonl", sessionDir: "/tmp/forks", tools: WORKTREE_TOOLS
  });
  assert.equal(worktree.at(-1), WORKTREE_TOOLS.join(","));
  const resumed = delegateArgs("p/m", undefined, true, ["node", "cli"], {
    source: "/tmp/parent.jsonl", sessionDir: "/tmp/forks", tools: WORKTREE_TOOLS, resume: "/tmp/forks/child.jsonl"
  });
  assert.deepEqual(resumed.slice(0, 7), ["--mode", "rpc", "--session", "/tmp/forks/child.jsonl", "--session-dir", "/tmp/forks", "--extension"],
    "a hibernated fork continues its own session file and still loads pi-jar; it never re-forks the parent");
  assert.ok(!resumed.includes("--fork"));
  assert.equal(resumed.at(-1), WORKTREE_TOOLS.join(","));
  assert.ok(!WORKTREE_TOOLS.includes("bash" as never), "worktree writers deliberately have no shell");
  assert.equal(delegateArgs("p/m", undefined, false, ["node", "cli"], undefined, ["read", "web_search"]).at(-1), "read,web_search");
  const prompt = delegatePrompt("Find the auth code", false);
  assert.match(prompt, /read-only[\s\S]*jar_todo[\s\S]*## Summary[\s\S]*## Details[\s\S]*## Verification[\s\S]*## Open issues[\s\S]*Task: Find the auth code$/);
  assert.match(delegatePrompt("x", true), /You may edit files/);
  assert.match(delegatePrompt("review", false, "fork"), /read-only fork of the parent conversation/);
  assert.match(delegatePrompt("implement", true, "worktree"), /isolated disposable Git worktree[\s\S]*shell tools are intentionally unavailable/);
  assert.deepEqual(piInvocation(["-p"], ["node", "/definitely/missing.js"], "/usr/bin/node"), { command: "pi", args: ["-p"] });
  assert.deepEqual(piInvocation(["-p"], ["pi"], "/opt/pi/bin/pi"), { command: "/opt/pi/bin/pi", args: ["-p"] });
  process.env[CHILD_ENV] = "1";
  try {
    let registered = false;
    registerDelegate({ registerTool() { registered = true; } } as never, roles({}), new DelegateRegistry());
    assert.equal(registered, false, "children do not get jar_delegate");
  } finally { delete process.env[CHILD_ENV]; }
});

test("default scouts load only pi-jar while optional tools and explicit parent extensions remain available", () => {
  const plain = ["node", "cli"];
  const scout = delegateArgs(undefined, undefined, false, plain);
  assert.ok(scout.includes("--no-extensions"));
  assert.ok(scout[scout.indexOf("--extension") + 1]!.endsWith("/extensions/index.ts"));
  const optional = delegateArgs(undefined, undefined, false, plain, undefined, ["read", "web_search"]);
  assert.ok(!optional.includes("--no-extensions"), "optional plugin tools retain auto-discovered extensions");
  const explicit = delegateArgs(undefined, undefined, false, [...plain, "-e", "/custom.ts"]);
  assert.ok(!explicit.includes("--no-extensions"));
  assert.ok(explicit.includes("/custom.ts"));
  const writer = delegateArgs(undefined, undefined, true, plain, { source: "/parent.jsonl", sessionDir: "/child", tools: WORKTREE_TOOLS });
  assert.ok(!writer.includes("--no-extensions"), "writers keep multi_file_edit and other required plugins");
});

test("explicit active web tools and filtered parent inheritance produce per-child allowlists", async () => {
  const active = [...READ_ONLY_TOOLS, "web_search", "edit", "write", "bash", "jar_delegate", "jar_subagent", "jar_democracy"];
  const fake = fakeSpawn(child => { say(child, "ready"); settle(child); });
  const host = moderatorHost(fake.spawn, active);
  const context = { ...quiet, sessionManager: { getSessionFile: () => "/tmp/parent.jsonl" } };
  const explicit = await host.delegate.execute("d1", {
    tasks: [{ task: "browse docs", mode: "scout", tools: ["read", "web_search"] }]
  }, undefined, undefined, quiet);
  assert.match(explicit.content[0]!.text, /launch is asynchronous/);
  await tick();
  assert.ok(fake.calls[0]!.args.includes("--tools") && fake.calls[0]!.args.at(-1) === "read,web_search");
  await host.registry.stop(host.registry.records()[0]!.key);

  await host.delegate.execute("d2", {
    tasks: [{ task: "review", mode: "fork", inheritTools: true }]
  }, undefined, undefined, context);
  await tick();
  const inherited = fake.calls[1]!.args.at(-1)!;
  assert.ok(inherited.includes("read") && inherited.includes("jar_discuss") && inherited.includes("web_search"));
  for (const forbidden of ["edit", "write", "bash", "jar_delegate", "jar_subagent", "jar_democracy"])
    assert.ok(!inherited.split(",").includes(forbidden), `${forbidden} is filtered from read-only inheritance`);
  await host.registry.stop(host.registry.records()[0]!.key);
});

test("custom subagent tools validate active names and cannot widen unsafe modes", async () => {
  const fake = fakeSpawn(child => { say(child, "ready"); settle(child); });
  const host = moderatorHost(fake.spawn, ["read", "edit", "bash", "multi_file_edit", "web_search", "jar_delegate"]);
  const missing = await host.delegate.execute("d", { tasks: [{ task: "x", tools: ["not_active"] }] }, undefined, undefined, quiet);
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text, /not currently active/);
  const readOnly = await host.delegate.execute("d", { tasks: [{ task: "x", mode: "scout", tools: ["read", "edit"] }] }, undefined, undefined, quiet);
  assert.equal(readOnly.isError, true);
  assert.match(readOnly.content[0]!.text, /read-only/);
  const recursive = await host.delegate.execute("d", { tasks: [{ task: "x", mode: "fork", tools: ["read", "jar_delegate"] }] }, undefined, undefined, quiet);
  assert.equal(recursive.isError, true);
  assert.match(recursive.content[0]!.text, /recursive delegation/);
  const unguarded = await host.delegate.execute("d", { tasks: [{ task: "x", mode: "worktree", tools: ["read", "bash"] }] }, undefined, undefined, quiet);
  assert.equal(unguarded.isError, true);
  assert.match(unguarded.content[0]!.text, /path-guarded|bash/);
  assert.equal(fake.calls.length, 0, "rejected capability sets must not spawn a child");
});

test("tool inheritance fails clearly when the Pi host cannot enumerate active tools", async () => {
  const host = moderatorHost(fakeSpawn(() => {}).spawn);
  const result = await host.delegate.execute("d", { tasks: [{ task: "x", inheritTools: true }] }, undefined, undefined, quiet);
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /does not expose active tool names/);
});

test("jar_delegate runs tasks in parallel on roles and returns a detailed report per subagent", async () => {
  const { spawn, calls, children } = fakeSpawn((child, prompt) => {
    const task = taskOf(prompt);
    emit(child, { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "src/auth.ts" } });
    emit(child, { type: "tool_execution_end", toolCallId: "a", toolName: "read", result: { content: [{ type: "text", text: "code" }] }, isError: false });
    emit(child, { type: "tool_execution_start", toolCallId: "b", toolName: "grep", args: { pattern: "login" } });
    emit(child, { type: "tool_execution_end", toolCallId: "b", toolName: "grep", result: { content: [{ type: "text", text: "no match" }] }, isError: true });
    if (task.includes("fail")) { say(child, "partial"); child.emit("close", 1); return; }
    say(child, "## Summary\nReport: " + task, 0.01);
    settle(child);
  });
  let tool: Tool | undefined;
  registerDelegate({ registerTool(definition: Tool) { if (definition.name === "jar_delegate") tool = definition; } } as never,
    roles({ scout: { provider: "p", model: "small", thinking: "low" }, default: { provider: "p", model: "big" } }), new DelegateRegistry(), { spawnProcess: spawn as never });
  const statuses = new Map<string, string | undefined>();
  const updates: string[] = [];
  const ctx = { cwd: "/repo", hasUI: true, model: { provider: "p", id: "current" },
    modelRegistry: { getAvailable: () => [{ provider: "p", id: "small" }, { provider: "p", id: "big" }] },
    ui: { setStatus(key: string, value?: string) { statuses.set(key, value); } } };
  const result = await tool!.execute("d", { tasks: [{ task: "scan api", name: "api" }, { task: "please fail", role: "review" }] }, undefined,
    (update) => updates.push(update.content[0]!.text), ctx);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.env[CHILD_ENV] === "1"));
  assert.ok(calls[0]!.args.includes("p/small") && calls[0]!.args.includes("low"), "scout role resolves");
  assert.ok(calls[1]!.args.includes("p/big"), "unknown role falls back to default");
  assert.equal(children[0]!.stdin.commands[0]!.type, "prompt");
  assert.match(String(children[0]!.stdin.commands[0]!.message), /Task: scan api$/);
  assert.equal(children[0]!.stdin.writableEnded, false, "retained scout stays alive after settling");
  const text = result.content[0]!.text;
  assert.match(text, /## \[1\] api \(scout · p\/small\) — idle\n- took \d+s · 1 turn · 2 tool calls \(read×1, grep×1\) · \$0\.010\n- files read: src\/auth\.ts\n- failed tool calls: grep login\n\n## Summary\nReport: scan api/);
  assert.match(text, /## \[2\] review 2 \(review · p\/big\) — failed: exited 1 before finishing[\s\S]*\npartial/);
  assert.ok(updates.some((update) => /api: working/.test(update)));
  assert.ok([...statuses.keys()].every((key) => key.startsWith("pi-jar.role.delegate-")));
  assert.ok([...statuses.values()].some((value) => value?.includes('"state":"idle"')), "settled retained teammate remains published");
  const rendered = tool!.renderResult(result, { expanded: false }, { fg: (_c, t) => t }).render(120).join("\n");
  assert.match(rendered, /○ api · scout · 2 tools · \$0\.010/);
  assert.match(rendered, /✖ review 2/);
});

test("a rejected prompt and an aborted call fail with the reason", async () => {
  const rejecting = fakeSpawn(() => {});
  const failing = register(new DelegateRegistry(), (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    const child = rejecting.spawn(command, args, options) as unknown as FakeChild;
    child.stdin.write = (line: string) => { const request = JSON.parse(line); if (request.type === "prompt") queueMicrotask(() => emit(child, { type: "response", id: request.id, command: "prompt", success: false, error: "No model" })); return true; };
    return child as never;
  });
  assert.match((await failing.execute("d", { tasks: [{ task: "x" }] }, undefined, undefined, quiet)).content[0]!.text, /failed: No model/);
  const hanging = fakeSpawn(() => {});
  const controller = new AbortController();
  const pending = register(new DelegateRegistry(), hanging.spawn).execute("d", { tasks: [{ task: "long" }] }, controller.signal, undefined, quiet);
  await tick();
  controller.abort();
  assert.match((await pending).content[0]!.text, /failed: aborted/);
  assert.deepEqual(hanging.children[0]!.killed, ["SIGTERM"]);
});

test("the transcript keeps structured, bounded tool calls and text that never reach tool details", async () => {
  const gate = new EventEmitter();
  const { spawn } = fakeSpawn(async (child) => {
    emit(child, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test", path: "ignored" } });
    emit(child, { type: "tool_execution_update", toolCallId: "t1", toolName: "bash", partialResult: { content: [{ type: "text", text: "running 3 tests" }] } });
    emit(child, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Found " } });
    emit(child, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "it" } });
    await once(gate, "open");
    emit(child, { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "\x1b[32mok\x1b[0m 3 passed" }] }, isError: false });
    say(child, "Found it.\n\n\n\x1b[31mred\x1b[0m " + "y".repeat(5000));
    for (let index = 0; index < 250; index++) emit(child, { type: "tool_execution_start", toolCallId: `g${index}`, toolName: "grep", args: { pattern: `p${index}` } });
    settle(child);
  });
  const registry = new DelegateRegistry();
  let notified = 0;
  const unsubscribe = registry.subscribe(() => notified++);
  const updates: Result[] = [];
  const pending = register(registry, spawn).execute("d", { tasks: [{ task: "look", name: "scout" }] }, undefined, (update) => updates.push(update), quiet);
  await tick(); await tick();
  const { run } = registry.records()[0]!;
  assert.equal(run.state, "working");
  const [call] = run.transcript;
  assert.ok(call?.kind === "tool");
  assert.deepEqual([call.name, call.hint, call.status, call.output], ["bash", "npm test", "running", "running 3 tests"], "the command wins over other args; partial output streams in");
  assert.match(call.args, /"command": "npm test"/);
  assert.equal(run.live, "Found it", "streaming text is visible before the message ends");
  assert.equal(run.activity, "writing");
  assert.ok(notified >= 4, "listeners hear about every event");
  gate.emit("open");
  const result = await pending;
  assert.equal(run.state, "idle");
  assert.equal(run.live, "");
  assert.equal(call.status, "done");
  assert.equal(call.output, "ok 3 passed", "escapes are stripped from tool output");
  assert.ok(call.endedAt! >= call.startedAt);
  assert.equal(run.transcript.length, 200, "the transcript keeps the newest 200 entries");
  const last = run.transcript.at(-1)!;
  assert.ok(last.kind === "tool" && last.hint === "p249" && last.status === "error", "calls still running when the child ends are marked failed");
  const text = registry.records()[0]!.run.output;
  assert.ok(text.startsWith("Found it."));
  assert.ok([result.details, ...updates.map((update) => update.details)].every((details) => details.runs.every((item) => !("transcript" in item) && !("live" in item))));
  unsubscribe();
  const before = notified;
  registry.clear();
  assert.equal(notified, before, "unsubscribed listeners are not called");
  assert.deepEqual(registry.records(), []);
});

test("a working subagent can be steered, its dialogs never block, and its checklist is mirrored into the report", async () => {
  const gate = new EventEmitter();
  const { spawn, children } = fakeSpawn(async (child) => {
    emit(child, { type: "extension_ui_request", id: "ask-1", method: "select", title: "Pick", options: ["a", "b"] });
    emit(child, { type: "extension_ui_request", id: "note-1", method: "notify", message: "hi" });
    emit(child, { type: "tool_execution_start", toolCallId: "todo", toolName: "jar_todo", args: {} });
    emit(child, { type: "tool_execution_end", toolCallId: "todo", toolName: "jar_todo", isError: false, result: { content: [], details: { items: [
      { id: "p", title: "Audit", status: "in_progress", done: false },
      { id: "c1", title: "Read routes", status: "completed", done: true, parentId: "p" },
      { id: "c2", title: "Check \x1b[31mauth", status: "in_progress", done: false, parentId: "p", activeForm: "Checking auth" },
      { id: "bad", title: 3, status: "done" }
    ] } } });
    await once(gate, "open");
    say(child, "done");
    settle(child);
  });
  const registry = new DelegateRegistry();
  const pending = register(registry, spawn).execute("d", { tasks: [{ task: "audit", name: "auditor" }] }, undefined, undefined, quiet);
  await tick(); await tick();
  const child = children[0]!;
  assert.deepEqual(child.stdin.commands.filter((command) => command.type === "extension_ui_response"), [{ type: "extension_ui_response", id: "ask-1", cancelled: true }],
    "dialogs are answered as cancelled; notifications need no answer");
  const [record] = registry.records();
  assert.deepEqual(record!.run.todos.map((todo) => [todo.id, todo.title, todo.status, todo.parentId ?? ""]),
    [["p", "Audit", "in_progress", ""], ["c1", "Read routes", "completed", "p"], ["c2", "Check auth", "in_progress", "p"]], "invalid items are dropped and titles cleaned");
  assert.equal(registry.steer(record!.key, "  focus on\nthe login flow  "), true);
  assert.deepEqual(child.stdin.commands.at(-1), { type: "steer", message: "focus on\nthe login flow" });
  const steer = record!.run.transcript.at(-1)!;
  assert.ok(steer.kind === "steer" && steer.text === "focus on\nthe login flow");
  assert.equal(registry.steer(record!.key, "   "), false, "empty messages are not sent");
  assert.equal(registry.steer("delegate-9-9", "x"), false);
  gate.emit("open");
  const text = (await pending).content[0]!.text;
  assert.equal(registry.steer(record!.key, "too late"), false, "idle runs use resume rather than steer");
  assert.match(text, /steered 1×/);
  assert.match(text, /- tasks: 1\/2 done\n  \[~\] Audit\n    \[x\] Read routes\n    \[~\] Check auth/);
});

test("files a subagent edits join the parent's /diff once each, with the subagent's baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-delegate-"));
  try {
    writeFileSync(join(root, "a.ts"), "before\n");
    const tracker = new ChangeTracker(() => root);
    let changed = 0;
    let baselineDir = "";
    const { spawn, calls } = fakeSpawn((child) => {
      baselineDir = calls[0]!.env[CHILD_BASELINE_ENV] ?? "";
      // What pi-jar's own tool_call hook does inside the child before each edit runs.
      writeChildBaseline(baselineDir, join(root, "a.ts"), readFileSync(join(root, "a.ts"), "utf8"));
      writeFileSync(join(root, "a.ts"), "after\n");
      for (const id of ["e1", "e2"]) {
        emit(child, { type: "tool_execution_start", toolCallId: id, toolName: "edit", args: { path: "a.ts", oldText: "before", newText: "after" } });
        emit(child, { type: "tool_execution_end", toolCallId: id, toolName: "edit", result: { content: [] }, isError: false });
      }
      writeChildBaseline(baselineDir, join(root, "new.ts"), null);
      writeFileSync(join(root, "new.ts"), "created\n");
      emit(child, { type: "tool_execution_start", toolCallId: "w", toolName: "write", args: { path: join(root, "new.ts"), content: "created\n" } });
      emit(child, { type: "tool_execution_end", toolCallId: "w", toolName: "write", result: { content: [] }, isError: false });
      settle(child);
    });
    const tool = register(new DelegateRegistry(), spawn, { changes: () => tracker, changed: () => { changed++; } });
    const result = await tool.execute("d", { tasks: [{ task: "edit", name: "editor" }], write: true }, undefined, undefined, { cwd: root, hasUI: false });
    assert.ok(baselineDir, "editing subagents get a baseline directory");
    assert.equal(existsSync(baselineDir), false, "the baseline directory is removed afterwards");
    assert.equal(tracker.count(), 2, "two files, counted once each");
    assert.equal(changed, 3);
    assert.deepEqual(tracker.changes().map((change) => [change.rel, change.status, change.before]), [["a.ts", "modified", "before\n"], ["new.ts", "added", ""]]);
    assert.match(result.content[0]!.text, /- files edited: a\.ts, .*new\.ts/);
    const readOnly = fakeSpawn((child) => settle(child));
    await register(new DelegateRegistry(), readOnly.spawn, { changes: () => tracker }).execute("d", { tasks: [{ task: "look" }] }, undefined, undefined, { cwd: root, hasUI: false });
    assert.equal(readOnly.calls[0]!.env[CHILD_BASELINE_ENV], undefined, "read-only subagents need no baselines");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stopping one subagent retires it with a progress report and leaves the rest running", async () => {
  const { spawn, children } = fakeSpawn(() => {});
  const registry = new DelegateRegistry();
  const pending = register(registry, spawn).execute("d", { tasks: [{ task: "one", name: "first" }, { task: "two", name: "second" }] }, undefined, undefined, quiet);
  await tick();
  const [first, second] = registry.records();
  assert.equal(registry.running(), 2);
  const report = await registry.stop(first!.key);
  assert.equal(report?.state, "stopped");
  assert.equal(report?.task, "one");
  assert.equal(await registry.stop(first!.key), undefined, "already retired");
  assert.equal(await registry.stop("delegate-9-9"), undefined, "unknown key");
  assert.equal(children[0]!.stdin.writableEnded, true, "stop retires the child process");
  assert.equal(registry.running(), 1);
  assert.deepEqual(registry.records().map((record) => record.key), [second!.key, first!.key], "retained runs stay ahead of retired ones");
  say(children[1]!, "two done");
  settle(children[1]!);
  const text = (await pending).content[0]!.text;
  assert.match(text, /\[1\] first \(scout\) — stopped/);
  assert.match(text, /\[2\] second \(scout\) — idle\n[\s\S]*\ntwo done$/);
});

test("clearing a session retires retained subagents and removes their details", async () => {
  const { spawn, children } = fakeSpawn(() => {});
  const registry = new DelegateRegistry();
  const pending = register(registry, spawn).execute("d", { tasks: [{ task: "one" }, { task: "two" }] }, undefined, undefined, quiet);
  await tick();
  registry.clear();
  assert.deepEqual(registry.records(), []);
  await pending;
  await tick();
  assert.ok(children.every((child) => child.stdin.writableEnded), "session clear closes retained child RPC processes");
  assert.deepEqual(registry.records(), [], "old process events cannot repopulate a new session");
});

test("the registry keeps only the newest eight retired subagents", async () => {
  const { spawn } = fakeSpawn((child) => settle(child));
  const registry = new DelegateRegistry();
  const tool = register(registry, spawn);
  for (let batch = 0; batch < 3; batch++) {
    await tool.execute("d", { tasks: [1, 2, 3, 4].map((n) => ({ task: `t${n}` })) }, undefined, undefined, quiet);
    const retained = registry.records().filter((record) => record.run.state === "idle");
    await Promise.all(retained.map((record) => registry.stop(record.key)));
  }
  assert.equal(registry.running(), 0);
  assert.equal(registry.retained(), 0);
  assert.deepEqual(registry.records().map((record) => record.key),
    ["delegate-3-4", "delegate-3-3", "delegate-3-2", "delegate-3-1", "delegate-2-4", "delegate-2-3", "delegate-2-2", "delegate-2-1"], "newest retired agents are kept");
});


test("worktree mode retains isolated edits until stop, then safely applies them into /diff", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-worktree-run-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(root, "a.ts"), "before\n");
    git("add", "a.ts");
    git("commit", "-m", "initial");

    const tracker = new ChangeTracker(() => root);
    const fake = fakeSpawn((child) => {
      const call = fake.calls[0]!;
      assert.ok(call.cwd);
      assert.notEqual(call.cwd, root, "child runs in a disposable worktree");
      writeFileSync(join(call.cwd, "a.ts"), "from child\n");
      emit(child, { type: "tool_execution_start", toolCallId: "e", toolName: "edit", args: { path: "a.ts" } });
      emit(child, { type: "tool_execution_end", toolCallId: "e", toolName: "edit", result: { content: [] }, isError: false });
      say(child, "implemented");
      settle(child);
    });
    const registry = new DelegateRegistry();
    const tool = register(registry, fake.spawn, { changes: () => tracker });
    const result = await tool.execute("d", { mode: "worktree", tasks: [{ task: "edit a", name: "writer" }] }, undefined, undefined, {
      cwd: root, hasUI: false, sessionManager: { getSessionFile: () => "/tmp/pi-parent.jsonl" }
    });
    const call = fake.calls[0]!;
    assert.ok(call.args.includes("--fork") && call.args.includes("/tmp/pi-parent.jsonl"), "child receives a real Pi fork");
    const expectedTools = WORKTREE_TOOLS.filter(name => name !== "multi_file_edit");
    assert.ok(call.args.includes("--tools") && call.args.includes(expectedTools.join(",")), "writer receives the guarded defaults without unavailable extension tools");
    assert.deepEqual(JSON.parse(call.env.PI_JAR_CHILD_TOOLS!), expectedTools, "runtime capabilities match the CLI allowlist");
    assert.ok(call.env[CHILD_WORKTREE_ENV], "child receives its workspace boundary");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "before\n", "parent stays untouched while the worker is reusable");
    assert.equal(tracker.count(), 0);
    assert.ok(call.cwd && existsSync(call.cwd), "worktree remains available while idle");
    assert.equal(result.details.runs[0]!.state, "idle");
    assert.match(result.content[0]!.text, /- mode: worktree[\s\S]*- workspace:/);

    const [record] = registry.records();
    const [report, duplicate] = await Promise.all([registry.stop(record!.key), registry.stop(record!.key)]);
    assert.deepEqual(duplicate, report, "concurrent stops share one finalization/apply");
    assert.deepEqual(report?.changed, ["a.ts"]);
    assert.deepEqual(report?.applied, ["a.ts"], JSON.stringify(report));
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "from child\n");
    assert.equal(tracker.count(), 1, "stopping reconciles the worker into /diff");
    assert.ok(call.cwd);
    assert.equal(existsSync(call.cwd), false, "finalized worktree is cleaned up");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("moderator can peek, resume, pause, ask and stop the same retained subagent", async () => {
  const registry = new DelegateRegistry();
  const tools = new Map<string, Tool>();
  let prompts = 0;
  const fake = fakeSpawn((child, prompt) => {
    prompts++;
    if (prompt.includes("Moderator BTW:")) {
      say(child, "The auth guard is in middleware.ts.");
      settle(child);
      return;
    }
    if (prompt.includes("continue slowly")) {
      emit(child, { type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
      return;
    }
    say(child, prompts === 1 ? "initial report" : "finished follow-up");
    settle(child);
  });
  registerDelegate({ registerTool(definition: Tool) { tools.set(definition.name, definition); } } as never,
    roles({ scout: { provider: "p", model: "cheap" } }), registry, { spawnProcess: fake.spawn as never });
  const delegate = tools.get("jar_delegate")!;
  const control = tools.get("jar_subagent")!;
  await delegate.execute("d", { tasks: [{ task: "inspect auth", name: "auth scout" }] }, undefined, undefined, {
    ...quiet, model: { provider: "p", id: "current" }, modelRegistry: { getAvailable: () => [{ provider: "p", id: "cheap" }] }
  });
  const [record] = registry.records();
  assert.equal(record!.run.state, "idle");

  const peek = await control.execute("p", { action: "peek" }, undefined, undefined, quiet);
  assert.equal(peek.content[0]!.text, `${record!.key} · auth scout · idle\nprogress: no checklist`, "peek is task progress only");

  const resumed = await control.execute("r", { action: "resume", agent: record!.key, message: "continue slowly" }, undefined, undefined, quiet);
  assert.match(resumed.content[0]!.text, /Resumed/);
  await tick();
  assert.equal(record!.run.state, "working");

  const paused = await control.execute("pa", { action: "pause", agent: "auth scout" }, undefined, undefined, quiet);
  assert.match(paused.content[0]!.text, /Paused/);
  assert.equal(record!.run.state, "paused");

  const answer = await control.execute("a", { action: "ask", agent: record!.key, message: "Where is the guard?" }, undefined, undefined, quiet);
  assert.match(answer.content[0]!.text, /middleware\.ts/);
  assert.equal(record!.run.state, "paused", "BTW on a paused worker returns it to paused");

  await control.execute("r2", { action: "resume", agent: record!.key, message: "finish now" }, undefined, undefined, quiet);
  await tick();
  assert.equal(record!.run.state, "idle");

  const stopped = await control.execute("s", { action: "stop", agent: record!.key }, undefined, undefined, quiet);
  assert.match(stopped.content[0]!.text, /workspace: none[\s\S]*changed: none[\s\S]*remaining:/);
  assert.equal(record!.run.state, "stopped");
  assert.equal(fake.children[0]!.stdin.writableEnded, true);
});

test("failed assistant turns and rejected follow-up prompts never become successful idle reports", async () => {
  for (const message of [{ stopReason: "error", errorMessage: "provider unavailable" }, { stopReason: "error" }]) {
    const registry = new DelegateRegistry();
    const fake = fakeSpawn((child) => {
      emit(child, { type: "message_end", message: { role: "assistant", content: [], ...message } });
      settle(child);
    });
    const result = await register(registry, fake.spawn).execute("d", { tasks: [{ task: "fail" }] }, undefined, undefined, quiet);
    assert.equal(result.isError, true);
    assert.equal(result.details.runs[0]!.state, "failed");
    assert.equal(registry.retained(), 0);
    assert.notEqual(fake.children[0]!.exitCode, null);
  }
  const registry = new DelegateRegistry();
  const fake = fakeSpawn((child, prompt) => {
    if (prompt === "reject follow-up") emit(child, { type: "response", command: "prompt", success: false, error: "rejected follow-up" });
    else { say(child, "old report"); settle(child); }
  });
  await register(registry, fake.spawn).execute("d", { tasks: [{ task: "initial" }] }, undefined, undefined, quiet);
  assert.equal(registry.resume(registry.records()[0]!.key, "reject follow-up"), true);
  await tick();
  assert.equal(registry.records()[0]!.run.state, "failed");
  assert.equal(registry.records()[0]!.run.output, "", "failed follow-up cannot reuse a previous report");
  assert.equal(registry.retained(), 0);
});

test("ask interrupts a tool-active turn and waits for the dedicated question's final answer", async () => {
  const registry = new DelegateRegistry();
  const fake = fakeSpawn((child, prompt) => {
    if (prompt.includes("Moderator BTW:")) {
      say(child, "intermediate question reasoning");
      queueMicrotask(() => { say(child, "actual BTW answer"); settle(child); });
    } else {
      say(child, "old active task report");
      emit(child, { type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "x" } });
    }
  });
  const pending = register(registry, fake.spawn).execute("d", { tasks: [{ task: "work" }] }, undefined, undefined, quiet);
  await tick();
  const record = registry.records()[0]!;
  fake.children[0]!.stdin.on("command", (command: Record<string, unknown>) => {
    if (command.type === "abort") say(fake.children[0]!, "interrupted task final report");
  });
  const answer = await registry.ask(record.key, "Where is x?");
  assert.equal(answer, "actual BTW answer");
  assert.equal(record.run.state, "idle");
  assert.deepEqual(fake.children[0]!.stdin.commands.slice(1).map((command) => command.type), ["clear_queue", "abort", "prompt"]);
  await pending;
  registry.clear();
});

test("configured pool sizes include idle, paused, and in-progress one-shot children", async () => {
  for (const maximum of [2, 4, 6, 8, 16]) {
    const registry = new DelegateRegistry();
    const fake = fakeSpawn((child) => settle(child));
    const tool = register(registry, fake.spawn, { getMaxSubagents: () => maximum });
    const result = await tool.execute("d", { tasks: Array.from({ length: maximum }, (_, i) => ({ task: `scout ${i}` })) }, undefined, undefined, quiet);
    assert.equal(result.details.runs.length, maximum, "batch must not be truncated to four");
    assert.equal(await registry.pause(registry.records()[0]!.key), true);
    const denied = await tool.execute("d2", { tasks: [{ task: "overflow" }] }, undefined, undefined, quiet);
    assert.equal(denied.isError, true);
    assert.equal(fake.calls.length, maximum);
    registry.clear();
    await tick();
  }
  const registry = new DelegateRegistry();
  const fake = fakeSpawn(() => {});
  const tool = register(registry, fake.spawn, { getMaxSubagents: () => 2 });
  const pending = tool.execute("direct", { write: true, tasks: [{ task: "one" }, { task: "two" }] }, undefined, undefined, quiet);
  const denied = await tool.execute("other", { tasks: [{ task: "three" }] }, undefined, undefined, quiet);
  assert.equal(denied.isError, true);
  assert.equal(fake.calls.length, 2);
  registry.clear();
  await pending;
});

test("queued batch reservations prevent reentrant concurrent launch oversubscription", async () => {
  const registry = new DelegateRegistry();
  const fake = fakeSpawn((child) => settle(child));
  const tool = register(registry, fake.spawn, { getMaxSubagents: () => 2 });
  let concurrent: Promise<Result> | undefined;
  let attempted = false;
  registry.subscribe(() => {
    if (attempted) return;
    attempted = true;
    concurrent = tool.execute("other", { tasks: [{ task: "overflow" }] }, undefined, undefined, quiet);
  });
  await tool.execute("batch", { tasks: [{ task: "one" }, { task: "two" }] }, undefined, undefined, quiet);
  assert.equal((await concurrent)!.isError, true);
  assert.equal(fake.calls.length, 2);
  registry.clear();
});

test("session clear during handle publication kills the child and never launches the remaining queued child", async () => {
  const registry = new DelegateRegistry();
  const fake = fakeSpawn(() => {});
  let cleared = false;
  registry.subscribe(() => {
    if (cleared || !registry.records().some((record) => record.run.state === "working")) return;
    cleared = true;
    registry.clear();
  });
  await register(registry, fake.spawn).execute("d", { tasks: [{ task: "one" }, { task: "two" }] }, undefined, undefined, quiet);
  await tick();
  assert.equal(fake.children.length, 1);
  assert.notEqual(fake.children[0]!.exitCode, null);
  assert.deepEqual(registry.records(), []);
});

test("exit without close retires an idle child and prevents dead-child resume/ask", async () => {
  const registry = new DelegateRegistry();
  const fake = fakeSpawn((child) => { say(child, "done"); settle(child); });
  await register(registry, fake.spawn).execute("d", { tasks: [{ task: "one" }] }, undefined, undefined, quiet);
  const record = registry.records()[0]!;
  fake.children[0]!.exit(0, undefined, false);
  await tick();
  assert.equal(record.run.state, "done");
  assert.equal(registry.retained(), 0);
  assert.equal(registry.resume(record.key, "x"), false);
  assert.equal(await registry.ask(record.key, "x"), undefined);
  fake.children[0]!.emit("close", 0);
  await record.stop();
});

test("controller reuses the same pool/process and only resumes its fresh read-only scouts", async () => {
  const registry = new DelegateRegistry();
  const fake = fakeSpawn((child, prompt) => { say(child, prompt.includes("Task:") ? "initial report" : prompt); settle(child); });
  let controller!: DelegateController;
  const handlers = new Map<string, (event: object, ctx: object) => unknown>();
  const tools = new Map<string, Tool>();
  registerDelegate({
    on(event: string, handler: (event: object, ctx: object) => unknown) { handlers.set(event, handler); },
    registerTool(tool: Tool) { tools.set(tool.name, tool); }
  } as never, roles({}), registry, { spawnProcess: fake.spawn as never, getMaxSubagents: () => 2, onController: (value) => { controller = value; } });
  handlers.get("session_start")!({}, quiet);
  const scout = await controller.spawnScout("investigate independently");
  assert.equal(scout.state, "idle");
  assert.equal(scout.mode, "scout");
  assert.equal(scout.output, "initial report");
  const vote = await controller.resumeScout(scout.id, "Vote yes with evidence");
  assert.equal(vote.output, "Vote yes with evidence");
  assert.equal(fake.calls.length, 1, "resumes use the retained process");
  await tools.get("jar_delegate")!.execute("d", { tasks: [{ task: "ordinary scout" }] }, undefined, undefined, quiet);
  const other = controller.list().find((report) => report.id !== scout.id)!;
  assert.equal((await controller.resumeScout(other.id, "vote")).output, "vote", "Relevant ordinary fresh scouts can be nominated too");
  await assert.rejects(controller.spawnScout("overflow"), /pool is full/);
  assert.equal(fake.calls.length, 2);
  registry.clear();
});

test("controller resume abort retires only its scout and does not return a stale answer", async () => {
  const registry = new DelegateRegistry();
  let controller!: DelegateController;
  const fake = fakeSpawn((child, prompt) => {
    if (prompt.includes("Task:")) { say(child, "previous answer"); settle(child); }
  });
  const tool = register(registry, fake.spawn, { onController: (value) => { controller = value; } });
  await tool.execute("context", { tasks: [{ task: "ordinary scout" }] }, undefined, undefined, quiet);
  const scout = await controller.spawnScout("fresh scout");
  const abort = new AbortController();
  const pending = controller.resumeScout(scout.id, "vote slowly", abort.signal);
  abort.abort();
  await assert.rejects(pending, /aborted/);
  await registry.get(scout.id)!.stop();
  assert.equal(registry.get(scout.id)!.run.state, "stopped");
  assert.equal(registry.get(scout.id)!.run.output, "");
  assert.equal(registry.retained(), 1);
  registry.clear();
});

test("stop blocks resume immediately, clears its status, and shares finalization", async () => {
  const registry = new DelegateRegistry();
  const fake = fakeSpawn((child) => settle(child));
  const statuses = new Map<string, string | undefined>();
  await register(registry, fake.spawn).execute("d", { tasks: [{ task: "one" }] }, undefined, undefined, {
    ...quiet, hasUI: true, ui: { setStatus(key: string, value?: string) { statuses.set(key, value); } }
  });
  const record = registry.records()[0]!;
  const stopped = registry.stop(record.key);
  assert.equal(registry.resume(record.key, "must not start"), false);
  const duplicate = registry.stop(record.key);
  assert.deepEqual(await stopped, await duplicate);
  assert.equal([...statuses.values()][0], undefined);
  assert.equal(fake.children[0]!.stdin.commands.filter((command) => command.type === "prompt").length, 1);
});

test("discarded live processes hold capacity until actual exit", async () => {
  const registry = new DelegateRegistry();
  const fake = fakeSpawn(() => {});
  const tool = register(registry, fake.spawn, { getMaxSubagents: () => 2 });
  const pending = tool.execute("d", { tasks: [{ task: "one" }, { task: "two" }] }, undefined, undefined, quiet);
  await tick();
  // Model a child that ignores TERM and whose stdio does not close on stdin.end().
  for (const child of fake.children) {
    child.kill = (signal) => { child.killed.push(signal); };
    child.stdin.removeAllListeners("finish");
  }
  registry.clear();
  assert.equal(registry.retained(), 2);
  assert.equal((await tool.execute("overflow", { tasks: [{ task: "three" }] }, undefined, undefined, quiet)).isError, true);
  for (const child of fake.children) child.exit(143);
  await pending;
  await tick();
  assert.equal(registry.retained(), 0);
});

test("session discard racing a worktree stop never applies private edits", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-discard-race-"));
  let preserved = "";
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
    writeFileSync(join(root, "a.ts"), "parent\n"); git("add", "a.ts"); git("commit", "-m", "initial");
    const registry = new DelegateRegistry();
    const fake = fakeSpawn((child) => {
      writeFileSync(join(fake.calls[0]!.cwd!, "a.ts"), "private\n");
      say(child, "private changes ready"); settle(child);
    });
    await register(registry, fake.spawn).execute("d", { mode: "worktree", tasks: [{ task: "edit" }] }, undefined, undefined, {
      cwd: root, hasUI: false, sessionManager: { getSessionFile: () => "/tmp/parent.jsonl" }
    });
    const record = registry.records()[0]!;
    const stopped = registry.stop(record.key);
    preserved = registry.clear()[0]!;
    assert.deepEqual((await stopped)?.applied, []);
    await tick();
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "parent\n");
    assert.equal(existsSync(preserved), true, "the unresolved worktree survives a racing session change");
  } finally {
    if (preserved) rmSync(dirname(preserved), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

/** jar_delegate + jar_subagent on a host that records hooks and wake-up messages. */
const moderatorHost = (spawn: unknown, activeTools?: string[]) => {
  const registry = new DelegateRegistry();
  const tools = new Map<string, Tool>();
  const events = new Map<string, (event: { messages: unknown[] }) => { messages: unknown[] } | undefined>();
  const sent: Array<{ message: { customType: string; content: string }; options: { triggerTurn?: boolean; deliverAs?: string } }> = [];
  registerDelegate({
    registerTool(definition: Tool) { tools.set(definition.name, definition); },
    on(name: string, handler: never) { events.set(name, handler); },
    sendMessage(message: { customType: string; content: string }, options: { triggerTurn?: boolean; deliverAs?: string }) { sent.push({ message, options }); }
  } as never, roles({}), registry, { spawnProcess: spawn as never, ...(activeTools ? { getActiveToolNames: () => activeTools } : {}) });
  return { registry, delegate: tools.get("jar_delegate")!, control: tools.get("jar_subagent")!, events, sent };
};

test("stale moderator context is pruned on every LLM call while the fleet is retained", async () => {
  const fake = fakeSpawn((child) => { say(child, "ready"); settle(child); });
  const host = moderatorHost(fake.spawn);
  await host.delegate.execute("d", { tasks: [{ task: "inspect" }] }, undefined, undefined, quiet);
  const messages = [
    { customType: "pi-jar.moderator-context", content: "old fleet" },
    { role: "user", content: "normal" },
    { customType: "pi-jar.moderator-context", content: "new fleet" }
  ];
  // Pi re-sends the full persisted history to the context hook before each LLM call.
  for (let call = 1; call <= 3; call++) {
    const pruned = host.events.get("context")!({ messages });
    assert.deepEqual(pruned?.messages.map((item) => (item as { content: string }).content), ["normal", "new fleet"], `call ${call}`);
  }
  await host.registry.records()[0]!.stop();
});

test("jar_delegate returns before the first turn ends so the moderator can steer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = new EventEmitter();
  const fake = fakeSpawn(async (child) => {
    await once(gate, "finish");
    say(child, "initial report");
    settle(child);
  });
  const host = moderatorHost(fake.spawn);
  const result = await host.delegate.execute("d", { tasks: [{ task: "inspect", name: "auth scout" }] }, undefined, undefined, quiet);
  assert.match(result.content[0]!.text, /Subagent launch is asynchronous/);
  const [record] = host.registry.records();
  assert.equal(record!.run.state, "working");
  assert.equal(host.sent.length, 0, "no completion event before the child settles");
  await host.control.execute("s", { action: "steer", agent: record!.key, message: "prioritize the token refresh path" }, undefined, undefined, quiet);
  assert.ok(fake.children[0]!.stdin.commands.some((command) => command.type === "steer"), "parent can steer while the child is active");
  gate.emit("finish");
  await tick();
  await tick();
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(record!.run.state, "idle");
  assert.equal(host.sent.length, 1, "the first completion is reported once through Pi's event bus");
  assert.match(host.sent[0]!.message.content, /initial report/);
  await host.control.execute("x", { action: "stop", agent: record!.key }, undefined, undefined, quiet);
});

test("initial and resumed subagent turns wake the moderator over RPC without blocking steering", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeSpawn((child, prompt) => { say(child, prompt.includes("Task:") ? "initial report" : "follow-up report"); settle(child); });
  const host = moderatorHost(fake.spawn);
  await host.delegate.execute("d", { tasks: [{ task: "inspect", name: "auth scout" }] }, undefined, undefined, quiet);
  await tick();
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(host.sent.length, 1, "the initial completion is delivered asynchronously over the event bus");
  assert.match(host.sent[0]!.message.content, /auth scout turn ended[\s\S]*initial report/);
  const [record] = host.registry.records();
  const resumed = await host.control.execute("r", { action: "resume", agent: record!.key, message: "dig deeper" }, undefined, undefined, quiet);
  assert.match(resumed.content[0]!.text, /Resumed auth scout/);
  await tick();
  assert.equal(record!.run.state, "idle");
  t.mock.timers.tick(1000);
  assert.equal(host.sent.length, 2, "one coalesced event per settled turn");
  assert.equal(host.sent[1]!.message.customType, "pi-jar.subagent");
  assert.deepEqual(host.sent[1]!.options, { triggerTurn: true }, "idle wake-ups never use Pi's irrevocable follow-up queue");
  assert.match(host.sent[1]!.message.content, /auth scout · idle[\s\S]*last: follow-up report/);
  await host.control.execute("s", { action: "stop", agent: record!.key }, undefined, undefined, quiet);
  await until(() => host.sent.length >= 3);
  t.mock.timers.tick(1000);
  assert.equal(host.sent.length, 3, "stop completes through its operation event, not a duplicate turn wake-up");
  assert.match(host.sent[2]!.message.content, /stop subagent-op-.*completed/);
});

test("completions during a moderator run join its settle boundary instead of re-waking it after the final answer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeSpawn((child) => { say(child, "initial report"); settle(child); });
  const host = moderatorHost(fake.spawn);
  const hook = (name: string, event: object = {}) => (host.events.get(name) as unknown as (event: object) => unknown)(event);
  hook("agent_start");
  await host.delegate.execute("d", { tasks: [{ task: "inspect", name: "auth scout" }] }, undefined, undefined, quiet);
  await tick();
  const [record] = host.registry.records();
  await host.control.execute("s", { action: "stop", agent: record!.key }, undefined, undefined, quiet);
  await until(() => record!.run.state === "stopped");
  await tick();
  t.mock.timers.tick(1000);
  assert.equal(host.sent.length, 0, "nothing reaches Pi's follow-up queue while the moderator runs");
  const settled = hook("agent_before_settle", { outcome: "completed" }) as { entries: Array<{ content: string; details: { summary: string } }>; continue: boolean };
  assert.equal(settled.continue, true, "the moderator sees the events before its final answer");
  assert.equal(settled.entries.length, 1, "events coalesce into one message");
  assert.doesNotMatch(settled.entries[0]!.content, /turn ended/, "the stop handoff supersedes the queued turn report");
  assert.match(settled.entries[0]!.details.summary, /stop auth scout completed/);
  assert.equal(hook("agent_before_settle", { outcome: "completed" }), undefined, "consumed events never replay");
  hook("agent_settled");
  t.mock.timers.tick(1000);
  assert.equal(host.sent.length, 0, "no wake-up after the moderator's final answer");
});

test("stop sends EOF immediately rather than waiting for an unacknowledged abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeSpawn(() => {});
  const host = moderatorHost(fake.spawn);
  await host.delegate.execute("d", { tasks: [{ task: "inspect" }] }, undefined, undefined, quiet);
  await tick();
  const child = fake.children[0]!;
  child.stdin.removeAllListeners("command"); // A busy extension does not acknowledge abort.
  const stopping = host.registry.stop(host.registry.records()[0]!.key);
  await tick();
  assert.equal(child.stdin.writableEnded, true, "EOF is sent in the same shutdown phase as abort");
  await stopping;
  assert.equal(child.killed.length, 0, "a child honoring EOF exits without a forced grace timeout");
});

test("stop has one process-exit deadline when the child ignores both abort and EOF", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeSpawn(() => {});
  const host = moderatorHost(fake.spawn);
  await host.delegate.execute("d", { tasks: [{ task: "inspect" }] }, undefined, undefined, quiet);
  await tick();
  const child = fake.children[0]!;
  child.stdin.removeAllListeners("command");
  child.stdin.removeAllListeners("finish");
  const stopping = host.registry.stop(host.registry.records()[0]!.key);
  await tick();
  t.mock.timers.tick(2999);
  assert.equal(child.killed.length, 0);
  t.mock.timers.tick(1);
  await stopping;
  assert.ok(child.killed.includes("SIGTERM"), "one 3s budget, not consecutive abort and exit budgets");
});

test("stop never hangs when a grandchild keeps the child's stdio open after exit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeSpawn((child) => { say(child, "done"); settle(child); });
  const registry = new DelegateRegistry();
  const spawn = (command: string, args: string[], options: object) => {
    const child = fake.spawn(command, args, options) as unknown as FakeChild;
    const emitEvent = child.emit.bind(child);
    // An inherited pipe held by a grandchild: the process exits, 'close' never comes.
    child.emit = (event: string | symbol, ...rest: unknown[]) => event === "close" ? false : emitEvent(event, ...rest);
    return child as never;
  };
  await register(registry, spawn).execute("d", { tasks: [{ task: "one" }] }, undefined, undefined, quiet);
  const done: { report?: SubagentStopReport } = {};
  const stopping = registry.stop(registry.records()[0]!.key).then((value) => { done.report = value; });
  await tick();
  assert.equal(fake.children[0]!.exitCode, 0);
  const early = done.report;
  assert.equal(early, undefined, "still draining stdio");
  t.mock.timers.tick(2000);
  await stopping;
  assert.equal(done.report?.state, "stopped");
});

test("pause and stop return receipts even when the child ignores abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeSpawn((child, prompt) => {
    if (prompt.includes("Task:")) { say(child, "ready"); settle(child); return; }
    emit(child, { type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
  });
  const spawn = (command: string, args: string[], options: object) => {
    const child = fake.spawn(command, args, options) as unknown as FakeChild;
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (line: string) => (JSON.parse(line) as { type?: string }).type === "abort" || write(line);
    return child as never;
  };
  const host = moderatorHost(spawn);
  await host.delegate.execute("d", { tasks: [{ task: "inspect" }] }, undefined, undefined, quiet);
  const [record] = host.registry.records();
  await host.control.execute("r", { action: "resume", agent: record!.key, message: "keep going" }, undefined, undefined, quiet);
  const pauseReceipt = await host.control.execute("p", { action: "pause", agent: record!.key }, undefined, undefined, quiet);
  assert.match(pauseReceipt.content[0]!.text, /pause accepted/);
  assert.equal(record!.run.state, "working", "acceptance does not pretend the child has paused");
  const stopReceipt = await host.control.execute("s", { action: "stop", agent: record!.key }, undefined, undefined, quiet);
  assert.match(stopReceipt.content[0]!.text, /stop accepted/);
  assert.equal(record!.run.state, "working", "stop is asynchronous too");
  const duplicate = await host.control.execute("s2", { action: "stop", agent: record!.key }, undefined, undefined, quiet);
  assert.match(duplicate.content[0]!.text, /already accepted/);
  assert.deepEqual(duplicate.details, stopReceipt.details, "duplicate stop shares an operation id");
  await tick();
  t.mock.timers.tick(3000);
  await until(() => record!.run.state === "stopped");
  assert.equal(record!.run.state, "stopped");
  t.mock.timers.tick(1000);
  assert.ok(host.sent.some(item => /stop subagent-op-.*completed/.test(item.message.content)), "the final handoff arrives via event");
  assert.deepEqual(fake.children[0]!.killed, [], "EOF-cooperative children exit without an unnecessary forced kill");
});

test("BTW asks return immediately and deliver exactly one answer event", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = new EventEmitter();
  const fake = fakeSpawn(async (child, prompt) => {
    if (prompt.includes("Task:")) { say(child, "ready"); settle(child); return; }
    await once(gate, "answer");
    say(child, "the guard is in auth.ts");
    settle(child);
  });
  const host = moderatorHost(fake.spawn);
  await host.delegate.execute("d", { tasks: [{ task: "inspect" }] }, undefined, undefined, quiet);
  await tick();
  t.mock.timers.tick(1000);
  host.sent.length = 0;
  const record = host.registry.records()[0]!;
  const receipt = await host.control.execute("a", { action: "ask", agent: record.key, message: "Where is the guard?" }, undefined, undefined, quiet);
  assert.match(receipt.content[0]!.text, /ask accepted/);
  assert.equal(host.sent.length, 0, "the moderator returns before an answer exists");
  const peek = await host.control.execute("p", { action: "peek", agent: record.key }, undefined, undefined, quiet);
  assert.match(peek.content[0]!.text, /working/);
  gate.emit("answer");
  await tick();
  await tick();
  assert.equal(host.sent.length, 0, "the answer is coalesced briefly before waking the idle moderator");
  t.mock.timers.tick(1000);
  assert.equal(host.sent.length, 1);
  assert.match(host.sent[0]!.message.content, /ask subagent-op-.*completed:[\s\S]*guard is in auth.ts/);
  t.mock.timers.tick(1000);
  assert.equal(host.sent.length, 1, "the BTW turn must not also emit a duplicate turn notification");
  await host.registry.stop(record.key);
});

test("legacy direct delegates also return before their child finishes", async () => {
  const gate = new EventEmitter();
  const fake = fakeSpawn(async child => { await once(gate, "finish"); say(child, "done"); settle(child); });
  const host = moderatorHost(fake.spawn);
  const receipt = await host.delegate.execute("d", { write: true, tasks: [{ task: "legacy" }] }, undefined, undefined, quiet);
  assert.match(receipt.content[0]!.text, /launch is asynchronous/);
  assert.equal(host.registry.records()[0]!.run.state, "working");
  gate.emit("finish");
  await tick();
  await tick();
  assert.equal(host.registry.records()[0]!.run.state, "done");
});

test("stop cancels hung worktree startup without waiting for a Git deadline", { skip: process.platform === "win32", timeout: 3000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-startup-stop-"));
  const executable = join(root, "git");
  const previous = process.env[GIT_EXECUTABLE_ENV];
  writeFileSync(executable, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o755 });
  process.env[GIT_EXECUTABLE_ENV] = executable;
  const fake = fakeSpawn(() => { throw new Error("child must not spawn after startup cancellation"); });
  const host = moderatorHost(fake.spawn);
  const ctx = { ...quiet, cwd: root, sessionManager: { getSessionFile: () => "/tmp/parent.jsonl" } };
  const pulse = setInterval(() => {}, 5);
  try {
    const launched = await host.delegate.execute("d", { tasks: [{ task: "edit", mode: "worktree" }] }, undefined, undefined, ctx);
    assert.match(launched.content[0]!.text, /launch is asynchronous/);
    const record = host.registry.records()[0]!;
    const receipt = await host.control.execute("s", { action: "stop", agent: record.key }, undefined, undefined, ctx);
    assert.match(receipt.content[0]!.text, /stop accepted/);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const report = await record.stop();
    assert.equal(report.state, "stopped");
    assert.equal(fake.children.length, 0);
    await tick();
    t.mock.timers.tick(1000);
    assert.equal(host.sent.length, 1);
    assert.match(host.sent[0]!.message.content, /stop subagent-op-.*completed/);
  } finally {
    clearInterval(pulse);
    host.registry.clear();
    if (previous === undefined) delete process.env[GIT_EXECUTABLE_ENV]; else process.env[GIT_EXECUTABLE_ENV] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("RPC agent_end is not treated as final while retries/compaction may continue", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeSpawn(child => { say(child, "low-level run ended"); emit(child, { type: "agent_end" }); });
  const host = moderatorHost(fake.spawn);
  await host.delegate.execute("d", { tasks: [{ task: "inspect" }] }, undefined, undefined, quiet);
  await tick();
  t.mock.timers.tick(1000);
  assert.equal(host.registry.records()[0]!.run.state, "working");
  assert.equal(host.sent.length, 0, "only agent_settled is the native idle boundary");
  settle(fake.children[0]!);
  t.mock.timers.tick(1000);
  assert.equal(host.sent.length, 1);
  await host.registry.stop(host.registry.records()[0]!.key);
});

test("a handled RPC prompt settles without waiting for a nonexistent agent event", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeSpawn(child => emit(child, { type: "response", command: "prompt", success: true, data: { disposition: "handled" } }));
  const host = moderatorHost(fake.spawn);
  await host.delegate.execute("d", { tasks: [{ task: "inspect" }] }, undefined, undefined, quiet);
  await tick();
  assert.equal(host.registry.records()[0]!.run.state, "idle");
  t.mock.timers.tick(1000);
  assert.equal(host.sent.length, 1);
  await host.registry.stop(host.registry.records()[0]!.key);
});

test("coalesced events preserve initial reports across an immediate resume", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeSpawn((child, prompt) => { say(child, prompt.includes("Task:") ? "original report" : "second report"); settle(child); });
  const host = moderatorHost(fake.spawn);
  await host.delegate.execute("d", { tasks: [{ task: "inspect" }] }, undefined, undefined, quiet);
  await tick();
  const record = host.registry.records()[0]!;
  // Resume before the 250ms coalescer flushes the first completion.
  await host.control.execute("r", { action: "resume", agent: record.key, message: "continue" }, undefined, undefined, quiet);
  await tick();
  assert.equal(host.sent.length, 0);
  t.mock.timers.tick(1000);
  assert.equal(host.sent.length, 1, "one transport message may contain several distinct completed turns");
  assert.match(host.sent[0]!.message.content, /original report[\s\S]*second report/);
  await host.registry.stop(record.key);
});
