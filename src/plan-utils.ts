import { cleanText } from "./status.ts";

const SIMPLE_READ_COMMANDS = new Set([
  "cat", "head", "tail", "grep", "rg", "ls", "pwd", "wc", "sort", "diff",
  "file", "stat", "du", "df", "tree", "which", "whereis", "uname", "date",
  "ps", "fd", "eza", "realpath", "basename", "dirname"
]);

const SHELL_MUTATION = /(?:[;&]|\|\||&&|`|\$\(|\$\{|>|<|\n|\r)/;
const FIND_MUTATION = /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/;
const GIT_MUTATION = /(?:^|\s)(?:-d|-D|-m|-M|--delete|--move|--set-upstream-to|--unset-upstream)\b/;
const OUTPUT_FLAG = /(?:^|\s)(?:--output(?:=|\s)|-o(?:\s|$))/;

function safeGit(tokens: string[]): boolean {
  const sub = tokens[1] ?? "";
  if (!["status", "log", "diff", "show", "remote", "grep", "ls-files", "rev-parse", "describe"].includes(sub)) return false;
  const rest = tokens.slice(2).join(" ");
  if (GIT_MUTATION.test(rest) || OUTPUT_FLAG.test(rest)) return false;
  if (tokens.some((token) => ["--ext-diff", "--textconv"].includes(token))) return false;
  // git grep -O launches an arbitrary pager. Git also accepts abbreviated long
  // options; reject every spelling/prefix rather than just the full flag.
  if (sub === "grep" && tokens.slice(2).some((token) =>
    token.startsWith("--open") || (/^-[A-Za-z]*O/.test(token)))) return false;
  if (sub === "remote" && tokens.length > 2 && !["-v", "show", "get-url"].includes(tokens[2] ?? "")) return false;
  return true;
}

function safePackageQuery(tokens: string[]): boolean {
  const sub = tokens[1] ?? "";
  return ["list", "ls", "view", "info", "why", "outdated"].includes(sub);
}

function safeSegment(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  const command = tokens[0] ?? "";
  if (!command) return false;

  if (SIMPLE_READ_COMMANDS.has(command)) {
    if (OUTPUT_FLAG.test(segment)) return false;
    if (command === "sort" && tokens.some((token) => token.startsWith("--compress-program"))) return false;
    if (command === "date" && tokens.some((token) => token === "-s" || token.startsWith("--set"))) return false;
    if (command === "rg" && tokens.some((token) => token === "--pre" || token.startsWith("--pre="))) return false;
    return true;
  }
  if (command === "find") return !FIND_MUTATION.test(segment);
  if (command === "git") return safeGit(tokens);
  if (["npm", "pnpm", "yarn", "bun"].includes(command)) return safePackageQuery(tokens);
  return false;
}

/** Conservative shell allowlist used while plan mode is read-only. */
export function isSafePlanCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 8192 || SHELL_MUTATION.test(trimmed)) return false;
  const segments = trimmed.split(/\s*\|\s*/);
  return segments.length > 0 && segments.every(safeSegment);
}

export function extractPlanSteps(text: string): string[] {
  const lines = text.replace(/\r/g, "").split("\n");
  let inPlan = false;
  const steps: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!inPlan) {
      if (/^(?:#{1,6}\s*)?plan\s*:?$/i.test(line)) inPlan = true;
      continue;
    }
    const match = /^(\d+)[.)]\s+(.+)$/.exec(line);
    if (match) {
      const value = cleanText(match[2] ?? "", 240);
      if (value) steps.push(value);
      continue;
    }
    if (steps.length && /^(?:#{1,6}\s+|[A-Z][A-Za-z ]+:$)/.test(line)) break;
  }
  return steps.slice(0, 50);
}

export function planTextFromSteps(steps: readonly string[]): string {
  return steps.map((step, index) => String(index + 1) + ". " + cleanText(step, 240)).join("\n");
}
