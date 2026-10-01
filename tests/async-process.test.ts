import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runProcess } from "../src/async-process.ts";
import { createDelegateWorktree, GIT_EXECUTABLE_ENV } from "../src/delegate-worktree.ts";

const node = process.execPath;

test("async process explicitly closes empty and non-empty stdin", async () => {
  const empty = await runProcess(node, ["-e", "let n=0;process.stdin.on('data',x=>n+=x.length);process.stdin.on('end',()=>process.stdout.write(String(n)))"], { input: Buffer.alloc(0) });
  const payload = await runProcess(node, ["-e", "let n=0;process.stdin.on('data',x=>n+=x.length);process.stdin.on('end',()=>process.stdout.write(String(n)))"], { input: Buffer.from("abc") });
  assert.equal(empty.toString(), "0");
  assert.equal(payload.toString(), "3");
});

test("timeout kills a hung process tree while the event loop remains responsive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jar-process-test-"));
  const pidFile = join(dir, "grandchild.pid");
  const script = "const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000)";
  let heartbeat = 0;
  const pulse = setInterval(() => heartbeat++, 5);
  try {
    await assert.rejects(runProcess(node, ["-e", script, pidFile], { timeoutMs: 300, maxOutputBytes: 1024 }), /timed out/);
    assert.ok(heartbeat > 0, "timers must continue while subprocess is running");
    assert.ok(existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise(resolve => setTimeout(resolve, 50));
    if (process.platform !== "win32") assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    clearInterval(pulse);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("abort terminates a long-running process and reports cancellation", async () => {
  const controller = new AbortController();
  const pending = runProcess(node, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal, timeoutMs: 5000 });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /aborted/i);
});

test("non-zero exit preserves stderr in the error", async () => {
  await assert.rejects(runProcess(node, ["-e", "console.error('expected failure');process.exit(7)"]), /expected failure/);
});

test("missing executable and pre-aborted requests reject without crashing", async () => {
  await assert.rejects(runProcess(join(tmpdir(), "pi-jar-nonexistent-command"), []), /ENOENT/);
  const controller = new AbortController();
  controller.abort(new Error("cancelled before spawn"));
  await assert.rejects(runProcess(node, ["-e", "process.exit(99)"], { signal: controller.signal }), /cancelled before spawn/);
});

test("output limits terminate a flooding child", async () => {
  await assert.rejects(runProcess(node, ["-e", "setInterval(()=>process.stdout.write('x'.repeat(8192)),1)"], {
    maxOutputBytes: 1024, timeoutMs: 2000
  }), /exceeded 1024 output bytes/);
});

test("early stdin closure consumes EPIPE and preserves the non-zero exit", async () => {
  await assert.rejects(runProcess(node, ["-e", "console.error('rejected input');process.exit(9)"], {
    input: Buffer.alloc(8 * 1024 * 1024), timeoutMs: 2000
  }), /exited 9: rejected input/);
});

test("large stdin uses backpressure and delivers EOF", async () => {
  const size = 2 * 1024 * 1024;
  const output = await runProcess(node, ["-e", "let n=0;process.stdin.on('data',x=>n+=x.length);process.stdin.on('end',()=>console.log(n))"], {
    input: Buffer.alloc(size), timeoutMs: 2000
  });
  assert.equal(output.toString().trim(), String(size));
});

test("a descendant holding pipes after the leader exits cannot hang completion", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jar-orphan-test-"));
  const file = join(dir, "pid");
  let pid: number | undefined;
  try {
    const output = await runProcess(node, ["-e", "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});require('node:fs').writeFileSync(process.argv[1],String(c.pid));console.log('leader done');process.exit(0)", file], { timeoutMs: 2000 });
    pid = Number(readFileSync(file, "utf8"));
    assert.equal(output.toString().trim(), "leader done");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configured Git can be cancelled while hung without blocking UI timers", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jar-fake-git-"));
  const executable = join(dir, "git");
  const old = process.env[GIT_EXECUTABLE_ENV];
  const controller = new AbortController();
  let heartbeat = 0;
  const pulse = setInterval(() => heartbeat++, 5);
  writeFileSync(executable, `#!${node}\nsetInterval(()=>{},1000);\n`, { mode: 0o755 });
  process.env[GIT_EXECUTABLE_ENV] = executable;
  try {
    const pending = createDelegateWorktree(dir, controller.signal);
    setTimeout(() => controller.abort(new Error("cancel hung git")), 150);
    await assert.rejects(pending, /cancel hung git/);
    assert.ok(heartbeat >= 3, "the main event loop keeps accepting timers during Git startup");
    await assert.rejects(runProcess(executable, ["hash-object", "--stdin"], { input: Buffer.alloc(0), timeoutMs: 150 }), /timed out/);
  } finally {
    controller.abort();
    clearInterval(pulse);
    if (old === undefined) delete process.env[GIT_EXECUTABLE_ENV]; else process.env[GIT_EXECUTABLE_ENV] = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
