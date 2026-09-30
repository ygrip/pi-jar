import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRoleManager, ThinkingLevel } from "./model-roles.ts";

/** One model call pi-jar made outside the main conversation (advisor, commit message, ...). */
export interface SideCall {
  role: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  at: number;
}

/** Session-scoped record of side calls, so /usage can show what they cost. */
export class SideUsage {
  private calls: SideCall[] = [];
  add(call: SideCall): void {
    this.calls.push(call);
    if (this.calls.length > 512) this.calls.splice(0, 64);
  }
  all(): readonly SideCall[] { return this.calls; }
  clear(): void { this.calls = []; }
}

export interface SideAnswer { text: string; model: string }

/**
 * Ask the model assigned to `role` (or the current model) a one-shot question outside the
 * conversation. Tries configured fallbacks in order on failure; cancellation never retries.
 */
export async function askRole(ctx: ExtensionContext, roles: ModelRoleManager, usage: SideUsage | undefined, role: string,
  systemPrompt: string, prompt: string, signal?: AbortSignal): Promise<SideAnswer> {
  const fallbacks = roles.fallbackSpecs?.(role) ?? [];
  const failures: string[] = [];
  const tried = new Set<string>();
  for (const spec of [undefined, ...fallbacks]) {
    signal?.throwIfAborted();
    let name = spec ?? role;
    let aborted = false;
    try {
      const assigned = spec === undefined ? roles.resolve(role) : roles.resolveSpec(spec);
      const model = assigned ? ctx.modelRegistry.find(assigned.provider, assigned.model) : ctx.model;
      if (!model) throw new Error(assigned ? `model not found for role ${role}: ${assigned.provider}/${assigned.model}` : "no model selected");
      name = `${model.provider}/${model.id}`;
      const key = name + ":" + (assigned?.thinking ?? "off");
      if (tried.has(key)) continue;
      tried.add(key);
      const thinking: ThinkingLevel | undefined = assigned?.thinking;
      const reasoning = thinking && thinking !== "off" ? thinking : undefined;
      const result = await ctx.modelRegistry.streamSimple(model,
        { systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        { ...(reasoning ? { reasoning } : {}), ...(signal ? { signal } : {}) }).result();
      const cost = result.usage?.cost?.total;
      usage?.add({ role, model: name, input: result.usage?.input ?? 0, output: result.usage?.output ?? 0, cacheRead: result.usage?.cacheRead ?? 0,
        cacheWrite: result.usage?.cacheWrite ?? 0, cost: Number.isFinite(cost) ? cost! : 0, at: Date.now() });
      signal?.throwIfAborted();
      aborted = result.stopReason === "aborted";
      if (result.stopReason === "error" || aborted) throw new Error(result.errorMessage || `${name} ${result.stopReason}`);
      const MAX_ANSWER_CHARS = 32 * 1024;
      let text = "";
      for (const part of result.content) {
        if (part.type !== "text") continue;
        const value = (part as { text: string }).text;
        const room = MAX_ANSWER_CHARS - text.length;
        if (room <= 0) break;
        text += value.slice(0, room);
      }
      text = text.trim();
      if (!text) throw new Error(`${name} returned an empty answer`);
      return { text, model: name };
    } catch (error) {
      signal?.throwIfAborted();
      if (aborted || (error instanceof Error && error.name === "AbortError") || !fallbacks.length) throw error;
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`All models for role ${role} failed:\n${failures.join("\n")}`);
}
