import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRoleManager } from "./model-roles.ts";
import { askRole, type SideUsage } from "./side-model.ts";

const DIFF_LIMIT = 60_000;

export const COMMIT_SYSTEM = [
  "You write git commit messages.",
  "Reply with the message only: no code fences, no preamble.",
  "First line: imperative summary under 72 characters, matching the style of the recent commits (e.g. a `type: ` prefix if they use one).",
  "Then a blank line and a short body explaining what changed and why, wrapped at 72 columns. Skip the body for trivial changes."
].join("\n");

/** Remove fences or quoting a model may add around the message. */
export function cleanCommitMessage(text: string): string {
  let body = text.trim().replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, "$1").trim();
  if (/^["'].*["']$/s.test(body)) body = body.slice(1, -1).trim();
  return body.split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n");
}

export function commitPrompt(stat: string, diff: string, log: string, hint: string): string {
  const clipped = diff.length > DIFF_LIMIT ? diff.slice(0, DIFF_LIMIT) + `\n… diff truncated (${diff.length - DIFF_LIMIT} more characters)` : diff;
  return [hint ? `Author's note: ${hint}\n` : "", "Recent commits:\n" + (log.trim() || "(none)"), "\nStaged files:\n" + stat.trim(), "\nStaged diff:\n" + clipped].join("\n");
}

/** `/jar commit [note]`: draft a message for the staged changes with the commit role, review it, commit. Never pushes. */
export async function jarCommit(pi: ExtensionAPI, ctx: ExtensionContext, roles: ModelRoleManager, usage: SideUsage | undefined, hint = ""): Promise<void> {
  if (!ctx.hasUI) { ctx.ui.notify("/jar commit needs the interactive UI to review the message", "warning"); return; }
  const git = async (...args: string[]) => {
    const result = await pi.exec("git", args, { cwd: ctx.cwd, timeout: 20_000 });
    if (result.code !== 0) throw new Error(`git ${args[0]}: ${(result.stderr || result.stdout).trim() || "exit " + result.code}`);
    return result.stdout;
  };
  try {
    await git("rev-parse", "--is-inside-work-tree");
    let stat = await git("diff", "--cached", "--stat");
    if (!stat.trim()) {
      const dirty = await git("status", "--porcelain");
      if (!dirty.trim()) { ctx.ui.notify("Nothing to commit", "info"); return; }
      if (!await ctx.ui.confirm("Nothing staged", "Stage all changes (git add -A) and continue?")) return;
      await git("add", "-A");
      stat = await git("diff", "--cached", "--stat");
    }
    const [diff, log] = await Promise.all([git("diff", "--cached", "--no-color"), git("log", "-n", "8", "--oneline").catch(() => "")]);
    ctx.ui.notify("Drafting a commit message…", "info");
    const answer = await askRole(ctx, roles, usage, "commit", COMMIT_SYSTEM, commitPrompt(stat, diff, log, hint), ctx.signal);
    const message = cleanCommitMessage(await ctx.ui.editor(`Commit message · ${answer.model} · save to commit, empty to cancel`, cleanCommitMessage(answer.text)) ?? "");
    if (!message) { ctx.ui.notify("Commit cancelled", "info"); return; }
    const dir = mkdtempSync(join(tmpdir(), "pi-jar-commit-"));
    try {
      writeFileSync(join(dir, "MSG"), message + "\n");
      const out = await git("commit", "-F", join(dir, "MSG"));
      ctx.ui.notify(out.trim().split("\n")[0] || "Committed", "info");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } catch (error) {
    ctx.ui.notify("pi-jar commit: " + (error instanceof Error ? error.message : String(error)), "error");
  }
}
