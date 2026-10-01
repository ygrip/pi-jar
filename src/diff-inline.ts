/** Word-level changes inside one replaced line, for intraline emphasis in /diff. */

export type Span = readonly [start: number, end: number];

/** Token LCS stays tiny: long or wholly rewritten lines are shown without intraline emphasis. */
const MAX_INLINE_CELLS = 40_000;
const TOKEN = /\w+|\s+|[^\w\s]/gu;

const tokens = (text: string) => Array.from(text.matchAll(TOKEN), match => ({ text: match[0], at: match.index! }));

/**
 * Changed `[start, end)` code-unit spans of `before` and `after`. Undefined when the lines are equal,
 * too long to compare cheaply, or share no non-whitespace token (emphasizing everything adds nothing).
 */
export function inlineChanges(before: string, after: string): { before: Span[]; after: Span[] } | undefined {
  if (before === after) return undefined;
  const a = tokens(before), b = tokens(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start]!.text === b[start]!.text) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1]!.text === b[endB - 1]!.text) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  if (n * m > MAX_INLINE_CELLS) return undefined;
  // lcs[i][j] = LCS length of a[start+i..endA) and b[start+j..endB), flattened.
  const lcs = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i * (m + 1) + j] = a[start + i]!.text === b[start + j]!.text ? lcs[(i + 1) * (m + 1) + j + 1]! + 1
      : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!);
  }
  const changedA = new Uint8Array(n), changedB = new Uint8Array(m);
  let common = /\S/.test(a.slice(0, start).map(token => token.text).join("") + a.slice(endA).map(token => token.text).join(""));
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && a[start + i]!.text === b[start + j]!.text) {
      if (/\S/.test(a[start + i]!.text)) common = true;
      i++; j++;
    } else if (j < m && (i >= n || lcs[i * (m + 1) + j + 1]! >= lcs[(i + 1) * (m + 1) + j]!)) changedB[j++] = 1;
    else changedA[i++] = 1;
  }
  if (!common) return undefined;
  return { before: spans(a, start, changedA), after: spans(b, start, changedB) };
}

/** Merge consecutive changed tokens into spans; whitespace between two changes joins them. */
function spans(list: readonly { text: string; at: number }[], offset: number, changed: Uint8Array): Span[] {
  const result: [number, number][] = [];
  let previous = -1;
  for (let index = 0; index < changed.length; index++) {
    if (!changed[index]) continue;
    const token = list[offset + index]!;
    let joined = previous >= 0;
    for (let gap = previous + 1; joined && gap < index; gap++) if (/\S/.test(list[offset + gap]!.text)) joined = false;
    if (joined) result.at(-1)![1] = token.at + token.text.length;
    else result.push([token.at, token.at + token.text.length]);
    previous = index;
  }
  return result;
}

const SGR = /\x1b\[[0-?]*[ -/]*[@-~]/y;
const INVERSE_ON = "\x1b[7m";
const INVERSE_OFF = "\x1b[27m";

/**
 * Insert inverse-video markers around `spans` of the visible text inside an SGR-styled string.
 * Offsets count visible code units, so styling (syntax colours) never shifts the emphasis.
 */
export function emphasize(styled: string, spans: readonly Span[]): string {
  if (!spans.length) return styled;
  let out = "", visible = 0, span = 0, open = false;
  for (let at = 0; at < styled.length;) {
    SGR.lastIndex = at;
    const escape = SGR.exec(styled);
    if (escape) { out += escape[0]; at += escape[0].length; continue; }
    while (span < spans.length && open && visible >= spans[span]![1]) { out += INVERSE_OFF; open = false; span++; }
    if (span < spans.length && !open && visible >= spans[span]![0]) { out += INVERSE_ON; open = true; }
    out += styled[at++];
    visible++;
  }
  return open ? out + INVERSE_OFF : out;
}
