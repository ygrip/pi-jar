import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Character counts are diagnostics, NOT token estimates: signatures can be opaque ciphertext. */
export interface ContextDietStats {
  removedThinkingParts: number;
  removedVisibleChars: number;
  removedSignatureChars: number;
}

export interface DietMessage {
  role: string;
  content?: unknown;
  toolCallId?: string;
}

const emptyStats = (): ContextDietStats => ({ removedThinkingParts: 0, removedVisibleChars: 0, removedSignatureChars: 0 });
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * Opt-in provider-context projection; never edits the session or mutates its messages.
 * Only prior user turns are eligible. The complete current reasoning/tool chain is retained.
 * Ambiguous, unresolved or boundary-crossing historical tool calls make the whole projection
 * a no-op: reducing context is less important than preserving provider sequencing constraints.
 */
export function trimCompletedThinking<T extends DietMessage>(messages: T[]): { messages: T[]; stats: ContextDietStats } {
  const stats = emptyStats();
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === "user") { boundary = index; break; }
  }
  const firstUser = messages.findIndex(message => message.role === "user");
  if (boundary <= 0 || firstUser === boundary) return { messages, stats };

  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "toolResult") {
      const id = message.toolCallId;
      if (typeof id !== "string" || !id || results.has(id)) return { messages, stats };
      results.set(id, index);
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const value of message.content) {
      const part = record(value);
      if (part?.type !== "toolCall") continue;
      const id = part.id;
      if (typeof id !== "string" || !id || calls.has(id)) return { messages, stats };
      calls.set(id, index);
    }
  }
  for (const [id, index] of calls) {
    if (index >= boundary) continue;
    const result = results.get(id);
    if (result === undefined || result <= index || result >= boundary) return { messages, stats };
  }
  // A detached historical result means the original reasoning sequence is not fully known.
  for (const [id, index] of results) {
    if (index < boundary && !calls.has(id)) return { messages, stats };
  }

  let changed = false;
  const projected = messages.map((message, index) => {
    if (index < firstUser || index >= boundary || message.role !== "assistant" || !Array.isArray(message.content)) return message;
    const kept = message.content.filter(value => record(value)?.type !== "thinking");
    // Retain thinking-only rows unchanged rather than manufacturing empty assistant messages.
    if (!kept.length || kept.length === message.content.length) return message;
    for (const value of message.content) {
      const part = record(value);
      if (part?.type !== "thinking") continue;
      stats.removedThinkingParts++;
      if (typeof part.thinking === "string") stats.removedVisibleChars += part.thinking.length;
      if (typeof part.thinkingSignature === "string") stats.removedSignatureChars += part.thinkingSignature.length;
    }
    changed = true;
    return { ...message, content: kept } as T;
  });
  return { messages: changed ? projected : messages, stats };
}

/** Register a runtime-toggleable diet; caller owns its persisted, opt-in setting. */
export function registerContextDiet(pi: ExtensionAPI, enabled: () => boolean): { stats: () => ContextDietStats } {
  let latest = emptyStats();
  pi.on("context", event => {
    latest = emptyStats();
    if (!enabled()) return;
    const result = trimCompletedThinking(event.messages);
    latest = result.stats;
    if (result.messages !== event.messages) return { messages: result.messages };
  });
  pi.on("session_start", () => { latest = emptyStats(); });
  return { stats: () => ({ ...latest }) };
}
