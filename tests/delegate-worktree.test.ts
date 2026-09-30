import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChangeTracker } from "../src/changes.ts";
import {
  applyDelegateWorktree,
  createDelegateWorktree,
  disposeDelegateWorktree,
  workspacePathAllowed,
  worktreeChangedFiles
} from "../src/delegate-worktree.ts";

const initRepo = () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-worktree-test-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(root, "tracked.txt"), "base\n");
  git("add", "tracked.txt");
  git("commit", "-m", "initial");
  return { root, git };
};

test("delegate worktree snapshots dirty and untracked parent state, then applies only child deltas", () => {
  const { root } = initRepo();
  let worktree: ReturnType<typeof createDelegateWorktree> | undefined;
  try {
    writeFileSync(join(root, "tracked.txt"), "parent dirty\n");
    writeFileSync(join(root, "untracked.txt"), "parent untracked\n");
    worktree = createDelegateWorktree(root);

    assert.equal(readFileSync(join(worktree.root, "tracked.txt"), "utf8"), "parent dirty\n");
    assert.equal(readFileSync(join(worktree.root, "untracked.txt"), "utf8"), "parent untracked\n");
    assert.deepEqual(worktreeChangedFiles(worktree), [], "the private baseline absorbs the parent's starting dirty state");

    writeFileSync(join(worktree.root, "tracked.txt"), "child edit\n");
    writeFileSync(join(worktree.root, "new.txt"), "new child file\n");
    assert.deepEqual(worktreeChangedFiles(worktree), ["new.txt", "tracked.txt"]);

    const tracker = new ChangeTracker(() => root);
    const files = worktreeChangedFiles(worktree);
    assert.deepEqual(applyDelegateWorktree(worktree, root, files, tracker), files);
    assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "child edit\n");
    assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "new child file\n");
    assert.equal(readFileSync(join(root, "untracked.txt"), "utf8"), "parent untracked\n");
    assert.equal(tracker.count(), 2);
    disposeDelegateWorktree(worktree);
    assert.equal(existsSync(worktree.root), false);
    worktree = undefined;
  } finally {
    if (worktree) disposeDelegateWorktree(worktree);
    rmSync(root, { recursive: true, force: true });
  }
});

test("delegate worktree refuses to overwrite a parent file that changed after the snapshot", () => {
  const { root } = initRepo();
  const worktree = createDelegateWorktree(root);
  try {
    writeFileSync(join(worktree.root, "tracked.txt"), "child edit\n");
    writeFileSync(join(root, "tracked.txt"), "external edit\n");
    assert.throws(() => applyDelegateWorktree(worktree, root, ["tracked.txt"]), /parent changed since delegation started/);
    assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "external edit\n");
  } finally {
    disposeDelegateWorktree(worktree);
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path guard rejects lexical and symlink escapes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-path-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-jar-outside-"));
  try {
    writeFileSync(join(root, "inside.txt"), "ok");
    assert.equal(workspacePathAllowed(root, root, "inside.txt"), true);
    assert.equal(workspacePathAllowed(root, root, "../escape.txt"), false);
    assert.equal(workspacePathAllowed(root, root, join(outside, "secret.txt")), false);

    try { symlinkSync(outside, join(root, "escape-link"), "dir"); }
    catch (error) {
      t.skip("symlink creation is unavailable: " + String(error));
      return;
    }
    assert.equal(workspacePathAllowed(root, root, "escape-link/new.txt"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
