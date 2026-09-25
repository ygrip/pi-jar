import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { parsePlanSections, type PlanSection } from "./plan-utils.ts";
import { contentRows, sidebarWidth, splitFrame } from "./split-view.ts";

export type PlanViewAction = "implement" | "compact" | "refine" | "edit" | "stop";
export interface PlanViewResult { action: PlanViewAction; role?: string }
export interface PlanViewInput { title: string; text: string; path?: string; roles?: readonly string[]; role?: string }

const ACTIONS: { action: PlanViewAction; label: string }[] = [
  { action: "implement", label: "1 ▶ Approve & execute" },
  { action: "compact", label: "2 ◇ Approve, compact & execute" },
  { action: "refine", label: "3 ✎ Refine" },
  { action: "stop", label: "4 ■ Stop" }
];
type Focus = "toc" | "body" | "actions";

export interface PlanEntry { title: string; level: number; start: number; end: number }

/** Table of contents: a lone H1 becomes the title; H2/H3 become entries; preamble becomes "Overview". */
export function planEntries(text: string): { title?: string; entries: PlanEntry[] } {
  const lines = text.replace(/\r/g, "").split("\n");
  const sections = parsePlanSections(text);
  const h1 = sections.filter((section) => section.level === 1);
  const title = h1.length === 1 ? h1[0]!.title : undefined;
  const visible = sections.filter((section) => section.level <= 3 && !(title && section.level === 1));
  const entries: PlanEntry[] = visible.map((section) => ({ title: section.title, level: section.level, start: section.start, end: subtreeEnd(sections, section, lines.length) }));
  const firstStart = visible[0]?.start ?? lines.length;
  const preambleStart = title ? h1[0]!.start + 1 : 0;
  if (visible.length && lines.slice(preambleStart, firstStart).some((line) => line.trim())) {
    entries.unshift({ title: "Overview", level: 2, start: preambleStart - (title ? 1 : 0), end: firstStart });
  }
  if (!entries.length) entries.push({ title: title ?? "Plan", level: 2, start: 0, end: lines.length });
  return { ...(title ? { title } : {}), entries };
}

function subtreeEnd(sections: readonly PlanSection[], section: PlanSection, total: number): number {
  const next = sections.find((candidate) => candidate.start > section.start && candidate.level <= section.level);
  return next?.start ?? total;
}

