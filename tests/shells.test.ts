import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { MAX_RUNNING_SHELLS, registerShells, shellEventMessage, ShellManager, type ShellEvent } from "../src/shells.ts";

const waitFor = async (check: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("shell output is captured, a watch pattern fires once, and exit is reported", async () => {
  const events: ShellEvent[] = [];
  const manager = new ShellManager((event) => events.push(event));
  try {
    const job = manager.start({ command: "printf 'boot\\n\\033[32mready on 3000\\033[0m\\nready again\\n'; exit 3", cwd: tmpdir(), name: "server", watch: "ready on \\d+" });
    assert.equal(job.status, "running");
    await waitFor(() => events.some((event) => event.kind === "exit"));
    assert.deepEqual(events.map((event) => event.kind), ["match", "exit"]);
    assert.equal(events[0]!.job.matched, "ready on 3000", "ANSI is stripped before matching");
    const done = manager.get(job.id)!;
    assert.equal(done.status, "exited");
    assert.equal(done.exitCode, 3);
    assert.deepEqual(manager.output(job.id, 2), ["ready on 3000", "ready again"]);
    const message = shellEventMessage(events[1]!);
    assert.match(message, /Background shell s1 \(server\) exited 3/);
    assert.match(message, /ready again/);
    assert.equal(manager.running(), 0);
  } finally { manager.dispose(); }
});

test("kill stops the process group and invalid input is rejected", async () => {
  const events: ShellEvent[] = [];
  const manager = new ShellManager((event) => events.push(event));
  try {
    const job = manager.start({ command: "sleep 30 & sleep 30; wait", cwd: tmpdir() });
    assert.equal(manager.running(), 1);
    assert.equal(manager.kill(job.id), true);
    await waitFor(() => events.some((event) => event.kind === "exit"));
    assert.equal(manager.get(job.id)!.status, "killed");
    assert.equal(manager.kill(job.id), false, "already stopped");
    assert.throws(() => manager.start({ command: "  ", cwd: tmpdir() }), /command is required/);
    assert.throws(() => manager.start({ command: "true", cwd: tmpdir(), watch: "(" }), /invalid watch pattern/);
    assert.throws(() => manager.output("nope"), /no shell nope/);
  } finally { manager.dispose(); }
});

test("running shells are capped", () => {
  const fake = (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number; kill(): void };
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 1; child.kill = () => {};
    return child;
  }) as never;
  const manager = new ShellManager(() => {}, fake);
  for (let index = 0; index < MAX_RUNNING_SHELLS; index++) manager.start({ command: "sleep 1", cwd: tmpdir() });
  assert.throws(() => manager.start({ command: "sleep 1", cwd: tmpdir() }), /at most 8 shells/);
});

test("jar_shell tool starts, lists, reads and kills", async () => {
  let tool: any;
  const manager = new ShellManager(() => {});
  try {
    registerShells({ registerTool(definition: unknown) { tool = definition; } } as never, () => manager);
    const run = (params: object) => tool.execute("t", params, undefined, undefined, { cwd: tmpdir() });
    const started = await run({ action: "start", command: "echo hi; sleep 30", name: "hello", watch: "hi" });
    assert.match(started.content[0].text, /Started s1 · hello · running/);
    assert.equal("lines" in started.details.jobs[0], false, "tool details never duplicate retained shell logs");
    assert.match(started.content[0].text, /next safe turn boundary.*use wait now/);
    await waitFor(() => manager.output("s1").includes("hi"));
    assert.match((await run({ action: "output", id: "s1" })).content[0].text, /hi/);
    assert.match((await run({ action: "list" })).content[0].text, /s1 · hello · running/);
    assert.match((await run({ action: "kill", id: "s1" })).content[0].text, /Stopping s1/);
    assert.match((await run({ action: "output", id: "zz" })).content[0].text, /output failed: no shell zz/);
  } finally { manager.dispose(); }
});

test("shell exit with inherited pipes still emits exactly one terminal event", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  child.exitCode = 0;
  const events: ShellEvent[] = [];
  const manager = new ShellManager(event => events.push(event), (() => child) as never);
  const job = manager.start({ command: "test", cwd: tmpdir() });
  child.stdout.emit("data", "partial output");
  child.emit("exit", 0, null);
  assert.equal(manager.running(), 0);
  t.mock.timers.tick(250);
  assert.deepEqual(events.map(event => event.kind), ["exit"]);
  assert.deepEqual(manager.output(job.id), ["partial output"]);
  child.emit("close", 0, null);
  assert.equal(events.length, 1, "late close must not duplicate the exit notification");
});

