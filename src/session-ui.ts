import type { ExtensionContext, SessionInfo } from "@earendil-works/pi-coding-agent";
import { popup } from "./popup.ts";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { sessionDisplayName } from "./composer.ts";
import { iconSet, withIcon } from "./icons.ts";
import { contentRows, sidebarWidth, splitFrame } from "./split-view.ts";
import { cleanText } from "./status.ts";

/** Extra per-session facts that need reading the session file; loaded lazily for the selected row only. */
export interface SessionDetails { goal?: string; plan?: string }

/** Search session titles and first prompts, without exposing raw JSONL contents in the picker. */
export function filterSessions(sessions: readonly SessionInfo[], query: string): SessionInfo[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return sessions.filter((session) => {
    const haystack = `${session.name ?? ""} ${sessionDisplayName(session.name, session.id)} ${session.firstMessage}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

const two = (value: number) => String(value).padStart(2, "0");
function age(date: Date, now = Date.now()): string {
  if (Number.isNaN(date.getTime())) return "";
  const minutes = Math.max(0, Math.floor((now - date.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 43_200) return `${Math.floor(minutes / 1440)}d`;
  return minutes < 525_600 ? `${Math.floor(minutes / 43_200)}mo` : `${Math.floor(minutes / 525_600)}y`;
}

// Chrome rows: top border, divider, search row, hint row, bottom border.
const CHROME = 5;

/** Overlay: searchable sessions on the left, the selected session's details on the right; resolves to the chosen path. */
export async function pickSession(ctx: ExtensionContext, sessions: readonly SessionInfo[], initial = "",
  details?: (session: SessionInfo) => Promise<SessionDetails>): Promise<string | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") return undefined;
  const indexed = sessions.map((session) => ({
    session,
    haystack: `${session.name ?? ""} ${sessionDisplayName(session.name, session.id)} ${session.firstMessage}`.toLowerCase()
  }));
  const search = (query: string): SessionInfo[] => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return sessions.slice();
    const rows: SessionInfo[] = [];
    for (const item of indexed) if (terms.every((term) => item.haystack.includes(term))) rows.push(item.session);
    return rows;
  };
  return popup<string | undefined>(ctx, (tui, theme, _keys, done) => {
    let query = initial.slice(0, 100);
    let selected = 0;
    let first = 0;
    let width = 80;
    let listRows = contentRows(CHROME, 4);
    let layout = { top: 1, rows: 0, leftWidth: 0, bodyX: 2, footerTop: 0 };
    let rows = search(query);
    let closed = false;
    // undefined = never requested; null = in flight. Keyed by path so re-filtering keeps loaded details.
    const cache = new Map<string, SessionDetails | null>();
    const fg = (color: string, text: string) => theme.fg(color as never, text);
    const finish = (path: string | undefined) => { closed = true; done(path); };
    const reveal = () => { first = Math.max(0, Math.min(selected, first), selected - listRows + 1); };
    const move = (to: number) => { selected = Math.max(0, Math.min(rows.length - 1, to)); reveal(); tui.requestRender(); };
    const refresh = () => { rows = search(query); selected = 0; first = 0; tui.requestRender(); };
    const load = (session: SessionInfo) => {
      if (!details || cache.has(session.path)) return;
      cache.set(session.path, null);
      // Never awaited: input stays live while the file is read, and late results after close are dropped.
      const settle = (value: SessionDetails) => { if (closed) return; cache.set(session.path, value); tui.requestRender(); };
      Promise.resolve().then(() => details(session)).then((value) => settle(value ?? {}), () => settle({}));
    };
    // Wrapping a 4 KiB first prompt is the costliest part of a frame; redo it only when its inputs change.
    let described: { session: SessionInfo; inputs: string; loaded: SessionDetails | null | undefined; lines: string[] } | undefined;
    const describe = (session: SessionInfo, bodyWidth: number, height: number): string[] => {
      const date = session.modified;
      const inputs = `${bodyWidth}\0${height}\0${age(date)}\0${iconSet()}`;
      const loaded = details ? cache.get(session.path) : undefined;
      if (described?.session === session && described.inputs === inputs && described.loaded === loaded) return described.lines;
      const when = Number.isNaN(date.getTime()) ? "unknown"
        : `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}` + (age(date) ? ` · ${age(date)} ago` : "");
      const lines = [
        fg("accent", truncateToWidth(cleanText(sessionDisplayName(session.name, session.id), 200), bodyWidth)),
        fg("muted", withIcon("session", cleanText(session.id, 36).slice(0, 8))),
        fg("muted", withIcon("time", when)),
        fg("muted", `${session.messageCount} message${session.messageCount === 1 ? "" : "s"}`)
      ];
      if (session.cwd) lines.push(fg("muted", withIcon("folder", cleanText(session.cwd, 400))));
      if (details) {
        if (!loaded) lines.push(fg("dim", "Loading details…"));
        else {
          for (const [key, text] of [["goal", loaded.goal], ["plan", loaded.plan]] as const) {
            if (text?.trim()) lines.push(...wrapTextWithAnsi(withIcon(key, cleanText(text, 600)), Math.max(1, bodyWidth)).slice(0, 3).map((line) => fg("text", line)));
          }
        }
      }
      lines.push("", fg("dim", "First prompt"));
      const prompt = cleanText(session.firstMessage, 4096);
      lines.push(...(prompt ? wrapTextWithAnsi(prompt, Math.max(1, bodyWidth)).map((line) => fg("muted", line)) : [fg("dim", "No first prompt")]));
      described = { session, inputs, loaded, lines: lines.slice(0, height).map((line) => truncateToWidth(line, Math.max(0, bodyWidth))) };
      return described.lines;
    };
    return {
      invalidate() { described = undefined; },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape)) return finish(undefined);
        if (matchesKey(data, Key.enter)) return finish(rows[selected]?.path);
        if (matchesKey(data, Key.up)) move(selected - 1);
        else if (matchesKey(data, Key.down)) move(selected + 1);
        else if (matchesKey(data, Key.pageUp)) move(selected - listRows);
        else if (matchesKey(data, Key.pageDown)) move(selected + listRows);
        else if (matchesKey(data, Key.backspace) || data === "\x7f") { query = query.slice(0, -1); refresh(); }
        else if (/^[\x20-\x7e]$/.test(data) && query.length < 100) { query += data; refresh(); }
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === "wheel" && event.wheelDelta) { move(selected + Math.sign(event.wheelDelta)); return { handled: true }; }
        if (event.type !== "click" || event.button !== "left") return;
        if (event.y === 0 && event.x >= width - 3) { finish(undefined); return { handled: true }; }
        const row = event.y - layout.top;
        // Collapsed layouts draw the list in the only pane, so any column inside the frame hits a row.
        const inList = layout.leftWidth ? event.x < layout.leftWidth + 3 : event.x < width;
        const index = first + row;
        if (row < 0 || row >= layout.rows || !inList || !rows[index]) return;
        // First click selects (details follow); clicking the selected row again resumes it.
        if (index === selected) finish(rows[index]!.path);
        else move(index);
        return { handled: true };
      },
      render(available: number): string[] {
        width = Math.max(12, available);
        listRows = contentRows(CHROME, 4);
        selected = Math.max(0, Math.min(selected, rows.length - 1));
        reveal();
        const leftWidth = sidebarWidth(width, 22, 40);
        const bodyWidth = leftWidth ? width - leftWidth - 6 : width - 4;
        const listWidth = leftWidth || bodyWidth;
        const list = rows.slice(first, first + listRows).map((session, offset) => {
          const active = first + offset === selected;
          const when = age(session.modified);
          const title = truncateToWidth(cleanText(sessionDisplayName(session.name, session.id), 200), Math.max(1, listWidth - 2 - (when ? when.length + 1 : 0)));
          return fg(active ? "accent" : "muted", (active ? "▌" : " ") + " " + title) + (when ? fg("dim", " " + when) : "");
        });
        if (!rows.length) list.push(fg("dim", "No matching sessions"));
        const session = rows[selected];
        if (session && leftWidth) load(session);
        const right = leftWidth ? (session ? describe(session, bodyWidth, listRows) : []) : list;
        const footer = [
          fg("muted", `Search: ${cleanText(query, 100)}${query ? "" : fg("dim", "(type to filter)")}`),
          fg("dim", "Type to search · ↑↓/PgUp/PgDn select · Enter/click again resume · Esc cancel")
        ];
        const split = splitFrame(theme, width, `${withIcon("session", "SESSIONS")} · ${rows.length}/${sessions.length}`, leftWidth ? list : [], right, footer, listRows, leftWidth);
        layout = split.layout;
        return available < width ? split.lines.map((line) => truncateToWidth(line, Math.max(0, available))) : split.lines;
      }
    };
  }, { filter: false });
}
