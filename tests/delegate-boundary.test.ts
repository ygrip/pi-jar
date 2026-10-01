import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyDelegateWorktree, createDelegateWorktree, disposeDelegateWorktree, workspacePathAllowed } from "../src/delegate-worktree.ts";

test("read guard checks Pi's alternate apostrophe, NFD and AM/PM filename fallbacks", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-read-boundary-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-jar-read-outside-"));
  try {
    writeFileSync(join(outside, "secret"), "private");
    for (const [requested, alternate] of [["secret's.txt", "secret’s.txt"], ["capture 1 PM.png", "capture 1\u202fPM.png"],
      ["école's.txt", "école’s.txt".normalize("NFD")]]) {
      symlinkSync(join(outside, "secret"), join(root, alternate));
      assert.equal(workspacePathAllowed(root, root, requested), true, "plain requested spelling alone appears safe");
      assert.equal(workspacePathAllowed(root, root, requested, true), false, "actual read fallback must not escape");
    }
    writeFileSync(join(root, "safe.txt"), "safe");
    assert.equal(workspacePathAllowed(root, root, "safe.txt", true), true);
    symlinkSync(outside, join(root, "file:"));
    assert.equal(workspacePathAllowed(root, root, "file:" + join(root, "secret.txt"), true), false,
      "single-slash file: is a literal Pi path, not a URL that can hide a symlink escape");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("later-file preparation failures do not partially overwrite earlier parent files", { skip: process.getuid?.() === 0 ? "root bypasses directory permissions" : false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-transaction-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  let worktree: Awaited<ReturnType<typeof createDelegateWorktree>> | undefined;
  try {
    git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
    writeFileSync(join(root, "a.txt"), "original\n"); git("add", "."); git("commit", "-m", "baseline");
    worktree = await createDelegateWorktree(root);
    writeFileSync(join(worktree.root, "a.txt"), "changed\n");
    mkdirSync(join(worktree.root, "z")); writeFileSync(join(worktree.root, "z/new.txt"), "new\n");
    mkdirSync(join(root, "z")); chmodSync(join(root, "z"), 0o555);
    await assert.rejects(applyDelegateWorktree(worktree!, root, ["a.txt", "z/new.txt"]), /EACCES|EPERM/);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "original\n");
    assert.equal(existsSync(join(root, "z/new.txt")), false);
    assert.equal(readdirSync(root).some((name) => name.startsWith(".pi-jar-apply-")), false);
    chmodSync(join(root, "z"), 0o755);
    assert.deepEqual(await applyDelegateWorktree(worktree, root, ["a.txt", "z/new.txt"]), ["a.txt", "z/new.txt"]);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "changed\n");
  } finally {
    if (existsSync(join(root, "z"))) chmodSync(join(root, "z"), 0o755);
    if (worktree) await disposeDelegateWorktree(worktree);
    rmSync(root, { recursive: true, force: true });
  }
});
