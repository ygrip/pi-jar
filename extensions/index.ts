import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { execFileSync } from "node:child_process";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { ACCENT_NAMES, loadedAccents, selectAccent } from "../src/accent.ts";
import { ComposerStyle } from "../src/composer.ts";
import { promptText } from "../src/dialogs.ts";
import { renderFooter } from "../src/footer.ts";
import { fetchQuota, QuotaCache, type QuotaProvider } from "../src/quota.ts";
import { createDemoRoles } from "../src/roles.ts";
import { ACTIVE_STATES, collectStatuses, type JarRole } from "../src/status.ts";
import { manageTasks } from "../src/tasks-ui.ts";
import { TASK_ENTRY, TodoStore } from "../src/tasks.ts";
import { formatCost, sessionCost } from "../src/usage.ts";
import { WorkingState } from "../src/working.ts";
import { welcomeLines } from "../src/welcome.ts";

const WELCOME_KEY = "pi-jar.welcome";
export default function piJar(pi: ExtensionAPI): void {
  let demo = false;
  let animations = true;
  let enabled = true;
  let disposeFooter: (() => void) | undefined;
  let footerTui: { requestRender(): void } | undefined;
  let quotaCache: QuotaCache | undefined;
  let cost = 0;
  let welcomeInterval: ReturnType<typeof setInterval> | undefined;
  let welcomeFrame = 0;
  let welcomeDismiss = 0;
  let welcomeTui: { requestRender(): void } | undefined;
  let todos: TodoStore | undefined;
  const composer = new ComposerStyle();
  let welcomeStatuses = (): ReadonlyMap<string, string> => new Map();
  const working = new WorkingState();

  const updateTaskWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const count = todos?.all().filter((item) => !item.done).length ?? 0;
    try {
      ctx.ui.setWidget("pi-jar.todos", !enabled || !count ? undefined : (_tui, theme) => ({
        invalidate() {},
        render(width: number) {
          const colors = ctx.ui.theme ?? theme;
          return [truncateToWidth(colors.fg("accent", `☐ ${count} pi-jar to-do${count === 1 ? "" : "s"}`) + colors.fg("dim", " · /jar tasks"), Math.max(0, width))];
        }
      }));
    } catch { /* Optional widget; task data remains available via /jar tasks. */ }
  };
  const applyWorking = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    try {
      if (!enabled) { ctx.ui.setWorkingMessage?.(); ctx.ui.setWorkingIndicator(); return; }
      const display = () => {
        const view = working.view(animations, (color, text) => ctx.ui.theme?.fg(color, text) ?? text);
        ctx.ui.setWorkingMessage?.(view.message);
        ctx.ui.setWorkingIndicator({ frames: view.frames, intervalMs: 240 });
      };
      display();
    } catch { /* Working decoration must never interrupt a Pi turn. */ }
  };

  const stopWelcome = (ctx?: ExtensionContext) => {
    if (welcomeInterval) clearInterval(welcomeInterval);
    welcomeInterval = undefined;
    welcomeTui = undefined;
    if (ctx?.hasUI && ctx.mode === "tui") {
      try { ctx.ui.setWidget(WELCOME_KEY, undefined); } catch { /* optional widget API */ }
    }
  };
  const showWelcome = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || ctx.mode !== "tui" || !enabled) return;
    stopWelcome(ctx);
    welcomeFrame = 0;
    welcomeDismiss = 0;
    try {
      const contextUsage = ctx.getContextUsage();
      const context = contextUsage?.percent != null && Number.isFinite(contextUsage.percent)
        ? `ctx ${Math.round(contextUsage.percent)}%` : "ctx ?";
      const commands = pi.getCommands().filter((item) => item.source === "extension");
      const managers: ("tasks" | "subagents")[] = [];
      if (commands.some((item) => item.name === "tasks")) managers.push("tasks");
      if (commands.some((item) => item.name === "subagents-fleet")) managers.push("subagents");
      // Git metadata is sampled once per welcome; never spawn processes in render().
      let branch: string | undefined;
      let dirty = false;
      try {
        branch = execFileSync("git", ["branch", "--show-current"], { cwd: ctx.cwd, timeout: 800, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
        dirty = !!execFileSync("git", ["status", "--porcelain"], { cwd: ctx.cwd, timeout: 800, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch { /* Non-git projects do not show a branch. */ }
      const info = {
        model: ctx.model?.id,
        project: ctx.cwd ? basename(ctx.cwd) : undefined,
        context,
        cost: formatCost(cost),
        managers,
        quotaEnabled: quotaCache?.enabled ?? false,
        tasks: todos?.all().filter((item) => !item.done).length,
        branch, dirty
      };
      ctx.ui.setWidget(WELCOME_KEY, (tui, theme) => {
        welcomeTui = tui;
        return { invalidate() {}, render(width: number) {
          const statuses = welcomeStatuses();
          const live = collectStatuses(statuses, Date.now());
          const quota = quotaCache?.get(ctx.model?.provider, statuses, Date.now());
          const lines = welcomeLines(width, welcomeFrame, (color, text) => (ctx.ui.theme ?? theme).fg(color, text), {
            ...info, roles: live.roles, advisor: statuses.get("advisor") ?? statuses.get("pi-jar.advisor"),
            quota: quota?.week?.used ?? quota?.fiveHour?.used
          });
          if (!welcomeDismiss) return lines;
          // A short upward dissolve: dim the remaining art as rows disappear.
          const remaining = Math.max(0, Math.ceil(lines.length * (1 - welcomeDismiss / 5)));
          return lines.slice(0, remaining).map((line) => (ctx.ui.theme ?? theme).fg("dim", line));
        } };
      });
      if (animations) welcomeInterval = setInterval(() => { welcomeFrame++; welcomeTui?.requestRender(); }, 280);
    } catch { stopWelcome(ctx); }
  };

  const installUi = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    if (!enabled) {
      stopWelcome(ctx);
      quotaCache?.stop();
      composer.disable(ctx);
      updateTaskWidget(ctx);
      disposeFooter?.();
      disposeFooter = undefined;
      ctx.ui.setFooter(undefined);
      applyWorking(ctx);
      return;
    }
    applyWorking(ctx);
    updateTaskWidget(ctx);
    try {
      ctx.ui.setFooter((tui, theme, footerData) => {
        footerTui = tui;
        welcomeStatuses = () => footerData.getExtensionStatuses();
        let frame = 0;
        let timer: ReturnType<typeof setInterval> | undefined;
        let expiryTimer: ReturnType<typeof setTimeout> | undefined;
        let disposed = false;
        const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          if (timer) clearInterval(timer);
          if (expiryTimer) clearTimeout(expiryTimer);
          timer = undefined;
          expiryTimer = undefined;
          if (footerTui === tui) { footerTui = undefined; welcomeStatuses = () => new Map<string, string>(); }
          unsubscribe();
        };
        disposeFooter = dispose;
        return {
          dispose,
          invalidate() {},
          render(width: number): string[] {
            try {
              const now = Date.now();
              const statuses = footerData.getExtensionStatuses();
              const live = collectStatuses(statuses, now);
              const roles: JarRole[] = demo ? createDemoRoles() : live.roles;
              if (expiryTimer) clearTimeout(expiryTimer);
              expiryTimer = undefined;
              const nearest = demo ? undefined : roles.reduce<number | undefined>((min, role) =>
                role.expiresAt != null ? Math.min(min ?? Infinity, role.expiresAt) : min, undefined);
              if (nearest != null) expiryTimer = setTimeout(() => tui.requestRender(), Math.max(1, nearest - now));
              const active = animations && roles.some((role) => ACTIVE_STATES.has(role.state));
              if (active && !timer) timer = setInterval(() => { frame += 1; tui.requestRender(); }, 240);
              else if (!active && timer) { clearInterval(timer); timer = undefined; }
              const usage = ctx.getContextUsage();
              const context = usage?.percent == null || !Number.isFinite(usage.percent)
                ? "ctx ?" : `ctx ${Math.round(usage.percent)}%`;
              const quota = quotaCache?.get(ctx.model?.provider, statuses, now);
              return renderFooter({
                model: ctx.model?.id ?? "no-model", branch: footerData.getGitBranch(),
                context, cost: formatCost(cost), quota, roles, extras: live.extras,
                demo, animations, frame, motionBudget: ctx.isIdle() ? 2 : 1
              }, width, ctx.ui.theme ?? theme);
            } catch {
              if (timer) clearInterval(timer);
              if (expiryTimer) clearTimeout(expiryTimer);
              timer = undefined;
              expiryTimer = undefined;
              return width > 0 ? ["pi-jar: UI unavailable (run /jar ui off)".slice(0, width)] : [];
            }
          }
        };
      });
    } catch {
      disposeFooter?.();
      disposeFooter = undefined;
      ctx.ui.setFooter(undefined);
      ctx.ui.notify("pi-jar: custom footer unavailable; using Pi footer", "warning");
    }
  };

  const updateCost = (ctx: ExtensionContext) => {
    try { cost = sessionCost(ctx); } catch { cost = 0; }
    footerTui?.requestRender();
  };
  const restoreTodos = (ctx: ExtensionContext) => {
    try { todos?.restore(ctx.sessionManager.getBranch()); } catch { todos?.restore([]); }
    updateTaskWidget(ctx);
  };
  pi.on("session_start", (_event, ctx) => {
    demo = false;
    composer.disable(ctx);
    working.end();
    quotaCache?.stop();
    todos = new TodoStore((entry) => pi.appendEntry(TASK_ENTRY, entry));
    restoreTodos(ctx);
    // Quota opt-in is deliberately session-local. No credentials or consent are persisted.
    quotaCache = new QuotaCache(
      (provider: QuotaProvider, signal) => fetchQuota(provider, (id) => ctx.modelRegistry.getProviderAuth(id), signal),
      () => footerTui?.requestRender()
    );
    updateCost(ctx);
    installUi(ctx);
    composer.setMotion(animations);
    composer.enable(ctx);
    showWelcome(ctx);
  });
  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive" || !welcomeTui || welcomeDismiss) return;
    if (!animations) { stopWelcome(ctx); return; }
    welcomeDismiss = 1;
    if (welcomeInterval) clearInterval(welcomeInterval);
    welcomeInterval = setInterval(() => {
      welcomeDismiss++;
      if (welcomeDismiss >= 5) stopWelcome(ctx);
      else welcomeTui?.requestRender();
    }, 90);
    welcomeTui.requestRender();
  });
  pi.on("agent_start", (_event, ctx) => { working.start(); applyWorking(ctx); });
  pi.on("turn_start", (_event, ctx) => { working.start(); applyWorking(ctx); });
  pi.on("tool_execution_start", (event, ctx) => { working.toolStart(event.toolCallId, event.toolName); applyWorking(ctx); });
  pi.on("tool_execution_end", (event, ctx) => { working.toolEnd(event.toolCallId); applyWorking(ctx); });
  pi.on("ui_prompt_start", (_event, ctx) => { working.prompt(true); applyWorking(ctx); });
  pi.on("ui_prompt_end", (_event, ctx) => { working.prompt(false); applyWorking(ctx); });
  pi.on("turn_end", (_event, ctx) => { working.end(); applyWorking(ctx); updateCost(ctx); });
  pi.on("agent_end", (_event, ctx) => { working.end(); applyWorking(ctx); });
  pi.on("agent_settled", (_event, ctx) => { working.end(); applyWorking(ctx); });
  pi.on("session_tree", (_event, ctx) => { restoreTodos(ctx); updateCost(ctx); });
  pi.on("session_compact", (_event, ctx) => { restoreTodos(ctx); updateCost(ctx); });
  pi.on("model_select", (_event, _ctx) => footerTui?.requestRender());
  pi.on("session_shutdown", (_event, ctx) => {
    stopWelcome(ctx);
    composer.disable(ctx);
    working.end();
    try { if (ctx.hasUI && ctx.mode === "tui") { ctx.ui.setWorkingMessage?.(); ctx.ui.setWorkingIndicator(); ctx.ui.setWidget("pi-jar.todos", undefined); } } catch {}
    quotaCache?.stop();
    quotaCache = undefined;
    todos = undefined;
    disposeFooter?.();
    disposeFooter = undefined;
    demo = false;
  });

  pi.registerCommand("jar", {
    description: "Pi-jar hub, to-dos, prompts, quota and animation controls",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (!command || command === "status") {
        ctx.ui.notify(`pi-jar: UI ${enabled ? "on" : "off"}; animations ${animations ? "on" : "off"}; quota ${quotaCache?.enabled ? "on" : "off"} (session-only); composer ${composer.enabled ? "on" : "off"}; ${todos?.all().length ?? 0} to-dos; demo ${demo ? "on" : "off"}`, "info");
        return;
      }
      if (command === "tasks" || command.startsWith("tasks ")) {
        if (todos) await manageTasks(args.trim().slice(5).trim(), ctx, todos, () => updateTaskWidget(ctx));
        return;
      }
      if (command === "accent") {
        const loaded = loadedAccents(ctx);
        ctx.ui.notify(loaded.length
          ? `Pi-jar loaded accents: ${loaded.join(", ")}`
          : "Pi-jar loaded accents: none. Install the package or launch with --theme <pi-jar>/themes", "info");
        return;
      }
      if (command.startsWith("accent ")) {
        const selected = command.slice(7).trim();
        const applied = selectAccent(ctx, selected);
        if (applied) applyWorking(ctx);
        const valid = selected === "default" || ACCENT_NAMES.some((name) => name === selected);
        const failure = applied ? "" : !valid ? `Unknown pi-jar accent: ${selected || "(empty)"}; use /jar accent`
          : !loadedAccents(ctx).includes(selected) ? `Pi-jar accent ${selected} is not loaded. Install with pi install git:github.com/ygrip/pi-jar and restart Pi, or launch with --theme <pi-jar>/themes`
          : `Could not apply pi-jar accent: ${selected}`;
        ctx.ui.notify(applied ? `pi-jar accent: ${selected}` : failure, applied ? "info" : "warning");
        return;
      }
      if (command === "composer on") {
        ctx.ui.notify(composer.enable(ctx) ? "pi-jar composer on; /jar composer off restores Pi's editor" : "Composer unavailable in this UI", composer.enabled ? "info" : "warning");
        return;
      }
      if (command === "composer off") { composer.disable(ctx); ctx.ui.notify("pi-jar composer off", "info"); return; }
      if (command === "ask" || command.startsWith("ask ")) {
        if (!ctx.hasUI || ctx.mode !== "tui") return;
        const question = args.trim().slice(3).trim() || await promptText(ctx, "Ask with pi-jar", "What would you like to ask?");
        if (!question) return;
        const answer = await promptText(ctx, "Your answer", question);
        if (answer) ctx.ui.pasteToEditor(answer);
        return;
      }
      if (command === "hub") {
        if (!ctx.hasUI || ctx.mode !== "tui") return;
        const native = [
          { name: "tasks", label: "Tasks · Team Mode (/tasks)" },
          { name: "subagents-fleet", label: "Subagents · Fleet (/subagents-fleet)" }
        ].filter((entry) => pi.getCommands().some((item) => item.name === entry.name && item.source === "extension"));
        if (!native.length) { ctx.ui.notify("No task or subagent manager is installed", "info"); return; }
        const selected = await ctx.ui.select("pi-jar · open existing manager", native.map((item) => item.label));
        const target = native.find((item) => item.label === selected);
        if (target && pi.getCommands().some((item) => item.name === target.name && item.source === "extension")) {
          pi.sendUserMessage(`/${target.name}`, { expandPromptTemplates: true });
        }
        return;
      }
      if (command === "welcome") { showWelcome(ctx); return; }
      if (command === "demo") demo = true;
      else if (command === "reset" || command === "demo off") demo = false;
      else if (command === "animations on") { animations = true; composer.setMotion(true); }
      else if (command === "animations off") { animations = false; composer.setMotion(false); if (welcomeInterval) { clearInterval(welcomeInterval); welcomeInterval = undefined; } welcomeFrame = 0; welcomeTui?.requestRender(); }
      else if (command === "ui on") { enabled = true; composer.enable(ctx); }
      else if (command === "ui off") enabled = false;
      else if (command === "quota on" && quotaCache) quotaCache.enabled = true;
      else if (command === "quota off" && quotaCache) { quotaCache.enabled = false; quotaCache.stop(); }
      else {
        ctx.ui.notify("Usage: /jar [status|tasks|ask|composer on/off|accent [preset]|hub|welcome|demo|reset|animations on/off|ui on/off|quota on/off]", "error");
        return;
      }
      installUi(ctx);
      ctx.ui.notify(`pi-jar: ${command}`, "info");
    }
  });
}
