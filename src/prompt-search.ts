import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { cleanText } from "./status.ts";

export interface PastPrompt { text: string; source: "this session" | "earlier session"; at?: number }

const userText = (message: { content?: unknown }) => typeof message.content === "string" ? message.content
  : Array.isArray(message.content) ? message.content.filter((part: { type?: string }) => part?.type === "text").map((part: { text?: string }) => part.text ?? "").join("\n") : "";

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
    if (!value || value.length > 8000 || seen.has(key)) return;
    seen.add(key);
    result.push({ text: value, source, ...(at ? { at } : {}) });
  };
  const own = entries.filter((raw): raw is { type: string; message: { role: string; content?: unknown }; timestamp?: string } =>
    !!raw && typeof raw === "object" && (raw as { type?: string }).type === "message" && (raw as { message?: { role?: string } }).message?.role === "user");
  for (const entry of [...own].reverse()) add(userText(entry.message), "this session", entry.timestamp ? Date.parse(entry.timestamp) : undefined);
  for (const session of earlier) if (session.firstMessage) add(session.firstMessage, "earlier session", session.modified?.getTime());
  return result;
}

/** Type to fuzzy-filter past prompts; Enter puts the selection in the composer for editing. */
export async function openPromptSearch(ctx: ExtensionContext, prompts: readonly PastPrompt[]): Promise<string | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") return undefined;
  if (!prompts.length) { ctx.ui.notify("pi-jar: no earlier prompts yet", "info"); return undefined; }
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    let query = "";
    let selected = 0;
    let first = 0;
    let visible: PastPrompt[] = [...prompts];
    const rows = 10;
    const filter = () => { visible = query ? fuzzyFilter([...prompts], query, (item) => item.text) : [...prompts]; selected = 0; first = 0; };
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
        const inner = w - 4;
        if (selected < first) first = selected;
        if (selected >= first + rows) first = selected - rows + 1;
        const fit = (text: string) => { const value = truncateToWidth(text, inner); return value + " ".repeat(Math.max(0, inner - visibleWidth(value))); };
        const dim = (text: string) => theme.fg("dim", text);
        const lines = [
          theme.fg("accent", "╭─ ⌕ PROMPT HISTORY ") + dim("─".repeat(Math.max(0, w - 21)) + "╮"),
          dim("│ ") + fit(theme.fg("accent", "› ") + query + "\x1b[7m \x1b[0m" + dim(`  ${visible.length}/${prompts.length}`)) + dim(" │")
        ];
        for (let row = 0; row < rows; row++) {
          const item = visible[first + row];
          const active = first + row === selected;
          const text = item ? (active ? "❯ " : "  ") + cleanText(item.text, 400) : "";
          const tag = item?.source === "earlier session" ? dim(" · earlier") : "";
          lines.push(dim("│ ") + fit(item ? theme.fg(active ? "accent" : "muted", truncateToWidth(text, Math.max(4, inner - 10))) + tag : "") + dim(" │"));
        }
        lines.push(dim("╰─ type to filter · ↑↓ select · Enter edit · Esc close " + "─".repeat(Math.max(0, w - 57)) + "╯"));
        return lines.map((line) => truncateToWidth(line, w));
      }
    };
  }, { overlay: true, overlayOptions: { width: "80%", maxHeight: "60%" } });
}
