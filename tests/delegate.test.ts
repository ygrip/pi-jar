import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { ChangeTracker } from "../src/changes.ts";
import { CHILD_BASELINE_ENV, writeChildBaseline } from "../src/child-baselines.ts";
import { CHILD_ENV, DelegateRegistry, delegateArgs, delegatePrompt, piInvocation, READ_ONLY_TOOLS, registerDelegate, WORKTREE_TOOLS, type DelegateOptions } from "../src/delegate.ts";
import { CHILD_WORKTREE_ENV } from "../src/delegate-worktree.ts";
import { emit, fakeSpawn, say, settle, taskOf, type FakeChild } from "./fake-rpc.ts";

const roles = (map: Record<string, { provider: string; model: string; thinking?: string }>) => ({
  resolve: (role: string) => map[role],
  resolveCandidates: (role: string) => map[role] ? [{ ...map[role], via: [role] }] : []
}) as never;
type Result = { content: Array<{ text: string }>; details: { runs: Array<Record<string, unknown>> } };
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

test("subagents run in RPC mode with the parent's extensions, read-only tools plus jar_todo, and never recurse", () => {
  const argv = ["node", "/opt/pi/cli.js", "-ne", "-e", "./extensions", "--extension=/abs/other.ts", "--tui-mode", "fullscreen"];
  const args = delegateArgs("anthropic/claude-haiku", "low", false, argv);
  assert.deepEqual(args.slice(0, 3), ["--mode", "rpc", "--no-session"]);
  assert.deepEqual(args.slice(3, 8), ["-ne", "--extension", join(process.cwd(), "extensions"), "--extension", "/abs/other.ts"], "extension flags are forwarded with absolute paths");
  assert.deepEqual(args.slice(8), ["--model", "anthropic/claude-haiku", "--thinking", "low", "--tools", READ_ONLY_TOOLS.join(",")]);
  assert.ok(READ_ONLY_TOOLS.includes("jar_todo"));
  assert.ok(!delegateArgs(undefined, undefined, true, ["node", "cli"]).includes("--tools"), "legacy write mode keeps the default tools");
  const fork = delegateArgs("p/m", undefined, false, ["node", "cli"], { source: "/tmp/parent.jsonl", sessionDir: "/tmp/forks" });
  assert.deepEqual(fork.slice(0, 7), ["--mode", "rpc", "--fork", "/tmp/parent.jsonl", "--session-dir", "/tmp/forks", "--model"]);
  assert.ok(!fork.includes("--no-session"));
  assert.equal(fork.at(-1), READ_ONLY_TOOLS.join(","));
  const worktree = delegateArgs("p/m", undefined, true, ["node", "cli"], {
    source: "/tmp/parent.jsonl", sessionDir: "/tmp/forks", tools: WORKTREE_TOOLS
  });
  assert.equal(worktree.at(-1), WORKTREE_TOOLS.join(","));
  assert.ok(!WORKTREE_TOOLS.includes("bash" as never), "worktree writers deliberately have no shell");
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
  assert.match(text, /## \[2\] agent 2 \(review · p\/big\) — failed: exited 1 before finishing[\s\S]*\npartial/);
  assert.ok(updates.some((update) => /api: working/.test(update)));
  assert.ok([...statuses.keys()].every((key) => key.startsWith("pi-jar.role.delegate-")));
  assert.ok([...statuses.values()].some((value) => value?.includes('"state":"idle"')), "settled retained teammate remains published");
  const rendered = tool!.renderResult(result, { expanded: false }, { fg: (_c, t) => t }).render(120).join("\n");
  assert.match(rendered, /○ api · scout · 2 tools · \$0\.010/);
  assert.match(rendered, /✖ agent 2/);
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
  assert.equal(report?.state, "done");
  assert.equal(report?.task, "one");
  assert.equal(await registry.stop(first!.key), undefined, "already retired");
  assert.equal(await registry.stop("delegate-9-9"), undefined, "unknown key");
  assert.equal(children[0]!.stdin.writableEnded, true, "stop retires the child process");
  assert.equal(registry.running(), 1);
  assert.deepEqual(registry.records().map((record) => record.key), [second!.key, first!.key], "retained runs stay ahead of retired ones");
  say(children[1]!, "two done");
  settle(children[1]!);
  const text = (await pending).content[0]!.text;
  assert.match(text, /\[1\] first \(scout\) — done/);
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
    assert.ok(call.args.includes("--tools") && call.args.includes(WORKTREE_TOOLS.join(",")), "writer receives the sandboxed tool allowlist");
    assert.ok(call.env[CHILD_WORKTREE_ENV], "child receives its workspace boundary");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "before\n", "parent stays untouched while the worker is reusable");
    assert.equal(tracker.count(), 0);
    assert.ok(call.cwd && existsSync(call.cwd), "worktree remains available while idle");
    assert.equal(result.details.runs[0]!.state, "idle");
    assert.match(result.content[0]!.text, /- mode: worktree[\s\S]*- workspace:/);

    const [record] = registry.records();
    const report = await registry.stop(record!.key);
    assert.deepEqual(report?.changed, ["a.ts"]);
    assert.deepEqual(report?.applied, ["a.ts"]);
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
  assert.match(peek.content[0]!.text, /auth scout · idle[\s\S]*task: inspect auth/);

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
  assert.equal(record!.run.state, "done");
  assert.equal(fake.children[0]!.stdin.writableEnded, true);
});