test("kill is bounded when a shell ignores signals and never emits close", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  const killed: string[] = [];
  child.kill = (signal: string) => killed.push(signal);
  const events: ShellEvent[] = [];
  const manager = new ShellManager(event => events.push(event), (() => child) as never);
  const job = manager.start({ command: "test", cwd: tmpdir() });
  assert.equal(manager.kill(job.id), true);
  assert.deepEqual(killed, ["SIGTERM"]);
  t.mock.timers.tick(3000);
  assert.ok(killed.includes("SIGKILL"));
  assert.equal(events.length, 1);
  assert.equal(manager.get(job.id)!.status, "killed");
  assert.ok(manager.get(job.id)!.endedAt);
});

test("shell spawn errors followed by close notify only once", () => {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {};
  const events: ShellEvent[] = [];
  const manager = new ShellManager(event => events.push(event), (() => child) as never);
  const job = manager.start({ command: "test", cwd: tmpdir() });
  child.emit("error", new Error("spawn failed"));
  child.emit("close", -2, null);
  assert.equal(events.length, 1);
  assert.equal(manager.get(job.id)!.status, "failed");
});

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; signals: string[]; kill(signal: string): void };
/** Fake children without a pid, so signalProcessTree falls back to child.kill (never a real group). */
function fakeShells(options?: ConstructorParameters<typeof ShellManager>[2]) {
  const children: FakeChild[] = [];
  const spawnFake = (() => {
    const child: FakeChild = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null, signals: [] as string[],
      kill(signal: string) { child.signals.push(signal); } });
    children.push(child);
    return child;
  }) as never;
  return { children, manager: new ShellManager(() => {}, spawnFake, options) };
}
const emitLines = (child: FakeChild, prefix: string, count: number, width: number, from = 0) =>
  child.stdout.emit("data", Array.from({ length: count }, (_, index) => `${prefix}${from + index}:`.padEnd(width, ".")).join("\n") + "\n");
const charsOf = (manager: ShellManager, id: string) => manager.get(id)!.lines.reduce((sum, line) => sum + line.length, 0);

test("the global output budget trims oldest finished output first and keeps live tails", () => {
  const { children, manager } = fakeShells({ budgetChars: 100_000, liveTailChars: 5_000 });
  try {
    const done = manager.start({ command: "build", cwd: tmpdir() });
    emitLines(children[0], "a", 60, 1000);
    children[0].emit("close", 0, null);
    const live = manager.start({ command: "dev", cwd: tmpdir(), purpose: "service" });
    emitLines(children[1], "b", 45, 1000);
    assert.ok(manager.get(done.id)!.dropped > 0, "finished output is trimmed first");
    assert.equal(manager.get(live.id)!.dropped, 0, "live output is untouched while finished output can pay");
    emitLines(children[1], "b", 60, 1000, 45);
    const other = manager.start({ command: "watch", cwd: tmpdir() });
    emitLines(children[2], "c", 80, 1000);
    const stats = manager.stats();
    assert.ok(stats.retainedChars <= 100_000, `retained ${stats.retainedChars} exceeds the global budget`);
    assert.equal(stats.retainedChars, [done, live, other].reduce((sum, job) => sum + charsOf(manager, job.id), 0), "incremental accounting matches retained lines");
    const finished = charsOf(manager, done.id);
    assert.ok(finished > 0 && finished <= 32 * 1024, "a finished job keeps its compact tail before live tails are cut");
    for (const job of [live, other]) assert.ok(charsOf(manager, job.id) >= 5_000, `${job.id} keeps its protected tail`);
    assert.match(manager.output(live.id, 1)[0]!, /^b104:/, "the newest live line survives");
    assert.match(manager.output(other.id, 1)[0]!, /^c79:/);
    assert.deepEqual([live, other].map(job => manager.get(job.id)!.status), ["running", "running"], "log pressure never ends a process");
    assert.deepEqual(children.slice(1).map(child => child.signals), [[], []]);
  } finally { manager.dispose(); }
});

