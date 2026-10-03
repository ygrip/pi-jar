import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { ChangeTracker } from "../src/changes.ts";
import {
  applyDelegateWorktree,
  createDelegateWorktree,
  disposeDelegateWorktree,
  normalizeWorkspacePath,
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

test("delegate worktree snapshots dirty and untracked parent state, then applies only child deltas", async () => {
  const { root } = initRepo();
  let worktree: Awaited<ReturnType<typeof createDelegateWorktree>> | undefined;
  try {
    writeFileSync(join(root, "tracked.txt"), "parent dirty\n");
    writeFileSync(join(root, "untracked.txt"), "parent untracked\n");
    worktree = await createDelegateWorktree(root);

    assert.equal(readFileSync(join(worktree.root, "tracked.txt"), "utf8"), "parent dirty\n");
    assert.equal(readFileSync(join(worktree.root, "untracked.txt"), "utf8"), "parent untracked\n");
    assert.deepEqual(await worktreeChangedFiles(worktree), [], "the private baseline absorbs the parent's starting dirty state");

    writeFileSync(join(worktree.root, "tracked.txt"), "child edit\n");
    writeFileSync(join(worktree.root, "new.txt"), "new child file\n");
    assert.deepEqual(await worktreeChangedFiles(worktree), ["new.txt", "tracked.txt"]);

    const tracker = new ChangeTracker(() => root);
    const files = await worktreeChangedFiles(worktree);
    assert.deepEqual(await applyDelegateWorktree(worktree, root, files, tracker), files);
    assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "child edit\n");
    assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "new child file\n");
    assert.equal(readFileSync(join(root, "untracked.txt"), "utf8"), "parent untracked\n");
    assert.equal(tracker.count(), 2);
    await disposeDelegateWorktree(worktree);
    assert.equal(existsSync(worktree.root), false);
    worktree = undefined;
  } finally {
    if (worktree) await disposeDelegateWorktree(worktree);
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded concurrent snapshots preserve every nested file's bytes and executable mode", async () => {
  const { root } = initRepo();
  let worktree: Awaited<ReturnType<typeof createDelegateWorktree>> | undefined;
  try {
    const files: string[] = [];
    for (let index = 0; index < 37; index++) {
      const directory = `group-${index % 3}`;
      mkdirSync(join(root, directory), { recursive: true });
      const path = `${directory}/item-${index}.txt`;
      files.push(path);
      writeFileSync(join(root, path), `snapshot ${index}\n`);
    }
    chmodSync(join(root, files[15]!), 0o755);
    worktree = await createDelegateWorktree(root);
    for (const [index, path] of files.entries()) assert.equal(readFileSync(join(worktree.root, path), "utf8"), `snapshot ${index}\n`);
    assert.equal(lstatSync(join(worktree.root, files[15]!)).mode & 0o777, 0o755);
    assert.deepEqual(await worktreeChangedFiles(worktree), []);
  } finally {
    if (worktree) await disposeDelegateWorktree(worktree);
    rmSync(root, { recursive: true, force: true });
  }
});

