import assert from "node:assert/strict";
import test from "node:test";
import { extractPlanSteps, isSafePlanCommand, planTextFromSteps } from "../src/plan-utils.ts";

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
    "git branch -D old",
    "find . -delete",
    "find . -type f -fprint /tmp/files",
    "sort -o /tmp/out input.txt",
    "git log --output=/tmp/log",
    "git diff --ext-diff",
    "rg --pre 'touch /tmp/pwned' TODO .",
    "sort --compress-program=touch README.md",
    "date --set 2030-01-01",
    "diff --output=/tmp/diff a b",
    "echo hello > file.txt",
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
