import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childToolAllowlist, worktreeToolViolation } from "../src/subagent-tools.ts";

test("child capability parsing fails closed and excludes recursive delegation", () => {
  assert.equal(childToolAllowlist(undefined), undefined);
  assert.deepEqual([...childToolAllowlist('["read","web_search"]')!], ["read", "web_search"]);
  for (const value of ["bad json", '{}', '["jar_delegate"]', '["jar_subagent"]', '["jar_democracy"]', '["read",42]'])
    assert.equal(childToolAllowlist(value)!.size, 0);
});

test("every multi-file target, default and alternate path is guarded", () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-jar-tool-guard-"));
  const root = join(temp, "workspace"); mkdirSync(root);
  try {
    const check = (args: unknown) => worktreeToolViolation(root, root, "multi_file_edit", args);
    assert.equal(check({ path: "one.ts", edits: [{ oldText: "a" }, { path: "two.ts" }] }), undefined);
    assert.equal(check({ file_path: "one.ts", edits: [{ file_path: "two.ts" }] }), undefined);
    for (const args of [
      { path: "one.ts", edits: [{ path: "../outside.ts" }] },
      { path: "one.ts", edits: [{ path: "safe.ts", file_path: "../outside.ts" }] },
      { path: "../outside.ts", edits: [{ path: "safe.ts" }] },
      { edits: [{}] }, { edits: [] }, { edits: [null] }
    ]) assert.ok(check(args), JSON.stringify(args));
    symlinkSync(temp, join(root, "escape"));
    assert.ok(check({ path: "one.ts", edits: [{ path: "escape/outside.ts" }] }));
    assert.ok(worktreeToolViolation(root, temp, "edit", { path: "workspace/one.ts" }));
    assert.ok(worktreeToolViolation(root, root, "bash", { command: "true" }));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