test("delegate worktree refuses to overwrite a parent file that changed after the snapshot", async () => {
  const { root } = initRepo();
  const worktree = await createDelegateWorktree(root);
  try {
    writeFileSync(join(worktree.root, "tracked.txt"), "child edit\n");
    writeFileSync(join(root, "tracked.txt"), "external edit\n");
    await assert.rejects(applyDelegateWorktree(worktree, root, ["tracked.txt"]), /parent changed since delegation started/);
    assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "external edit\n");
  } finally {
    await disposeDelegateWorktree(worktree);
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
    symlinkSync(join(outside, "missing"), join(root, "dangling"));
    assert.equal(workspacePathAllowed(root, root, "dangling"), false);
    assert.equal(workspacePathAllowed(root, root, "dangling/child"), false);
    assert.equal(workspacePathAllowed(root, root, "~/escape.txt"), false);
    assert.equal(workspacePathAllowed(root, root, "@" + join(outside, "secret.txt")), false);
    assert.equal(workspacePathAllowed(root, root, pathToFileURL(join(outside, "secret.txt")).href), false);
    assert.equal(normalizeWorkspacePath(root, "~/file"), join(homedir(), "file"));
    assert.equal(workspacePathAllowed(root, root, "@~/escape.txt"), false);
    for (const space of ["\u00a0", "\u2000", "\u200a", "\u202f", "\u205f", "\u3000"]) {
      assert.equal(normalizeWorkspacePath(root, `@a${space}b`), join(root, "a b"));
    }
    assert.equal(workspacePathAllowed(root, root, "@inside.txt"), true);
    assert.equal(workspacePathAllowed(root, root, pathToFileURL(join(root, "inside.txt")).href), true);
    mkdirSync(join(root, ".git"));
    symlinkSync(join(root, ".git"), join(root, "metadata"));
    for (const path of [".git", ".git/config", "metadata/config", "nested/.git/config"]) {
      assert.equal(workspacePathAllowed(root, root, path), false, path);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});


test("delegate worktree refuses changes that cannot enter /diff review", async () => {
  const { root, git } = initRepo();
  const binary = join(root, "binary.dat");
  writeFileSync(binary, Buffer.from([1, 0, 2, 3]));
  git("add", "binary.dat");
  git("commit", "-m", "binary");
  const worktree = await createDelegateWorktree(root);
  try {
    writeFileSync(join(worktree.root, "binary.dat"), Buffer.from([4, 0, 5, 6]));
    const tracker = new ChangeTracker(() => root);
    await assert.rejects(applyDelegateWorktree(worktree, root, ["binary.dat"], tracker), /cannot add changed file to \/diff review/);
    assert.deepEqual(readFileSync(binary), Buffer.from([1, 0, 2, 3]));
    assert.equal(tracker.count(), 0);
  } finally {
    await disposeDelegateWorktree(worktree);
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot preserves raw CRLF bytes and never invokes filters or hooks", async () => {
  const { root, git } = initRepo();
  let worktree: Awaited<ReturnType<typeof createDelegateWorktree>> | undefined;
  try {
    writeFileSync(join(root, ".gitattributes"), "*.txt text eol=lf filter=unsafe\n");
    git("add", ".gitattributes");
    git("commit", "-m", "attributes");
    const marker = join(root, "executed");
    git("config", "filter.unsafe.clean", `touch '${marker}'; cat`);
    git("config", "filter.unsafe.smudge", `touch '${marker}'; cat`);
    writeFileSync(join(root, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(root, ".git", "hooks", "post-checkout"), 0o755);
    writeFileSync(join(root, "tracked.txt"), "parent\r\n");
    worktree = await createDelegateWorktree(root);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(readFileSync(join(worktree.root, "tracked.txt")), Buffer.from("parent\r\n"));
    assert.deepEqual(await worktreeChangedFiles(worktree), []);
    writeFileSync(join(worktree.root, "tracked.txt"), "child\r\n");
    assert.deepEqual(await worktreeChangedFiles(worktree), ["tracked.txt"]);
    await applyDelegateWorktree(worktree, root, ["tracked.txt"], new ChangeTracker(() => root));
    assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "child\r\n");
    assert.equal(existsSync(marker), false);
  } finally {
    if (worktree) await disposeDelegateWorktree(worktree);
    rmSync(root, { recursive: true, force: true });
  }
});

test("finalization rejects ancestor symlinks, dangling leaf links and Git metadata", async () => {
  const { root } = initRepo();
  const outside = mkdtempSync(join(tmpdir(), "pi-jar-finalize-outside-"));
  const worktree = await createDelegateWorktree(root);
  try {
    writeFileSync(join(outside, "new.txt"), "outside\n");
    mkdirSync(join(worktree.root, "parent-link"));
    writeFileSync(join(worktree.root, "parent-link", "new.txt"), "child\n");
    symlinkSync(outside, join(root, "parent-link"), "dir");
    await assert.rejects(applyDelegateWorktree(worktree, root, ["parent-link/new.txt"]), /unsafe parent/);
    symlinkSync(outside, join(worktree.root, "source-link"), "dir");
    await assert.rejects(applyDelegateWorktree(worktree, root, ["source-link/new.txt"]), /unsafe changed path/);
    symlinkSync(join(outside, "absent"), join(worktree.root, "dangling"));
    await assert.rejects(applyDelegateWorktree(worktree, root, ["dangling"]), /symlink change/);
    symlinkSync(join(outside, "absent"), join(root, "parent-dangling"));
    writeFileSync(join(worktree.root, "parent-dangling"), "child\n");
    await assert.rejects(applyDelegateWorktree(worktree, root, ["parent-dangling"]), /unsafe parent/);
    await assert.rejects(applyDelegateWorktree(worktree, root, [".git"]), /unsafe parent/);
    await assert.rejects(applyDelegateWorktree(worktree, root, [".git/config"]), /unsafe parent/);
    assert.equal(readFileSync(join(outside, "new.txt"), "utf8"), "outside\n");
    assert.equal(existsSync(join(outside, "absent")), false);
  } finally {
    await disposeDelegateWorktree(worktree);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("new binary and text-to-binary output cannot bypass review capture", async () => {
  const { root } = initRepo();
  const worktree = await createDelegateWorktree(root);
  try {
    for (const rel of ["new.bin", "tracked.txt"]) {
      writeFileSync(join(worktree.root, rel), Buffer.from([65, 0, 66]));
      const tracker = new ChangeTracker(() => root);
      await assert.rejects(applyDelegateWorktree(worktree, root, [rel], tracker), /cannot add changed file/);
      assert.equal(tracker.count(), 0);
      await assert.rejects(applyDelegateWorktree(worktree, root, [rel]), /cannot add changed file/);
    }
    assert.equal(existsSync(join(root, "new.bin")), false);
    assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "base\n");
  } finally {
    await disposeDelegateWorktree(worktree);
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot preserves nested tracked files and dangling symlink bytes", async () => {
  const { root, git } = initRepo();
  let worktree: Awaited<ReturnType<typeof createDelegateWorktree>> | undefined;
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "tracked.txt"), "nested base\n");
    symlinkSync("missing-relative-target", join(root, "link"));
    git("add", "nested/tracked.txt", "link");
    git("commit", "-m", "nested and link");
    worktree = await createDelegateWorktree(root);
    assert.deepEqual(await worktreeChangedFiles(worktree), []);
    writeFileSync(join(worktree.root, "nested", "tracked.txt"), "nested child\n");
    assert.deepEqual(await worktreeChangedFiles(worktree), ["nested/tracked.txt"]);
    await applyDelegateWorktree(worktree, root, ["nested/tracked.txt"]);
    assert.equal(readFileSync(join(root, "nested", "tracked.txt"), "utf8"), "nested child\n");
  } finally {
    if (worktree) await disposeDelegateWorktree(worktree);
    rmSync(root, { recursive: true, force: true });
  }
});

test("binary deletions with late NUL bytes cannot bypass review", async () => {
  const { root } = initRepo();
  const bytes = Buffer.alloc(9000, 65);
  bytes[8500] = 0;
  writeFileSync(join(root, "late.bin"), bytes);
  const worktree = await createDelegateWorktree(root);
  try {
    rmSync(join(worktree.root, "late.bin"));
    await assert.rejects(applyDelegateWorktree(worktree, root, ["late.bin"], new ChangeTracker(() => root)), /cannot add changed file/);
    assert.deepEqual(readFileSync(join(root, "late.bin")), bytes);
  } finally {
    await disposeDelegateWorktree(worktree);
    rmSync(root, { recursive: true, force: true });
  }
});

test("legitimate executable files retain their mode when applied", async () => {
  const { root } = initRepo();
  const worktree = await createDelegateWorktree(root);
  try {
    writeFileSync(join(worktree.root, "script.sh"), "#!/bin/sh\necho child\n");
    chmodSync(join(worktree.root, "script.sh"), 0o755);
    await applyDelegateWorktree(worktree, root, ["script.sh"], new ChangeTracker(() => root));
    if (process.platform !== "win32") assert.equal(lstatSync(join(root, "script.sh")).mode & 0o777, 0o755);
  } finally {
    await disposeDelegateWorktree(worktree);
    rmSync(root, { recursive: true, force: true });
  }
});

test("delegate worktree treats executable-bit drift as a parent conflict", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable bits are not meaningful on Windows");
    return;
  }
  const { root, git } = initRepo();
  const script = join(root, "script.sh");
  writeFileSync(script, "#!/bin/sh\necho base\n");
  chmodSync(script, 0o755);
  git("add", "script.sh");
  git("commit", "-m", "script");
  const worktree = await createDelegateWorktree(root);
  try {
    writeFileSync(join(worktree.root, "script.sh"), "#!/bin/sh\necho child\n");
    chmodSync(script, 0o644);
    await assert.rejects(applyDelegateWorktree(worktree, root, ["script.sh"]), /parent changed since delegation started/);
    assert.equal(readFileSync(script, "utf8"), "#!/bin/sh\necho base\n");
  } finally {
    await disposeDelegateWorktree(worktree);
    rmSync(root, { recursive: true, force: true });
  }
});
