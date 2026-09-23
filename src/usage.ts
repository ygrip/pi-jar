import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Sum the active session branch, not all historical branches, using Pi's reported monetary cost. */
export function sessionCost(ctx: Pick<ExtensionContext, "sessionManager">): number {
  let total = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const value = entry.message.usage.cost.total;
    if (Number.isFinite(value) && value >= 0) total += value;
  }
  return total;
}

export function formatCost(value: number): string {
  return `cost $${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
}
