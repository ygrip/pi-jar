import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionName, normalizeSource, planExtensions, planSkills, skillName, type CatalogResource } from "../src/subagent-resources.ts";

test("source normalization and short names", () => {
  assert.equal(normalizeSource("npm:@g/auth@1.2.0"), "npm:@g/auth");
  assert.equal(normalizeSource("npm:pi-web-access"), "npm:pi-web-access");
  assert.equal(normalizeSource("https://github.com/o/r.git"), "git:github.com/o/r");
  assert.equal(normalizeSource("git:github.com/o/r@v1"), "git:github.com/o/r");
  assert.equal(normalizeSource("git@github.com:o/r.git"), "git:github.com/o/r");
  assert.equal(extensionName({ path: "/n/@g/auth/src/index.ts", enabled: true, source: "npm:@g/auth" }), "@g/auth");
  assert.equal(extensionName({ path: "/g/o/r/x.ts", enabled: true, source: "git:github.com/o/r" }), "r");
  assert.equal(extensionName({ path: "/a/extensions/claude-otel/index.ts", enabled: true, source: "auto" }), "claude-otel");
  assert.equal(extensionName({ path: "/a/extensions/figma-lazy.ts", enabled: true, source: "auto" }), "figma-lazy");
  assert.equal(extensionName({ path: "builtin:mcp", enabled: false, source: "builtin" }), "mcp");
  assert.equal(skillName({ path: "/s/mom/SKILL.md", enabled: true, source: "auto" }), "mom");
});

test("extension plans: npm short names resolve to installed paths; disallows build an explicit list without pi-jar", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-res-"));
  try {
    mkdirSync(join(root, "pi-jar"));
    writeFileSync(join(root, "pi-jar", "package.json"), JSON.stringify({ name: "pi-jar" }));
    const ext = (path: string, source: string, enabled = true, packageRoot?: string): CatalogResource => ({ path, enabled, source, ...(packageRoot ? { packageRoot } : {}) });
    const catalog = { skills: [], extensions: [
      ext("/n/@g/auth/src/index.ts", "npm:@g/auth"), ext("/n/web/index.js", "npm:pi-web-access"),
      ext(join(root, "pi-jar", "extensions/index.ts"), "npm:pi-jar", true, join(root, "pi-jar")),
      ext("/a/extensions/figma-lazy.ts", "auto"), ext("builtin:mcp", "builtin", false), ext("builtin:codemode", "builtin")
    ] };
    const own = "/repo/extensions/index.ts";
    const allowOnly = planExtensions({ allow: ["npm:@g/auth@2", "npm:not-installed", "mcp"], deny: [] }, catalog, own);
    assert.deepEqual(allowOnly, { lean: ["/n/@g/auth/src/index.ts", "npm:not-installed", "builtin:mcp"], add: ["npm:not-installed", "builtin:mcp"] });
    const denied = planExtensions({ allow: ["npm:@g/auth"], deny: ["pi-web-access", "/a/extensions"] }, catalog, own);
    assert.deepEqual(denied.explicit, ["/n/@g/auth/src/index.ts", "builtin:codemode"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill plans: defaults, config allow/deny, exact and subtractive task lists", () => {
  const skill = (name: string, enabled = true): CatalogResource => ({ path: `/s/${name}/SKILL.md`, enabled, source: "auto" });
  const catalog = { extensions: [], skills: [skill("a"), skill("b"), skill("c", false)] };
  const none = { allow: [], deny: [] };
  assert.equal(planSkills(none, undefined, catalog, "cfg"), undefined);
  assert.deepEqual(planSkills({ allow: ["c"], deny: ["a"] }, undefined, catalog, "cfg"), ["/s/b/SKILL.md", "/s/c/SKILL.md"]);
  assert.deepEqual(planSkills(none, { allow: [], deny: ["b"] }, catalog, "cfg"), ["/s/a/SKILL.md"]);
  assert.deepEqual(planSkills(none, { allow: ["c", "/abs/x/SKILL.md"], deny: [] }, catalog, "cfg"), ["/s/c/SKILL.md", "/abs/x/SKILL.md"]);
  assert.deepEqual(planSkills(none, none, catalog, "cfg"), []);
  assert.throws(() => planSkills({ allow: [], deny: ["a"] }, { allow: ["a"], deny: [] }, catalog, "cfg"), /disallowed by cfg: a/);
  assert.throws(() => planSkills({ allow: ["zzz"], deny: [] }, undefined, catalog, "cfg"), /cfg: unknown skill "zzz"/);
  assert.deepEqual(planSkills({ allow: [], deny: ["gone"] }, undefined, catalog, "cfg"), ["/s/a/SKILL.md", "/s/b/SKILL.md"], "stale config denies are no-ops");
  const twins = { extensions: [], skills: [{ path: "/x/d/SKILL.md", enabled: false, source: "auto" }, { path: "/y/d/SKILL.md", enabled: false, source: "auto" }] };
  assert.deepEqual(planSkills({ allow: ["d"], deny: [] }, undefined, twins, "cfg"), ["/x/d/SKILL.md"], "a name loads one skill, never colliding copies");
});