test("finished jobs compact once their result is surfaced", () => {
  const { children, manager } = fakeShells();
  try {
    const job = manager.start({ command: "npm test", cwd: tmpdir(), watch: "READY", purpose: "task" });
    children[0].stdout.emit("data", "READY\n");
    emitLines(children[0], "t", 1000, 100);
    children[0].emit("close", 2, null);
    assert.equal(manager.get(job.id)!.lines.length, 1001, "unsurfaced results keep their full bounded log");
    assert.deepEqual(manager.takeNotifications().map(event => event.kind), ["exit"]);
    const compacted = manager.get(job.id)!;
    assert.ok(compacted.lines.length <= 400 && charsOf(manager, job.id) <= 32 * 1024);
    assert.equal(compacted.dropped, 1001 - compacted.lines.length);
    assert.match(compacted.lines.at(-1)!, /^t999:/);
    assert.deepEqual([compacted.exitCode, compacted.command, compacted.matched, compacted.status], [2, "npm test", "READY", "exited"]);
    assert.ok(compacted.endedAt! >= compacted.startedAt);
    assert.equal(manager.stats().retainedChars, charsOf(manager, job.id));

    const quiet = manager.start({ command: "lint", cwd: tmpdir(), notify: false });
    emitLines(children[1], "q", 1000, 100);
    manager.acknowledge([quiet.id]);
    assert.equal(manager.get(quiet.id)!.lines.length, 1000, "acknowledging a running job does not compact it");
    children[1].emit("close", 0, null);
    assert.equal(manager.get(quiet.id)!.lines.length, 1000);
    manager.acknowledge([quiet.id]);
    assert.ok(charsOf(manager, quiet.id) <= 32 * 1024, "reading a finished result compacts it");
  } finally { manager.dispose(); }
});

type ToolResult = { content: Array<{ text: string }> };
/** The registered jar_shell tool as a text-returning call. */
function shellTool(manager: ShellManager) {
  let execute: ((id: string, params: object, signal: AbortSignal | undefined, update: undefined, ctx: { cwd: string }) => Promise<ToolResult>) | undefined;
  registerShells({ registerTool(definition: { execute: typeof execute }) { execute = definition.execute; } } as never, () => manager);
  return async (params: object, signal?: AbortSignal) => (await execute!("t", params, signal, undefined, { cwd: tmpdir() })).content[0]!.text;
}

test("jar_shell start with waitMs returns a quick job's exit code in one call and never re-notifies", async () => {
  const manager = new ShellManager(() => {});
  try {
    const run = shellTool(manager);
    assert.match(await run({ action: "start", command: "printf 'one\\ntwo\\n'; exit 3", waitMs: 5000 }), /^s1 · .* · exited 3 · .*\none\ntwo$/);
    assert.equal(manager.pendingNotifications(), 0, "the surfaced exit is acknowledged");
    assert.deepEqual(manager.takeNotifications(), []);
    assert.match(await run({ action: "output", id: "s1" }), /no new output/);
  } finally { manager.dispose(); }
});

test("start with waitMs reports partial output while running; output returns only new lines unless all", async () => {
  const { children, manager } = fakeShells();
  try {
    const run = shellTool(manager);
    const starting = run({ action: "start", command: "dev", waitMs: 30 });
    children[0].stdout.emit("data", "booting\n");
    assert.match(await starting, /Started s1 · dev · running.*Still running after 30ms.*\nbooting$/s);
    assert.equal(manager.get("s1")!.status, "running");
    assert.match(await run({ action: "output", id: "s1" }), /^s1 · dev · running · \d+s · no new output/);
    children[0].stdout.emit("data", "compiled\nlistening\n");
    assert.match(await run({ action: "output", id: "s1" }), /^s1 · dev · running · \d+s\ncompiled\nlistening$/);
    assert.match(await run({ action: "output", id: "s1", all: true }), /\nbooting\ncompiled\nlistening$/);
    assert.match(await run({ action: "output", id: "s1" }), /no new output/);

    const abort = new AbortController();
    const cancelled = run({ action: "start", command: "slow", waitMs: 30000 }, abort.signal);
    abort.abort(new Error("esc"));
    assert.match(await cancelled, /Started s2 · slow · running.*Wait cancelled; the job keeps running/);
    assert.equal(manager.get("s2")!.status, "running", "cancelling the wait never kills the job");
  } finally { manager.dispose(); }
});

