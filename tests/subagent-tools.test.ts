import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childSkillReadRoots, childToolAllowlist, loadSubagentConfig, skillReadRoots, SUBAGENT_CONFIG_FILE, worktreeToolViolation } from "../src/subagent-tools.ts";

test("granted skill documents and references are read-only and symlink-confined", () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-jar-skill-guard-"));
  const root = join(temp, "workspace");
  const skill = join(temp, "approved");
  mkdirSync(root); mkdirSync(skill);
  try {
    const instructions = join(skill, "SKILL.md");
    writeFileSync(instructions, "read reference.md");
    writeFileSync(join(skill, "reference.md"), "trusted reference");
    writeFileSync(join(temp, "secret.md"), "outside");
    symlinkSync(join(temp, "secret.md"), join(skill, "escape.md"));
    const roots = childSkillReadRoots(JSON.stringify(skillReadRoots([instructions])));
    const check = (name: string, path: string) => worktreeToolViolation(root, root, name, { path }, roots);
    assert.equal(check("read", instructions), undefined);
    assert.equal(check("read", join(skill, "reference.md")), undefined);
    for (const path of [join(temp, "secret.md"), join(skill, "escape.md"), join(skill, "..", "secret.md")])
      assert.ok(check("read", path));
    for (const name of ["edit", "write", "grep", "find", "ls"])
      assert.ok(check(name, instructions), name);
    assert.ok(worktreeToolViolation(root, root, "read", { path: instructions }), "no grant means no access");
    assert.ok(worktreeToolViolation(root, root, "bash", { command: "true" }, roots));
    const standalone = join(temp, "standalone.md"); writeFileSync(standalone, "one file");
    const exact = skillReadRoots([standalone]);
    assert.equal(worktreeToolViolation(root, root, "read", { path: standalone }, exact), undefined);
    assert.ok(worktreeToolViolation(root, root, "read", { path: join(temp, "secret.md") }, exact));
    const linked = join(temp, "linked"); mkdirSync(linked);
    symlinkSync(join(temp, "secret.md"), join(linked, "SKILL.md"));
    const linkedRoots = skillReadRoots([join(linked, "SKILL.md")]);
    assert.equal(worktreeToolViolation(root, root, "read", { path: join(linked, "SKILL.md") }, linkedRoots), undefined);
    assert.ok(worktreeToolViolation(root, root, "read", { path: standalone }, linkedRoots), "a linked instruction grants only that file, not its target's parent");
    for (const invalid of [undefined, "bad json", '{}', '["relative"]', '[42]'])
      assert.deepEqual(childSkillReadRoots(invalid), []);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

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
