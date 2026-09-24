import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { Key, truncateToWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ACCENT_NAMES, loadedAccents, selectAccent } from "../src/accent.ts";
import { ComposerStyle } from "../src/composer.ts";
import { installCompactBuiltinTools } from "../src/compact-tools.ts";
import { WELCOME_INTERVAL_MS } from "../src/animations.ts";
import { promptText } from "../src/dialogs.ts";
import { renderFooter } from "../src/footer.ts";
import { openJarHistory } from "../src/history-ui.ts";
import { FOOTER_FIELDS } from "../src/footer-settings.ts";
import { defaultVisualSettings, loadVisualSettings, migrateLegacySettings, saveVisualSettings, type JarVisualSettings } from "../src/settings.ts";
import { openJarSettings } from "../src/settings-ui.ts";
import { fetchQuota, QuotaCache, type QuotaProvider } from "../src/quota.ts";
import { createDemoRoles } from "../src/roles.ts";
import { ACTIVE_STATES, collectStatuses, type JarRole } from "../src/status.ts";
import { manageTasks } from "../src/tasks-ui.ts";
import { registerTaskTool } from "../src/task-tool.ts";
import { TASK_ENTRY, TodoStore } from "../src/tasks.ts";
import { formatCost, sessionCost } from "../src/usage.ts";
import { WorkingState } from "../src/working.ts";
import { hopefulWelcomeMessage, welcomeLines, welcomeSettingsHit } from "../src/welcome.ts";

