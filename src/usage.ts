import { sessionBranch } from "./session-branch.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Sum the active session branch, not all historical branches, using Pi's reported monetary cost. */
export function sessionCost(ctx: Pick<ExtensionContext, "sessionManager">): number {
  let total = 0;
  for (const entry of sessionBranch(ctx) as ReturnType<typeof ctx.sessionManager.getBranch>) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const value = entry.message.usage.cost.total;
    if (Number.isFinite(value) && value >= 0) total += value;
  }
  return total;
}

/** `cost $1.23`, plus the recent average per provider call when there is one: `cost $1.23 · $0.04/call`. */
export function formatCost(value: number, perCall?: number): string {
  const money = (amount: number) => `$${amount < 0.01 && amount > 0 ? amount.toFixed(4) : amount.toFixed(2)}`;
  return `cost ${money(value)}` + (perCall !== undefined && perCall > 0 ? ` · ${money(perCall)}/call` : "");
}
