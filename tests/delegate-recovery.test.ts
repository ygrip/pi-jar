import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { DelegateRegistry, registerDelegate, RECOVERY_LIMIT } from "../src/delegate.ts";
import { ChangeTracker } from "../src/changes.ts";
import { emit, fakeSpawn, say, settle, taskOf, until, type FakeChild } from "./fake-rpc.ts";

function setup(registry: DelegateRegistry, fake: ReturnType<typeof fakeSpawn>, options: object = {}) {
  let tool: any;
  registerDelegate({ registerTool: (value: any) => { if (value.name === "jar_delegate") tool = value; } } as never,
    { resolve: () => undefined } as never, registry, { spawnProcess: fake.spawn as never, ...options });
  return tool;
}
const quiet = { cwd: "/repo", hasUI: false };
interface Tool { name: string; execute(id: string, params: object, signal: undefined, onUpdate: undefined, ctx: object): Promise<{ isError?: boolean; content: Array<{ text: string }> }> }
/** jar_delegate and jar_subagent without an event bus, so control actions return their final result. */
function tools(registry: DelegateRegistry, fake: ReturnType<typeof fakeSpawn>) {
  const registered = new Map<string, Tool>();
  registerDelegate({ registerTool: (value: Tool) => { registered.set(value.name, value); } } as never,
    { resolve: () => undefined } as never, registry, { spawnProcess: fake.spawn as never });
  return { delegate: registered.get("jar_delegate")!, control: registered.get("jar_subagent")! };
}
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-recovery-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  writeFileSync(join(root, "a.ts"), "baseline\n"); git("add", "."); git("commit", "-m", "baseline");
  return root;
}
const worktreeContext = (root: string) => ({ cwd: root, hasUI: false, sessionManager: { getSessionFile: () => "/tmp/parent.jsonl" } });
/** The worktree a fake child runs in. */
const cwdOf = (fake: ReturnType<typeof fakeSpawn>, child: FakeChild) => fake.calls[fake.children.indexOf(child)]!.cwd!;

test("stop waits for close, not just process exit, before completing its handoff", async () => {
  const registry = new DelegateRegistry();
  const fake = fakeSpawn((child) => { say(child, "finished"); settle(child); });
  await setup(registry, fake).execute("d", { tasks: [{ task: "inspect" }] }, undefined, undefined, quiet);
  const child = fake.children[0]!;
  child.stdin.removeAllListeners("finish");
  child.stdin.on("finish", () => child.exit(0, undefined, false));
  let complete = false;
  const stopped = registry.stop(registry.records()[0]!.key).then((value) => { complete = true; return value; });
  await tick();
  assert.equal(child.exitCode, 0);
  assert.equal(complete, false);
  child.emit("close", 0);
  assert.equal((await stopped)?.state, "stopped");
});

test("queued records replace reservations before reentrant launch notifications", async () => {
  const registry = new DelegateRegistry();
  const fake = fakeSpawn((child) => settle(child));
  const tool = setup(registry, fake, { getMaxSubagents: () => 2 });
  let second: Promise<any> | undefined;
  registry.subscribe(() => {
    if (!second && registry.records().length === 1) {
      // Set sentinel first; reserve/add can synchronously notify again.
      second = Promise.resolve();
      second = tool.execute("second", { tasks: [{ task: "two" }] }, undefined, undefined, quiet);
    }
  });
  await tool.execute("first", { tasks: [{ task: "one" }] }, undefined, undefined, quiet);
  assert.equal((await second)?.isError, undefined);
  assert.equal(fake.calls.length, 2);
  registry.clear();
});

