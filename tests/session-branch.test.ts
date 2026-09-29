import assert from "node:assert/strict";
import test from "node:test";
import { clearSessionBranchCache, sessionBranch } from "../src/session-branch.ts";

test("session branch projection is reused until the leaf changes", () => {
  let leaf = "a";
  let calls = 0;
  const manager = {
    getLeafId: () => leaf,
    getBranch: () => { calls++; return leaf === "a" ? [{ id: "a" }] : [{ id: "a" }, { id: "b" }]; }
  };
  const ctx = { sessionManager: manager } as never;
  const first = sessionBranch(ctx);
  const second = sessionBranch(ctx);
  assert.equal(first, second);
  assert.equal(calls, 1);

  leaf = "b";
  assert.equal(sessionBranch(ctx).length, 2);
  assert.equal(calls, 2);

  clearSessionBranchCache(ctx);
  sessionBranch(ctx);
  assert.equal(calls, 3);
});

test("branch cache falls back safely when a mock manager has no leaf id", () => {
  let calls = 0;
  const ctx = { sessionManager: { getBranch: () => { calls++; return []; } } } as never;
  sessionBranch(ctx);
  sessionBranch(ctx);
  assert.equal(calls, 2);
});
