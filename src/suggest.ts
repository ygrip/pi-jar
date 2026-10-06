import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { cleanText } from "./status.ts";
import { setToolActive } from "./tool-activation.ts";

export const SUGGEST_TOOL = "jar_suggest";
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
}

/** Ask the agent for one next-prompt suggestion per finished request, like an inline autocomplete. */
export function registerSuggestions(pi: ExtensionAPI, state: SuggestionState, options: SuggestionOptions): { sync(): void } {
  pi.registerTool?.({
    name: SUGGEST_TOOL,
    label: "suggest",
    description: "Optionally offer one useful next prompt (one imperative line under 120 characters) as ghost text in the input box; Tab accepts it for editing. Call once as the final action; do not mention it in your reply.",
    promptSnippet: "Optionally end with one jar_suggest call only when one clear next prompt is worth surfacing; skip it for routine completions.",
    parameters: Type.Object({ suggestion: Type.String({ description: "The user's likely next prompt, one line." }) }),
    execute: async (_id, params) => {
      const ok = state.set(params.suggestion ?? "");
      return { content: [{ type: "text", text: ok ? "Suggestion shown to the user. End your turn now." : "Suggestion was empty; skipped." }], details: { suggestion: state.text }, terminate: true };
    },
    renderCall() { return new Text("", 0, 0); },
    renderResult(result, _options, theme) {
      const text = (result.details as { suggestion?: string } | undefined)?.suggestion;
      return new Text(text ? theme.fg("dim", "↳ next: " + text + "  (Tab in the input box)") : "", 0, 0);
    }
  });

  const sync = () => {
    setToolActive(pi, SUGGEST_TOOL, options.enabled());
    if (!options.enabled()) state.clear();
  };

  pi.on("input", (event) => {
    if (event.source !== "interactive") return;
    state.clear();
  });
  pi.on("agent_start", () => { state.clear(); });
  pi.on("session_start", () => { state.clear(); });
  pi.on("session_tree", () => { state.clear(); });
  // No settle hook: suggestions must not add a provider turn or a hidden session entry.
  return { sync };
}
