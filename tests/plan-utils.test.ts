import assert from "node:assert/strict";
import test from "node:test";
import { extractPlanSteps, isSafePlanCommand, planTextFromSteps, parsePlanSections, validatePlanDocument, extractApproachSteps, planSlug } from "../src/plan-utils.ts";
import { planEntries } from "../src/plan-view.ts";

test("plan shell allowlist permits read-only inspection and pipelines", () => {
  for (const command of [
    "git status",
    "git diff --stat",
    "rg TODO src | head -20",
    "find src -type f",
    "npm view typescript version"
  ]) assert.equal(isSafePlanCommand(command), true, command);
});

test("plan shell allowlist blocks mutation and ambiguous shell syntax", () => {
  for (const command of [
    "rm -rf build",
    "git checkout main",
    "git config user.name unsafe",
    "git stash push",
    "git reset --hard",
    "git fetch origin",
    "env FOO=bar git status",
    "git branch -D old",
    "find . -delete",
    "find . -exec touch /tmp/pwned {} \\;",
    "find . -type f -fprint /tmp/files",
    "sort -o /tmp/out input.txt",
    "git log --output=/tmp/log",
    "git diff --ext-diff",
    "git grep --open-files-in-pager='touch /tmp/pwned' TODO",
    "git grep --open-files TODO",
    "git grep --open TODO",
    "git grep --op=vim TODO",
    "git grep --ope=vim TODO",
    "git grep '--op=vim' TODO",
    "git grep --o\\p=vim TODO",
    "git grep $GIT_FLAGS TODO",
    "git grep -Ovim TODO",
    "git grep -inO TODO",
    "git grep -C3O TODO",
    "git -c core.pager=evil grep TODO",
    "git -C . grep -Ovim TODO",
    "git --no-pager grep --op=vim TODO",
    "git -P grep -O TODO",
    "git diff --out=/tmp/pwned",
    "git diff --ext",
    "git show --tex",
    "rg --pre 'touch /tmp/pwned' TODO .",
    "sort --compress-program=touch README.md",
    "date --set 2030-01-01",
    "diff --output=/tmp/diff a b",
    "echo hello > file.txt",
    "cat package.json | tee /tmp/file",
    "rg TODO src | xargs rm",
    "git status; touch /tmp/file",
    "git status || touch /tmp/file",
    "git status\ntouch /tmp/file",
    "git status $(touch /tmp/file)",
    "git status `touch /tmp/file`",
    "cat package.json && npm install",
    "npm install lodash",
    "sed -i s/a/b/ file.txt"
  ]) assert.equal(isSafePlanCommand(command), false, command);
});

test("plan extraction reads a numbered Plan section and normalizes it", () => {
  const steps = extractPlanSteps(`Analysis first.

## Plan
1. Inspect the command lifecycle
2) Add the read-only gate
3. Verify branch restoration

Notes:
Do not implement yet.`);
  assert.deepEqual(steps, [
    "Inspect the command lifecycle",
    "Add the read-only gate",
    "Verify branch restoration"
  ]);
  assert.equal(planTextFromSteps(steps), [
    "1. Inspect the command lifecycle",
    "2. Add the read-only gate",
    "3. Verify branch restoration"
  ].join("\n"));
});

test("plan sections ignore headings inside fenced code and keep bodies", () => {
  const text = "# Title\n\nIntro\n\n## Context\nWhy\n```md\n# not a heading\n```\n## Approach\n### 1. First\nDo it\n### 2. Second\n";
  const sections = parsePlanSections(text);
  assert.deepEqual(sections.map((section) => [section.level, section.title]), [[1, "Title"], [2, "Context"], [2, "Approach"], [3, "1. First"], [3, "2. Second"]]);
  assert.match(sections[1]!.body, /# not a heading/);
  assert.deepEqual(extractApproachSteps(text), ["First", "Second"]);
});

test("plan validation reports missing sections, empty sections and step-less approaches", () => {
  const ok = "# T\n## Context\nx\n## Approach\n1. **Do** thing\n## Critical files\n- a\n## Verification\n- test\n";
  assert.deepEqual(validatePlanDocument(ok), { ok: true, title: "T", missing: [], problems: [] });
  assert.deepEqual(extractApproachSteps(ok), ["Do thing"]);
  const bad = validatePlanDocument("## Context\n\n## Approach\nprose only\n");
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing, ["Critical files", "Verification"]);
  assert.ok(bad.problems.some((problem) => /Title/.test(problem)));
  assert.ok(bad.problems.some((problem) => /Context.*empty/.test(problem)));
  assert.ok(bad.problems.some((problem) => /numbered steps/.test(problem)));
  assert.deepEqual(extractApproachSteps("Plan:\n1. Legacy step"), ["Legacy step"], "falls back to Plan: lists");
  assert.equal(planSlug("Add Hello ✨ Command!"), "add-hello-command");
  assert.equal(planSlug("✨"), "plan");
});

test("plan view table of contents promotes a lone H1 to the title and keeps a preamble", () => {
  const view = planEntries("# Title\nintro line\n## Context\nx\n### Detail\ny\n## Approach\n1. a\n");
  assert.equal(view.title, "Title");
  assert.deepEqual(view.entries.map((entry) => [entry.title, entry.level]), [["Overview", 2], ["Context", 2], ["Detail", 3], ["Approach", 2]]);
  assert.deepEqual([view.entries[1]!.start, view.entries[1]!.end], [2, 6], "a section spans its subsections");
  assert.deepEqual(planEntries("no headings").entries.map((entry) => entry.title), ["Plan"]);
});