test("conflicted worktrees remain recoverable past history trim and finalization can be retried", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-recovery-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  try {
    git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
    writeFileSync(join(root, "a.ts"), "baseline\n"); git("add", "."); git("commit", "-m", "baseline");
    const registry = new DelegateRegistry();
    const fake = fakeSpawn((child, _prompt, args) => {
      if (args.includes("--fork")) writeFileSync(join(fake.calls[0]!.cwd!, "a.ts"), "worker\n");
      say(child, "ready"); settle(child);
    });
    const tracker = new ChangeTracker(() => root);
    const tool = setup(registry, fake, { changes: () => tracker });
    const ctx = { cwd: root, hasUI: false, sessionManager: { getSessionFile: () => "/tmp/parent.jsonl" } };
    await tool.execute("worker", { mode: "worktree", tasks: [{ task: "implement" }] }, undefined, undefined, ctx);
    const key = registry.records()[0]!.key;
    const workspace = registry.get(key)!.run.workspace!;
    writeFileSync(join(root, "a.ts"), "parent drift\n");
    assert.equal((await registry.stop(key))?.state, "failed");
    for (let i = 0; i < 9; i++) {
      const result = await tool.execute("scout", { write: true, tasks: [{ task: "one-shot" }] }, undefined, undefined, ctx);
      assert.equal(result.isError, undefined);
    }
    assert.ok(registry.get(key), "private recovery workspace is not evicted with report history");
    assert.equal(registry.records().filter((record) => !record.run.workspace).length, 8, "normal finished history keeps its full cap beside recovery state");
    writeFileSync(join(root, "a.ts"), "baseline\n");
    assert.deepEqual((await registry.stop(key))?.applied, ["a.ts"]);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "worker\n");
    assert.equal(existsSync(workspace), false);
    registry.clear();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a conflicted worktree becomes a lightweight recovery record that peek and stats describe", { timeout: 60_000 }, async () => {
  const root = repository();
  try {
    const registry = new DelegateRegistry();
    const fake = fakeSpawn((child) => {
      writeFileSync(join(cwdOf(fake, child), "a.ts"), "worker\n");
      for (let index = 0; index < 40; index++) {
        emit(child, { type: "tool_execution_start", toolCallId: `r${index}`, toolName: "read", args: { path: `src/f${index}.ts` } });
        emit(child, { type: "tool_execution_end", toolCallId: `r${index}`, toolName: "read", result: { content: [{ type: "text", text: "x".repeat(3000) }] }, isError: false });
      }
      emit(child, { type: "tool_execution_start", toolCallId: "e", toolName: "edit", args: { path: "a.ts" } });
      emit(child, { type: "tool_execution_end", toolCallId: "e", toolName: "edit", result: { content: [] }, isError: false });
      say(child, "worker report " + "y".repeat(5000));
      settle(child);
    });
    const { delegate, control } = tools(registry, fake);
    await delegate.execute("w", { mode: "worktree", tasks: [{ task: "implement", name: "writer" }] }, undefined, undefined, worktreeContext(root));
    const record = registry.records()[0]!;
    assert.ok(record.run.transcript.length > 40);
    writeFileSync(join(root, "a.ts"), "parent drift\n");
    const report = await registry.stop(record.key);
    assert.equal(report?.state, "failed");
    assert.match(report!.error!, /changes not applied/);

    const { run } = record;
    assert.equal(run.transcript.length, 1, "the bulky transcript is released");
    const [note] = run.transcript;
    assert.ok(note?.kind === "note" && note.text.includes(run.workspace!), "a single note explains where the changes are");
    assert.deepEqual([run.live, run.filesRead], ["", []]);
    assert.ok(run.output.length <= 1200, "only a bounded report excerpt remains");
    assert.deepEqual(run.filesEdited, ["a.ts"], "the changed-file summary is kept");
    assert.equal(readFileSync(join(run.workspace!, "a.ts"), "utf8"), "worker\n", "the unresolved changes stay on disk");
    assert.deepEqual(registry.stats(), { retained: 0, live: 0, hibernated: 0, recovery: 1, recoveryLimit: RECOVERY_LIMIT, pids: [] });
    assert.deepEqual(registry.recoveries().map((item) => [item.key, item.workspace, item.changed]), [[record.key, run.workspace, ["a.ts"]]]);
    const peek = (await control.execute("p", { action: "peek" }, undefined, undefined, worktreeContext(root))).content[0]!.text;
    assert.ok(peek.startsWith(`${record.key} · writer · failed · unresolved recovery`), peek);
    assert.ok(peek.includes(`workspace: ${run.workspace}`) && peek.includes("changed: a.ts") && /error: changes not applied/.test(peek), peek);

    writeFileSync(join(root, "a.ts"), "baseline\n");
    assert.deepEqual((await registry.stop(record.key))?.applied, ["a.ts"], "stop still retries reconciliation");
    assert.equal(registry.stats().recovery, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the recovery bound refuses new worktree agents without touching existing workspaces, and discard frees a slot", { timeout: 120_000 }, async () => {
  const root = repository();
  let kept: string[] = [];
  try {
    const registry = new DelegateRegistry();
    const fake = fakeSpawn((child, prompt, args) => {
      if (args.includes("--fork")) writeFileSync(join(cwdOf(fake, child), "a.ts"), `${taskOf(prompt)}\n`);
      say(child, "done");
      settle(child);
    });
    const { delegate, control } = tools(registry, fake);
    const ctx = worktreeContext(root);
    await delegate.execute("w", { mode: "worktree", tasks: [1, 2, 3, 4].map((n) => ({ task: `w${n}` })) }, undefined, undefined, ctx);
    writeFileSync(join(root, "a.ts"), "parent drift\n");
    for (const record of registry.records()) assert.equal((await registry.stop(record.key))?.state, "failed");
    const recoveries = registry.recoveries();
    assert.equal(recoveries.length, RECOVERY_LIMIT);
    const launched = fake.calls.length;
    const refused = await delegate.execute("w5", { mode: "worktree", tasks: [{ task: "w5" }] }, undefined, undefined, ctx);
    assert.equal(refused.isError, true);
    const text = refused.content[0]!.text;
    assert.match(text, /Worktree recovery limit: 4 unresolved recovery workspaces and 0 active worktree agents leave no room for 1 more/);
    for (const item of recoveries) assert.ok(text.includes(item.key) && text.includes(item.workspace), "the refusal lists what to resolve");
    assert.equal(fake.calls.length, launched, "nothing was launched");
    assert.ok(recoveries.every((item) => existsSync(item.workspace)), "no recovery workspace was deleted to make room");

    assert.equal((await delegate.execute("s", { tasks: [{ task: "scout" }] }, undefined, undefined, ctx)).isError, undefined, "recovery state holds no pool slot");
    const scout = registry.records().find((record) => record.run.mode === "scout")!;
    assert.equal((await control.execute("x", { action: "discard", agent: scout.key }, undefined, undefined, ctx)).isError, true, "discard only applies to recovery records");
    const discarded = await control.execute("x", { action: "discard", agent: recoveries[0]!.key }, undefined, undefined, ctx);
    assert.match(discarded.content[0]!.text, /removed .* without applying its changes \(a\.ts\)/);
    assert.equal(existsSync(recoveries[0]!.workspace), false, "discard removes the worktree");
    assert.equal(registry.get(recoveries[0]!.key), undefined, "and unregisters the record");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "parent drift\n", "discard never applies");
    assert.equal(registry.stats().recovery, 3);

    assert.equal((await delegate.execute("w6", { mode: "worktree", tasks: [{ task: "w6" }] }, undefined, undefined, ctx)).isError, undefined, "a freed slot admits a new worktree agent");
    const full = await delegate.execute("w7", { mode: "worktree", tasks: [{ task: "w7" }] }, undefined, undefined, ctx);
    assert.match(full.content[0]!.text, /3 unresolved recovery workspaces and 1 active worktree agent leave no room/,
      "an active worktree agent reserves its recovery slot, so the bound holds even if it fails later");
    await until(registry, () => !!registry.records().find((item) => item.run.task === "w6")?.run.workspace);
    const workspaces = registry.records().map((item) => item.run.workspace).filter((item): item is string => !!item);
    kept = registry.clear();
    assert.deepEqual(kept.sort(), workspaces.sort());
  } finally {
    for (const workspace of kept) rmSync(dirname(workspace), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("session clear preserves unresolved and still-running worktrees, reporting their paths", { timeout: 60_000 }, async () => {
  const root = repository();
  let kept: string[] = [];
  try {
    const registry = new DelegateRegistry();
    const fake = fakeSpawn((child, prompt) => {
      writeFileSync(join(cwdOf(fake, child), "a.ts"), `${taskOf(prompt)}\n`);
      emit(child, { type: "tool_execution_start", toolCallId: "e", toolName: "edit", args: { path: "a.ts" } });
      emit(child, { type: "tool_execution_end", toolCallId: "e", toolName: "edit", result: { content: [] }, isError: false });
      say(child, "progress");
      if (taskOf(prompt) === "crash") { child.exit(1); return; }
      settle(child);
    });
    const { delegate } = tools(registry, fake);
    await delegate.execute("w", { mode: "worktree", tasks: [{ task: "crash", name: "crasher" }, { task: "keep", name: "keeper" }] }, undefined, undefined, worktreeContext(root));
    const crashed = registry.resolve("crasher")!;
    const live = registry.resolve("keeper")!;
    await until(registry, () => crashed.run.transcript.length === 1);
    assert.equal(crashed.run.state, "failed");
    assert.deepEqual(registry.recoveries().map((item) => [item.key, item.changed]), [[crashed.key, ["a.ts"]]], "a worker that died on its own leaves recovery state");
    const crashedWorkspace = crashed.run.workspace!;
    const liveWorkspace = live.run.workspace!;

    kept = registry.clear();
    assert.deepEqual(kept.sort(), [crashedWorkspace, liveWorkspace].sort(), "clear reports every workspace that might hold edits");
    assert.deepEqual(registry.records(), []);
    await until(registry, () => registry.retained() === 0);
    await tick();
    assert.equal(readFileSync(join(crashedWorkspace, "a.ts"), "utf8"), "crash\n");
    assert.equal(readFileSync(join(liveWorkspace, "a.ts"), "utf8"), "keep\n", "active user changes survive the session change");
  } finally {
    for (const workspace of kept) rmSync(dirname(workspace), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
