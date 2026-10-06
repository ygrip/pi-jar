import { getAgentDir, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Key, truncateToWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ACCENT_NAMES, loadedAccents, selectAccent } from "../src/accent.ts";
import { registerAskTool } from "../src/ask-tool.ts";
import { registerCouncil } from "../src/council.ts";
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
import { ProfileStore, PROFILE_FILE, PROFILE_ENTRY, conversationStarted, pinnedProfileId } from "../src/profiles.ts";
import { openJarSettings, type PiPreferences } from "../src/settings-ui.ts";
import { openProfiles, type ProfileAction } from "../src/profile-ui.ts";
import { pickSession } from "../src/session-ui.ts";
import { fetchQuota, QuotaCache, type QuotaProvider } from "../src/quota.ts";
import { ModelRoleManager } from "../src/model-roles.ts";
import { jarCommit } from "../src/commit.ts";
import { registerAdvisor } from "../src/advisor.ts";
import { registerContextDiet } from "../src/context-diet.ts";
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
import { branchCalls, compactForBudget, CONTEXT_CONTINUATION, ContextBudgetGuard, providerCall, resumeAfterBudget } from "../src/context-budget.ts";
import { WorkingState } from "../src/working.ts";
import { ChangeTracker } from "../src/changes.ts";
import { CHILD_ENV, DelegateRegistry, registerDelegate, SUBAGENT_MESSAGE, type DelegateRun } from "../src/delegate.ts";
import { CHILD_WORKTREE_ENV, workspacePathAllowed } from "../src/delegate-worktree.ts";
import { DiscussionBroker, DISCUSSION_NOTICE, discussionClientFromEnv, registerDiscussionTool } from "../src/discussion.ts";
import { openActivityView, type ActivityTarget } from "../src/activity-view.ts";
import { ICON_SETS, setIconSet, withIcon } from "../src/icons.ts";
import { collectPrompts, openPromptSearch } from "../src/prompt-search.ts";
import { ago, recentSessions, sessionDetails, type RecentSession } from "../src/session-gallery.ts";
import { clearSessionBranchCache, sessionBranch } from "../src/session-branch.ts";
import { ContextSampler, formatPerf, LARGE_SESSION_ENTRIES, processRss, RenderScheduler, type RenderKind } from "../src/perf.ts";
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
/** Conversation content, unlike startup metadata or extension bookkeeping. */
const SESSION_TRANSCRIPT_ENTRIES = new Set(["message", "custom_message", "compaction", "branch_summary"]);
export default function piJar(pi: ExtensionAPI): void {
  const delegatedChild = process.env[CHILD_ENV] === "1";
  const delegatedWorktree = delegatedChild ? process.env[CHILD_WORKTREE_ENV] : undefined;
  if (delegatedChild) {
    // Forked transcripts retain custom prompt messages even though their automation stores
    // and handlers are disabled. Remove only parent automation, not task/user context.
    const parentAutomation = new Set([
      "pi-jar.goal-context", "pi-jar.goal-continuation",
      "pi-jar.plan-context", "pi-jar.plan-reminder", "pi-jar.moderator-context", SUBAGENT_MESSAGE, DISCUSSION_NOTICE, CONTEXT_CONTINUATION
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
  installCompactBuiltinTools(pi, { readCache: () => visualSettings.readCache === true });
  let demo = false;
  let visualSettings = defaultVisualSettings();
  let profileStore: ProfileStore | undefined;
  let animations = visualSettings.animations;
  let enabled = visualSettings.ui;
  let disposeFooter: (() => void) | undefined;
  let footerTui: { requestRender(): void } | undefined;
  /**
   * Per-session render budget and context-usage cache (src/perf.ts): created on session_start and
   * disposed on shutdown, so no repaint or sampling timer outlives its session.
   */
  let renders: RenderScheduler | undefined;
  let contextUsage: ContextSampler | undefined;
  /** Only an installed footer in a live session is repainted; user actions and transitions stay prompt. */
  const repaint = (source: string, kind: RenderKind = "foreground") => { if (footerTui) renders?.request(source, kind); };
  let footerSessionName: string | undefined;
  /** Boundaries refresh the footer facts that walk the session; message ends only mark context dirty. */
  const sampleFooter = (ctx: ExtensionContext) => {
    contextUsage?.refresh(() => ctx.getContextUsage());
    try { footerSessionName = ctx.sessionManager?.getSessionName?.(); } catch { footerSessionName = undefined; }
    repaint("session", "transition");
  };
  let quotaCache: QuotaCache | undefined;
  let enableQuota: NodeJS.Timeout | undefined;
  /**
   * Lookups start on session boundaries, never from a render, and only while an installed footer can
   * show them (never in RPC children or with the UI off); the cache bounds them to one per TTL.
   */
  const refreshQuota = (ctx: ExtensionContext) => {
    if (footerTui && footerSettings.quota) quotaCache?.refresh(ctx.model?.provider, welcomeStatuses(), Date.now());
  };
  let cost = 0;
  /**
   * Context budget: footer chip, average cost per call, prompt hints and safe-point compaction.
   * Delegated children never run it; the parent session owns the budget.
   */
  const contextGuard = new ContextBudgetGuard(() => delegatedChild ? { ...visualSettings.contextBudget, action: "off" } : visualSettings.contextBudget);
  /** jar_todo calls in flight → completed count before each ran; a raised count marks a safe point. */
  const todoCalls = new Map<string, number>();
  /** Bumped per session: a compaction finishing after a session change resumes nothing. */
  let budgetGeneration = 0;
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
  /** Leaf completion: jar_todo safe points, the stop decision and the topic hint. */
  const todoCounts = () => todoTotals(todos?.all() ?? []);
  let goals: GoalStore | undefined;
  const composer = new ComposerStyle();
  let footerSettings = visualSettings.footer;
  let welcomeStatuses = (): ReadonlyMap<string, string> => new Map();
  const working = new WorkingState();
  let workingIndicatorKey = "";
  let openSettings: (ctx: ExtensionContext) => Promise<void> = async () => {};
  let settingsOpen = false;
  const discussionClient = delegatedChild ? discussionClientFromEnv() : undefined;
  let discussion: DiscussionBroker | undefined;
  registerDiscussionTool(pi, () => delegatedChild ? discussionClient : discussion?.local());

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
    const before = changeCount;
    try { changeCount = changes?.count() ?? 0; } catch { changeCount = 0; }
    if (changeCount !== before) repaint("changes", "transition");
  };
  registerChangeReview(pi, () => changes, refreshChanges);
  let shells: ShellManager | undefined;
  registerShells(pi, () => shells);
  const shellNotifications = registerShellNotifications(pi, () => shells);
  /** Shell rows show status and watch matches: changing those is a transition, anything else a background delta. */
  let shellSignature = "";
  const noteShells = () => {
    if (!footerTui) return;
    const signature = (shells?.summaries() ?? []).map((job) => `${job.id}:${job.status}:${job.matched ? 1 : 0}`).join(" ");
    repaint("shells", signature === shellSignature ? "background" : "transition");
    shellSignature = signature;
  };
  const onShellEvent = (event: ShellEvent) => {
    noteShells();
    if (!event.job.notify) return;
    // Queue compact metadata until a model boundary; observed completions are acknowledged.
    shellNotifications.notify();
  };
  /** Footer indicators owned by pi-jar; live subagents and shells get their own rows. */
  const footerChips = () => changeCount ? [withIcon("changes", `${changeCount} file${changeCount === 1 ? "" : "s"} · /diff`)] : [];
  const subagents = new DelegateRegistry();
  /**
   * Subagent streams notify many times a second, but footer rows only change state rarely: a changed
   * key/state set is a transition, anything else (tool counts, activity text) a background delta.
   */
  let subagentSignature = "";
  subagents.subscribe(() => {
    if (!footerTui) return;
    const signature = subagents.stateSignature();
    repaint("subagents", signature === subagentSignature ? "background" : "transition");
    subagentSignature = signature;
  });
  /** Finished work stays visible briefly so a quick run is not a flicker. */
  const ACTIVITY_LINGER_MS = 5000;
  // A hibernated agent has no live process but resumes on demand: the footer shows it as idle.
  const subagentState = (run: DelegateRun): ActivityState => run.state === "working" ? "running" : run.state === "queued" ? "queued"
    : run.state === "idle" || run.state === "hibernated" ? "idle" : run.state === "paused" ? "paused" : run.state === "stopped" ? "stopped"
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
  /**
   * Subagents, shells and other extensions' roles in one live split view. While it is open it
   * repaints live updates itself (on the tier's focused cadence), so footer background deltas wait.
   */
  const openActivity = async (ctx: ExtensionContext, initial?: ActivityTarget) => {
    if (!ctx.hasUI || ctx.mode !== "tui" || overlayOpen) return;
    overlayOpen = true;
    const budget = renders;
    budget?.setFocused(true);
    try {
      await openActivityView(ctx, {
        subagents, ...(shells ? { shells } : {}),
        roles: () => collectStatuses(welcomeStatuses(), Date.now()).roles.filter((role) => !role.id.startsWith("delegate-"))
          .map((role) => ({ id: role.id, name: role.name, state: role.state, ...(role.task ? { task: role.task } : {}) })),
        repaintMs: () => renders?.focusedMs() ?? 100
      }, initial);
    } finally { overlayOpen = false; budget?.setFocused(false); }
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
  registerContextDiet(pi, () => visualSettings.contextDiet === true);
  const advisor = registerAdvisor(pi, modelRoles, { enabled: () => !delegatedChild && visualSettings.advisor, gates: () => !delegatedChild && visualSettings.advisorGates, usage: sideUsage });
  registerInfoPanels(pi, { side: sideUsage, quotaEnabled: () => quotaCache?.enabled ?? false,
    quota: (ctx) => quotaCache?.get(ctx.model?.provider, welcomeStatuses(), Date.now()),
    quotaFailure: (ctx) => quotaCache?.failure(ctx.model?.provider, Date.now()),
    refreshQuota: (ctx) => { quotaCache?.refresh(ctx.model?.provider, welcomeStatuses(), Date.now()); } });
  let followingTheme: string | undefined;
  const profileEntries = (ctx: ExtensionContext): readonly unknown[] => {
    try { return ctx.sessionManager.getEntries?.() ?? sessionBranch(ctx); } catch { return sessionBranch(ctx); }
  };
  const applyProfileTheme = (name: string, ctx: ExtensionContext) => {
    if (!ctx.hasUI || ctx.mode !== "tui" || typeof ctx.ui.setTheme !== "function") return;
    const target = name === "follow" ? followingTheme ?? "system" : name;
    if (!ctx.ui.getTheme?.(target)) throw new Error(`Theme ${target} is not loaded`);
    const result = ctx.ui.setTheme(target);
    if (result && !result.success) throw new Error(result.error ?? `Could not apply theme ${target}`);
  };
  const initializeProfiles = (ctx: ExtensionContext) => {
    const previousTheme = ctx.ui.theme?.name;
    followingTheme ??= previousTheme ?? "system";
    try {
      if (!existsSync(join(getAgentDir(), PROFILE_FILE))
        && (!ctx.hasUI || ctx.mode !== "tui" || typeof ctx.ui.getAllThemes !== "function")) {
        profileStore = undefined; visualSettings = loadVisualSettings(getAgentDir()); return undefined;
      }
      modelRoles.load(ctx.cwd);
      const legacyAccent = loadVisualSettings(getAgentDir()).accent;
      const legacyTheme = accentTheme(legacyAccent);
      const initialTheme = legacyAccent !== "follow" && ctx.ui.getTheme?.(legacyTheme) ? legacyTheme : previousTheme ?? "system";
      const store = new ProfileStore(getAgentDir(), initialTheme, modelRoles.profileRoleConfig());
      const entries = profileEntries(ctx);
      const id = pinnedProfileId(entries) ?? (conversationStarted(entries) ? "default" : store.active().id);
      const profile = store.list().find((item) => item.id === id);
      if (!profile) throw new Error("This session's profile is no longer available");
      applyProfileTheme(profile.theme, ctx);
      if (store.activeName !== profile.name) store.activate(profile.name);
      profileStore = store;
      visualSettings = profile.settings;
      composer.setProfile(profile.name);
      return { roles: profile.roles, profileId: profile.id };
    } catch (error) {
      if (previousTheme) { try { applyProfileTheme(previousTheme, ctx); } catch {} }
      profileStore = undefined; visualSettings = loadVisualSettings(getAgentDir()); composer.setProfile("Default");
      ctx.ui.notify(`Could not load profiles: ${(error as Error).message}`, "warning");
      return undefined;
    }
  };
  modelRoles.register((ctx) => openRolesUi(ctx, modelRoles), { activateDefault: () => !delegatedChild, beforeSessionStart: initializeProfiles });
  let delegateController: DelegateController | undefined;
  registerDelegate(pi, modelRoles, subagents, { changes: () => changes, changed: refreshChanges,
    discussionEnv: (key, name) => discussion?.childEnv(key, name),
    discussionRetire: (key) => discussion?.retire(key),
    discussionUnread: (key) => discussion?.unreadFor(key) ?? 0,
    discussionDigest: () => discussion?.digest(),
    getMaxSubagents: () => visualSettings.maxSubagents, onController: (controller) => { delegateController = controller; } });
  if (!delegatedChild) registerCouncil(pi, () => delegateController, () => visualSettings.maxSubagents);
  const planMode = new PlanMode(pi, () => todos, modelRoles, updateTaskWidget);
  if (!delegatedChild) planMode.register();
  const goalLoop = new GoalLoop(pi, {
    goals: () => goals, todos: () => todos, roles: modelRoles, planActive: () => planMode.isEnabled(),
    maxRounds: () => visualSettings.goalRounds,
    subagentMode: (agent) => subagents.resolve(agent)?.run.mode,
    changed: (ctx) => { repaint("goal", "transition"); welcomeTui?.requestRender(); updateTaskWidget(ctx); },
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
      // The cached sample: the welcome never forces its own walk of the session.
      const context = contextUsage?.label ?? "ctx ?";
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
            ...info, model: ctx.model?.id, profile: profileStore?.activeName ?? "Default", settingsClickable: tui.mode !== "regular", roles: live.roles,
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
        const unsubscribe = footerData.onBranchChange(() => repaint("branch", "transition"));
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
              // Whatever background state was waiting for a repaint is drawn by this frame, ours or Pi's.
              renders?.painted();
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
                  expiryTimer = setTimeout(() => { expiryTimer = undefined; expiryAt = undefined; repaint("roles", "transition"); }, Math.max(1, nearest - now));
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
                context: contextUsage?.label ?? "ctx ?", goal: goalLoop.progress(), chips: footerChips(), activity: footerActivity(now),
                memory, cost: formatCost(cost, contextGuard.perCall), overBudget: contextGuard.over, quota, roles, extras: live.extras,
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

  const persistVisualPreferences = (next: JarVisualSettings, ctx: ExtensionContext, theme?: string) => {
    if (profileStore) {
      try { profileStore.update(profileStore.activeName, { settings: next, ...(theme ? { theme } : {}) }); }
      catch (error) { ctx.ui.notify("Profile preferences changed for this session but could not be saved: " + (error as Error).message, "warning"); return; }
    }
    if (!profileStore || profileStore.active().id === "default") {
      try { saveVisualSettings(getAgentDir(), next); }
      catch { ctx.ui.notify("Visual preferences changed for this session but could not be saved", "warning"); }
    }
  };
  const accentTheme = (accent: JarVisualSettings["accent"]) => accent === "follow" ? "follow" : accent === "default" ? "pi-jar-dark" : `pi-jar-dark-${accent}`;
  const applyVisualSettings = (next: JarVisualSettings, ctx: ExtensionContext, options: { persist?: boolean; accent?: boolean } = {}) => {
    const wasEnabled = enabled;
    const hadMotion = animations;
    const accentChanged = next.accent !== visualSettings.accent;
    const quotaShown = !!footerTui && footerSettings.quota;
    if (options.accent !== false && accentChanged && next.accent === "follow") {
      try { applyProfileTheme("follow", ctx); } catch (error) { ctx.ui.notify(String(error), "warning"); return; }
    }
    if (options.accent !== false && accentChanged && next.accent !== "follow" && !selectAccent(ctx, next.accent)) {
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
    repaint("settings");
    welcomeTui?.requestRender();
    // Quota shown again (field or UI back on): hiding it stopped lookups and dropped the cache.
    if (!quotaShown) refreshQuota(ctx);
    if (options.persist !== false) persistVisualPreferences(next, ctx, accentChanged ? accentTheme(next.accent) : undefined);
  };

  let switchingProfile = false;
  const profileSwitchBlocked = (ctx: ExtensionContext): string | undefined => {
    if (switchingProfile || advisor.isBusy() || !ctx.isIdle?.() || working.phase !== "idle" || planMode.isEnabled() || goals?.isActive() || subagents.running() > 0) {
      return "Finish the active agent/workflow before switching profiles";
    }
    if (conversationStarted(profileEntries(ctx)) || pinnedProfileId(profileEntries(ctx)) !== undefined) {
      return "This session's profile is locked. Open a new session to switch profiles";
    }
    return undefined;
  };
  const canSwitchProfile = (ctx: ExtensionContext) => {
    const blocked = profileSwitchBlocked(ctx);
    if (blocked) ctx.ui.notify(blocked, "warning");
    return !blocked;
  };
  const switchProfile = async (name: string, ctx: ExtensionContext) => {
    if (!profileStore || name === profileStore.activeName || !canSwitchProfile(ctx)) return;
    const store = profileStore;
    const previous = store.active();
    const previousTheme = ctx.ui.theme?.name;
    const previousModel = ctx.model;
    const previousRole = modelRoles.activeRole();
    const previousThinking = pi.getThinkingLevel();
    const next = store.list().find((profile) => profile.name === name);
    if (!next) { ctx.ui.notify("Unknown profile: " + name, "warning"); return; }
    switchingProfile = true;
    try {
      applyProfileTheme(next.theme, ctx);
      store.activate(name);
      modelRoles.invalidateTemporaryRestores();
      modelRoles.load(ctx.cwd, next.roles, next.id);
      composer.setProfile(next.name);
      applyVisualSettings(next.settings, ctx, { persist: false, accent: false });
      if (!await modelRoles.activate("default", ctx, true)) ctx.ui.notify("Profile loaded, but its default model is unavailable; keeping the current model", "warning");
      repaint("profile"); welcomeTui?.requestRender();
      ctx.ui.notify(`Profile: ${next.name}`, "info");
    } catch (error) {
      try { if (store.activeName !== previous.name) store.activate(previous.name); } catch {}
      if (previousTheme) { try { applyProfileTheme(previousTheme, ctx); } catch {} }
      modelRoles.load(ctx.cwd, previous.roles, previous.id);
      try {
        if (previousModel && ctx.model !== previousModel && !await pi.setModel(previousModel)) throw new Error("Previous model is unavailable");
        pi.setThinkingLevel(previousThinking);
        modelRoles.restoreActiveRole(previousRole, ctx);
      } catch { ctx.ui.notify("Could not restore the previous model after the failed profile switch", "warning"); }
      composer.setProfile(previous.name);
      applyVisualSettings(previous.settings, ctx, { persist: false, accent: false });
      ctx.ui.notify(`Could not switch profile: ${(error as Error).message}`, "warning");
    } finally { switchingProfile = false; }
  };
  const profileUi = (ctx: ExtensionContext, action?: ProfileAction) => {
    if (!profileStore) { ctx.ui.notify("Profiles are unavailable in this session", "warning"); return Promise.resolve(); }
    const store = profileStore;
    return openProfiles(ctx, {
      store, themes: ctx.ui.getAllThemes?.().map((theme) => theme.name) ?? [],
      create: (name, theme) => store.add(name, theme, { ...visualSettings, accent: "follow" }, modelRoles.profileRoleConfig()),
      switchBlocked: () => profileSwitchBlocked(ctx),
      select: (name) => switchProfile(name, ctx),
      openRoles: () => openRolesUi(ctx, modelRoles)
    }, action);
  };
  openSettings = async (ctx) => {
    if (settingsOpen) return;
    settingsOpen = true;
    try { await openJarSettings(ctx, () => visualSettings,
      (next) => applyVisualSettings(next, ctx), loadedAccents(ctx), piPreferences(ctx), profileStore ? {
        activeName: () => profileStore?.activeName ?? "Default",
        open: (action) => profileUi(ctx, action)
      } : undefined); }
    finally { settingsOpen = false; }
  };
  pi.registerCommand("profiles", {
    description: "Create or switch pi-jar profiles: /profiles, /profiles new, /profiles <name>",
    handler: async (args, ctx) => {
      const target = args.trim();
      if (!target) return profileUi(ctx);
      if (["new", "create"].includes(target.toLowerCase())) return profileUi(ctx, "create");
      const profile = profileStore?.list().find((item) => item.name.toLocaleLowerCase() === target.toLocaleLowerCase());
      if (!profile) { ctx.ui.notify("Unknown profile: " + target, "warning"); return; }
      await switchProfile(profile.name, ctx);
    }
  });

  /** Callers are lifecycle handlers that repaint once through sampleFooter. */
  const updateCost = (ctx: ExtensionContext) => {
    try { cost = sessionCost(ctx); } catch { cost = 0; }
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
  };
  /** Awaited by agent_settled (see compactForBudget), whose handler is the last pi-jar settle handler. */
  const settleBudget = async (ctx: ExtensionContext) => {
    const job = contextGuard.settle({ idle: ctx.isIdle(), blocked: planMode.isEnabled() });
    if (!job) return;
    const open = (todos?.all() ?? []).filter((item) => !item.done).map((item) => item.title);
    if (!job.compact) { resumeAfterBudget(pi, ctx, open); return; }
    const generation = budgetGeneration;
    await compactForBudget(pi, ctx, { resume: job.resume, tokens: contextGuard.lastTokens, softTokens: visualSettings.contextBudget.softTokens, open },
      () => generation === budgetGeneration);
  };
  pi.on("session_start", (event, ctx) => {
    sideUsage.clear();
    if (!profileStore) initializeProfiles(ctx);
    composer.setProfile(profileStore?.activeName ?? "Default");
    setIconSet(visualSettings.icons);
    animations = visualSettings.animations;
    enabled = visualSettings.ui;
    footerSettings = visualSettings.footer;
    demo = false;
    composer.disable(ctx);
    workingIndicatorKey = "";
    working.end();
    quotaCache?.stop();
    clearTimeout(enableQuota);
    // Render and sampling counters are session-scoped; nothing from a previous session may fire.
    renders?.dispose();
    contextUsage?.dispose();
    todos = new TodoStore((entry) => pi.appendEntry(TASK_ENTRY, entry));
    changes = new ChangeTracker(() => ctx.cwd);
    changeCount = 0;
    shells?.dispose();
    const preserved = subagents.clear();
    if (preserved.length) ctx.ui.notify(`Unresolved subagent worktrees preserved on disk:\n${preserved.join("\n")}`, "warning");
    const previousDiscussion = discussion;
    if (!delegatedChild) {
      discussion = new DiscussionBroker();
      discussion.onChange = () => repaint("discussion", "background");
    }
    renders = new RenderScheduler(() => {
      const tui = footerTui;
      if (!tui) return false;
      tui.requestRender();
      return true;
    });
    contextUsage = new ContextSampler(() => repaint("context", "background"));
    subagentSignature = "";
    shellSignature = "";
    shells = new ShellManager(onShellEvent);
    shells.onChange = noteShells;
    goals = new GoalStore((entry) => pi.appendEntry(GOAL_ENTRY, entry));
    let branch: readonly unknown[] = [];
    try { branch = sessionBranch(ctx); } catch { /* keep empty */ }
    // Counted from here on per message_end: no per-event branch walk.
    renders.setEntries(branch.length);
    if (delegatedChild) {
      todos.restore([]);
      goals.restore([]);
    } else {
      restoreTodos(ctx, branch);
      restoreGoal(ctx, branch);
    }
    contextGuard.reset(branchCalls(branch, Date.now()));
    todoCalls.clear();
    budgetGeneration++;
    // Quota is enabled per session; no credentials or consent are persisted.
    quotaCache = new QuotaCache(
      (provider: QuotaProvider, signal) => fetchQuota(provider, (id) => ctx.modelRegistry.getProviderAuth(id), signal),
      () => repaint("quota", "transition")
    );
    // Hold the network lookup until startup settles; the footer shows it once it arrives.
    quotaCache.enabled = false;
    const cache = quotaCache;
    enableQuota = setTimeout(() => {
      enableQuota = undefined;
      if (quotaCache === cache && !quotaDisabledByUser) { cache.enabled = true; refreshQuota(ctx); }
    }, STARTUP_GRACE_MS);
    enableQuota.unref?.();
    quotaDisabledByUser = false;
    updateCost(ctx);
    installUi(ctx);
    sampleFooter(ctx);
    composer.setMascot(visualSettings.mascot);
    if (visualSettings.composer && enabled) composer.enable(ctx);
    suggest.sync();
    if (!profileStore && visualSettings.accent !== "follow") selectAccent(ctx, visualSettings.accent);
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
    // Fresh sessions can already contain model settings and other extensions' custom metadata.
    // Those entries are not a transcript; only conversation content or an explicit resume/fork
    // should suppress the welcome (including resumes of sessions containing only saved state).
    const resumed = event.reason === "resume" || event.reason === "fork" || branch.some((entry) =>
      typeof entry === "object" && entry !== null && "type" in entry
      && typeof entry.type === "string" && SESSION_TRANSCRIPT_ENTRIES.has(entry.type));
    if (!delegatedChild && !resumed) showWelcome(ctx);
    if (discussion) {
      const current = discussion;
      return (previousDiscussion ? previousDiscussion.close().then(() => current.start()) : current.start())
        .catch((error) => { ctx.ui.notify("Discussion broker unavailable: " + String(error), "warning"); });
    }
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
    if (profileStore && !conversationStarted(profileEntries(ctx))) {
      const id = profileStore.active().id;
      if (pinnedProfileId(profileEntries(ctx)) !== id) pi.appendEntry?.(PROFILE_ENTRY, { version: 1, id });
    }
    if (event.source !== "interactive") return;
    dismissWelcome(ctx);
    // Hints read a finished list before this prompt acknowledges (hides) it.
    if (!event.streamingBehavior) {
      const hint = contextGuard.prompt(Date.now(), todoCounts());
      if (hint) ctx.ui.notify(hint, "info");
    }
    if (!todosAcknowledged && todos?.all().every((item) => item.done)) { todosAcknowledged = true; updateTaskWidget(ctx); }
  });
  pi.on("agent_start", (_event, ctx) => {
    if (profileStore && pinnedProfileId(profileEntries(ctx)) !== profileStore.active().id) {
      pi.appendEntry?.(PROFILE_ENTRY, { version: 1, id: profileStore.active().id });
    }
    dismissWelcome(ctx); working.start(); applyWorking(ctx); refreshQuota(ctx);
  });
  pi.on("turn_start", (_event, ctx) => { working.start(); applyWorking(ctx); });
  pi.on("message_end", (event, ctx) => {
    // Every message (user, assistant, tool result) moves the context window, and a tool-heavy turn
    // ends many: count the entry and let the sampler recompute once per window, not per message.
    renders?.addEntries(1);
    contextUsage?.markDirty(() => ctx.getContextUsage());
    if (event.message.role === "assistant") {
      working.reportOutputTokens(event.message.usage?.output ?? 0);
      addMessageCost(event.message);
      // Each provider call moves the per-call average and the budget; a crossing turns the context chip amber.
      const notice = contextGuard.call(providerCall(event.message, Date.now()));
      if (notice) ctx.ui.notify(notice, "warning");
      applyWorking(ctx);
      repaint("cost", "background");
    }
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName === "jar_todo") todoCalls.set(event.toolCallId, todoCounts().done);
    working.toolStart(event.toolCallId, event.toolName); applyWorking(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    const before = todoCalls.get(event.toolCallId);
    if (before !== undefined) {
      todoCalls.delete(event.toolCallId);
      if (todoCounts().done > before) contextGuard.todoCompleted();
    }
    working.toolEnd(event.toolCallId); applyWorking(ctx);
  });
  pi.on("ui_prompt_start", (_event, ctx) => { working.prompt(true); applyWorking(ctx); });
  pi.on("ui_prompt_end", (_event, ctx) => { working.prompt(false); applyWorking(ctx); });
  // A request may span several tool turns; keep its elapsed time and reported tokens until agent_end.
  pi.on("turn_end", (event, ctx) => {
    applyWorking(ctx); refreshQuota(ctx);
    todoCalls.clear();
    // Safe point: every tool result of this turn is in. Stop before the next request; agent_settled compacts and resumes.
    const stop = event.message?.role === "assistant" ? event.message.stopReason : undefined;
    if (contextGuard.turnEnd({ open: () => { const { done, total } = todoCounts(); return total - done; },
      interrupted: stop === "error" || stop === "aborted" || ctx.signal?.aborted === true || ctx.hasPendingMessages?.() === true,
      blocked: planMode.isEnabled() })) ctx.abort();
  });
  pi.on("agent_end", (_event, ctx) => { working.end(); applyWorking(ctx); sampleFooter(ctx); });
  pi.on("agent_before_settle", (event) => { if (event.outcome === "error") composer.flash("error"); });
  // Retries or compaction after agent_end may have added messages; otherwise the agent_end sample stands.
  pi.on("agent_settled", (_event, ctx) => {
    working.end(); applyWorking(ctx); if (contextUsage?.dirty) sampleFooter(ctx); refreshQuota(ctx);
    if (contextGuard.busy) return settleBudget(ctx);
  });
  // Pi's idle cache warming keeps the prompt cache alive; the cold-cache hint counts from its last refresh.
  pi.on("cache_warming_decision", (event) => { if (event.action === "warm") contextGuard.warmed(Date.now()); });
  pi.on("session_tree", (_event, ctx) => {
    let branch: readonly unknown[] = [];
    try { branch = sessionBranch(ctx); } catch { /* keep empty */ }
    renders?.setEntries(branch.length);
    if (!delegatedChild) {
      restoreTodos(ctx, branch);
      restoreGoal(ctx, branch);
    }
    contextGuard.reset(branchCalls(branch, Date.now()));
    updateCost(ctx);
    composer.refreshSession(ctx);
    sampleFooter(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    let branch: readonly unknown[] = [];
    try { branch = sessionBranch(ctx); } catch { /* keep empty */ }
    renders?.setEntries(branch.length);
    if (!delegatedChild) { restoreTodos(ctx, branch); restoreGoal(ctx, branch); }
    contextGuard.compacted();
    updateCost(ctx);
    sampleFooter(ctx);
  });
  pi.on("model_select", (_event, ctx) => { sampleFooter(ctx); refreshQuota(ctx); });
  pi.on("thinking_level_select", (_event, _ctx) => repaint("effort"));
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
    clearTimeout(enableQuota);
    enableQuota = undefined;
    // Late notifications (draining children, shell disposal) find no scheduler and start no timer.
    renders?.dispose();
    renders = undefined;
    contextUsage?.dispose();
    contextUsage = undefined;
    contextGuard.reset();
    todoCalls.clear();
    budgetGeneration++;
    todos = undefined;
    changes = undefined;
    changeCount = 0;
    shells?.dispose();
    shells = undefined;
    const preserved = subagents.clear();
    if (preserved.length) ctx.ui.notify(`Unresolved subagent worktrees preserved on disk:\n${preserved.join("\n")}`, "warning");
    const closingDiscussion = discussion;
    discussion = undefined;
    goals = undefined;
    disposeFooter?.();
    disposeFooter = undefined;
    demo = false;
    return closingDiscussion?.close();
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
  pi.registerShortcut?.(Key.ctrlShift("tab"), {
    description: "Switch pi-jar profile",
    handler: async (ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui" || !profileStore || settingsOpen) return;
      const profiles = profileStore.list();
      const index = profiles.findIndex((profile) => profile.name === profileStore!.activeName);
      if (profiles.length > 1) await switchProfile(profiles[(index + 1) % profiles.length]!.name, ctx);
    }
  });
  pi.registerShortcut?.(Key.ctrlAlt("m"), {
    description: "Cycle pi-jar model roles",
    handler: async (ctx) => { await modelRoles.cycle(ctx); repaint("roles"); }
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
      if (command === "perf") {
        // On demand only: one `ps` call for live children; everything else is an in-memory counter.
        const subagentStats = subagents.stats();
        const childRssBytes = await processRss(subagentStats.pids);
        ctx.ui.notify(formatPerf({
          entries: renders?.entries ?? 0, context: contextUsage?.label ?? "ctx ?", rssBytes: process.memoryUsage.rss(),
          ...(renders ? { render: renders.stats() } : {}), ...(contextUsage ? { sampling: contextUsage.stats() } : {}),
          subagents: subagentStats, ...(childRssBytes !== undefined ? { childRssBytes } : {}),
          ...(shells ? { shells: shells.stats() } : {}), ...(discussion ? { discussion: discussion.stats() } : {}),
          ...(quotaCache ? { quota: quotaCache.stats() } : {}),
          sideCalls: sideUsage.all().length, now: Date.now()
        }), "info");
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
        repaint("settings");
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
          persistVisualPreferences(visualSettings, ctx, accentTheme(visualSettings.accent));
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
      else if (command === "quota on" && quotaCache) { quotaCache.enabled = true; quotaDisabledByUser = false; refreshQuota(ctx); }
      else if (command === "quota off" && quotaCache) { quotaCache.enabled = false; quotaDisabledByUser = true; quotaCache.stop(); }
      else {
        ctx.ui.notify("Usage: /jar [status|perf|settings|activity|shells|sessions [search]|icons [unicode|nerd|ascii]|commit [note]|name <title>|history|footer|tasks|ask|composer on/off|accent [preset]|hub|welcome|demo|reset|animations on/off|ui on/off|quota on/off]", "error");
        return;
      }
      if (!["animations on", "animations off", "ui on", "ui off"].includes(command)) installUi(ctx);
      ctx.ui.notify(`pi-jar: ${command}`, "info");
    }
  });
}
