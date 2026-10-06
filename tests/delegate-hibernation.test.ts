import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { ChangeTracker } from "../src/changes.ts";
import { DelegateRegistry, HIBERNATE_AFTER_MS, registerDelegate, type DelegateOptions } from "../src/delegate.ts";
import { DISCUSSION_ENDPOINT_ENV, DISCUSSION_TOKEN_ENV } from "../src/discussion.ts";
import { emit, fakeSpawn, say, sessionFileOf, settle, taskOf, until, type FakeChild } from "./fake-rpc.ts";

interface Tool { name: string; execute(id: string, params: object, signal: undefined, onUpdate: undefined, ctx: object): Promise<{ isError?: boolean; content: Array<{ text: string }> }> }

/** jar_delegate and jar_subagent on a host whose event bus records moderator wake-ups. */
const host = (spawn: unknown, options: DelegateOptions = {}) => {
  const registry = new DelegateRegistry();
  const tools = new Map<string, Tool>();
  const sent: Array<{ content: string }> = [];
  registerDelegate({
    registerTool(definition: Tool) { tools.set(definition.name, definition); },
    on() {},
    sendMessage(message: { content: string }) { sent.push(message); }
  } as never, { resolve: () => undefined } as never, registry, { spawnProcess: spawn as never, ...options });
  return { registry, delegate: tools.get("jar_delegate")!, control: tools.get("jar_subagent")!, sent };
};
const quiet = { cwd: "/repo", hasUI: false, modelRegistry: { getAvailable: () => [] } };
const prompts = (file: string) => readFileSync(file, "utf8").trim().split("\n");
const flag = (args: readonly string[], name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;

test("a settled scout hibernates after its quiet grace without waking the moderator, and resume continues the same session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeSpawn((child, prompt) => {
    emit(child, { type: "tool_execution_start", toolCallId: "r", toolName: "read", args: { path: "src/auth.ts" } });
    emit(child, { type: "tool_execution_end", toolCallId: "r", toolName: "read", result: { content: [] }, isError: false });
    say(child, prompt.includes("Task:") ? "initial report" : "follow-up report", 0.01);
    settle(child);
  });
  const envs: string[] = [];
  const retired: string[] = [];
  const moderator = host(fake.spawn, {
    discussionEnv: (key) => { envs.push(key); return { [DISCUSSION_ENDPOINT_ENV]: "/tmp/broker.sock", [DISCUSSION_TOKEN_ENV]: "capability" }; },
    discussionRetire: (key) => { retired.push(key); }
  });
  await moderator.delegate.execute("d", { tasks: [{ task: "inspect auth", name: "auth scout" }] }, undefined, undefined, quiet);
  await tick();
  t.mock.timers.tick(1000);
  assert.equal(moderator.sent.length, 1, "the initial turn wakes the moderator once");
  const [record] = moderator.registry.records();
  const first = fake.children[0]!;
  const sessionFile = sessionFileOf(fake.calls[0]!.args)!;
  t.mock.timers.tick(HIBERNATE_AFTER_MS - 1001);
  await tick();
  assert.equal(record!.run.state, "idle", "the child stays up during the quiet grace");
  assert.equal(first.exitCode, null);

  t.mock.timers.tick(1);
  for (let turn = 0; turn < 5; turn++) await tick();
  assert.equal(record!.run.state, "hibernated");
  assert.ok(first.stdin.commands.some((command) => command.type === "get_state"), "the session file is learned from Pi itself");
  assert.equal(first.exitCode, 0, "hibernation closes the child through EOF, Pi's orderly shutdown");
  assert.deepEqual(first.killed, []);
  assert.ok(existsSync(sessionFile), "the private session outlives its process");
  assert.deepEqual([record!.run.output, record!.run.turns, record!.run.tools, record!.run.filesRead, record!.run.cost],
    ["initial report", 1, 1, ["src/auth.ts"], 0.01], "the record keeps its report and metadata");
  assert.deepEqual(moderator.registry.stats(), { retained: 1, live: 0, hibernated: 1, recovery: 0, recoveryLimit: 4, pids: [] });
  t.mock.timers.tick(1000);
  assert.equal(moderator.sent.length, 1, "hibernation is not a turn end: nobody is woken");
  assert.deepEqual(retired, [], "a hibernated agent keeps its discussion identity");

  const resumed = await moderator.control.execute("r", { action: "resume", agent: record!.key, message: "dig deeper" }, undefined, undefined, quiet);
  assert.match(resumed.content[0]!.text, /Resumed auth scout/);
  assert.equal(fake.calls.length, 2, "resume relaunches a new child");
  const relaunch = fake.calls[1]!;
  assert.deepEqual([flag(relaunch.args, "--session"), flag(relaunch.args, "--session-dir")], [sessionFile, dirname(sessionFile)],
    "the new process continues the same session file");
  assert.equal(flag(relaunch.args, "--fork"), undefined);
  assert.equal(relaunch.cwd, fake.calls[0]!.cwd);
  assert.equal(relaunch.env[DISCUSSION_ENDPOINT_ENV], "/tmp/broker.sock", "every spawn gets the discussion broker environment");
  assert.deepEqual(envs, [record!.key, record!.key]);
  await tick();
  assert.equal(record!.run.state, "idle");
  assert.deepEqual(prompts(sessionFile).map((line) => line.includes("Task:")), [true, false], "both processes wrote one session: the task, then the resume");
  t.mock.timers.tick(1000);
  assert.equal(moderator.sent.length, 2);
  assert.match(moderator.sent[1]!.content, /auth scout · idle\nsummary: follow-up report/, "the resumed turn wakes the moderator as before");
  assert.deepEqual([record!.run.turns, record!.run.resumes], [2, 1]);

  assert.equal((await moderator.registry.stop(record!.key))?.state, "stopped");
  assert.equal(existsSync(dirname(sessionFile)), false, "stop removes the private session");
  assert.deepEqual(retired, [record!.key]);
});

