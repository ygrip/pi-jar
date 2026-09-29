import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext, type Skill } from "@earendil-works/pi-coding-agent";
import { contextBreakdown, contextLines } from "./context-view.ts";
import { openPanel, type PanelTab } from "./panel.ts";
import type { Quota } from "./quota.ts";
import type { SideUsage } from "./side-model.ts";
import { collectUsage, usageLines } from "./usage-view.ts";
import { sessionBranch } from "./session-branch.ts";

/** Pi's default compaction reserve, used when its settings cannot be read. */
const DEFAULT_RESERVE = 16_384;

export interface InfoPanelDeps {
  side: SideUsage;
  quota(ctx: ExtensionContext): Quota | undefined;
  quotaEnabled(): boolean;
}

function reserveTokens(ctx: ExtensionContext): number {
  try {
    const settings = SettingsManager.create(ctx.cwd, getAgentDir());
    if (!settings.getCompactionEnabled()) return 0;
    return settings.getCompactionReserveTokens(ctx.model ?? undefined);
  } catch (error) {
    ctx.ui.notify("pi-jar: could not read compaction settings, assuming the default buffer: " + String(error), "warning");
    return DEFAULT_RESERVE;
  }
}

/** Context files and skills as the last prompt saw them (captured on before_agent_start). */
export interface PromptParts { contextFiles: readonly { path: string; content: string }[]; skills: readonly Skill[] }

export function contextFor(pi: ExtensionAPI, ctx: ExtensionContext, options?: PromptParts) {
  const usage = ctx.getContextUsage();
  const active = new Set(pi.getActiveTools());
  return contextBreakdown({
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model",
    window: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
    reported: usage?.tokens ?? null,
    systemPrompt: ctx.getSystemPrompt(),
    contextFiles: options?.contextFiles ?? [],
    skills: (options?.skills ?? []).filter((skill) => !skill.disableModelInvocation),
    tools: pi.getAllTools().filter((tool) => active.has(tool.name)),
    messages: ctx.sessionManager.buildSessionProjection().messages as never,
    reserve: reserveTokens(ctx)
  });
}

/** `/usage` and `/context`: one tabbed panel, like Claude's usage and context views. */
export function registerInfoPanels(pi: ExtensionAPI, deps: InfoPanelDeps): void {
  let parts: PromptParts | undefined;
  pi.on("before_agent_start", (event) => {
    parts = { contextFiles: event.systemPromptOptions.contextFiles ?? [], skills: event.systemPromptOptions.skills ?? [] };
  });
  pi.on("session_start", () => { parts = undefined; });
  const tabs = (ctx: ExtensionContext): PanelTab[] => {
    // These panels can scan a large branch/projection. Snapshot each expensive view once per
    // panel open, lazily on first render, so scrolling/resizing does not repeat O(history) work.
    let usage: ReturnType<typeof collectUsage> | undefined;
    let context: ReturnType<typeof contextFor> | undefined;
    return [
      { name: "Usage", render: (width, fg) => {
        usage ??= collectUsage(sessionBranch(ctx) as never, deps.side.all());
        const quota = deps.quota(ctx);
        return usageLines({
          stats: usage,
          ...(ctx.model?.provider ? { provider: ctx.model.provider } : {}),
          ...(quota ? { quota } : {}),
          quotaEnabled: deps.quotaEnabled(), now: Date.now()
        }, width, fg);
      } },
      { name: "Context", render: (width, fg) => {
        context ??= contextFor(pi, ctx, parts);
        return contextLines(context, width, fg);
      } }
    ];
  };
  const plain = (_color: string, text: string) => text;
  const open = async (ctx: ExtensionContext, tab: number) => {
    try {
      const pages = tabs(ctx);
      if (ctx.hasUI && ctx.mode === "tui") await openPanel(ctx, pages, tab);
      else ctx.ui.notify(pages[tab]!.render(100, plain).join("\n"), "info");
    } catch (error) { ctx.ui.notify("pi-jar: " + (error instanceof Error ? error.message : String(error)), "error"); }
  };
  pi.registerCommand("usage", { description: "Session cost, tokens per model and plan limits (pi-jar)", handler: async (_args, ctx) => open(ctx, 0) });
  pi.registerCommand("context", { description: "Breakdown of what fills the context window (pi-jar)", handler: async (_args, ctx) => open(ctx, 1) });
}
