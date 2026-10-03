import type { ExtensionAPI, ExtensionContext, CustomMessageEntryDraft } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { cleanText } from "./status.ts";
import { describe, SHELL_MESSAGE, type ShellEvent, type ShellManager } from "./shells.ts";

export interface ShellNotificationDetails {
  summary: string;
  ids: string[];
  events: Array<{ id: string; name: string; kind: ShellEvent["kind"]; status: string; exitCode?: number | null }>;
}

/** A compact transport payload; logs are fetched explicitly, never copied into wake-up messages. */
export function shellNotification(events: readonly ShellEvent[]): CustomMessageEntryDraft {
  const failed = events.filter(({ kind, job }) => kind === "exit" && (job.status === "failed" || (job.status === "exited" && job.exitCode !== 0))).length;
  const ready = events.filter(event => event.kind === "match").length;
  const completed = events.length - ready;
  const summary = `Background shells · ${completed} completed${failed ? ` · ${failed} failed` : ""}${ready ? ` · ${ready} ready` : ""}`;
  const details: ShellNotificationDetails = {
    summary, ids: events.map(event => event.job.id),
    events: events.map(({ kind, job }) => ({ id: job.id, name: job.name, kind, status: job.status, exitCode: job.exitCode }))
  };
  return {
    type: "custom_message", customType: SHELL_MESSAGE, display: true, details,
    content: [summary, ...events.map(({ kind, job }) => kind === "match" ? `${job.id} · ${job.name} · ready: ${cleanText(job.matched ?? "", 120)}` : describe(job)),
      "Use jar_shell output for relevant diagnostics only; observed completions do not replay."].join("\n")
  };
}

/** Keep events in our own queue while the model runs, not Pi's irrevocable follow-up queue.
 * Boundary entries are consumed before final settlement; output/peek/wait can acknowledge events
 * before delivery. Idle events wake once after a debounce, and session replacement drops old work. */
export function registerShellNotifications(pi: ExtensionAPI, manager: () => ShellManager | undefined): { notify(): void; dispose(): void } {
  let active = false;
  let interrupted = false;
  let deliveryFailures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let context: ExtensionContext | undefined;
  const shown = new Set<string>();
  const eventKey = (event: ShellEvent) => `${event.kind}:${event.job.id}`;
  const warned = new Set<string>();
  const cancelTimer = () => { clearTimeout(timer); timer = undefined; clearTimeout(feedbackTimer); feedbackTimer = undefined; };
  const take = () => {
    cancelTimer();
    const events = manager()?.takeNotifications() ?? [];
    shown.clear();
    return events.length ? shellNotification(events) : undefined;
  };
  const notify = () => {
    // UI feedback must not wait for the remote model to finish reasoning. Keep model transport
    // boundary-safe and acknowledgeable: this preview does not consume or enqueue a follow-up.
    if (active && !interrupted && context?.hasUI && !feedbackTimer && manager()?.pendingNotifications()) {
      const owner = manager(), ctx = context;
      feedbackTimer = setTimeout(() => {
        feedbackTimer = undefined;
        if (!active || interrupted || owner !== manager() || ctx !== context) return;
        const snapshot = owner?.notificationSnapshot() ?? [];
        const known = new Set(snapshot.map(eventKey));
        for (const key of shown) if (!known.has(key)) shown.delete(key);
        const events = snapshot.filter(event => !shown.has(eventKey(event)));
        if (!events.length) return;
        const summary = shellNotification(events).details as ShellNotificationDetails;
        const text = `${summary.summary}: ${events.slice(0, 3).map(event => describe(event.job)).join("; ")}. Model delivery waits for a safe turn boundary.`;
        try {
          ctx.ui.notify(cleanText(text, 420), events.some(event => event.job.exitCode !== 0 && event.kind === "exit") ? "warning" : "info");
          for (const event of events) shown.add(eventKey(event));
        } catch (error) { console.error("pi-jar: could not show shell completion", error); }
      }, 300);
      feedbackTimer.unref?.();
    }
    if (active || interrupted || timer || !manager()?.pendingNotifications()) return;
    const owner = manager();
    timer = setTimeout(() => {
      timer = undefined;
      if (active || interrupted || owner !== manager()) return;
      const events = owner?.takeNotifications() ?? [];
      if (!events.length) return;
      const { type: _type, ...message } = shellNotification(events);
      try { pi.sendMessage(message, { triggerTurn: true, deliverAs: "nextTurn" }); deliveryFailures = 0; }
      catch (error) {
        owner?.restoreNotifications(events);
        console.error("pi-jar: could not deliver shell summary", error);
        if (++deliveryFailures < 3) notify();
      }
    }, 300);
    timer.unref?.();
  };
  const reset = () => { cancelTimer(); active = false; interrupted = false; context = undefined; deliveryFailures = 0; warned.clear(); shown.clear(); };

  pi.registerMessageRenderer?.<ShellNotificationDetails>(SHELL_MESSAGE, (message, { expanded }, theme) => {
    const text = typeof message.content === "string" ? message.content : "Background shells";
    const summary = message.details?.summary ?? text.split("\n", 1)[0] ?? "Background shells";
    return new Text(expanded ? text : theme.fg("accent", cleanText(summary, 160)) + theme.fg("dim", " · expand for status"), 0, 0);
  });
  pi.on?.("session_start", (_event, ctx) => { reset(); context = ctx; });
  pi.on?.("session_shutdown", reset);
  pi.on?.("before_agent_start", (_event, ctx) => {
    context = ctx;
    active = true;
    interrupted = false;
    const entry = take();
    if (!entry) return;
    const { type: _type, ...message } = entry;
    return { message };
  });
  pi.on?.("agent_start", (_event, ctx) => { context = ctx; active = true; cancelTimer(); });
  pi.on?.("turn_end", event => {
    if (event.outcome !== "completed" || event.context?.canContinue === false) return;
    const entry = take();
    if (entry) return { entries: [entry], continue: true };
  });
  pi.on?.("agent_before_settle", event => {
    interrupted = event.outcome !== "completed";
    if (interrupted || event.context?.canContinue === false) return;
    const entry = take();
    if (entry) return { entries: [entry], continue: true };
    // One reminder per outstanding finite job, never a self-repeating continuation loop.
    const owner = manager();
    const known = new Set(owner?.summaries().map(job => job.id) ?? []);
    for (const id of warned) if (!known.has(id)) warned.delete(id);
    const pending = (owner?.verificationPending() ?? []).filter(job => !warned.has(job.id));
    if (!pending.length) return;
    for (const job of pending) warned.add(job.id);
    return { entries: [{ type: "custom_message" as const, customType: SHELL_MESSAGE, display: true,
      content: `Verification still pending: ${pending.map(job => `${job.id} (${job.name})`).join(", ")}. Use jar_shell wait/peek for these ids before claiming success, or clearly report them as pending. Do not wait for long-lived services.`,
      details: { summary: `${pending.length} background check(s) still pending`, ids: pending.map(job => job.id) }
    }], continue: true };
  });
  pi.on?.("agent_settled", () => { active = false; notify(); });
  return { notify, dispose: reset };
}
