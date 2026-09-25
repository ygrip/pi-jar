import { cleanText } from "./status.ts";

const SIMPLE_READ_COMMANDS = new Set([
  "cat", "head", "tail", "grep", "rg", "ls", "pwd", "wc", "sort", "diff",
  "file", "stat", "du", "df", "tree", "which", "whereis", "uname", "date",
  "ps", "fd", "eza", "realpath", "basename", "dirname"
]);

// Avoid shell expansions and quoting that could change the options seen by the
// allowlist after validation (for example: git grep '--op=command').
const SHELL_MUTATION = /(?:[;&]|\|\||[`$\\'"*?\[\]{}]|>|<|\n|\r)/;
const FIND_MUTATION = /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/;
const GIT_MUTATION = /(?:^|\s)(?:-d|-D|-m|-M|--delete|--move|--set-upstream-to|--unset-upstream)\b/;
const OUTPUT_FLAG = /(?:^|\s)(?:--output(?:=|\s)|-o(?:\s|$))/;

function safeGit(tokens: string[]): boolean {
  const sub = tokens[1] ?? "";
  if (!["status", "log", "diff", "show", "remote", "grep", "ls-files", "rev-parse", "describe"].includes(sub)) return false;
  const rest = tokens.slice(2).join(" ");
  if (GIT_MUTATION.test(rest) || OUTPUT_FLAG.test(rest)) return false;
  // Git accepts unique long-option prefixes; do not only reject the full
  // spelling of flags that write files or run external programs.
  const dangerous = sub === "grep"
    ? ["output", "ext-diff", "textconv", "open-files-in-pager"]
    : ["output", "ext-diff", "textconv"];
  if (tokens.slice(2).some((token) => {
    if (sub === "grep" && /^-[^-]*O/.test(token)) return true;
    if (!token.startsWith("--")) return false;
    const flag = token.slice(2).split("=", 1)[0] ?? "";
    return flag.length >= 2 && dangerous.some((option) => option.startsWith(flag));
  })) return false;
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

export interface PlanSection { level: number; title: string; start: number; end: number; body: string }

/** Split markdown into ATX-heading sections, ignoring `#` lines inside fenced code. */
export function parsePlanSections(text: string): PlanSection[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const sections: PlanSection[] = [];
  let fence: string | undefined;
  lines.forEach((line, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0]!.repeat(marker.length);
      else if (marker.startsWith(fence)) fence = undefined;
      return;
    }
    if (fence) return;
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) return;
    const previous = sections.at(-1);
    if (previous) previous.end = index;
    sections.push({ level: heading[1]!.length, title: cleanText(heading[2]!, 120), start: index, end: lines.length, body: "" });
  });
  for (const section of sections) section.body = lines.slice(section.start + 1, section.end).join("\n").replace(/^\n+|\n+$/g, "");
  return sections;
}

/** Sections every submitted plan must contain (matched case-insensitively by prefix). */
export const REQUIRED_PLAN_SECTIONS = ["Context", "Approach", "Critical files", "Verification"] as const;
export const PLAN_TEMPLATE = [
  "# <Plan title>",
  "",
  "## Context",
  "Why this change is needed, the literal request, and the intended end state (2–4 sentences).",
  "",
  "## Approach",
  "1. Ordered, behavior-grouped steps. Name exact files, symbols, reused helpers, signatures and error handling.",
  "2. …",
  "",
  "## Critical files",
  "- `path/to/file.ts` — symbol — why it changes (at most ~5 files).",
  "",
  "## Verification",
  "- Exact commands to run and at least one concrete check of new behavior (input → expected output).",
  "",
  "## Assumptions",
  "- Only decisions the user could override, each with a pre-decided fallback."
].join("\n");

const sectionMatches = (title: string, required: string) => title.toLowerCase().replace(/[^a-z ]/g, "").trim().startsWith(required.toLowerCase());

/** A section with its nested subsections (everything until the next heading of the same or higher level). */
function sectionTree(sections: readonly PlanSection[], index: number): PlanSection[] {
  const root = sections[index]!;
  const tree = [root];
  for (const section of sections.slice(index + 1)) {
    if (section.level <= root.level) break;
    tree.push(section);
  }
  return tree;
}

const findSection = (sections: readonly PlanSection[], name: string, minLevel = 1) =>
  sections.findIndex((section) => section.level >= minLevel && sectionMatches(section.title, name));

export interface PlanValidation { ok: boolean; title?: string; missing: string[]; problems: string[] }

export function validatePlanDocument(text: string): PlanValidation {
  const sections = parsePlanSections(text);
  const title = sections.find((section) => section.level === 1)?.title;
  const missing: string[] = [];
  const problems: string[] = [];
  if (!title) problems.push("add a single `# Title` heading at the top");
  for (const required of REQUIRED_PLAN_SECTIONS) {
    const index = findSection(sections, required, 2);
    if (index < 0) { missing.push(required); continue; }
    const content = sectionTree(sections, index).map((section) => section.body).join("\n");
    if (!content.trim() && sectionTree(sections, index).length === 1) problems.push(`\`## ${sections[index]!.title}\` is empty`);
    else if (required === "Approach" && sectionTree(sections, index).length === 1 && !/^\s*(?:\d+[.)]|[-*])\s+\S/m.test(content)) {
      problems.push("list concrete numbered steps under `## Approach`");
    }
  }
  return { ok: !missing.length && !problems.length, ...(title ? { title } : {}), missing, problems };
}

/** Actionable steps from the Approach section (`###` step headings or numbered items), falling back to a legacy `Plan:` list. */
export function extractApproachSteps(text: string): string[] {
  const sections = parsePlanSections(text);
  const index = findSection(sections, "Approach", 2);
  if (index < 0) return extractPlanSteps(text);
  const [approach, ...nested] = sectionTree(sections, index);
  const direct = nested.filter((section) => section.level === approach!.level + 1);
  const steps = direct.length
    ? direct.map((section) => section.title.replace(/^(?:step\s*)?\d+[.):]?\s*/i, ""))
    : approach!.body.split("\n").map((line) => /^\s*\d+[.)]\s+(.+)$/.exec(line)?.[1] ?? "").map((step) => step.replace(/\*\*/g, ""));
  return steps.map((step) => cleanText(step, 240)).filter(Boolean).slice(0, 50);
}

/** Filesystem-safe slug for plan file names. */
export function planSlug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "plan";
}
