import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childToolAllowlist, loadSubagentConfig, SUBAGENT_CONFIG_FILE, worktreeToolViolation } from "../src/subagent-tools.ts";

test("child capability parsing fails closed and excludes recursive delegation", () => {
  assert.equal(childToolAllowlist(undefined), undefined);
  assert.deepEqual([...childToolAllowlist('["read","web_search"]')!], ["read", "web_search"]);
  for (const value of ["bad json", '{}', '["jar_delegate"]', '["jar_subagent"]', '["jar_council"]', '["read",42]'])
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

test("subagent config: missing is empty, +/- rules, specs vs paths, malformed or recursive fails loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jar-subcfg-"));
  const empty = { allow: [], deny: [] };
  try {
    assert.deepEqual(loadSubagentConfig(dir), { tools: empty, extensions: empty, skills: empty });
    writeFileSync(join(dir, SUBAGENT_CONFIG_FILE), JSON.stringify({
      tools: [" mom_search ", "+mom_get", "-punakawan_connector_call", "+x", "-x"],
      extensions: ["+npm:@g/auth", "~/a.ts", "-/b.ts", "rel/c.ts", "-pi-web-access", "git:github.com/o/r@v1"],
      skills: ["+mom", "-lavish"]
    }));
    assert.deepEqual(loadSubagentConfig(dir, "/home/u"), {
      tools: { allow: ["mom_search", "mom_get"], deny: ["punakawan_connector_call", "x"] },
      extensions: { allow: ["npm:@g/auth", "/home/u/a.ts", join(dir, "rel/c.ts"), "git:github.com/o/r@v1"], deny: ["/b.ts", "pi-web-access"] },
      skills: { allow: ["mom"], deny: ["lavish"] }
    });
    for (const bad of ["nope", "[]", JSON.stringify({ tools: ["jar_delegate"] }), JSON.stringify({ tools: "mom_search" }), JSON.stringify({ extensions: ["+"] }), JSON.stringify({ skills: [1] })]) {
      writeFileSync(join(dir, SUBAGENT_CONFIG_FILE), bad);
      assert.throws(() => loadSubagentConfig(dir), new RegExp(SUBAGENT_CONFIG_FILE));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
