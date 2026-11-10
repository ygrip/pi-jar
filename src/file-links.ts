import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Resolve only Markdown file destinations; leave web, fragment, and unsupported URLs unchanged. */
function fileUrl(destination: string, cwd: string): string | undefined {
  if (!destination || /[\u0000-\u001f\u007f]/.test(destination)) return;
  if ((!isAbsolute(destination) && /^[a-z][a-z0-9+.-]*:/i.test(destination)) || destination.startsWith("//")) return;
  if (destination.startsWith("#") || destination.startsWith("?")) return;
  let suffixAt = -1;
  for (let i = 0; i < destination.length; i++) {
    if (destination[i] === "\\") { i++; continue; }
    if (destination[i] === "?" || destination[i] === "#") { suffixAt = i; break; }
  }
  let path = destination;
  let suffix = "";
  if (suffixAt >= 0) {
    path = destination.slice(0, suffixAt);
    suffix = destination.slice(suffixAt);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path.replace(/\\([ !"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1"));
  } catch {
    return;
  }
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return;
  if (decoded === "~" || decoded.startsWith("~/")) decoded = homedir() + decoded.slice(1);
  if (!isAbsolute(cwd)) return;
  return pathToFileURL(resolve(cwd, decoded)).href.replace(/\(/g, "%28").replace(/\)/g, "%29") + suffix;
}

function labelStart(line: string, end: number): number {
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    if (line[i] !== "[" && line[i] !== "]") continue;
    let escapes = 0;
    while (line[i - escapes - 1] === "\\") escapes++;
    if (escapes % 2 === 1) continue;
    if (line[i] === "]") depth++;
    else if (--depth === 0) return i;
  }
  return -1;
}

/** Find the end of a CommonMark destination, leaving any title and closing parenthesis intact. */
function destinationEnd(line: string, start: number): number {
  if (line[start] === "<") {
    for (let i = start + 1; i < line.length; i++) {
      if (line[i] === "\\") { i++; continue; }
      if (line[i] === ">") return i + 1;
    }
    return start;
  }
  let depth = 0;
  for (let i = start; i < line.length; i++) {
    if (line[i] === "\\") { i++; continue; }
    if (line[i] === "(") depth++;
    if (line[i] === ")") {
      if (depth === 0) return i;
      depth--;
    }
    if (/\s/.test(line[i])) return i;
  }
  return line.length;
}

function replaceDestination(line: string, start: number, cwd: string): { line: string; end: number } {
  const end = destinationEnd(line, start);
  if (end === start) return { line, end };
  const raw = line.slice(start, end);
  const angle = raw.startsWith("<") && raw.endsWith(">");
  let destination = raw;
  if (angle) destination = raw.slice(1, -1);
  const url = fileUrl(destination, cwd);
  if (!url) return { line, end };
  let replacement = url;
  if (angle) replacement = `<${url}>`;
  return { line: line.slice(0, start) + replacement + line.slice(end), end: start + replacement.length };
}

/** Rewrite rendered links without changing the assistant message stored by Pi. */
export function resolveFileLinks(markdown: string, cwd: string): string {
  let fence = "";
  let inlineTicks = 0;
  return markdown.split("\n").map(original => {
    const marker = original.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*$/.test(original.slice(marker[0].length))) fence = "";
      return original;
    }
    if (!inlineTicks && marker) { fence = marker[1]; return original; }
    if (!inlineTicks && /^(?: {4}|\t)/.test(original)) return original;
    let line = original;
    if (!inlineTicks) {
      const definition = line.match(/^ {0,3}\[[^\]\n]+\]:[ \t]*/);
      if (definition) line = replaceDestination(line, definition[0].length, cwd).line;
    }
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "\\") { i++; continue; }
      if (line[i] === "`") {
        let end = i + 1;
        while (line[end] === "`") end++;
        const count = end - i;
        if (inlineTicks === count) inlineTicks = 0;
        else if (!inlineTicks) inlineTicks = count;
        i = end - 1;
        continue;
      }
      if (inlineTicks || line[i] !== "]" || line[i + 1] !== "(") continue;
      const label = labelStart(line, i);
      if (label < 0 || line[label - 1] === "!") continue;
      const start = i + 2;
      const end = destinationEnd(line, start);
      if (!/^(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\)/.test(line.slice(end))) continue;
      const replaced = replaceDestination(line, start, cwd);
      line = replaced.line;
      i = replaced.end - 1;
    }
    return line;
  }).join("\n");
}
