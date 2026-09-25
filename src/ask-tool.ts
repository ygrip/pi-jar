import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { cleanText } from "./status.ts";

const OptionSchema = Type.Object({
  label: Type.String({ maxLength: 160 }),
  description: Type.Optional(Type.String({ maxLength: 320 }))
});
const QuestionSchema = Type.Object({
  id: Type.Optional(Type.String({ maxLength: 64 })),
  header: Type.Optional(Type.String({ maxLength: 48 })),
  question: Type.String({ maxLength: 1000 }),
  multi: Type.Optional(Type.Boolean()),
  allowCustom: Type.Optional(Type.Boolean()),
  options: Type.Optional(Type.Array(OptionSchema, { maxItems: 12 }))
});
const Parameters = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 8 })
});

type AskOption = { label: string; description?: string };
type AskQuestion = { id?: string; header?: string; question: string; multi?: boolean; allowCustom?: boolean; options?: AskOption[] };
type AskAnswer = { id: string; answer?: string; selected?: string[]; chat?: string; cancelled?: boolean };
type PickResult = { kind: "answer"; selected: string[] } | { kind: "custom" } | { kind: "chat" } | { kind: "cancel" };

const fit = (line: string, width: number) => truncateToWidth(line, Math.max(0, width));

async function pickQuestion(ctx: ExtensionContext, question: AskQuestion, index: number, total: number): Promise<PickResult> {
  const options = (question.options ?? []).map((option) => ({
    label: cleanText(option.label, 120),
    description: option.description ? cleanText(option.description, 240) : undefined
  })).filter((option) => !!option.label);
  if (!ctx.hasUI || ctx.mode !== "tui") return { kind: "cancel" };
  return ctx.ui.custom<PickResult>((tui, theme, _keys, done) => {
    const multi = !!question.multi;
    const allowCustom = question.allowCustom !== false;
    const actions = [
      ...(allowCustom ? [{ kind: "custom" as const, label: "Type your own answer", icon: "✎" }] : []),
      { kind: "chat" as const, label: "Chat about this", icon: "◇" },
      ...(multi ? [{ kind: "submit" as const, label: "Continue with selection", icon: "✓" }] : [])
    ];
    let selected = 0;
    const checked = new Set<number>();
    let hitRows: number[] = [];
    let scroll = 0;
    let lastSelected = selected;
    const totalRows = () => options.length + actions.length;
    const choose = () => {
      if (selected < options.length) {
        if (multi) {
          if (checked.has(selected)) checked.delete(selected); else checked.add(selected);
          return;
        }
        return done({ kind: "answer", selected: [options[selected]!.label] });
      }
      const action = actions[selected - options.length];
      if (!action) return;
      if (action.kind === "custom") return done({ kind: "custom" });
      if (action.kind === "chat") return done({ kind: "chat" });
      return done({ kind: "answer", selected: [...checked].sort((a, b) => a - b).map((at) => options[at]!.label) });
    };
    return {
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, Key.escape)) return done({ kind: "cancel" });
        if (matchesKey(data, Key.up)) selected = (selected + totalRows() - 1) % totalRows();
        else if (matchesKey(data, Key.down)) selected = (selected + 1) % totalRows();
        else if (/^[1-9]$/.test(data)) {
          const at = Number(data) - 1;
          if (at < options.length) { selected = at; choose(); }
        } else if (matchesKey(data, Key.enter) || data === " ") choose();
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === "wheel" && event.wheelDelta) {
          scroll = Math.max(0, scroll + Math.sign(event.wheelDelta) * 3);
          tui.requestRender(); return { handled: true };
        }
        if (event.type !== "click" || event.button !== "left") return;
        const index = hitRows[event.y];
        if (index === undefined) return;
        selected = index;
        choose();
        tui.requestRender();
        return { handled: true };
      },
      render(width: number): string[] {
        hitRows = [];
        const inner = Math.max(1, width - 4);
        const badge = "◆ QUESTION " + String(index + 1) + "/" + String(total) + (multi ? " · MULTI SELECT" : "");
        const title = question.header ? cleanText(question.header, 48) : "Clarification";
        const lines: string[] = [
          fit(theme.fg("accent", "╭─ " + badge + " ─"), width),
          fit(theme.fg("muted", "│ " + title), width)
        ];
        const content: { line: string; target?: number }[] = [];
        for (const row of wrapTextWithAnsi(cleanText(question.question, 900), inner)) content.push({ line: fit("│ " + row, width) });
        content.push({ line: fit(theme.fg("dim", "├" + "─".repeat(Math.max(0, width - 1))), width) });
        options.forEach((option, at) => {
          const active = selected === at;
          const marker = multi ? (checked.has(at) ? "☑" : "☐") : (active ? "●" : "○");
          const number = String(at + 1).padStart(2, " ") + ".";
          content.push({ target: at, line: fit(theme.fg(active ? "accent" : "muted", "│ " + (active ? "❯ " : "  ") + marker + " " + number + " " + option.label), width) });
          if (option.description) content.push({ target: at, line: fit(theme.fg("dim", "│      " + option.description), width) });
        });
        actions.forEach((action, at) => {
          const row = options.length + at;
          const active = row === selected;
          const chip = "[ " + action.icon + " " + action.label + " ]";
          content.push({ target: row, line: fit(theme.fg(active ? "accent" : "dim", "│ " + (active ? "❯ " : "  ") + chip), width) });
        });
        const page = Math.max(3, Math.min(16, (process.stdout.rows ?? 24) - 5));
        if (selected !== lastSelected) {
          const target = content.findIndex((row) => row.target === selected);
          if (target < scroll) scroll = target;
          else if (target >= scroll + page) scroll = target - page + 1;
          lastSelected = selected;
        }
        scroll = Math.max(0, Math.min(scroll, Math.max(0, content.length - page)));
        content.slice(scroll, scroll + page).forEach((row) => {
          if (row.target !== undefined) hitRows[lines.length] = row.target;
          lines.push(row.line);
        });
        const hint = multi ? "↑↓ move · Space/Enter toggle · wheel scroll · Esc cancel" : "↑↓ move · Enter choose · wheel scroll · Esc cancel";
        lines.push(fit(theme.fg("dim", `╰─ ${scroll + 1}–${Math.min(scroll + page, content.length)}/${content.length} · ${hint}`), width));
        return lines.map((line) => visibleWidth(line) <= width ? line : fit(line, width));
      }
    };
  });
}