test("repeated hibernate, resume and ask cycles reuse one private session and leave no process or directory behind", { timeout: 15_000 }, async () => {
  const fake = fakeSpawn((child, prompt) => {
    say(child, prompt.includes("Moderator BTW:") ? "btw answer" : prompt.includes("Task:") ? "initial" : "continued");
    settle(child);
  });
  const moderator = host(fake.spawn, { hibernateAfterMs: 0 });
  await moderator.delegate.execute("d", { tasks: [{ task: "inspect" }] }, undefined, undefined, quiet);
  const [record] = moderator.registry.records();
  const sessionFile = sessionFileOf(fake.calls[0]!.args)!;
  const asleep = () => until(moderator.registry, () => record!.run.state === "hibernated");
  for (let cycle = 1; cycle <= 4; cycle++) {
    await asleep();
    assert.equal(moderator.registry.stats().live, 0, `cycle ${cycle} leaves no live process`);
    assert.ok(fake.children.every((child) => child.exitCode === 0), "every earlier process exited cleanly");
    if (cycle % 2) assert.equal(moderator.registry.resume(record!.key, `continue ${cycle}`), true);
    else assert.equal(await moderator.registry.ask(record!.key, "where?"), "btw answer");
    assert.equal(fake.calls.length, cycle + 1, "each wake-up launches exactly one process");
    assert.equal(flag(fake.calls[cycle]!.args, "--session"), sessionFile);
  }
  await asleep();

  assert.equal(await moderator.registry.pause(record!.key), true, "pausing a hibernated agent needs no process");
  assert.equal(record!.run.state, "hibernated");
  assert.equal(fake.calls.length, 5);
  assert.equal(await moderator.registry.ask(record!.key, "and now?"), "btw answer");
  assert.equal(record!.run.state, "paused", "a BTW answer returns a paused agent to paused across hibernation");
  await asleep();

  assert.deepEqual(readdirSync(dirname(sessionFile)), ["fake-session.jsonl"], "one session file serves all six processes");
  assert.equal(prompts(sessionFile).length, 6);
  assert.deepEqual(moderator.registry.stats(), { retained: 1, live: 0, hibernated: 1, recovery: 0, recoveryLimit: 4, pids: [] });
  await moderator.registry.stop(record!.key);
  assert.equal(existsSync(dirname(sessionFile)), false);
});

test("a resume accepted while the hibernating child is still exiting relaunches only after that process is gone", { timeout: 15_000 }, async () => {
  const fake = fakeSpawn((child, prompt) => { say(child, prompt.includes("Task:") ? "first" : "second"); settle(child); });
  const spawn = (command: string, args: string[], options: object) => {
    const child = fake.spawn(command, args, options) as unknown as FakeChild;
    // The first child keeps running after EOF until the test lets it exit.
    if (fake.children.length === 1) child.stdin.removeAllListeners("finish");
    return child as never;
  };
  const moderator = host(spawn, { hibernateAfterMs: 0 });
  await moderator.delegate.execute("d", { tasks: [{ task: "inspect" }] }, undefined, undefined, quiet);
  const [record] = moderator.registry.records();
  const first = fake.children[0]!;
  await until(moderator.registry, () => record!.run.activity === "hibernating");
  assert.equal(first.stdin.writableEnded, true, "hibernation sends EOF");
  assert.equal(record!.run.state, "idle", "still settled while the process exits");
  assert.equal(moderator.registry.resume(record!.key, "next step"), true);
  assert.equal(record!.run.state, "working");
  await tick();
  assert.equal(fake.calls.length, 1, "never two processes on one session file");
  first.exit(0);
  await until(moderator.registry, () => record!.run.state === "idle" && fake.calls.length === 2);
  assert.equal(record!.run.output, "second");
  assert.match(String(fake.children[1]!.stdin.commands.find((command) => command.type === "prompt")!.message), /next step/);
  await moderator.registry.stop(record!.key);
});