/** Full-screen plan review: headings on the left, the selected section on the right, actions below. */
export async function openPlanView(ctx: ExtensionContext, input: PlanViewInput): Promise<PlanViewResult | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") return undefined;
  const lines = input.text.replace(/\r/g, "").split("\n");
  const { title, entries } = planEntries(input.text);
  const roleChoices = ["current", ...(input.roles ?? [])];
  return ctx.ui.custom<PlanViewResult | undefined>((tui, theme, _keys, done) => {
    let selected = 0;
    let focus: Focus = "toc";
    let action = 0;
    let role = Math.max(0, roleChoices.indexOf(input.role ?? "current"));
    let scroll = 0;
    let tocScroll = 0;
    let width = 80;
    let bodyRows = 0;
    let rendered: { key: string; lines: string[] } | undefined;
    let layout = { top: 1, rows: 0, leftWidth: 0, bodyX: 2, footerTop: 0 };
    let chips: { start: number; end: number; index: number }[] = [];
    let roleChip = { start: -1, end: -1 };
    const finish = (value: PlanViewAction) => done({ action: value, ...(roleChoices[role] !== "current" ? { role: roleChoices[role] } : {}) });
    const body = (bodyWidth: number) => {
      const entry = entries[selected]!;
      const key = `${selected}:${bodyWidth}`;
      if (rendered?.key !== key) {
        const markdown = new Markdown(lines.slice(entry.start, entry.end).join("\n"), 0, 0, getMarkdownTheme());
        rendered = { key, lines: markdown.render(Math.max(1, bodyWidth)) };
      }
      return rendered.lines;
    };
    const selectEntry = (index: number) => { selected = Math.max(0, Math.min(entries.length - 1, index)); scroll = 0; };
    const scrollBody = (delta: number) => { scroll = Math.max(0, Math.min(Math.max(0, (rendered?.lines.length ?? 0) - bodyRows), scroll + delta)); };
    return {
      invalidate() { rendered = undefined; },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || data === "q") return finish("stop");
        if (/^[1-4]$/.test(data)) return finish(ACTIONS[Number(data) - 1]!.action);
        if (data === "e") return finish("edit");
        if (data === "r") role = (role + 1) % roleChoices.length;
        else if (matchesKey(data, Key.tab)) focus = focus === "toc" ? "body" : focus === "body" ? "actions" : "toc";
        else if (matchesKey(data, Key.shift("tab"))) focus = focus === "toc" ? "actions" : focus === "body" ? "toc" : "body";
        else if (matchesKey(data, Key.pageDown) || data === " ") scrollBody(Math.max(1, bodyRows - 2));
        else if (matchesKey(data, Key.pageUp)) scrollBody(-Math.max(1, bodyRows - 2));
        else if (data === "g") focus === "toc" ? selectEntry(0) : scrollBody(-Infinity);
        else if (data === "G") focus === "toc" ? selectEntry(entries.length - 1) : scrollBody(Infinity);
        else if (matchesKey(data, Key.enter)) {
          if (focus === "actions") return finish(ACTIONS[action]!.action);
          focus = focus === "toc" ? "body" : "actions";
        } else if (matchesKey(data, Key.up) || data === "k") {
          if (focus === "toc") selectEntry(selected - 1); else if (focus === "body") scrollBody(-1); else action = (action + ACTIONS.length - 1) % ACTIONS.length;
        } else if (matchesKey(data, Key.down) || data === "j") {
          if (focus === "toc") selectEntry(selected + 1); else if (focus === "body") scrollBody(1); else action = (action + 1) % ACTIONS.length;
        } else if (matchesKey(data, Key.left) || data === "h") {
          if (focus === "actions") action = (action + ACTIONS.length - 1) % ACTIONS.length; else focus = "toc";
        } else if (matchesKey(data, Key.right) || data === "l") {
          if (focus === "actions") action = (action + 1) % ACTIONS.length; else focus = "body";
        }
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        const row = event.y - layout.top;
        const inContent = row >= 0 && row < layout.rows;
        const inToc = layout.leftWidth > 0 && event.x < layout.leftWidth + 3;
        if (event.type === "wheel" && event.wheelDelta) {
          if (inContent && inToc) selectEntry(selected + Math.sign(event.wheelDelta));
          else scrollBody(Math.sign(event.wheelDelta) * 3);
          tui.requestRender(); return { handled: true };
        }
        // Leave press/drag/release to Pi so text selection (and copy-on-select) keeps working.
        if (event.type !== "click" || event.button !== "left") return;
        if (event.y === 0 && event.x >= width - 3) { finish("stop"); return { handled: true }; }
        if (inContent && inToc) {
          const index = tocScroll + row;
          if (index < entries.length) { selectEntry(index); focus = "toc"; tui.requestRender(); return { handled: true, focus: true }; }
        }
        if (inContent) { focus = "body"; tui.requestRender(); return { handled: true, focus: true }; }
        if (event.y === layout.footerTop) {
          const chip = chips.find((item) => event.x - 2 >= item.start && event.x - 2 < item.end);
          if (chip) { action = chip.index; finish(ACTIONS[chip.index]!.action); return { handled: true }; }
        }
        if (event.y === layout.footerTop + 1 && event.x - 2 >= roleChip.start && event.x - 2 < roleChip.end) {
          role = (role + 1) % roleChoices.length; tui.requestRender(); return { handled: true, focus: true };
        }
      },
      render(available: number): string[] {
        width = Math.max(24, available);
        bodyRows = contentRows(6, 6);
        const tocWidth = sidebarWidth(width);
        const bodyWidth = tocWidth ? width - tocWidth - 6 : width - 4;
        const narrowHeader = tocWidth ? [] : [theme.fg("accent", `‹ ${selected + 1}/${entries.length} ${entries[selected]!.title} ›`), ""];
        const content = [...narrowHeader, ...body(bodyWidth)];
        const rows = bodyRows;
        scroll = Math.max(0, Math.min(scroll, Math.max(0, content.length - rows)));
        if (selected < tocScroll) tocScroll = selected;
        if (selected >= tocScroll + rows) tocScroll = selected - rows + 1;
        const toc = entries.slice(tocScroll, tocScroll + rows).map((entry, index) => {
          const current = tocScroll + index === selected;
          const indent = "  ".repeat(Math.max(0, entry.level - 2));
          const text = (current ? "▌" : " ") + indent + entry.title;
          return theme.fg(current ? (focus === "toc" ? "accent" : "warning") : entry.level > 2 ? "dim" : "muted", truncateToWidth(text, tocWidth));
        });
        const window = content.slice(scroll, scroll + rows);
        const position = content.length > rows ? ` ${scroll + 1}–${Math.min(content.length, scroll + rows)}/${content.length}` : "";
        let x = 0;
        chips = [];
        const actionRow = ACTIONS.map((item, index) => {
          const text = `[ ${item.label} ]`;
          chips.push({ start: x, end: x + visibleWidth(text), index });
          x += visibleWidth(text) + 1;
          const active = focus === "actions" && index === action;
          return theme.fg(active ? "accent" : "muted", active ? theme.bold?.(text) ?? text : text);
        }).join(" ");
        const roleText = `[ continue with: ${roleChoices[role]} ⟳ ]`;
        roleChip = { start: 0, end: visibleWidth(roleText) };
        const hints = theme.fg("dim", "  Tab focus · ↑↓ move · PgUp/PgDn scroll · r role · e edit · Esc stop" + (input.path ? " · " + input.path : ""));
        const split = splitFrame(theme, width, "◆ PLAN" + (title ? " · " + title : "") + " · read-only" + position, toc, window,
          [actionRow, theme.fg("accent", roleText) + hints], rows, tocWidth);
        layout = split.layout;
        return split.lines;
      }
    };
  }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } });
}
