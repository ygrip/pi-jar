import type { ExtensionContext, SessionInfo } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { sessionDisplayName } from "./composer.ts";
import { cleanText } from "./status.ts";

/** Search session titles and first prompts, without exposing raw JSONL contents in the picker. */
export function filterSessions(sessions: readonly SessionInfo[], query: string): SessionInfo[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return sessions.filter((session) => {
    const haystack = `${session.name ?? ""} ${sessionDisplayName(session.name, session.id)} ${session.firstMessage}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export async function pickSession(ctx: ExtensionContext, sessions: readonly SessionInfo[], initial = ""): Promise<string | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") return undefined;
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    let query = initial.slice(0, 100);
    let selected = 0;
    let first = 0;
    let width = 80;
    const pageSize = () => Math.max(2, Math.min(10, Math.floor(((process.stdout.rows ?? 24) - 7) / 2)));
    const matches = () => filterSessions(sessions, query);
    const refresh = () => { selected = 0; first = 0; tui.requestRender(); };
    return {
      invalidate() {},
      handleInput(data: string) {
        const rows = matches();
        if (matchesKey(data, Key.escape)) return done(undefined);
        if (matchesKey(data, Key.enter)) return done(rows[selected]?.path);
        if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1);
        else if (matchesKey(data, Key.down)) selected = Math.min(rows.length - 1, selected + 1);
        else if (matchesKey(data, Key.pageUp)) selected = Math.max(0, selected - pageSize());
        else if (matchesKey(data, Key.pageDown)) selected = Math.min(rows.length - 1, selected + pageSize());
        else if (matchesKey(data, Key.backspace) || data === "\x7f") { query = query.slice(0, -1); return refresh(); }
        else if (/^[\x20-\x7e]$/.test(data) && query.length < 100) { query += data; return refresh(); }
        first = Math.max(0, Math.min(selected, first), selected - pageSize() + 1);
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === "wheel" && event.wheelDelta) {
          selected = Math.max(0, Math.min(matches().length - 1, selected + Math.sign(event.wheelDelta)));
          first = Math.max(0, Math.min(selected, first), selected - pageSize() + 1);
          tui.requestRender(); return { handled: true };
        }
        if (event.type !== "click" || event.button !== "left" || event.x >= width) return;
        const index = first + Math.floor((event.y - 2) / 2);
        const row = matches()[index];
        if (event.y >= 2 && event.y < 2 + 2 * pageSize() && row) {
          selected = index; done(row.path); return { handled: true };
        }
      },
      render(available: number): string[] {
        width = Math.max(0, available);
        const fit = (line: string) => truncateToWidth(line, width);
        const rows = matches();
        selected = Math.max(0, Math.min(selected, rows.length - 1));
        const lines = [
          fit(theme.fg("accent", `╭─ SESSIONS · ${rows.length}/${sessions.length} ─`)),
          fit(theme.fg("muted", `│ Search: ${cleanText(query, 100)}${query ? "" : "(type to filter)"}`))
        ];
        for (let i = first; i < Math.min(rows.length, first + pageSize()); i++) {
          const session = rows[i]!;
          const title = cleanText(sessionDisplayName(session.name, session.id), 55);
          const prompt = cleanText(session.firstMessage, 90);
          const when = Number.isNaN(session.modified.getTime()) ? "" : session.modified.toISOString().slice(0, 10);
          lines.push(fit(theme.fg(i === selected ? "accent" : "muted", `│ ${i === selected ? "❯" : " "} ${title} · ${when}`)));
          lines.push(fit(theme.fg("dim", `│     ${prompt || "No first prompt"}`)));
        }
        if (!rows.length) lines.push(fit(theme.fg("dim", "│ No matching sessions")));
        lines.push(fit(theme.fg("dim", "╰─ Type to search · ↑↓/PgUp/PgDn select · Enter resume · Esc cancel")));
        return lines;
      }
    };
  });
}
