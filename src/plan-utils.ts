import { cleanText } from "./status.ts";

const SIMPLE_READ_COMMANDS = new Set([
  "cat", "head", "tail", "grep", "rg", "ls", "pwd", "wc", "sort", "uniq", "diff",
  "file", "stat", "du", "df", "tree", "which", "whereis", "printenv", "uname", "date",
  "ps", "fd", "bat", "eza", "realpath", "basename", "dirname"
]);

const SHELL_MUTATION = /(?:[;&]|\|\||&&|`|\$\(|\$\{|>|<|\n|\r)/;
const FIND_MUTATION = /(?:^|\s)-(?:delete|exec|execdir|ok|okdir)\b/;
const GIT_MUTATION = /(?:^|\s)(?:-d|-D|-m|-M|--delete|--move|--set-upstream-to|--unset-upstream)\b/;

function safeGit(tokens: string[]): boolean {
  const sub = tokens[1] ?? "";
  if (!["status", "log", "diff", "show", "branch", "remote", "grep", "ls-files", "rev-parse", "describe"].includes(sub)) return false;
  if (sub === "branch" && GIT_MUTATION.test(tokens.slice(2).join(" "))) return false;
  if (sub === "remote" && tokens.length > 2 && !["-v", "show", "get-url"].includes(tokens[2] ?? "")) return false;
  if (tokens.some((token) => token === "--output" || token.startsWith("--output="))) return false;
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
  if (command === "sort" && tokens.some((token, index) => index > 0 && (token === "-o" || token.startsWith("--output")))) return false;
  if (SIMPLE_READ_COMMANDS.has(command)) return true;
  if (command === "find") return !FIND_MUTATION.test(segment);
  if (command === "git") return safeGit(tokens);
  if (["npm", "pnpm", "yarn", "bun"].includes(command)) return safePackageQuery(tokens);
  if (command === "sed") return tokens.includes("-n") && !tokens.some((token) => /^-i/.test(token));
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
