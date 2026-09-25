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
  add(call: SideCall): void { this.calls.push(call); if (this.calls.length > 500) this.calls.shift(); }
  all(): readonly SideCall[] { return this.calls; }
  clear(): void { this.calls = []; }
}

export interface SideAnswer { text: string; model: string }

/**
 * Ask the model assigned to `role` (or the current model) a one-shot question outside the
 * conversation. Throws on a missing model, provider error or empty answer.
 */
export async function askRole(ctx: ExtensionContext, roles: ModelRoleManager, usage: SideUsage | undefined, role: string,
  systemPrompt: string, prompt: string, signal?: AbortSignal): Promise<SideAnswer> {
  const assigned = roles.resolve(role);
  const model = assigned ? ctx.modelRegistry.find(assigned.provider, assigned.model) : ctx.model;
  if (!model) throw new Error(assigned ? `model not found for role ${role}: ${assigned.provider}/${assigned.model}` : "no model selected");
  const thinking: ThinkingLevel | undefined = assigned?.thinking;
  const reasoning = thinking && thinking !== "off" ? thinking : undefined;
  const result = await ctx.modelRegistry.streamSimple(model,
    { systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
    { ...(reasoning ? { reasoning } : {}), ...(signal ? { signal } : {}) }).result();
  const name = `${model.provider}/${model.id}`;
  const cost = result.usage?.cost?.total;
  usage?.add({ role, model: name, input: result.usage?.input ?? 0, output: result.usage?.output ?? 0, cacheRead: result.usage?.cacheRead ?? 0,
    cacheWrite: result.usage?.cacheWrite ?? 0, cost: Number.isFinite(cost) ? cost! : 0, at: Date.now() });
  if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage || `${name} ${result.stopReason}`);
  const text = result.content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("").trim();
  if (!text) throw new Error(`${name} returned an empty answer`);
  return { text, model: name };
}
