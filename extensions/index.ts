import { getAgentDir, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Key, truncateToWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ACCENT_NAMES, loadedAccents, selectAccent } from "../src/accent.ts";
import { registerAskTool } from "../src/ask-tool.ts";
import { registerDemocracy } from "../src/democracy.ts";
import type { DelegateController } from "../src/delegate.ts";
import { ComposerStyle } from "../src/composer.ts";
import { installCompactBuiltinTools } from "../src/compact-tools.ts";
import { WELCOME_INTERVAL_MS } from "../src/animations.ts";
import { promptText } from "../src/dialogs.ts";
import { renderFooterLayout, type ActivityState, type FooterActivity, type FooterHit, type FooterTarget } from "../src/footer.ts";
import { openJarHistory } from "../src/history-ui.ts";
import { GOAL_ENTRY, GoalStore } from "../src/goals.ts";
import { GoalLoop } from "../src/goal-loop.ts";
import { FOOTER_FIELDS } from "../src/footer-settings.ts";
import { defaultVisualSettings, loadVisualSettings, saveVisualSettings, type JarVisualSettings } from "../src/settings.ts";
import { openJarSettings, type PiPreferences } from "../src/settings-ui.ts";
import { pickSession } from "../src/session-ui.ts";
import { fetchQuota, QuotaCache, type QuotaProvider } from "../src/quota.ts";
import { ModelRoleManager } from "../src/model-roles.ts";
import { jarCommit } from "../src/commit.ts";
import { registerAdvisor } from "../src/advisor.ts";
import { registerInfoPanels } from "../src/info-panels.ts";
import { SideUsage } from "../src/side-model.ts";
import { PlanMode } from "../src/plan.ts";
import { openRolesUi } from "../src/roles-ui.ts";
import { registerSuggestions, SuggestionState } from "../src/suggest.ts";
import { createDemoRoles } from "../src/roles.ts";
import { ACTIVE_STATES, cleanText, collectStatuses, type JarRole } from "../src/status.ts";
import { manageTasks } from "../src/tasks-ui.ts";
import { registerTaskTool, todoRow } from "../src/task-tool.ts";
import { TASK_ENTRY, TodoStore, todoProgress, todoTotals } from "../src/tasks.ts";
import { formatCost, sessionCost } from "../src/usage.ts";
import { WorkingState } from "../src/working.ts";
import { ChangeTracker } from "../src/changes.ts";
import { CHILD_ENV, DelegateRegistry, registerDelegate, SUBAGENT_MESSAGE, type DelegateRun } from "../src/delegate.ts";
import { CHILD_WORKTREE_ENV, workspacePathAllowed } from "../src/delegate-worktree.ts";
import { createDiscussionPaper, DISCUSSION_FILE_ENV, disposeDiscussionPaper, registerDiscussionTool, SUBAGENT_NAME_ENV } from "../src/discussion.ts";
import { openActivityView, type ActivityTarget } from "../src/activity-view.ts";
import { ICON_SETS, setIconSet, withIcon } from "../src/icons.ts";
import { collectPrompts, openPromptSearch } from "../src/prompt-search.ts";
import { ago, recentSessions, sessionDetails, type RecentSession } from "../src/session-gallery.ts";
import { clearSessionBranchCache, sessionBranch } from "../src/session-branch.ts";
import { registerChangeReview } from "../src/diff-view.ts";
import { registerShells, ShellManager, type ShellEvent, type ShellJob } from "../src/shells.ts";
import { registerShellNotifications } from "../src/shell-notifications.ts";
import { CHILD_TOOLS_ENV, childToolAllowlist, RECURSIVE_TOOLS, worktreeToolViolation } from "../src/subagent-tools.ts";
import { hopefulWelcomeMessage, welcomeHit, welcomeLines, type WelcomeAction } from "../src/welcome.ts";

