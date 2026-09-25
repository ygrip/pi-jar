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
    assert.match(started.content[0].text, /woken when it matches or exits/);
    await waitFor(() => manager.output("s1").includes("hi"));
    assert.match((await run({ action: "output", id: "s1" })).content[0].text, /hi/);
    assert.match((await run({ action: "list" })).content[0].text, /s1 · hello · running/);
    assert.match((await run({ action: "kill", id: "s1" })).content[0].text, /Stopping s1/);
    assert.match((await run({ action: "output", id: "zz" })).content[0].text, /output failed: no shell zz/);
    assert.match(tool.promptGuidelines.join(" "), /Do not poll/);
  } finally { manager.dispose(); }
});
