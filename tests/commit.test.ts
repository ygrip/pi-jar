import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanCommitMessage, commitPrompt, jarCommit } from "../src/commit.ts";
import { SideUsage } from "../src/side-model.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

function harness(cwd: string, reply: string, edit: (text: string) => string | undefined) {
  const notices: string[] = [];
  const prompts: string[] = [];
  const pi = { exec: async (command: string, args: string[], options: { cwd: string }) => {
    const result = spawnSync(command, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: options.cwd, encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? 1, killed: false };
  } };
  const roles = { resolve: (role: string) => role === "commit" ? { provider: "p", model: "cheap", via: ["commit"] } : undefined };
  const ctx = { hasUI: true, cwd, model: { provider: "p", id: "main" },
    ui: { notify: (message: string) => notices.push(message), confirm: async () => true, editor: async (_title: string, text: string) => edit(text) },
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }),
      streamSimple: (_model: unknown, context: { messages: { content: string }[] }) => { prompts.push(context.messages[0]!.content); return { result: async () => ({
        content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0.001 } } }) }; } } };
  return { pi: pi as never, ctx: ctx as never, roles: roles as never, notices, prompts };
}

test("commit message cleanup drops fences and extra blank lines", () => {
  assert.equal(cleanCommitMessage("```\nfeat: add x\n\n\n\nbody  \n```"), "feat: add x\n\nbody");
  assert.equal(cleanCommitMessage('"fix: y"'), "fix: y");
  assert.match(commitPrompt("a | 1 +", "x".repeat(70_000), "abc feat: z", "note"), /Author's note: note[\s\S]*abc feat: z[\s\S]*diff truncated/);
});

test("/jar commit stages on request, drafts with the commit role, and commits the reviewed message", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-jar-commit-"));
  try {
    git(cwd, "init", "-q");
    writeFileSync(join(cwd, "a.txt"), "a\n");
    git(cwd, "add", "."); git(cwd, "commit", "-qm", "chore: start");
    writeFileSync(join(cwd, "a.txt"), "b\n");
    const usage = new SideUsage();
    const h = harness(cwd, "```\nfix: change a\n```", (text) => text + "\n\nReviewed.");
    await jarCommit(h.pi, h.ctx, h.roles, usage, "tweak");
    assert.equal(git(cwd, "log", "-1", "--format=%B").trim(), "fix: change a\n\nReviewed.");
    assert.match(h.prompts[0]!, /chore: start[\s\S]*a\.txt[\s\S]*\+b/);
    assert.deepEqual(usage.all().map((call) => [call.role, call.model, call.cost]), [["commit", "p/cheap", 0.001]]);

    writeFileSync(join(cwd, "a.txt"), "c\n");
    const cancel = harness(cwd, "fix: other", () => "");
    await jarCommit(cancel.pi, cancel.ctx, cancel.roles, undefined);
    assert.ok(cancel.notices.includes("Commit cancelled"));
    assert.equal(git(cwd, "log", "-1", "--format=%s").trim(), "fix: change a", "an empty message commits nothing");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