const WELCOME_KEY = "pi-jar.welcome";
const VERSION = (() => {
  try { return "v" + (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version; }
  catch { return undefined; }
})();
/** Ignore the click Pi may synthesize right after a press we already acted on. */
const WELCOME_CLICK_DEDUPE_MS = 400;
const LARGE_SESSION_ENTRIES = 800;
/** Entries Pi writes when a fresh session starts; a branch holding only these has no transcript yet. */
const SESSION_SETUP_ENTRIES = new Set(["thinking_level_change", "model_change", "session_info"]);
export default function piJar(pi: ExtensionAPI): void {
  const delegatedChild = process.env[CHILD_ENV] === "1";
  const delegatedWorktree = delegatedChild ? process.env[CHILD_WORKTREE_ENV] : undefined;
  if (delegatedChild) {
    // Forked transcripts retain custom prompt messages even though their automation stores
    // and handlers are disabled. Remove only parent automation, not task/user context.
    const parentAutomation = new Set([
      "pi-jar.goal-context", "pi-jar.goal-continuation",
      "pi-jar.plan-context", "pi-jar.plan-reminder", "pi-jar.moderator-context", SUBAGENT_MESSAGE
    ]);
    pi.on("context", (event) => {
      const messages = event.messages.filter((message) => !parentAutomation.has((message as { customType?: string }).customType ?? ""));
      if (messages.length !== event.messages.length) return { messages };
    });
  }
  if (delegatedChild) {
    const allowed = childToolAllowlist(process.env[CHILD_TOOLS_ENV]);
    pi.on("tool_call", (event, ctx) => {
      // Enforce capabilities per call as well as CLI startup. A web/MCP bootstrap must not
      // accidentally activate unrelated tools or permit recursive orchestration.
      if (RECURSIVE_TOOLS.has(event.toolName) || (allowed && !allowed.has(event.toolName))) {
        return { block: true, reason: "Tool was not granted to this subagent: " + event.toolName };
      }
      if (delegatedWorktree) {
        const reason = worktreeToolViolation(delegatedWorktree, ctx.cwd, event.toolName, event.input);
        if (reason) return { block: true, reason };
      }
    });
    pi.on("tool_result", event => {
      if (!allowed || event.toolName !== "web_enable") return;
      const available = new Set(pi.getAllTools().map(tool => tool.name));
      pi.setActiveTools([...allowed].filter(name => available.has(name)));
    });
  }
  installCompactBuiltinTools(pi);
  let demo = false;
  let visualSettings = defaultVisualSettings();
  let animations = visualSettings.animations;
  let enabled = visualSettings.ui;
  let disposeFooter: (() => void) | undefined;
  let footerTui: { requestRender(): void } | undefined;
  /** Footer facts that walk the session to compute; refreshed on the events that change them, never per frame. */
  let footerContext = "ctx ?";
  let footerSessionName: string | undefined;
  const sampleFooter = (ctx: ExtensionContext) => {
    try {
      const usage = ctx.getContextUsage();
      footerContext = usage?.percent == null || !Number.isFinite(usage.percent) ? "ctx ?" : `ctx ${Math.round(usage.percent)}%`;
    } catch { footerContext = "ctx ?"; }
    try { footerSessionName = ctx.sessionManager?.getSessionName?.(); } catch { footerSessionName = undefined; }
    footerTui?.requestRender();
  };
  let quotaCache: QuotaCache | undefined;
  let cost = 0;
  let welcomeInterval: ReturnType<typeof setInterval> | undefined;
  let welcomeFrame = 0;
  let welcomeDismiss = 0;
  let welcomeTui: TUI | undefined;
  /** Background work (quota, session files, git) waits this long after startup. */
  const STARTUP_GRACE_MS = 1500;
  let quotaDisabledByUser = false;
  let welcomeGit: AbortController | undefined;
  let welcomeBranch = (): string | null => null;
  let refreshWelcome: (() => void) | undefined;
  let todos: TodoStore | undefined;
  let goals: GoalStore | undefined;
  const composer = new ComposerStyle();
  let footerSettings = visualSettings.footer;
  let welcomeStatuses = (): ReadonlyMap<string, string> => new Map();
  const working = new WorkingState();
  let workingIndicatorKey = "";
  let openSettings: (ctx: ExtensionContext) => Promise<void> = async () => {};
  let settingsOpen = false;
  let discussionFile: string | undefined = process.env[DISCUSSION_FILE_ENV];
  registerDiscussionTool(pi, () => discussionFile, () => process.env[SUBAGENT_NAME_ENV] ?? "moderator");

  // A finished list stays visible (all struck through) until the user's next prompt, like Claude.
  let todosAcknowledged = false;
  const updateTaskWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const items = todos?.all() ?? [];
    const open = items.filter((item) => !item.done);
    if (open.length) todosAcknowledged = false;
    const visible = enabled && items.length > 0 && (open.length > 0 || !todosAcknowledged);
    try {
      // Rows are rebuilt only when the list changes (every change reinstalls the widget), the width or the theme.
      ctx.ui.setWidget("pi-jar.todos", !visible ? undefined : (_tui, theme) => {
        let memo: { width: number; sample: string; lines: string[] } | undefined;
        return {
          invalidate() { memo = undefined; },
          render(width: number) {
            const colors = ctx.ui.theme ?? theme;
            const sample = colors.fg("accent", "·") + colors.fg("dim", "·");
            if (memo && memo.width === width && memo.sample === sample) return memo.lines.slice();
            const all = todos?.all() ?? [];
            const { done, total } = todoTotals(all);
            const parents = new Set<string>();
            for (const item of all) if (item.parentId) parents.add(item.parentId);
            // Show a window of up to 8 rows that keeps the running leaf (or next open one) in view.
            const running = all.findIndex((item) => item.status === "in_progress" && !parents.has(item.id));
            const focus = Math.max(0, running >= 0 ? running : all.findIndex((item) => !item.done && !parents.has(item.id)));
            const start = Math.max(0, Math.min(focus - 2, all.length - 8));
            const shown = all.slice(start, start + 8);
            const rows = [
              colors.fg("accent", "Tasks") + colors.fg("dim", ` · ${done}/${total} done` + (done === total ? " · all complete" : "") + " · /jar tasks"),
              ...(start > 0 ? [colors.fg("dim", `  … ${start} earlier`)] : []),
              ...shown.map((item) => todoRow(item, (color, text) => colors.fg(color, text), (text) => colors.bold(text), parents.has(item.id) ? todoProgress(all, item.id) : undefined)),
              ...(start + shown.length < all.length ? [colors.fg("dim", `  … +${all.length - start - shown.length} more`)] : [])
            ];
            // Pi inserts a spacer before widgets, but not between widgets and the composer.
            const lines = [...rows.map((line) => truncateToWidth(line, Math.max(0, width))), truncateToWidth(" ", Math.max(0, width))];
            memo = { width, sample, lines };
            return lines.slice();
          }
        };
      });
    } catch { /* Optional widget; task data remains available via /jar tasks and jar_todo. */ }
  };
  registerTaskTool(pi, () => todos, (ctx) => updateTaskWidget(ctx));
  let changes: ChangeTracker | undefined;
  let changeCount = 0;
  const refreshChanges = () => {
    try { changeCount = changes?.count() ?? 0; } catch { changeCount = 0; }
    footerTui?.requestRender();
  };
  registerChangeReview(pi, () => changes, refreshChanges);
  let shells: ShellManager | undefined;
  registerShells(pi, () => shells);
  const shellNotifications = registerShellNotifications(pi, () => shells);
  const onShellEvent = (event: ShellEvent) => {
    footerTui?.requestRender();
    if (!event.job.notify) return;
    // Queue compact metadata until a model boundary; observed completions are acknowledged.
    shellNotifications.notify();
  };
  /** Footer indicators owned by pi-jar; live subagents and shells get their own rows. */
  const footerChips = () => changeCount ? [withIcon("changes", `${changeCount} file${changeCount === 1 ? "" : "s"} · /diff`)] : [];
  /**
   * Subagent streams and shell output change the footer many times a second; every requested frame
   * re-renders the whole transcript, so background sources repaint it at most this often.
   */
  const BACKGROUND_REPAINT_MS = 250;
  let backgroundRepaint: NodeJS.Timeout | undefined;
  const repaintFooterSoon = () => {
    if (backgroundRepaint) return;
    backgroundRepaint = setTimeout(() => { backgroundRepaint = undefined; footerTui?.requestRender(); }, BACKGROUND_REPAINT_MS);
    backgroundRepaint.unref?.();
  };
  const subagents = new DelegateRegistry();
  subagents.subscribe(repaintFooterSoon);
  /** Finished work stays visible briefly so a quick run is not a flicker. */
  const ACTIVITY_LINGER_MS = 5000;
  const subagentState = (run: DelegateRun): ActivityState => run.state === "working" ? "running" : run.state === "queued" ? "queued"
    : run.state === "idle" ? "idle" : run.state === "paused" ? "paused" : run.state === "stopped" ? "stopped"
      : run.state === "done" ? "done" : "failed";
  const shellActivityState = (job: Omit<ShellJob, "lines">): ActivityState => job.status === "running" ? "running"
    : job.status === "killed" ? "stopped" : job.status === "exited" && job.exitCode === 0 ? "done" : "failed";
  const seconds = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
  const footerActivity = (now: number): FooterActivity[] => {
    const rows: FooterActivity[] = [];
    for (const { key, run } of subagents.records()) {
      if ((run.state === "done" || run.state === "failed" || run.state === "stopped") && run.endedAt && now - run.endedAt > ACTIVITY_LINGER_MS) continue;
      rows.push({ kind: "subagent", id: key, name: run.name, state: subagentState(run),
        detail: run.error ?? run.activity ?? cleanText(run.task, 120),
        stats: [run.tools ? `${run.tools} tools` : "", run.startedAt ? seconds((run.endedAt ?? now) - run.startedAt) : ""].filter(Boolean).join(" · ") });
    }
    for (const job of shells?.summaries() ?? []) {
      if (job.endedAt && now - job.endedAt > ACTIVITY_LINGER_MS) continue;
      // Shell output does not repaint the footer, so show stable facts rather than a stale clock.
      rows.push({ kind: "shell", id: job.id, name: `${job.id} ${job.name}`, state: shellActivityState(job), detail: job.command,
        ...(job.watch ? { stats: `watch /${cleanText(job.watch, 20)}/` + (job.matched ? " ✓" : "") } : {}) });
    }
    return rows;
  };
  let overlayOpen = false;
  /** Subagents, shells and other extensions' roles in one live split view. */
  const openActivity = async (ctx: ExtensionContext, initial?: ActivityTarget) => {
    if (!ctx.hasUI || ctx.mode !== "tui" || overlayOpen) return;
    overlayOpen = true;
    try {
      await openActivityView(ctx, {
        subagents, ...(shells ? { shells } : {}),
        roles: () => collectStatuses(welcomeStatuses(), Date.now()).roles.filter((role) => !role.id.startsWith("delegate-"))
          .map((role) => ({ id: role.id, name: role.name, state: role.state, ...(role.task ? { task: role.task } : {}) }))
      }, initial);
    } finally { overlayOpen = false; }
  };
  /** Searchable project sessions with a details pane; Enter resumes the selected one. */
  const openSessions = async (ctx: ExtensionContext | ExtensionCommandContext, query = "") => {
    if (!ctx.hasUI || ctx.mode !== "tui") { ctx.ui.notify("Session search requires the interactive TUI", "warning"); return; }
    if (overlayOpen) return;
    let sessions;
    try { sessions = (await SessionManager.list(ctx.cwd)).sort((a, b) => b.modified.getTime() - a.modified.getTime()); }
    catch (error) { ctx.ui.notify("Could not search sessions: " + String(error), "error"); return; }
    if (!sessions.length) { ctx.ui.notify("No sessions found for this project", "info"); return; }
    overlayOpen = true;
    let selected: string | undefined;
    try { selected = await pickSession(ctx, sessions, query, (session) => sessionDetails(session.path)); }
    finally { overlayOpen = false; }
    if (!selected || selected === ctx.sessionManager.getSessionFile()) return;
    if (!("switchSession" in ctx)) {
      // Clicks and shortcuts get a plain context; switching needs a command, so stage it.
      ctx.ui.setEditorText(`/jar resume ${selected}`);
      ctx.ui.notify("Press Enter to resume that session", "info");
      return;
    }
    // Never access the old command context after a successful switch.
    const result = await ctx.switchSession(selected);
    if (result.cancelled) ctx.ui.notify("Session switch cancelled", "info");
  };
  const openFooterTarget = (ctx: ExtensionContext, target: FooterTarget) => target.kind === "session" ? openSessions(ctx)
    : openActivity(ctx, target.kind === "activity" ? undefined : target);
  registerAskTool(pi);
  const modelRoles = new ModelRoleManager(pi);
  const sideUsage = new SideUsage();
  registerAdvisor(pi, modelRoles, { enabled: () => visualSettings.advisor, gates: () => visualSettings.advisorGates, usage: sideUsage });
  registerInfoPanels(pi, { side: sideUsage, quotaEnabled: () => quotaCache?.enabled ?? false,
    quota: (ctx) => quotaCache?.get(ctx.model?.provider, welcomeStatuses(), Date.now()) });
  modelRoles.register((ctx) => openRolesUi(ctx, modelRoles), { activateDefault: () => !delegatedChild });
  let delegateController: DelegateController | undefined;
  registerDelegate(pi, modelRoles, subagents, { changes: () => changes, changed: refreshChanges, discussionFile: () => discussionFile,
    getMaxSubagents: () => visualSettings.maxSubagents, onController: (controller) => { delegateController = controller; } });
  if (!delegatedChild) registerDemocracy(pi, () => delegateController, () => visualSettings.maxSubagents);
  const planMode = new PlanMode(pi, () => todos, modelRoles, updateTaskWidget);
  if (!delegatedChild) planMode.register();
  const goalLoop = new GoalLoop(pi, {
    goals: () => goals, todos: () => todos, roles: modelRoles, planActive: () => planMode.isEnabled(),
    maxRounds: () => visualSettings.goalRounds,
    subagentMode: (agent) => subagents.resolve(agent)?.run.mode,
    changed: (ctx) => { footerTui?.requestRender(); welcomeTui?.requestRender(); updateTaskWidget(ctx); },
    completed: () => composer.flash("complete", 4000)
  });
  if (!delegatedChild) goalLoop.register();
  planMode.setOnEnter((ctx) => goalLoop.pause(ctx, "plan mode is on"));
  const suggestions = new SuggestionState();
  composer.attachSuggestions(suggestions);
  const suggest = registerSuggestions(pi, suggestions, {
    enabled: () => enabled && visualSettings.composer && visualSettings.suggestions && composer.enabled
  });
  let liveTui: { setCopyOnSelect?: (enabled: boolean) => void } | undefined;
  /** Pi's own settings (TUI mode, copy-on-select); written through Pi's SettingsManager. */
  const piPreferences = (ctx: ExtensionContext): PiPreferences | undefined => {
    let manager: SettingsManager;
    try { manager = SettingsManager.create(ctx.cwd, getAgentDir()); } catch { return undefined; }
    const save = () => { void manager.flush().catch((error: unknown) => ctx.ui.notify("Could not save Pi settings: " + String(error), "error")); };
    return {
      get: () => ({ fullscreen: manager.getTuiMode() === "fullscreen", copyOnSelect: manager.getFullscreenCopyOnSelect() }),
      setFullscreen: (on) => { manager.setTuiMode(on ? "fullscreen" : "regular"); save(); },
      setCopyOnSelect: (on) => { manager.setFullscreenCopyOnSelect(on); save(); liveTui?.setCopyOnSelect?.(on); }
    };
  };

  const applyWorking = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    composer.setActivity(enabled ? working.phase : "idle", animations);
    try {
      if (!enabled) { workingIndicatorKey = ""; ctx.ui.setWorkingMessage?.(); ctx.ui.setWorkingIndicator(); return; }
      const view = working.view(animations, (color, text) => ctx.ui.theme?.fg(color, text) ?? text,
        Date.now(), ctx.thinkingLevel);
      ctx.ui.setWorkingMessage?.(view.message);
      const indicatorKey = `${working.phase}:${animations}`;
      if (indicatorKey !== workingIndicatorKey) {
        // Pi's normal streaming/tool lifecycle already causes renders. A static indicator avoids
        // forcing the entire transcript to repaint on a timer in long sessions.
        ctx.ui.setWorkingIndicator({ frames: [view.frames[0] ?? "✢"] });
        workingIndicatorKey = indicatorKey;
      }
    } catch { /* Working decoration must never interrupt a Pi turn. */ }
  };

  const stopWelcome = (ctx?: ExtensionContext) => {
    welcomeGit?.abort();
    welcomeGit = undefined;
    if (welcomeInterval) clearInterval(welcomeInterval);
    welcomeInterval = undefined;
    welcomeTui = undefined;
    refreshWelcome = undefined;
    if (ctx?.hasUI && ctx.mode === "tui") {
      try { ctx.ui.setWidget(WELCOME_KEY, undefined); } catch { /* optional widget API */ }
    }
  };

  const openWelcomeSettings = (ctx: ExtensionContext) => {
    if (settingsOpen) return;
    stopWelcome(ctx);
    void openSettings(ctx);
  };
  const runWelcomeAction = (action: WelcomeAction, ctx: ExtensionContext) => {
    if (action === "settings") { openWelcomeSettings(ctx); return; }
    if (action === "refresh") { refreshWelcome?.(); return; }
    const report = (error: unknown) => ctx.ui.notify("pi-jar: " + String(error), "error");
    if (action === "roles") void openRolesUi(ctx, modelRoles).catch(report);
    else if (action === "plan") {
      if (planMode.hasPlan()) void planMode.review(ctx).catch(report);
      else ctx.ui.pasteToEditor("/plan ");
    } else if (action === "goal") void goalLoop.prompt(ctx).catch(report);
    else if (action.startsWith("resume:")) {
      // Switching sessions needs a command context, so stage the command for the user.
      ctx.ui.setEditorText(`/jar resume ${action.slice(7)}`);
      ctx.ui.notify("Press Enter to resume that session", "info");
    }
  };
  /** Recent sessions as the welcome lists them (numbered from 1). */
  let welcomeRecent: RecentSession[] = [];
  const loadRecent = async (ctx: ExtensionContext) => recentSessions(await SessionManager.list(ctx.cwd), ctx.sessionManager.getSessionFile());

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
        branch, dirty: false,
        message: hopefulWelcomeMessage(),
        flameSeed: 1 + Math.floor(Math.random() * 1000)
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
      welcomeRecent = [];
      // Background reads (session files, git) wait until startup settles so they never compete
      // with Pi loading other extensions; the card fills in when they finish.
      const background = setTimeout(() => {
        if (git.signal.aborted || welcomeGit !== git) return;
        void loadRecent(ctx).then((recent) => {
          if (git.signal.aborted || welcomeGit !== git || welcomeDismiss) return;
          welcomeRecent = recent;
          (info as { recent?: unknown }).recent = recent.map((session) => ({ title: session.title, age: ago(session.modified),
            ...(session.goal ? { goal: session.goal } : {}), ...(session.plan ? { plan: session.plan } : {}) }));
          welcomeTui?.requestRender();
        }).catch((error) => console.error("pi-jar: recent sessions unavailable", error));
        if (ctx.cwd && existsSync(ctx.cwd)) {
          if (!branch) sample(["branch", "--show-current"], (output) => { info.branch = output.trim() || undefined; });
          sample(["status", "--porcelain"], (output) => { info.dirty = !!output.trim(); });
        }
      }, STARTUP_GRACE_MS);
      background.unref?.();
      git.signal.addEventListener("abort", () => clearTimeout(background), { once: true });
      refreshWelcome = () => {
        info.message = hopefulWelcomeMessage(Math.random, info.message);
        info.flameSeed = 1 + Math.floor(Math.random() * 1000);
        welcomeFrame = 0;
        if (ctx.cwd && existsSync(ctx.cwd) && !welcomeGit?.signal.aborted) sample(["status", "--porcelain"], (output) => { info.dirty = !!output.trim(); });
        welcomeTui?.requestRender();
      };
      ctx.ui.setWidget(WELCOME_KEY, (tui, theme) => {
        welcomeTui = tui;
        let visibleLines: string[] = [];
        let pressed: { action: WelcomeAction; at: number } | undefined;
        return { invalidate() {}, handleMouse(event: TuiMouseEvent) {
          if (event.button !== "left" || welcomeDismiss) return;
          const action = welcomeHit(visibleLines, event.x, event.y);
          if (!action) return;
          if (event.type !== "press" && event.type !== "click") return { handled: true };
          // Act on press (click synthesis is not guaranteed through multiplexers); drop the echo click.
          const now = Date.now();
          if (event.type === "click" && pressed?.action === action && now - pressed.at < WELCOME_CLICK_DEDUPE_MS) return { handled: true };
          pressed = { action, at: now };
          queueMicrotask(() => runWelcomeAction(action, ctx));
          return { handled: true, capture: event.type === "press" };
        }, render(width: number) {
          const statuses = welcomeStatuses();
          const live = collectStatuses(statuses, Date.now());
          const quota = footerSettings.quota ? quotaCache?.get(ctx.model?.provider, statuses, Date.now()) : undefined;
          const open = todos?.all().filter((item) => !item.done) ?? [];
          const lines = welcomeLines(width, welcomeFrame, (color, text) => (ctx.ui.theme ?? theme).fg(color, text), {
            ...info, settingsClickable: tui.mode !== "regular", roles: live.roles,
            quota: quota?.week?.used ?? quota?.fiveHour?.used,
            effort: ctx.model?.reasoning === false ? "off" : pi.getThinkingLevel?.(),
            ...(modelRoles.activeRole() ? { activeRole: modelRoles.activeRole()! } : {}),
            tasks: open.length, ...(open[0] ? { nextTask: open[0].title } : {}),
            plan: planMode.summary(), ...(goalLoop.progress() ? { goal: goalLoop.progress()! } : {}),
            rolesSummary: modelRoles.summary(), ...(VERSION ? { version: VERSION } : {})
          });
          if (!welcomeDismiss) { visibleLines = lines; return lines; }
          // A short upward dissolve: dim the remaining art as rows disappear.
          const remaining = Math.max(0, Math.ceil(lines.length * (1 - welcomeDismiss / 5)));
          visibleLines = lines.slice(0, remaining).map((line) => (ctx.ui.theme ?? theme).fg("dim", line));
          return visibleLines;
        } };
      });
      if (animations) { welcomeInterval = setInterval(() => { welcomeFrame++; welcomeTui?.requestRender(); }, WELCOME_INTERVAL_MS); welcomeInterval.unref?.(); }
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
        liveTui = tui as { setCopyOnSelect?: (enabled: boolean) => void };
        welcomeStatuses = () => footerData.getExtensionStatuses();
        welcomeBranch = () => footerData.getGitBranch();
        let frame = 0;
        let expiryTimer: ReturnType<typeof setTimeout> | undefined;
        let expiryAt: number | undefined;
        let memory = `ram ${Math.round(process.memoryUsage.rss() / 1048576)} MiB`;
        let memorySampledAt = 0;
        let disposed = false;
        let hits: FooterHit[] = [];
        let pressed: { target: FooterTarget; at: number } | undefined;
        const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          if (expiryTimer) clearTimeout(expiryTimer);
          expiryTimer = undefined;
          expiryAt = undefined;
          if (footerTui === tui) { footerTui = undefined; welcomeStatuses = () => new Map<string, string>(); welcomeBranch = () => null; }
          unsubscribe();
        };
        disposeFooter = dispose;
        return {
          dispose,
          invalidate() {},
          handleMouse(event: TuiMouseEvent) {
            if (event.button !== "left") return;
            const hit = hits.find((item) => item.y === event.y && event.x >= item.x0 && event.x < item.x1);
            if (!hit) return;
            if (event.type !== "press" && event.type !== "click") return { handled: true };
            // Act on press (click synthesis is not guaranteed through multiplexers); drop the echo click.
            const now = Date.now();
            const same = pressed && JSON.stringify(pressed.target) === JSON.stringify(hit.target);
            if (event.type === "click" && same && now - pressed!.at < WELCOME_CLICK_DEDUPE_MS) return { handled: true };
            pressed = { target: hit.target, at: now };
            queueMicrotask(() => { void openFooterTarget(ctx, hit.target).catch((error) => ctx.ui.notify("pi-jar: " + String(error), "error")); });
            return { handled: true, capture: event.type === "press" };
          },
          render(width: number): string[] {
            try {
              const now = Date.now();
              const statuses = footerData.getExtensionStatuses();
              const live = collectStatuses(statuses, now);
              // jar_delegate runs get their own activity rows; other extensions' roles stay as chips.
              const roles: JarRole[] = demo ? createDemoRoles() : live.roles.filter((role) => !role.id.startsWith("delegate-"));
              const nearest = demo ? undefined : roles.reduce<number | undefined>((min, role) =>
                role.expiresAt != null ? Math.min(min ?? Infinity, role.expiresAt) : min, undefined);
              if (nearest !== expiryAt) {
                if (expiryTimer) clearTimeout(expiryTimer);
                expiryTimer = undefined;
                expiryAt = nearest;
                if (nearest != null) {
                  expiryTimer = setTimeout(() => { expiryTimer = undefined; expiryAt = undefined; tui.requestRender(); }, Math.max(1, nearest - now));
                  expiryTimer.unref?.();
                }
              }
              // Do not schedule cosmetic footer repaints. Role state still updates on Pi's native
              // stream/tool renders, which keeps long transcripts responsive.
              const active = animations && footerSettings.roles && roles.some((role) => ACTIVE_STATES.has(role.state));
              // Role glyphs advance with time, not with the render rate, so the footer memo still hits between steps.
              if (active) frame = Math.floor(now / 250);
              if (now - memorySampledAt >= 5000) {
                memory = `ram ${Math.round(process.memoryUsage.rss() / 1048576)} MiB`;
                memorySampledAt = now;
              }
              const quota = footerSettings.quota ? quotaCache?.get(ctx.model?.provider, statuses, now) : undefined;
              const layout = renderFooterLayout({
                model: ctx.model?.id ?? "no-model", effort: ctx.model?.reasoning === false ? "off" : (pi.getThinkingLevel?.() ?? "off"),
                sessionName: footerSessionName,
                cwd: ctx.cwd, settings: footerSettings, branch: footerData.getGitBranch(),
                context: footerContext, goal: goalLoop.progress(), chips: footerChips(), activity: footerActivity(now),
                memory, cost: formatCost(cost), quota, roles, extras: live.extras,
                demo, animations, frame, motionBudget: ctx.isIdle() ? 2 : 1
              }, width, ctx.ui.theme ?? theme);
              hits = layout.hits;
              return layout.lines;
            } catch {
              hits = [];
              if (expiryTimer) clearTimeout(expiryTimer);
              expiryTimer = undefined;
              expiryAt = undefined;
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
    setIconSet(next.icons);
    enabled = next.ui;
    animations = next.animations;
    if (footerSettings.quota && !next.footer.quota) quotaCache?.stop();
    footerSettings = next.footer;
    if (!animations && welcomeInterval) {
      clearInterval(welcomeInterval);
      welcomeInterval = undefined;
      welcomeFrame = 0;
    }
    installUi(ctx);
    if (enabled && next.composer) composer.enable(ctx);
    else composer.disable(ctx);
    composer.setMascot(next.mascot);
    composer.setActivity(enabled ? working.phase : "idle", animations);
    suggest.sync();
    applyWorking(ctx);
    if (!wasEnabled && enabled) showWelcome(ctx);
    else if (!hadMotion && animations && welcomeTui && !welcomeInterval) {
      { welcomeInterval = setInterval(() => { welcomeFrame++; welcomeTui?.requestRender(); }, WELCOME_INTERVAL_MS); welcomeInterval.unref?.(); }
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
      (next) => applyVisualSettings(next, ctx), loadedAccents(ctx), piPreferences(ctx)); }
    finally { settingsOpen = false; }
  };

  const updateCost = (ctx: ExtensionContext) => {
    try { cost = sessionCost(ctx); } catch { cost = 0; }
    footerTui?.requestRender();
  };
  const addMessageCost = (message: { usage?: { cost?: { total?: number } } }) => {
    const value = message.usage?.cost?.total;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) cost += value;
  };
  const restoreTodos = (ctx: ExtensionContext, branch?: readonly unknown[]) => {
    try { todos?.restore(branch ?? sessionBranch(ctx)); } catch { todos?.restore([]); }
    updateTaskWidget(ctx);
  };
  const restoreGoal = (ctx: ExtensionContext, branch?: readonly unknown[]) => {
    try { goals?.restore(branch ?? sessionBranch(ctx)); } catch { goals?.restore([]); }
    footerTui?.requestRender();
  };
  pi.on("session_start", (_event, ctx) => {
    sideUsage.clear();
    visualSettings = loadVisualSettings(getAgentDir());
    setIconSet(visualSettings.icons);
    animations = visualSettings.animations;
    enabled = visualSettings.ui;
    footerSettings = visualSettings.footer;
    demo = false;
    composer.disable(ctx);
    workingIndicatorKey = "";
    working.end();
    quotaCache?.stop();
    todos = new TodoStore((entry) => pi.appendEntry(TASK_ENTRY, entry));
    changes = new ChangeTracker(() => ctx.cwd);
    changeCount = 0;
    shells?.dispose();
    subagents.clear();
    if (!delegatedChild) {
      disposeDiscussionPaper(discussionFile);
      discussionFile = createDiscussionPaper();
    }
    shells = new ShellManager(onShellEvent);
    shells.onChange = repaintFooterSoon;
    goals = new GoalStore((entry) => pi.appendEntry(GOAL_ENTRY, entry));
    let branch: readonly unknown[] = [];
    try { branch = sessionBranch(ctx); } catch { /* keep empty */ }
    if (delegatedChild) {
      todos.restore([]);
      goals.restore([]);
    } else {
      restoreTodos(ctx, branch);
      restoreGoal(ctx, branch);
    }
    // Quota is enabled per session; no credentials or consent are persisted.
    quotaCache = new QuotaCache(
      (provider: QuotaProvider, signal) => fetchQuota(provider, (id) => ctx.modelRegistry.getProviderAuth(id), signal),
      () => footerTui?.requestRender()
    );
    // Hold the network lookup until startup settles; the footer shows it once it arrives.
    quotaCache.enabled = false;
    const cache = quotaCache;
    const enableQuota = setTimeout(() => { if (quotaCache === cache && !quotaDisabledByUser) { cache.enabled = true; footerTui?.requestRender(); } }, STARTUP_GRACE_MS);
    enableQuota.unref?.();
    quotaDisabledByUser = false;
    updateCost(ctx);
    installUi(ctx);
    sampleFooter(ctx);
    composer.setMascot(visualSettings.mascot);
    if (visualSettings.composer && enabled) composer.enable(ctx);
    suggest.sync();
    if (visualSettings.accent !== "follow") selectAccent(ctx, visualSettings.accent);
    if (branch.length >= LARGE_SESSION_ENTRIES) {
      try {
        const prefs = piPreferences(ctx)?.get();
        if (prefs && !prefs.fullscreen) {
          ctx.ui.notify(`Large session (${branch.length} entries): regular TUI redraw cost grows with history. Enable Fullscreen in /jar settings for smoother rendering.`, "warning");
        }
      } catch { /* Performance hint is optional. */ }
    }
    // Resumed sessions already have a transcript to paint. Rebuilding the animated welcome and
    // scanning other session files competes with that expensive initial render for no real benefit.
    // A fresh session is not empty: Pi records the startup thinking level/model as entries.
    const resumed = branch.some((entry) => !(typeof entry === "object" && entry !== null && "type" in entry
      && typeof entry.type === "string" && SESSION_SETUP_ENTRIES.has(entry.type)));
    if (!delegatedChild && !resumed) showWelcome(ctx);
  });
  // Any real prompt dismisses the welcome. Slash commands bypass `input`, so `agent_start` covers them.
  const dismissWelcome = (ctx: ExtensionContext) => {
    if (!welcomeTui || welcomeDismiss) return;
    if (!animations) { stopWelcome(ctx); return; }
    welcomeDismiss = 1;
    if (welcomeInterval) clearInterval(welcomeInterval);
    welcomeInterval = setInterval(() => {
      welcomeDismiss++;
      if (welcomeDismiss >= 5) stopWelcome(ctx);
      else welcomeTui?.requestRender();
    }, 90);
    welcomeTui.requestRender();
  };
  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive") return;
    dismissWelcome(ctx);
    if (!todosAcknowledged && todos?.all().every((item) => item.done)) { todosAcknowledged = true; updateTaskWidget(ctx); }
  });
  pi.on("agent_start", (_event, ctx) => { dismissWelcome(ctx); working.start(); applyWorking(ctx); });
  pi.on("turn_start", (_event, ctx) => { working.start(); applyWorking(ctx); });
  pi.on("message_end", (event, ctx) => {
    // Every message (user, assistant, tool result) moves the context window.
    sampleFooter(ctx);
    if (event.message.role === "assistant") {
      working.reportOutputTokens(event.message.usage?.output ?? 0);
      addMessageCost(event.message);
      applyWorking(ctx);
    }
  });
  pi.on("tool_execution_start", (event, ctx) => { working.toolStart(event.toolCallId, event.toolName); applyWorking(ctx); });
  pi.on("tool_execution_end", (event, ctx) => { working.toolEnd(event.toolCallId); applyWorking(ctx); });
  pi.on("ui_prompt_start", (_event, ctx) => { working.prompt(true); applyWorking(ctx); });
  pi.on("ui_prompt_end", (_event, ctx) => { working.prompt(false); applyWorking(ctx); });
  // A request may span several tool turns; keep its elapsed time and reported tokens until agent_end.
  pi.on("turn_end", (_event, ctx) => { applyWorking(ctx); });
  pi.on("agent_end", (_event, ctx) => { working.end(); applyWorking(ctx); });
  pi.on("agent_before_settle", (event) => { if (event.outcome === "error") composer.flash("error"); });
  pi.on("agent_settled", (_event, ctx) => { working.end(); applyWorking(ctx); });
  pi.on("session_tree", (_event, ctx) => {
    let branch: readonly unknown[] = [];
    try { branch = sessionBranch(ctx); } catch { /* keep empty */ }
    if (!delegatedChild) {
      restoreTodos(ctx, branch);
      restoreGoal(ctx, branch);
    }
    updateCost(ctx);
    composer.refreshSession(ctx);
    sampleFooter(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    if (!delegatedChild) { restoreTodos(ctx); restoreGoal(ctx); }
    updateCost(ctx);
    sampleFooter(ctx);
  });
  pi.on("model_select", (_event, ctx) => sampleFooter(ctx));
  pi.on("thinking_level_select", (_event, _ctx) => footerTui?.requestRender());
  pi.on("session_info_changed", (_event, ctx) => { composer.refreshSession(ctx); sampleFooter(ctx); });
  pi.on("session_shutdown", (_event, ctx) => {
    clearSessionBranchCache(ctx);
    stopWelcome(ctx);
    composer.disable(ctx);
    workingIndicatorKey = "";
    working.end();
    try { if (ctx.hasUI && ctx.mode === "tui") { ctx.ui.setWorkingMessage?.(); ctx.ui.setWorkingIndicator(); ctx.ui.setWidget("pi-jar.todos", undefined); } } catch {}
    quotaCache?.stop();
    quotaCache = undefined;
    if (!delegatedChild) { disposeDiscussionPaper(discussionFile); discussionFile = undefined; }
    todos = undefined;
    changes = undefined;
    changeCount = 0;
    shells?.dispose();
    shells = undefined;
    subagents.clear();
    goals = undefined;
    disposeFooter?.();
    disposeFooter = undefined;
    demo = false;
  });

  pi.registerShortcut?.(Key.ctrlAlt("r"), {
    description: "Refresh the pi-jar welcome screen",
    handler: async (ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") return;
      if (welcomeTui && !welcomeDismiss) refreshWelcome?.(); else showWelcome(ctx);
    }
  });
  pi.registerShortcut?.(Key.ctrlAlt("h"), {
    description: "Search earlier prompts (pi-jar)",
    handler: async (ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") return;
      let earlier: Awaited<ReturnType<typeof SessionManager.list>> = [];
      try {
        const current = ctx.sessionManager.getSessionFile();
        earlier = (await SessionManager.list(ctx.cwd)).filter((session) => session.path !== current)
          .sort((a, b) => b.modified.getTime() - a.modified.getTime()).slice(0, 50);
      } catch (error) { ctx.ui.notify("pi-jar: earlier sessions unavailable: " + String(error), "warning"); }
      const picked = await openPromptSearch(ctx, collectPrompts(sessionBranch(ctx), earlier));
      if (picked !== undefined) ctx.ui.setEditorText(picked);
    }
  });
  pi.registerShortcut?.(Key.ctrlAlt("m"), {
    description: "Cycle pi-jar model roles",
    handler: async (ctx) => { await modelRoles.cycle(ctx); footerTui?.requestRender(); }
  });
  pi.registerShortcut?.(Key.ctrlAlt("a"), {
    description: "Subagents and background shells (pi-jar)",
    handler: async (ctx) => { await openActivity(ctx); }
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
        ctx.ui.notify(`pi-jar: UI ${enabled ? "on" : "off"}; animations ${animations ? "on" : "off"}; quota ${quotaCache?.enabled ? "on" : "off"} (session-only); composer ${composer.enabled ? "on" : "off"}; mascot ${visualSettings.mascot ? "on" : "off"}; suggestions ${visualSettings.suggestions ? "on" : "off"}; ${todos?.all().length ?? 0} to-dos; demo ${demo ? "on" : "off"}`, "info");
        return;
      }
      // `/jar resume` without a number opens the same searchable picker.
      if (command === "sessions" || command.startsWith("sessions ") || command === "resume") {
        await openSessions(ctx, command === "resume" ? "" : args.trim().slice(8).trim());
        return;
      }
      if (command.startsWith("resume ")) {
        const arg = args.trim().slice(7).trim();
        const index = Number(arg);
        let recent = welcomeRecent;
        let target: { path: string } | undefined;
        try {
          if (arg.endsWith(".jsonl")) {
            // Clicks stage a path in the editor; restrict it to Pi's sessions for this project.
            target = (await SessionManager.list(ctx.cwd)).find((session) => session.path === arg);
          } else {
            if (!recent.length) recent = await loadRecent(ctx);
            target = Number.isInteger(index) && index >= 1 ? recent[index - 1] : undefined;
          }
        } catch (error) { ctx.ui.notify("Could not list sessions: " + String(error), "error"); return; }
        if (!target) { ctx.ui.notify(`No recent session ${arg}; try /jar sessions`, "warning"); return; }
        const result = await ctx.switchSession(target.path);
        if (result.cancelled) ctx.ui.notify("Session switch cancelled", "info");
        return;
      }
      if (command.startsWith("name ")) {
        const name = args.trim().slice(5).trim();
        if (name) { pi.setSessionName(name); ctx.ui.notify("Session named: " + name, "info"); }
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
          memory: "Process RAM (RSS)", cost: "Session cost", quota: "Quota", roles: "Roles", extras: "Extension statuses", branch: "Git branch"
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
          : !loadedAccents(ctx).includes(selected) ? `Pi-jar accent ${selected} is not loaded. Install with pi install npm:pi-jar and restart Pi, or launch with --theme <pi-jar>/themes`
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
          { name: "tasks", label: "Tasks (/tasks)" },
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
      if (command === "commit" || command.startsWith("commit ")) { await jarCommit(pi, ctx, modelRoles, sideUsage, args.trim().slice(6).trim()); return; }
      if (command === "shells" || command === "activity" || command === "agents") {
        if (!ctx.hasUI || ctx.mode !== "tui") {
          const lines = [...subagents.records().map(({ run }) => `${run.name} ${run.state}`), ...(shells?.summaries() ?? []).map((job) => `${job.id} ${job.name} ${job.status}`)];
          ctx.ui.notify(lines.join("\n") || "Nothing running", "info");
          return;
        }
        const shell = command === "shells" ? shells?.summaries().find((job) => job.status === "running") ?? shells?.summaries()[0] : undefined;
        await openActivity(ctx, shell ? { kind: "shell", id: shell.id } : undefined);
        return;
      }
      if (command === "icons" || command.startsWith("icons ")) {
        const requested = command.slice(5).trim();
        const next = ICON_SETS.find((set) => set === requested)
          ?? (requested ? undefined : ICON_SETS[(ICON_SETS.indexOf(visualSettings.icons) + 1) % ICON_SETS.length]);
        if (!next) { ctx.ui.notify(`Icons: ${ICON_SETS.join(" | ")} (nerd needs a Nerd Font)`, "error"); return; }
        applyVisualSettings({ ...visualSettings, icons: next }, ctx);
        ctx.ui.notify(`pi-jar icons: ${next}`, "info");
        return;
      }
      if (command === "demo") demo = true;
      else if (command === "reset" || command === "demo off") demo = false;
      else if (command === "animations on") applyVisualSettings({ ...visualSettings, animations: true }, ctx);
      else if (command === "animations off") applyVisualSettings({ ...visualSettings, animations: false }, ctx);
      else if (command === "ui on") applyVisualSettings({ ...visualSettings, ui: true }, ctx);
      else if (command === "ui off") applyVisualSettings({ ...visualSettings, ui: false }, ctx);
      else if (command === "quota on" && quotaCache) { quotaCache.enabled = true; quotaDisabledByUser = false; }
      else if (command === "quota off" && quotaCache) { quotaCache.enabled = false; quotaDisabledByUser = true; quotaCache.stop(); }
      else {
        ctx.ui.notify("Usage: /jar [status|settings|activity|shells|sessions [search]|icons [unicode|nerd|ascii]|commit [note]|name <title>|history|footer|tasks|ask|composer on/off|accent [preset]|hub|welcome|demo|reset|animations on/off|ui on/off|quota on/off]", "error");
        return;
      }
      if (!["animations on", "animations off", "ui on", "ui off"].includes(command)) installUi(ctx);
      ctx.ui.notify(`pi-jar: ${command}`, "info");
    }
  });
}
