import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { DelegateRegistry, registerDelegate } from "../src/delegate.ts";
import { ChangeTracker } from "../src/changes.ts";
import { fakeSpawn, say, settle } from "./fake-rpc.ts";

function setup(registry: DelegateRegistry, fake: ReturnType<typeof fakeSpawn>, options: object = {}) {
  let tool: any;
  registerDelegate({ registerTool: (value: any) => { if (value.name === "jar_delegate") tool = value; } } as never,
    { resolve: () => undefined } as never, registry, { spawnProcess: fake.spawn as never, ...options });
  return tool;
}
const quiet = { cwd: "/repo", hasUI: false };

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
    writeFileSync(join(root, "a.ts"), "baseline\n");
    assert.deepEqual((await registry.stop(key))?.applied, ["a.ts"]);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "worker\n");
    assert.equal(existsSync(workspace), false);
    registry.clear();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
