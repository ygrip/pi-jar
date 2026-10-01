import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { ShellManager } from "../src/shells.ts";

function fixture() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
  let kills = 0;
  child.kill = () => { kills++; child.emit("close", null, "SIGTERM"); };
  const manager = new ShellManager(() => {}, (() => child) as never);
  return { child, manager, kills: () => kills };
}

test("readiness acknowledgement does not suppress later exit; draining is not complete", async () => {
  const { child, manager } = fixture();
  try {
    const job = manager.start({ command: "check", cwd: tmpdir(), watch: "ready", purpose: "task" });
    child.stdout.emit("data", "ready\n");
    assert.equal(manager.pendingNotifications(), 1);
    manager.acknowledge([job.id]); assert.equal(manager.pendingNotifications(), 0);
    child.emit("exit", 1, null);
    assert.equal(await manager.wait([job.id], 0), false);
    assert.equal(manager.verificationPending().length, 1);
    assert.equal(manager.get(job.id)!.exitCode, 1);
    child.emit("close", 1, null);
    assert.equal(await manager.wait([job.id], 0), true);
    assert.equal(manager.verificationPending().length, 0);
    const events = manager.takeNotifications();
    assert.equal(events.length, 1); assert.equal(events[0]!.kind, "exit"); assert.equal(events[0]!.job.exitCode, 1);
  } finally { manager.dispose(); }
});

test("bounded waits time out or cancel without killing the job", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, kills } = fixture();
  try {
    const job = manager.start({ command: "check", cwd: tmpdir() });
    const waiting = manager.wait([job.id], 25);
    t.mock.timers.tick(25); assert.equal(await waiting, false);
    const abort = new AbortController();
    const cancelled = manager.wait([job.id], 1000, abort.signal);
    abort.abort(new Error("cancelled"));
    await assert.rejects(cancelled, /cancelled/);
    assert.equal(kills(), 0); assert.equal(manager.get(job.id)!.status, "running");
    await assert.rejects(manager.wait(["missing"], 0), /no shell/);
    await assert.rejects(manager.wait([job.id], 30001), /waitMs/);
  } finally { manager.dispose(); }
});
