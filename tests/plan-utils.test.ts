import assert from "node:assert/strict";
import test from "node:test";
import { extractPlanSteps, isSafePlanCommand, planTextFromSteps } from "../src/plan-utils.ts";

test("plan shell allowlist permits read-only inspection and pipelines", () => {
  for (const command of [
    "git status",
    "git diff --stat",
    "rg TODO src | head -20",
    "find src -type f",
    "sed -n 1,80p README.md",
    "npm view typescript version"
  ]) assert.equal(isSafePlanCommand(command), true, command);
});

test("plan shell allowlist blocks mutation and ambiguous shell syntax", () => {
  for (const command of [
    "rm -rf build",
    "git checkout main",
    "git branch -D old",
    "find . -delete",\n    "find . -type f -fprint /tmp/files",\n    "sort -o /tmp/out input.txt",\n    "git log --output=/tmp/log",
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