async function askOne(ctx: ExtensionContext, question: AskQuestion, index: number, total: number): Promise<AskAnswer> {
  const id = cleanText(question.id ?? "q" + String(index + 1), 64) || "q" + String(index + 1);
  const picked = await pickQuestion(ctx, question, index, total);
  if (!picked || picked.kind === "cancel") return { id, cancelled: true };
  if (picked.kind === "custom") {
    const text = await ctx.ui.editor("✎ Your answer · " + cleanText(question.header ?? "Question", 48), "");
    return text?.trim() ? { id, answer: text.trim() } : { id, cancelled: true };
  }
  if (picked.kind === "chat") {
    const text = await ctx.ui.editor("◇ Chat about this · " + cleanText(question.header ?? "Question", 48), "I want to discuss this before I answer. ");
    return text?.trim() ? { id, chat: text.trim() } : { id, cancelled: true };
  }
  return question.multi ? { id, selected: picked.selected } : { id, answer: picked.selected[0] ?? "" };
}

export function registerAskTool(pi: ExtensionAPI): void {
  if (typeof (pi as ExtensionAPI & { registerTool?: unknown }).registerTool !== "function") return;
  pi.registerTool({
    name: "jar_ask",
    label: "ask user",
    description: "Ask the user one or more structured clarification questions with described choices, multi-select checkboxes, custom text, or a chat-about-this path.",
    promptSnippet: "Use jar_ask when a decision or clarification is needed; prefer concise options with useful descriptions.",
    promptGuidelines: [
      "Use jar_ask instead of writing ad-hoc numbered questions when the user needs to choose between options or provide clarification.",
      "Use multi=true only when several answers may be selected. Include short descriptions when labels alone are ambiguous.",
      "If a jar_ask result contains chat, respond to that discussion before asking for a final choice again."
    ],
    parameters: Parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const questions = params.questions as AskQuestion[];
      if (!ctx.hasUI || ctx.mode !== "tui") {
        return { content: [{ type: "text", text: "Structured questions require Pi's interactive TUI." }], details: { answers: [] } };
      }
      const answers: AskAnswer[] = [];
      for (let index = 0; index < questions.length; index++) {
        const answer = await askOne(ctx, questions[index]!, index, questions.length);
        answers.push(answer);
        if (answer.cancelled || answer.chat) break;
      }
      const summary = answers.map((answer) => {
        if (answer.cancelled) return answer.id + ": cancelled";
        if (answer.chat) return answer.id + ": CHAT: " + answer.chat;
        if (answer.selected) return answer.id + ": " + (answer.selected.length ? answer.selected.join(", ") : "(none selected)");
        return answer.id + ": " + (answer.answer ?? "");
      }).join("\n");
      return { content: [{ type: "text", text: summary || "No answers." }], details: { answers } };
    }
  });
}