const WELCOME_KEY = "pi-jar.welcome";
export default function piJar(pi: ExtensionAPI): void {
  installCompactBuiltinTools(pi);
  let demo = false;
  let visualSettings = defaultVisualSettings();
  let animations = visualSettings.animations;
  let enabled = visualSettings.ui;
  let disposeFooter: (() => void) | undefined;
  let footerTui: { requestRender(): void } | undefined;
  let quotaCache: QuotaCache | undefined;
  let cost = 0;
  let welcomeInterval: ReturnType<typeof setInterval> | undefined;
  let welcomeFrame = 0;
  let welcomeDismiss = 0;
  let welcomeTui: TUI | undefined;
  let welcomePointerCleanup: (() => void) | undefined;
  let welcomeGit: AbortController | undefined;
  let welcomeBranch = (): string | null => null;
  let todos: TodoStore | undefined;
  const composer = new ComposerStyle();
  let footerSettings = visualSettings.footer;
  let welcomeStatuses = (): ReadonlyMap<string, string> => new Map();
  const working = new WorkingState();
  let workingClock: ReturnType<typeof setInterval> | undefined;
  let workingIndicatorKey = "";
  const stopWorkingClock = () => { if (workingClock) clearInterval(workingClock); workingClock = undefined; };
  let openSettings: (ctx: ExtensionContext) => Promise<void> = async () => {};
  let settingsOpen = false;

  const updateTaskWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const open = todos?.all().filter((item) => !item.done) ?? [];
    try {
      ctx.ui.setWidget("pi-jar.todos", !enabled || !open.length ? undefined : (_tui, theme) => ({
        invalidate() {},
        render(width: number) {
          const colors = ctx.ui.theme ?? theme;
          const shown = open.slice(0, 3);
          const rows = [
            colors.fg("accent", `Tasks · ${open.length} open`) + colors.fg("dim", " · tracked automatically · /jar tasks"),
            ...shown.map((item) => colors.fg("muted", `  ○ ${item.title}`))
          ];
          if (open.length > shown.length) rows.push(colors.fg("dim", `  … +${open.length - shown.length} more`));
          return rows.map((line) => truncateToWidth(line, Math.max(0, width)));
        }
      }));
    } catch { /* Optional widget; task data remains available via /jar tasks and jar_todo. */ }
  };
  registerTaskTool(pi, () => todos, (ctx) => updateTaskWidget(ctx));
  const applyWorking = (ctx: ExtensionContext) => {
    const active = enabled && working.phase !== "idle";
    if (!active || !ctx.hasUI || ctx.mode !== "tui") stopWorkingClock();
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    composer.setActivity(enabled ? working.phase : "idle", animations);
    try {
      if (!enabled) { workingIndicatorKey = ""; ctx.ui.setWorkingMessage?.(); ctx.ui.setWorkingIndicator(); return; }
      const view = working.view(animations, (color, text) => ctx.ui.theme?.fg(color, text) ?? text,
        Date.now(), ctx.thinkingLevel);
      ctx.ui.setWorkingMessage?.(view.message);
      const indicatorKey = `${working.phase}:${animations}`;
      if (indicatorKey !== workingIndicatorKey) {
        ctx.ui.setWorkingIndicator({ frames: view.frames, intervalMs: 240 });
        workingIndicatorKey = indicatorKey;
      }
      if (active && !workingClock) {
        workingClock = setInterval(() => applyWorking(ctx), 1000);
        workingClock.unref?.();
      }
    } catch { stopWorkingClock(); /* Working decoration must never interrupt a Pi turn. */ }
  };

  const stopWelcome = (ctx?: ExtensionContext) => {
    welcomeGit?.abort();
    welcomeGit = undefined;
    if (welcomeInterval) clearInterval(welcomeInterval);
    welcomeInterval = undefined;
    welcomePointerCleanup?.();
    welcomePointerCleanup = undefined;
    welcomeTui = undefined;
    if (ctx?.hasUI && ctx.mode === "tui") {
      try { ctx.ui.setWidget(WELCOME_KEY, undefined); } catch { /* optional widget API */ }
    }
  };

  const openWelcomeSettings = (ctx: ExtensionContext) => {
    if (settingsOpen) return;
    stopWelcome(ctx);
    void openSettings(ctx);
  };

  const installRegularWelcomePointer = (tui: TUI, ctx: ExtensionContext) => {
    if (tui.mode !== "regular") return;
    const main = tui as TUI & {
      captureRenderState?: () => { previousLines: string[]; previousViewportTop: number };
    };
    if (!main.captureRenderState || !tui.terminal?.write || !tui.addInputListener) return;

    // Pi intentionally leaves mouse reporting off on its regular screen. While
    // the transient welcome is visible, opt into click-only SGR reporting so
    // Settings behaves like the button it looks like, then restore the terminal
    // immediately when the welcome closes.
    tui.terminal.write("\x1b[?1000h\x1b[?1006h");
    const remove = tui.addInputListener((data) => {
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
      if (!mouse) return;
      const button = Number(mouse[1]);
      const x = Number(mouse[2]) - 1;
      const screenY = Number(mouse[3]) - 1;
      const kind = mouse[4];
      if (kind === "M" && (button & 3) === 0 && (button & 32) === 0 && (button & 64) === 0) {
        const state = main.captureRenderState?.();
        const line = state?.previousLines[state.previousViewportTop + screenY];
        if (line && welcomeSettingsHit([line], x, 0)) queueMicrotask(() => openWelcomeSettings(ctx));
      }
      return { consume: true };
    });
    welcomePointerCleanup = () => {
      remove();
      try { tui.terminal.write("\x1b[?1000l\x1b[?1006l"); } catch { /* best effort terminal restore */ }
    };
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
      // Footer metadata is cached. The optional dirty check is async and never blocks first paint.
      const branch = welcomeBranch() || undefined;
      const info = {
        model: ctx.model?.id,
        project: ctx.cwd ? basename(ctx.cwd) : undefined,
        context,
        cost: formatCost(cost),
        managers,
        quotaEnabled: quotaCache?.enabled ?? false,
        tasks: todos?.all().filter((item) => !item.done).length,
        branch, dirty: false,
        message: hopefulWelcomeMessage()
      };
      const git = new AbortController();
      welcomeGit = git;
      const sample = (args: string[], received: (output: string) => void) => {
        execFile("git", args, { cwd: ctx.cwd, timeout: 800, encoding: "utf8", signal: git.signal }, (error, stdout) => {
          if (error || git.signal.aborted || welcomeGit !== git || welcomeDismiss) return;
          received(stdout);
          welcomeTui?.requestRender();
        });
      };
      if (ctx.cwd && existsSync(ctx.cwd)) {
        if (!branch) sample(["branch", "--show-current"], (output) => { info.branch = output.trim() || undefined; });
        sample(["status", "--porcelain"], (output) => { info.dirty = !!output.trim(); });
      }
      ctx.ui.setWidget(WELCOME_KEY, (tui, theme) => {
        welcomeTui = tui;
        installRegularWelcomePointer(tui, ctx);
        let visibleLines: string[] = [];
        return { invalidate() {}, handleMouse(event: TuiMouseEvent) {
          if (event.button !== "left" || welcomeDismiss
            || !welcomeSettingsHit(visibleLines, event.x, event.y)) return;
          if (event.type !== "press" && event.type !== "click") return { handled: true };
          queueMicrotask(() => openWelcomeSettings(ctx));
          return { handled: true, capture: event.type === "press" };
        }, render(width: number) {
          const statuses = welcomeStatuses();
          const live = collectStatuses(statuses, Date.now());
          const quota = quotaCache?.get(ctx.model?.provider, statuses, Date.now());
          const lines = welcomeLines(width, welcomeFrame, (color, text) => (ctx.ui.theme ?? theme).fg(color, text), {
            ...info, roles: live.roles,
            quota: quota?.week?.used ?? quota?.fiveHour?.used
          });
          if (!welcomeDismiss) { visibleLines = lines; return lines; }
          // A short upward dissolve: dim the remaining art as rows disappear.
          const remaining = Math.max(0, Math.ceil(lines.length * (1 - welcomeDismiss / 5)));
          visibleLines = lines.slice(0, remaining).map((line) => (ctx.ui.theme ?? theme).fg("dim", line));
          return visibleLines;
        } };
      });
      if (animations) welcomeInterval = setInterval(() => { welcomeFrame++; welcomeTui?.requestRender(); }, WELCOME_INTERVAL_MS);
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
    disposeFooter?.();
    disposeFooter = undefined;
    try {
      ctx.ui.setFooter((tui, theme, footerData) => {
        footerTui = tui;
        welcomeStatuses = () => footerData.getExtensionStatuses();
        welcomeBranch = () => footerData.getGitBranch();
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
          if (footerTui === tui) { footerTui = undefined; welcomeStatuses = () => new Map<string, string>(); welcomeBranch = () => null; }
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
              const active = animations && footerSettings.roles && roles.some((role) => ACTIVE_STATES.has(role.state));
              if (active && !timer) timer = setInterval(() => { frame += 1; tui.requestRender(); }, 240);
              else if (!active && timer) { clearInterval(timer); timer = undefined; }
              const usage = ctx.getContextUsage();
              const context = usage?.percent == null || !Number.isFinite(usage.percent)
                ? "ctx ?" : `ctx ${Math.round(usage.percent)}%`;
              const quota = quotaCache?.get(ctx.model?.provider, statuses, now);
              return renderFooter({
                model: ctx.model?.id ?? "no-model", effort: ctx.model?.reasoning === false ? "off" : (pi.getThinkingLevel?.() ?? "off"),
                sessionName: ctx.sessionManager?.getSessionName?.(),
                cwd: ctx.cwd, settings: footerSettings, branch: footerData.getGitBranch(),
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
      disposeFooter = undefined;
      ctx.ui.setFooter(undefined);
      ctx.ui.notify("pi-jar: custom footer unavailable; using Pi footer", "warning");
    }
  };

  const applyVisualSettings = (next: JarVisualSettings, ctx: ExtensionContext) => {
    const wasEnabled = enabled;
    const hadMotion = animations;
    if (next.accent !== visualSettings.accent && next.accent !== "follow" && !selectAccent(ctx, next.accent)) {
      ctx.ui.notify(`Accent ${next.accent} is not loaded`, "warning");
      return;
    }
    visualSettings = next;
    enabled = next.ui;
    animations = next.animations;
    footerSettings = next.footer;
    if (!animations && welcomeInterval) {
      clearInterval(welcomeInterval);
      welcomeInterval = undefined;
      welcomeFrame = 0;
    }
    installUi(ctx);
    if (enabled && next.composer) composer.enable(ctx);
    else composer.disable(ctx);
    composer.setActivity(enabled ? working.phase : "idle", animations);
    applyWorking(ctx);
    if (!wasEnabled && enabled) showWelcome(ctx);
    else if (!hadMotion && animations && welcomeTui && !welcomeInterval) {
      welcomeInterval = setInterval(() => { welcomeFrame++; welcomeTui?.requestRender(); }, WELCOME_INTERVAL_MS);
    }
    footerTui?.requestRender();
    welcomeTui?.requestRender();
    try { saveVisualSettings(getAgentDir(), next); }
    catch { ctx.ui.notify("Visual preferences changed for this session but could not be saved", "warning"); }
  };

  openSettings = async (ctx) => {
    if (settingsOpen) return;
    settingsOpen = true;
    try { await openJarSettings(ctx, () => visualSettings,
      (next) => applyVisualSettings(next, ctx), loadedAccents(ctx)); }
    finally { settingsOpen = false; }
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
    migrateLegacySettings(getAgentDir());
    visualSettings = loadVisualSettings(getAgentDir());
    animations = visualSettings.animations;
    enabled = visualSettings.ui;
    footerSettings = visualSettings.footer;
    demo = false;
    composer.disable(ctx);
    stopWorkingClock();
    workingIndicatorKey = "";
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
    if (visualSettings.composer && enabled) composer.enable(ctx);
    if (visualSettings.accent !== "follow") selectAccent(ctx, visualSettings.accent);
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
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") {
      working.reportOutputTokens(event.message.usage?.output ?? 0);
      applyWorking(ctx);
    }
  });
  pi.on("tool_execution_start", (event, ctx) => { working.toolStart(event.toolCallId, event.toolName); applyWorking(ctx); });
  pi.on("tool_execution_end", (event, ctx) => { working.toolEnd(event.toolCallId); applyWorking(ctx); });
  pi.on("ui_prompt_start", (_event, ctx) => { working.prompt(true); applyWorking(ctx); });
  pi.on("ui_prompt_end", (_event, ctx) => { working.prompt(false); applyWorking(ctx); });
  // A request may span several tool turns; keep its elapsed time and reported tokens until agent_end.
  pi.on("turn_end", (_event, ctx) => { applyWorking(ctx); updateCost(ctx); });
  pi.on("agent_end", (_event, ctx) => { working.end(); applyWorking(ctx); });
  pi.on("agent_settled", (_event, ctx) => { working.end(); applyWorking(ctx); });
  pi.on("session_tree", (_event, ctx) => { restoreTodos(ctx); updateCost(ctx); composer.refreshSession(ctx); });
  pi.on("session_compact", (_event, ctx) => { restoreTodos(ctx); updateCost(ctx); });
  pi.on("model_select", (_event, _ctx) => footerTui?.requestRender());
  pi.on("thinking_level_select", (_event, _ctx) => footerTui?.requestRender());
  pi.on("session_info_changed", (_event, ctx) => { composer.refreshSession(ctx); footerTui?.requestRender(); });
  pi.on("session_shutdown", (_event, ctx) => {
    stopWelcome(ctx);
    composer.disable(ctx);
    stopWorkingClock();
    workingIndicatorKey = "";
    working.end();
    try { if (ctx.hasUI && ctx.mode === "tui") { ctx.ui.setWorkingMessage?.(); ctx.ui.setWorkingIndicator(); ctx.ui.setWidget("pi-jar.todos", undefined); } } catch {}
    quotaCache?.stop();
    quotaCache = undefined;
    todos = undefined;
    disposeFooter?.();
    disposeFooter = undefined;
    demo = false;
  });

  pi.registerShortcut?.(Key.ctrlAlt("s"), {
    description: "Open pi-jar settings",
    handler: async (ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") return;
      await openSettings(ctx);
    }
  });

  pi.registerCommand("jar", {
    description: "Pi-jar settings, read-only history, to-dos, prompts, quota and animations",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (!command && ctx.hasUI && ctx.mode === "tui" || command === "settings") {
        if (!ctx.hasUI || ctx.mode !== "tui") { ctx.ui.notify("Settings require the interactive TUI", "warning"); return; }
        await openSettings(ctx);
        return;
      }
      if (!command || command === "status") {
        ctx.ui.notify(`pi-jar: UI ${enabled ? "on" : "off"}; animations ${animations ? "on" : "off"}; quota ${quotaCache?.enabled ? "on" : "off"} (session-only); composer ${composer.enabled ? "on" : "off"}; ${todos?.all().length ?? 0} to-dos; demo ${demo ? "on" : "off"}`, "info");
        return;
      }
      if (command === "history") {
        if (!ctx.hasUI || ctx.mode !== "tui") { ctx.ui.notify("History requires the interactive TUI", "warning"); return; }
        await openJarHistory(ctx);
        return;
      }
      if (command === "tasks" || command.startsWith("tasks ")) {
        if (todos) await manageTasks(args.trim().slice(5).trim(), ctx, todos, () => updateTaskWidget(ctx));
        return;
      }
      if (command === "footer") {
        if (!ctx.hasUI || ctx.mode !== "tui") {
          ctx.ui.notify("Footer settings require the interactive TUI", "warning");
          return;
        }
        footerSettings = visualSettings.footer;
        footerTui?.requestRender();
        const labels: Record<(typeof FOOTER_FIELDS)[number], string> = {
          model: "Model", effort: "Model effort", sessionName: "Session name", cwd: "Working directory", context: "Context",
          cost: "Session cost", quota: "Quota", roles: "Roles", extras: "Extension statuses", branch: "Git branch"
        };
        while (true) {
          const options = FOOTER_FIELDS.map((field) => `${footerSettings[field] ? "[x]" : "[ ]"} ${labels[field]}`);
          const selected = await ctx.ui.select("pi-jar · footer visibility", [...options, "Done"]);
          const index = options.indexOf(selected ?? "");
          if (index < 0) break;
          const field = FOOTER_FIELDS[index]!;
          const next = { ...footerSettings, [field]: !footerSettings[field] };
          applyVisualSettings({ ...visualSettings, footer: next }, ctx);
        }
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
        if (applied) {
          visualSettings = { ...visualSettings, accent: selected as JarVisualSettings["accent"] };
          try { saveVisualSettings(getAgentDir(), visualSettings); }
          catch { ctx.ui.notify("Accent changed for this session but could not be saved", "warning"); }
          applyWorking(ctx);
        }
        const valid = selected === "default" || ACCENT_NAMES.some((name) => name === selected);
        const failure = applied ? "" : !valid ? `Unknown pi-jar accent: ${selected || "(empty)"}; use /jar accent`
          : !loadedAccents(ctx).includes(selected) ? `Pi-jar accent ${selected} is not loaded. Install with pi install git:github.com/ygrip/pi-jar and restart Pi, or launch with --theme <pi-jar>/themes`
          : `Could not apply pi-jar accent: ${selected}`;
        ctx.ui.notify(applied ? `pi-jar accent: ${selected}` : failure, applied ? "info" : "warning");
        return;
      }
      if (command === "composer on") {
        const ready = composer.enable(ctx);
        if (ready) applyVisualSettings({ ...visualSettings, composer: true }, ctx);
        ctx.ui.notify(ready ? "pi-jar composer on; /jar composer off restores Pi's editor" : "Composer unavailable in this UI", ready ? "info" : "warning");
        return;
      }
      if (command === "composer off") { applyVisualSettings({ ...visualSettings, composer: false }, ctx); ctx.ui.notify("pi-jar composer off", "info"); return; }
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
      else if (command === "animations on") applyVisualSettings({ ...visualSettings, animations: true }, ctx);
      else if (command === "animations off") applyVisualSettings({ ...visualSettings, animations: false }, ctx);
      else if (command === "ui on") applyVisualSettings({ ...visualSettings, ui: true }, ctx);
      else if (command === "ui off") applyVisualSettings({ ...visualSettings, ui: false }, ctx);
      else if (command === "quota on" && quotaCache) quotaCache.enabled = true;
      else if (command === "quota off" && quotaCache) { quotaCache.enabled = false; quotaCache.stop(); }
      else {
        ctx.ui.notify("Usage: /jar [status|settings|history|footer|tasks|ask|composer on/off|accent [preset]|hub|welcome|demo|reset|animations on/off|ui on/off|quota on/off]", "error");
        return;
      }
      if (!["animations on", "animations off", "ui on", "ui off"].includes(command)) installUi(ctx);
      ctx.ui.notify(`pi-jar: ${command}`, "info");
    }
  });
}
