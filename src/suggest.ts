import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { cleanText } from "./status.ts";

export const SUGGEST_TOOL = "jar_suggest";
const REMINDER_TYPE = "pi-jar.suggest-reminder";
const MAX_SUGGESTION = 160;

/** The next-prompt suggestion shown as ghost text in an empty composer. Session-only, never persisted. */
export class SuggestionState {
  private value: string | undefined;
  private readonly listeners = new Set<() => void>();
  get text(): string | undefined { return this.value; }
  set(text: string): boolean {
    const next = cleanText(text.replace(/\s+/g, " "), MAX_SUGGESTION);
    if (!next) return false;
    if (next !== this.value) { this.value = next; this.emit(); }
    return true;
  }
  clear(): void { if (this.value !== undefined) { this.value = undefined; this.emit(); } }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { for (const listener of this.listeners) listener(); }
}

export interface SuggestionOptions {
  enabled: () => boolean;
  /** Skip enforcement while another workflow owns the next step (plan review, goal loop). */
  skip: () => boolean;
}

/** Ask the agent for one next-prompt suggestion per finished request, like an inline autocomplete. */
export function registerSuggestions(pi: ExtensionAPI, state: SuggestionState, options: SuggestionOptions): { sync(): void } {
  let suggested = false;
  let reminded = false;
  pi.registerTool?.({
    name: SUGGEST_TOOL,
    label: "suggest",
    description: "Offer the user one short next prompt. It appears as dimmed ghost text in their input box; Tab accepts it for editing. Call it once, last, when you finish a request.",
    promptSnippet: "Finish each completed request by calling jar_suggest with the most useful next prompt for the user.",
    promptGuidelines: [
      "When you finish the user's request, call jar_suggest exactly once as your final action with the single most useful next prompt the user could send (imperative, one line, under 120 characters, written as the user would type it, e.g. \"Run the full test suite\").",
      "Do not mention jar_suggest or the suggestion in your reply, and do not call it mid-task or while waiting for an answer."
    ],
    parameters: Type.Object({ suggestion: Type.String({ description: "The user's likely next prompt, one line." }) }),
    execute: async (_id, params) => {
      const ok = state.set(params.suggestion ?? "");
      suggested ||= ok;
      return { content: [{ type: "text", text: ok ? "Suggestion shown to the user. End your turn now." : "Suggestion was empty; skipped." }], details: { suggestion: state.text }, terminate: true };
    },
    renderCall() { return new Text("", 0, 0); },
    renderResult(result, _options, theme) {
      const text = (result.details as { suggestion?: string } | undefined)?.suggestion;
      return new Text(text ? theme.fg("dim", "↳ next: " + text + "  (Tab in the input box)") : "", 0, 0);
    }
  });

  const sync = () => {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
    const active = pi.getActiveTools();
    const has = active.includes(SUGGEST_TOOL);
    if (options.enabled() && !has && pi.getAllTools().some((tool) => tool.name === SUGGEST_TOOL)) pi.setActiveTools([...active, SUGGEST_TOOL]);
    else if (!options.enabled() && has) pi.setActiveTools(active.filter((name) => name !== SUGGEST_TOOL));
    if (!options.enabled()) state.clear();
  };

  pi.on("input", (event) => {
    if (event.source !== "interactive") return;
    suggested = false;
    reminded = false;
    state.clear();
  });
  pi.on("agent_start", () => { state.clear(); });
  pi.on("session_start", () => { suggested = false; reminded = false; state.clear(); });
  pi.on("session_tree", () => { state.clear(); });
  pi.on("context", async (event) => ({ messages: event.messages.filter((raw) => (raw as { customType?: string }).customType !== REMINDER_TYPE) }));

  pi.on("agent_before_settle", (event) => {
    if (!options.enabled() || options.skip() || event.continue || event.outcome !== "completed" || suggested || reminded) return;
    if (typeof pi.getActiveTools === "function" && !pi.getActiveTools().includes(SUGGEST_TOOL)) return;
    reminded = true;
    return {
      entries: [{ type: "custom_message", customType: REMINDER_TYPE, display: false,
        content: "[PI-JAR] Call jar_suggest now with the single most useful next prompt for the user. Do not add any other text." }],
      continue: true
    };
  });
  return { sync };
}
