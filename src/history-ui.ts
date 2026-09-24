import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { createHistorySnapshot, historyChunk, historyPage, safeHistoryText, type HistoryItem } from "./history.ts";

/** Separate, read-only view. Pi's native transcript and session file are never modified. */
export async function openJarHistory(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  // Capture the active branch ONCE on open. Paging and search operate on this snapshot.
  const snapshot = createHistorySnapshot(ctx.sessionManager.getBranch());
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let current = historyPage(snapshot);
    let selected = Math.max(0, current.items.length - 1);
    let expanded = false;
    let detailScroll = 0;
    let offsets = [0];
    let search = "";
    let searching = false;
    let notice = "";
    let width = 76;
    const input = new Input({ prompt: "/", placeholder: "Search previews on this page" });
    const selectedItem = (): HistoryItem | undefined => current.items[selected];
    const budget = () => Math.max(7, Math.floor((process.stdout.rows ?? 24) * 0.8));
    const detailRows = () => expanded ? Math.min(8, Math.max(1, budget() - 9)) : 2;
    const listRows = () => Math.max(1, budget() - 7 - detailRows());
    const first = () => Math.max(0, Math.min(selected - listRows() + 1, current.items.length - listRows()));
    const resetDetails = () => { expanded = false; detailScroll = 0; offsets = [0]; };
    const select = (index: number) => {
      const next = Math.max(0, Math.min(current.items.length - 1, index));
      if (next !== selected) { selected = next; resetDetails(); }
    };
    const page = (number: number) => {
      current = historyPage(snapshot, number);
      selected = Math.max(0, current.items.length - 1);
      resetDetails();
      notice = "";
    };
    const find = (direction: number, includeSelected = false) => {
      if (!search || !current.items.length) return;
      const term = search.toLocaleLowerCase();
      for (let step = includeSelected ? 0 : 1; step < current.items.length + (includeSelected ? 0 : 1); step++) {
        const index = (selected + direction * step + current.items.length * 2) % current.items.length;
        if (current.items[index]!.search.toLocaleLowerCase().includes(term)) { select(index); notice = ""; return; }
      }
      notice = "No match in this page's previews";
    };
    input.onSubmit = (value) => {
      searching = false; input.focused = false;
      search = safeHistoryText(value, 80).trim();
      notice = "";
      find(1, true);
      tui.requestRender();
    };
    input.onEscape = () => { searching = false; input.focused = false; tui.requestRender(); };
    const chunks = () => selectedItem() ? historyChunk(selectedItem()!, offsets.at(-1)!) : undefined;
    const moveChunk = (direction: number) => {
      const chunk = chunks();
      if (direction > 0 && chunk?.more && chunk.nextOffset > offsets.at(-1)!) offsets.push(chunk.nextOffset);
      else if (direction < 0 && offsets.length > 1) offsets.pop();
      detailScroll = 0;
      expanded = true;
    };
    const fit = (text: string) => truncateToWidth(text, Math.max(0, width));
    const line = (content: string) => {
      const inside = Math.max(0, width - 4);
      const clipped = truncateToWidth(content, inside);
      return fit(theme.fg("dim", "│ ") + clipped + " ".repeat(Math.max(0, inside - visibleWidth(clipped))) + theme.fg("dim", " │"));
    };
    const border = (left: string, middle: string, right: string) => fit(theme.fg("dim", left + middle.repeat(Math.max(0, width - 2)) + right));
    return {
      invalidate() { input.invalidate(); },
      handleInput(data: string) {
        if (searching) { input.handleInput(data); tui.requestRender(); return; }
        if (matchesKey(data, Key.escape) || data === "q") { done(); return; }
        if (data === "/") { searching = true; input.focused = true; input.setValue(search); tui.requestRender(); return; }
        if (matchesKey(data, Key.up) || data === "k") select(selected - 1);
        else if (matchesKey(data, Key.down) || data === "j") select(selected + 1);
        else if (matchesKey(data, Key.pageUp)) select(selected - listRows());
        else if (matchesKey(data, Key.pageDown)) select(selected + listRows());
        else if (matchesKey(data, Key.home)) select(0);
        else if (matchesKey(data, Key.end)) select(current.items.length - 1);
        else if (data === "p") page(current.page + 1);
        else if (data === "o") page(current.page - 1);
        else if (data === "n") find(1);
        else if (data === "N") find(-1);
        else if (data === "e" || data === " " || matchesKey(data, Key.enter)) { expanded = !expanded; detailScroll = 0; }
        else if (data === "[" || data === "]") moveChunk(data === "]" ? 1 : -1);
        else if (data === "d") { expanded = true; detailScroll = Math.min(Math.max(0, (chunks()?.lines.length ?? 0) - detailRows()), detailScroll + detailRows()); }
        else if (data === "u") { expanded = true; detailScroll = Math.max(0, detailScroll - detailRows()); }
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === "wheel" && event.wheelDelta) { select(selected + Math.sign(event.wheelDelta) * Math.max(1, Math.abs(event.wheelDelta))); tui.requestRender(); return { handled: true, focus: true }; }
        if (event.type !== "click" || event.button !== "left") return;
        if (event.y === 0 && event.x >= width - 4) { done(); return { handled: true }; }
        if (event.x < 1 || event.x >= width - 1) return;
        const start = first();
        if (event.y >= 3 && event.y < 3 + listRows()) {
          const index = start + event.y - 3;
          if (index < current.items.length) { select(index); tui.requestRender(); return { handled: true, focus: true }; }
        }
        if (event.y === 4 + listRows()) { expanded = !expanded; tui.requestRender(); return { handled: true, focus: true }; }
      },
      render(available: number): string[] {
        width = Math.max(8, available);
        const start = first();
        const items = current.items.slice(start, start + listRows());
        const heading = ` pi-jar · history · ${snapshot.visible.length} turns`;
        const top = fit(theme.fg("accent", "╭─" + truncateToWidth(heading, Math.max(0, width - 6))
          + "─".repeat(Math.max(0, width - 4 - visibleWidth(heading))) + "×╮"));
        const subtitle = ` Active branch · page ${current.page + 1}/${current.totalPages} · snapshot at open`;
        const rows = items.length ? items.map((item, position) => {
          const index = start + position;
          const prefix = `${index === selected ? "●" : "○"} #${item.sequence} ${item.actor}${item.error ? " !" : ""}`;
          const time = item.time && width >= 74 ? ` · ${item.time}` : "";
          const spare = Math.max(0, width - 6 - visibleWidth(prefix + time));
          const summary = truncateToWidth(item.summary.replace(/\s+/g, " "), spare);
          return line(theme.fg(index === selected ? "accent" : "muted", prefix) + theme.fg("dim", time + " │ ") + summary);
        }) : [line(theme.fg("dim", " No visible messages on this branch"))];
        while (rows.length < listRows()) rows.push(line(""));
        const item = selectedItem();
        const chunk = chunks();
        const headingDetail = item ? `${item.actor} #${item.sequence} ${item.time ?? ""} · ${offsets.length} segment${chunk?.more ? " →" : ""}` : "No selected entry";
        const details = item && chunk ? chunk.lines.slice(detailScroll, detailScroll + detailRows()) : [];
        const body = Array.from({ length: detailRows() }, (_, i) => {
          const raw = details[i] ?? "";
          const code = raw.trimStart().startsWith("```") || raw.startsWith("    ");
          return line(theme.fg(code ? "muted" : "text", truncateToWidth(raw, Math.max(0, width - 5))));
        });
        const help = searching ? line(input.render(Math.max(1, width - 4))[0] ?? "/")
          : line(theme.fg("dim", notice || (width >= 66 ? "↑↓/Pg: move · /: search · n/N: next · e: expand · d/u: detail · [ ]: chunks · p/o: pages · Esc" : "↑↓ move · / search · e expand · p/o pages · Esc")));
        return [top, line(theme.fg("muted", subtitle)), border("├", "─", "┤"), ...rows,
          border("├", "─", "┤"), line(theme.fg("accent", headingDetail)), ...body, help, border("╰", "─", "╯")].map(fit);
      }
    };
  }, { overlay: true, overlayOptions: { anchor: "center", width: 92, maxHeight: "80%" } });
}
