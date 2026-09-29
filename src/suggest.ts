import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { cleanText } from "./status.ts";

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
    description: "Offer the user one short next prompt. It appears as dimmed ghost text in their input box; Tab accepts it for editing. Call it once, last, when you finish a request.",
    promptSnippet: "Optionally use jar_suggest at the end when one genuinely useful next prompt would help the user continue.",
    promptGuidelines: [
      "jar_suggest is best-effort, not mandatory. Use it only when there is one clear next action worth surfacing; skip it for routine completions.",
      "When used, call it once as the final action with one imperative line under 120 characters. Do not mention jar_suggest in your reply."
    ],
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
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
    const active = pi.getActiveTools();
    const has = active.includes(SUGGEST_TOOL);
    if (options.enabled() && !has && pi.getAllTools().some((tool) => tool.name === SUGGEST_TOOL)) pi.setActiveTools([...active, SUGGEST_TOOL]);
    else if (!options.enabled() && has) pi.setActiveTools(active.filter((name) => name !== SUGGEST_TOOL));
    if (!options.enabled()) state.clear();
  };

  pi.on("input", (event) => {
    if (event.source !== "interactive") return;
    state.clear();
  });
  pi.on("agent_start", () => { state.clear(); });
  pi.on("session_start", () => { state.clear(); });
  pi.on("session_tree", () => { state.clear(); });
  // Do not force a second provider turn merely to manufacture ghost text. Older pi-jar versions
  // appended a hidden reminder here, which added one session entry and sometimes another model call
  // to every request. Suggestions are intentionally best-effort now.
  pi.on("agent_before_settle", () => undefined);
  return { sync };
}
