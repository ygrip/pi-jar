import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { popup } from "./popup.ts";
import { fuzzyFilter, Key, matchesKey, truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { cleanText } from "./status.ts";

export interface PastPrompt { text: string; source: "this session" | "earlier session"; at?: number }

const MAX_PROMPT_CHARS = 8000;
const userText = (message: { content?: unknown }): string => {
  if (typeof message.content === "string") return message.content.slice(0, MAX_PROMPT_CHARS + 1);
  if (!Array.isArray(message.content)) return "";
  let text = "";
  for (const part of message.content as Array<{ type?: string; text?: string }>) {
    if (part?.type !== "text" || typeof part.text !== "string") continue;
    const separator = text ? "\n" : "";
    const room = MAX_PROMPT_CHARS + 1 - text.length - separator.length;
    if (room <= 0) break;
    text += separator + part.text.slice(0, room);
    if (part.text.length > room) break;
  }
  return text;
};

/**
 * Prompts newest first and deduplicated: every user message in this session file (all branches),
 * then the opening prompt of earlier sessions for the project.
 */
export function collectPrompts(entries: readonly unknown[], earlier: readonly { firstMessage?: string; modified?: Date }[] = []): PastPrompt[] {
  const seen = new Set<string>();
  const result: PastPrompt[] = [];
  const add = (text: string, source: PastPrompt["source"], at?: number) => {
    const value = text.trim();
    const key = value.replace(/\s+/g, " ");
    if (!value || value.length > MAX_PROMPT_CHARS || seen.has(key)) return;
    seen.add(key);
    result.push({ text: value, source, ...(at ? { at } : {}) });
  };
  for (let index = entries.length - 1; index >= 0; index--) {
    const raw = entries[index];
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { type?: string; message?: { role?: string; content?: unknown }; timestamp?: string };
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    add(userText(entry.message), "this session", entry.timestamp ? Date.parse(entry.timestamp) : undefined);
  }
  for (const session of earlier) if (session.firstMessage) add(session.firstMessage, "earlier session", session.modified?.getTime());
  return result;
}

/** Type to fuzzy-filter past prompts; Enter puts the selection in the composer for editing. */
export async function openPromptSearch(ctx: ExtensionContext, prompts: readonly PastPrompt[]): Promise<string | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") return undefined;
  if (!prompts.length) { ctx.ui.notify("pi-jar: no earlier prompts yet", "info"); return undefined; }
  return popup<string | undefined>(ctx, (tui, theme, _keys, done) => {
    let query = "";
    let selected = 0;
    let first = 0;
    // pi-tui's fuzzyFilter takes a mutable array; copy once per overlay, not per keystroke.
    const pool: PastPrompt[] = prompts.slice();
    let visible: PastPrompt[] = pool;
    let rows = 10;
    const filter = () => { visible = query ? fuzzyFilter(pool, query, (item) => item.text) : pool; selected = 0; first = 0; };
    // Prompts can be several KiB; sanitize each once, not on every repaint.
    const cleaned = new Map<PastPrompt, string>();
    const preview = (item: PastPrompt) => {
      let text = cleaned.get(item);
      if (text === undefined) cleaned.set(item, text = cleanText(item.text, 400));
      return text;
    };
    return {
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, Key.escape)) return done(undefined);
        if (matchesKey(data, Key.enter)) return done(visible[selected]?.text);
        if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) selected = Math.max(0, selected - 1);
        else if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) selected = Math.min(visible.length - 1, selected + 1);
        else if (matchesKey(data, Key.backspace)) { query = [...query].slice(0, -1).join(""); filter(); }
        else if (matchesKey(data, Key.ctrl("u"))) { query = ""; filter(); }
        else if (data.length >= 1 && !data.startsWith("\x1b") && !/[\x00-\x1f\x7f]/.test(data)) { query += data; filter(); }
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === "wheel" && event.wheelDelta) { selected = Math.max(0, Math.min(visible.length - 1, selected + Math.sign(event.wheelDelta))); tui.requestRender(); return { handled: true }; }
        if (event.type !== "click" || event.button !== "left") return;
        const index = first + event.y - 2;
        if (event.y >= 2 && event.y < 2 + rows && visible[index]) { done(visible[index]!.text); return { handled: true }; }
      },
      render(width: number): string[] {
        const w = Math.max(20, width);
        rows = Math.max(1, Math.min(10, (tui.terminal?.rows ?? process.stdout.rows ?? 24) - 3));
        const inner = w - 4;
        if (selected < first) first = selected;
        if (selected >= first + rows) first = selected - rows + 1;
        const dim = (text: string) => theme.fg("dim", text);
        // Rows are exactly `w` wide; only the two borders can overflow a narrow overlay.
        const lines = [
          truncateToWidth(theme.fg("accent", "╭─ ⌕ PROMPT HISTORY ") + dim("─".repeat(Math.max(0, w - 21)) + "╮"), w),
          dim("│ ") + truncateToWidth(theme.fg("accent", "› ") + query + "\x1b[7m \x1b[0m" + dim(`  ${visible.length}/${prompts.length}`), inner, "...", true) + dim(" │")
        ];
        for (let row = 0; row < rows; row++) {
          const item = visible[first + row];
          const active = first + row === selected;
          const text = item ? (active ? "❯ " : "  ") + preview(item) : "";
          const tag = item?.source === "earlier session" ? dim(" · earlier") : "";
          const content = item ? theme.fg(active ? "accent" : "muted", truncateToWidth(text, Math.max(4, inner - 10))) + tag : "";
          lines.push(dim("│ ") + truncateToWidth(content, inner, "...", true) + dim(" │"));
        }
        lines.push(truncateToWidth(dim("╰─ type to filter · ↑↓ select · Enter edit · Esc close " + "─".repeat(Math.max(0, w - 57)) + "╯"), w));
        return lines;
      }
    };
  }, { filter: false });
}