test("hibernated agents hold pool slots, stats count only running children, and stop and clear remove private state", { timeout: 15_000 }, async () => {
  let release = () => {};
  const fake = fakeSpawn((child, prompt) => {
    if (taskOf(prompt) === "slow") { release = () => { say(child, "slow done"); settle(child); }; return; }
    if (prompt.includes("hold on")) return;
    say(child, "ready");
    settle(child);
  });
  // Pids no process can have, so stats can report them and any signal is harmless.
  const spawn = (command: string, args: string[], options: object) => {
    const child = fake.spawn(command, args, options) as unknown as FakeChild & { pid?: number };
    child.pid = 2_000_000_000 + fake.children.length;
    return child as never;
  };
  const retired: string[] = [];
  const moderator = host(spawn, { hibernateAfterMs: 0, getMaxSubagents: () => 2, discussionRetire: (key) => { retired.push(key); } });
  await moderator.delegate.execute("d", { tasks: [{ task: "slow" }, { task: "quick" }] }, undefined, undefined, quiet);
  const [slow, quick] = moderator.registry.records();
  await until(moderator.registry, () => quick!.run.state === "hibernated");
  assert.deepEqual(moderator.registry.stats(), { retained: 2, live: 1, hibernated: 1, recovery: 0, recoveryLimit: 4, pids: [2_000_000_001] });
  release();
  await until(moderator.registry, () => slow!.run.state === "hibernated");
  assert.deepEqual(moderator.registry.stats(), { retained: 2, live: 0, hibernated: 2, recovery: 0, recoveryLimit: 4, pids: [] });
  const denied = await moderator.delegate.execute("d2", { tasks: [{ task: "third" }] }, undefined, undefined, quiet);
  assert.equal(denied.isError, true);
  assert.match(denied.content[0]!.text, /pool is full: 2\/2/, "hibernated agents still count toward the pool");
  assert.equal(fake.calls.length, 2);

  const dirs = fake.calls.map((call) => dirname(sessionFileOf(call.args)!));
  assert.equal((await moderator.registry.stop(slow!.key))?.state, "stopped");
  assert.equal(fake.calls.length, 2, "stopping a hibernated agent needs no process");
  assert.equal(existsSync(dirs[0]!), false, "stop removes its private session");
  assert.deepEqual(retired, [slow!.key]);

  assert.equal(moderator.registry.resume(quick!.key, "hold on"), true);
  assert.equal(moderator.registry.stats().live, 1);
  assert.deepEqual(moderator.registry.clear(), [], "nothing needed preserving");
  await until(moderator.registry, () => !existsSync(dirs[1]!) && moderator.registry.retained() === 0);
  assert.notEqual(fake.children[2]!.exitCode, null, "session clear terminates the live child");
  assert.deepEqual(moderator.registry.stats(), { retained: 0, live: 0, hibernated: 0, recovery: 0, recoveryLimit: 4, pids: [] });
  assert.deepEqual(retired.sort(), [quick!.key, slow!.key].sort());
});

test("a hibernated worktree worker keeps its private edits, resumes in the same workspace, and stop reconciles it", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-hibernate-worktree-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
    writeFileSync(join(root, "a.ts"), "before\n"); git("add", "a.ts"); git("commit", "-m", "initial");
    const fake = fakeSpawn((child, prompt) => {
      const workspace = fake.calls[0]!.cwd!;
      writeFileSync(join(workspace, "a.ts"), prompt.includes("Task:") ? "from child\n" : readFileSync(join(workspace, "a.ts"), "utf8") + "after resume\n");
      say(child, "edited");
      settle(child);
    });
    const tracker = new ChangeTracker(() => root);
    const moderator = host(fake.spawn, { hibernateAfterMs: 0, changes: () => tracker });
    await moderator.delegate.execute("d", { mode: "worktree", tasks: [{ task: "edit a", name: "writer" }] }, undefined, undefined, {
      ...quiet, cwd: root, sessionManager: { getSessionFile: () => "/tmp/pi-parent.jsonl" }
    });
    const [record] = moderator.registry.records();
    await until(moderator.registry, () => record!.run.state === "hibernated");
    const first = fake.calls[0]!;
    assert.ok(first.args.includes("--fork"));
    assert.equal(readFileSync(join(first.cwd!, "a.ts"), "utf8"), "from child\n", "the private edit survives the process");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "before\n", "the parent stays untouched");

    assert.equal(moderator.registry.resume(record!.key, "refine"), true);
    await until(moderator.registry, () => record!.run.state === "hibernated" && fake.calls.length === 2);
    const second = fake.calls[1]!;
    assert.equal(second.cwd, first.cwd, "the relaunch works in the same worktree");
    assert.equal(second.env.PI_JAR_WORKTREE_ROOT, first.env.PI_JAR_WORKTREE_ROOT);
    assert.ok(second.args.includes("--session") && !second.args.includes("--fork"), "it continues its own session instead of re-forking the parent");

    const report = await moderator.registry.stop(record!.key);
    assert.deepEqual(report?.applied, ["a.ts"]);
    assert.equal(fake.calls.length, 2, "reconciliation needs no live process");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "from child\nafter resume\n");
    assert.equal(tracker.count(), 1);
    assert.equal(existsSync(first.cwd!), false, "stop removes the worktree");
    assert.equal(existsSync(dirname(sessionFileOf(first.args)!)), false, "and the private session");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