test("read cursors survive trimming, cap new lines and show a growing partial line once", () => {
  const { children, manager } = fakeShells();
  try {
    const job = manager.start({ command: "build", cwd: tmpdir() });
    emitLines(children[0], "a", 1000, 10);
    assert.deepEqual({ ...manager.read(job.id, 10), lines: undefined }, { lines: undefined, missed: 0, skipped: 990 });
    emitLines(children[0], "b", 2200, 10);
    const behind = manager.read(job.id, 400);
    const { dropped } = manager.get(job.id)!;
    assert.ok(dropped > 1000, "the trim reached lines the cursor had not read");
    assert.deepEqual([behind.missed, behind.skipped, behind.lines.length], [dropped - 1000, 3200 - dropped - 400, 400], "trimmed unread lines are counted, not replayed");
    assert.match(behind.lines.at(-1)!, /^b2199:/);
    assert.deepEqual(manager.read(job.id), { lines: [], missed: 0, skipped: 0 });
    children[0].stdout.emit("data", "prog");
    assert.deepEqual(manager.read(job.id).lines, ["prog"]);
    assert.deepEqual(manager.read(job.id).lines, [], "an unchanged partial line is not repeated");
    children[0].stdout.emit("data", "ress\ndone\n");
    assert.deepEqual(manager.read(job.id).lines, ["progress", "done"]);
    assert.deepEqual(manager.read(job.id, 2, true).lines, ["progress", "done"], "all returns the trailing window");
    assert.deepEqual(manager.output(job.id, 1), ["done"], "display reads never move the cursor");
  } finally { manager.dispose(); }
});

test("pruning keeps killed-in-grace jobs managed and dispose reclaims draining trees", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { children, manager } = fakeShells();
  const stubborn = manager.start({ command: "ignore TERM", cwd: tmpdir() });
  manager.kill(stubborn.id);
  for (let index = 0; index < 25; index++) { manager.start({ command: "true", cwd: tmpdir() }); children.at(-1)!.emit("close", 0, null); }
  assert.ok(manager.get(stubborn.id), "a live process is never forgotten by finished-job pruning");
  assert.equal(manager.stats().live, 1);
  const draining = manager.start({ command: "spawns", cwd: tmpdir() });
  children.at(-1)!.emit("exit", 0, null);
  assert.equal(manager.get(draining.id)!.complete, false);
  manager.dispose();
  assert.deepEqual(children.at(-1)!.signals, ["SIGKILL"], "dispose reclaims a draining tree immediately");
  t.mock.timers.tick(3000);
  assert.deepEqual(children[0]!.signals.slice(0, 2), ["SIGTERM", "SIGKILL"], "the kill grace still ends a stubborn process");
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("stats report live processes, purpose and retained chars; dispose leaves nothing running", async () => {
  const manager = new ShellManager(() => {});
  const service = manager.start({ command: "sleep 30 & echo $!; wait", cwd: tmpdir(), name: "dev", watch: "^\\d+$" });
  const task = manager.start({ command: "printf 'one\\ntwo\\n'", cwd: tmpdir() });
  await waitFor(() => manager.get(task.id)!.complete === true && manager.output(service.id).length > 0);
  const descendant = Number(manager.output(service.id, 1)[0]);
  const stats = manager.stats();
  assert.deepEqual({ live: stats.live, finished: stats.finished, services: stats.services, budget: stats.budgetChars, oldest: stats.oldestLiveStartedAt },
    { live: 1, finished: 1, services: 1, budget: 4 * 1024 * 1024, oldest: service.startedAt });
  assert.deepEqual(stats.jobs, [
    { id: service.id, name: "dev", status: "running", purpose: "service", pid: service.pid, chars: String(descendant).length },
    { id: task.id, name: task.name, status: "exited", purpose: "task", chars: 6 }
  ]);
  assert.equal(stats.retainedChars, 6 + String(descendant).length);
  assert.ok(alive(service.pid!) && alive(descendant));
  manager.dispose();
  await waitFor(() => !alive(service.pid!) && !alive(descendant));
  assert.deepEqual([manager.stats().live, manager.stats().retainedChars], [0, 0]);
});
