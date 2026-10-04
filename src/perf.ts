import { execFile } from "node:child_process";
import type { SubagentStats } from "./delegate.ts";
import type { DiscussionStats } from "./discussion.ts";
import type { QuotaStats } from "./quota.ts";
import type { ShellStats } from "./shells.ts";

/**
 * Long-session budgets. Every frame Pi draws re-renders the whole transcript, so the cost of one
 * background repaint grows with the session: background sources share one adaptive cadence here,
 * and facts that walk the session (context usage) are cached and refreshed on boundaries.
 * Diagnostics are in-memory counters read on demand by `/jar perf`; nothing here polls.
 */

/** Branch size where Pi's regular TUI redraw cost becomes noticeable (also the large-session hint). */
export const LARGE_SESSION_ENTRIES = 800;

/** `foreground`: a user action; `transition`: a visible state change; `background`: a progress delta. */
export type RenderKind = "foreground" | "transition" | "background";
export interface RenderTier {
  name: "small" | "medium" | "large" | "very large";
  /** First branch entry count in this tier. */
  minEntries: number;
  /** Minimum gap between background repaints; undefined: state transitions only. */
  backgroundMs?: number;
  /** Live-update coalescing for the Activity view, which also re-renders the transcript beneath it. */
  focusedMs: number;
}
export const RENDER_TIERS: readonly RenderTier[] = [
  { name: "small", minEntries: 0, backgroundMs: 250, focusedMs: 100 },
  { name: "medium", minEntries: 300, backgroundMs: 500, focusedMs: 150 },
  { name: "large", minEntries: LARGE_SESSION_ENTRIES, backgroundMs: 1000, focusedMs: 250 },
  { name: "very large", minEntries: 2000, focusedMs: 500 }
];
export function renderTier(entries: number): RenderTier {
  let tier = RENDER_TIERS[0]!;
  for (const candidate of RENDER_TIERS) if (entries >= candidate.minEntries) tier = candidate;
  return tier;
}

export interface RenderStats {
  entries: number;
  tier: RenderTier["name"];
  /** Current background gap; undefined while background repaints wait for the next frame. */
  intervalMs?: number;
  focusedMs: number;
  focused: boolean;
  requested: number;
  kinds: Record<RenderKind, number>;
  /** Background requests folded into another frame: a pending repaint, ours or Pi's own. */
  coalesced: number;
  /** Background requests left for the next frame (very large sessions, focused Activity view). */
  deferred: number;
  /** Frames requested while no view was attached. */
  skipped: number;
  /** Frames requested from Pi by pi-jar, `background` of them from background sources. */
  actual: number;
  background: number;
  /** Footer paints, including Pi's own frames (streaming, typing, overlays). */
  frames: number;
  backgroundLastMinute: number;
  /** Requests per source, most first. */
  sources: Array<[string, number]>;
  /** Sources of the latest frames pi-jar requested, oldest first. */
  recent: string[];
  pending: boolean;
  dirty: boolean;
  ageMs: number;
}

const MAX_SOURCES = 16;
const RECENT_FRAMES = 8;
/** Enough timestamps for the fastest tier's full minute (250 ms → 240). */
const RATE_SAMPLES = 256;

/**
 * Central footer repaint budget. User actions and visible state transitions render at once (Pi
 * still coalesces them per tick); background deltas mark the footer dirty and share one repaint
 * per tier interval, measured from the last frame of any origin. Any footer paint, including Pi's
 * own, satisfies pending background work. Very large sessions and a focused Activity view leave
 * background deltas to the next frame instead.
 */
export class RenderScheduler {
  private entryCount = 0;
  private focused = false;
  private disposed = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly pendingSources = new Set<string>();
  private lastFrameAt = Number.NEGATIVE_INFINITY;
  private dirty = false;
  private readonly startedAt: number;
  private readonly counts = { requested: 0, coalesced: 0, deferred: 0, skipped: 0, actual: 0, background: 0, frames: 0 };
  private readonly kinds: Record<RenderKind, number> = { foreground: 0, transition: 0, background: 0 };
  private readonly sources = new Map<string, number>();
  private readonly recent: string[] = [];
  private readonly backgroundTimes: number[] = [];
  private readonly render: () => boolean;
  private readonly now: () => number;

  /** `render` asks Pi for a frame and reports whether a view was attached to draw it. */
  constructor(render: () => boolean, now: () => number = () => Date.now()) {
    this.render = render;
    this.now = now;
    this.startedAt = now();
  }

  /** Branch entries: set on session start/tree/compact, then counted per message, never re-walked. */
  get entries(): number { return this.entryCount; }
  setEntries(count: number): void { this.entryCount = Math.max(0, Math.floor(count)); }
  addEntries(count = 1): void { this.entryCount += count; }
  get tier(): RenderTier { return renderTier(this.entryCount); }
  intervalMs(): number | undefined { return this.focused ? undefined : this.tier.backgroundMs; }
  focusedMs(): number { return this.tier.focusedMs; }
  /** The Activity view repaints its own live updates, and with them the footer beneath it. */
  setFocused(focused: boolean): void { this.focused = focused; }

  request(source: string, kind: RenderKind = "background"): void {
    if (this.disposed) return;
    this.counts.requested++;
    this.kinds[kind]++;
    const key = this.sources.has(source) || this.sources.size < MAX_SOURCES ? source : "other";
    this.sources.set(key, (this.sources.get(key) ?? 0) + 1);
    if (kind !== "background") { this.flush(source, kind); return; }
    this.dirty = true;
    const interval = this.intervalMs();
    if (interval === undefined) { this.counts.deferred++; return; }
    this.pendingSources.add(key);
    if (this.timer) { this.counts.coalesced++; return; }
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(undefined, "background"); },
      Math.max(0, this.lastFrameAt + interval - this.now()));
    this.timer.unref?.();
  }

  /** The footer drew a frame (ours or Pi's own); call before reading state so pending deltas are on screen. */
  painted(): void {
    this.counts.frames++;
    this.lastFrameAt = this.now();
    this.dirty = false;
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingSources.clear();
    this.counts.coalesced++;
  }

  stats(): RenderStats {
    const now = this.now();
    const tier = this.tier;
    const interval = this.intervalMs();
    let lastMinute = 0;
    for (const at of this.backgroundTimes) if (now - at <= 60_000) lastMinute++;
    return {
      entries: this.entryCount, tier: tier.name, ...(interval !== undefined ? { intervalMs: interval } : {}),
      focusedMs: tier.focusedMs, focused: this.focused, ...this.counts, kinds: { ...this.kinds },
      backgroundLastMinute: lastMinute, sources: [...this.sources].sort((a, b) => b[1] - a[1]), recent: [...this.recent],
      pending: this.timer !== undefined, dirty: this.dirty, ageMs: now - this.startedAt
    };
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingSources.clear();
  }

  private flush(source: string | undefined, kind: RenderKind): void {
    // A prompt frame also shows whatever a pending background repaint was waiting to show.
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; this.counts.coalesced++; }
    const label = source ?? ([...this.pendingSources].join("+") || "background");
    this.pendingSources.clear();
    if (!this.render()) { this.counts.skipped++; return; }
    const at = this.now();
    this.counts.actual++;
    this.lastFrameAt = at;
    this.dirty = false;
    if (kind === "background") {
      this.counts.background++;
      this.backgroundTimes.push(at);
      if (this.backgroundTimes.length > RATE_SAMPLES) this.backgroundTimes.shift();
    }
    this.recent.push(label);
    if (this.recent.length > RECENT_FRAMES) this.recent.shift();
  }
}

/** Mid-turn context recomputation happens at most this often; boundaries refresh at once. */
export const CONTEXT_SAMPLE_MS = 750;
/** Costly samples widen the window to keep mid-turn sampling near a 1% duty cycle, up to this cap. */
export const CONTEXT_SAMPLE_MAX_MS = 5000;
const CONTEXT_SAMPLE_DUTY = 100;
export interface ContextUsageLike { percent?: number | null }
export interface ContextSamplingStats {
  label: string;
  calls: number;
  errors: number;
  /** message_end marks that asked for a sample. */
  marks: number;
  totalMs: number;
  maxMs: number;
  /** Median over the latest samples. */
  medianMs?: number;
  lastSampleAgeMs?: number;
  /** Current mid-turn throttle window, widened from the median sample cost. */
  windowMs: number;
  dirty: boolean;
  pending: boolean;
}
const DURATION_SAMPLES = 32;

export function contextLabel(usage: ContextUsageLike | undefined): string {
  return usage?.percent == null || !Number.isFinite(usage.percent) ? "ctx ?" : `ctx ${Math.round(usage.percent)}%`;
}

/**
 * Cached `getContextUsage()`. Pi ends a message for every user, assistant and tool-result message,
 * and the computation can walk the session, so message ends only mark the cache dirty; one sample
 * per throttle window follows. The footer and welcome read the cached label only.
 */
export class ContextSampler {
  private current = "ctx ?";
  private read: (() => ContextUsageLike | undefined) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastSampleAt: number | undefined;
  private stale = false;
  private readonly counts = { calls: 0, errors: 0, marks: 0, totalMs: 0, maxMs: 0 };
  private readonly durations: number[] = [];
  private readonly changed: () => void;
  private readonly throttleMs: number;
  private readonly now: () => number;

  /** `changed` runs when a throttled sample changed the label; boundary refreshes leave repainting to the caller. */
  constructor(changed: () => void, throttleMs = CONTEXT_SAMPLE_MS, now: () => number = () => Date.now()) {
    this.changed = changed;
    this.throttleMs = throttleMs;
    this.now = now;
  }

  get label(): string { return this.current; }
  get dirty(): boolean { return this.stale; }

  /** Lifecycle boundary (start, tree, compact, model, rename, settle): recompute now. */
  refresh(read: () => ContextUsageLike | undefined): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.read = read;
    this.sample();
  }

  /** A message moved the context window: recompute once the throttle window allows. */
  markDirty(read: () => ContextUsageLike | undefined): void {
    this.read = read;
    this.stale = true;
    this.counts.marks++;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.stale) return;
      const before = this.current;
      this.sample();
      if (this.current !== before) this.changed();
    }, Math.max(0, (this.lastSampleAt ?? Number.NEGATIVE_INFINITY) + this.windowMs() - this.now()));
    this.timer.unref?.();
  }

  stats(): ContextSamplingStats {
    const median = this.medianMs();
    return {
      label: this.current, ...this.counts,
      ...(median !== undefined ? { medianMs: median } : {}),
      ...(this.lastSampleAt !== undefined ? { lastSampleAgeMs: this.now() - this.lastSampleAt } : {}),
      windowMs: this.windowMs(), dirty: this.stale, pending: this.timer !== undefined
    };
  }

  private medianMs(): number | undefined {
    if (!this.durations.length) return undefined;
    return [...this.durations].sort((a, b) => a - b)[Math.floor(this.durations.length / 2)]!;
  }

  /** Cost-adaptive: large sessions whose usage walk is slow sample less often mid-turn. */
  private windowMs(): number {
    const cost = (this.medianMs() ?? 0) * CONTEXT_SAMPLE_DUTY;
    return Math.max(this.throttleMs, Math.min(CONTEXT_SAMPLE_MAX_MS, Math.round(cost)));
  }

  /** Session shutdown: no timer, and no reference to the old session's context. */
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.read = undefined;
    this.stale = false;
  }

  private sample(): void {
    const read = this.read;
    if (!read) return;
    const started = performance.now();
    try { this.current = contextLabel(read()); }
    catch { this.current = "ctx ?"; this.counts.errors++; }
    const elapsed = performance.now() - started;
    this.counts.calls++;
    this.counts.totalMs += elapsed;
    this.counts.maxMs = Math.max(this.counts.maxMs, elapsed);
    this.durations.push(elapsed);
    if (this.durations.length > DURATION_SAMPLES) this.durations.shift();
    this.lastSampleAt = this.now();
    this.stale = false;
  }
}

/** Summed RSS of `pids` in bytes from one `ps` call; undefined on Windows, failure or no live pid. */
export function processRss(pids: readonly number[]): Promise<number | undefined> {
  const valid = pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (!valid.length || process.platform === "win32") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile("ps", ["-o", "rss=", "-p", valid.join(",")], { timeout: 1000, encoding: "utf8" }, (_error, stdout) => {
      // ps exits 1 when one of the pids already exited, yet still reports the others.
      let kib = 0;
      let found = 0;
      for (const line of String(stdout ?? "").split("\n")) {
        const value = Number(line.trim());
        if (line.trim() && Number.isFinite(value) && value >= 0) { kib += value; found++; }
      }
      resolve(found ? kib * 1024 : undefined);
    });
  });
}

export interface PerfSnapshot {
  entries: number;
  context: string;
  rssBytes: number;
  render?: RenderStats;
  sampling?: ContextSamplingStats;
  subagents?: SubagentStats;
  childRssBytes?: number;
  shells?: ShellStats;
  discussion?: DiscussionStats;
  quota?: QuotaStats;
  sideCalls?: number;
  now: number;
}

const count = (value: number) => Math.round(value).toLocaleString("en-US");
const mib = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MiB`;
const kib = (bytes: number) => bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : mib(bytes);
const chars = (value: number) => value < 10_000 ? count(value) : value < 1_000_000 ? `${(value / 1000).toFixed(1)}k` : `${(value / 1_000_000).toFixed(1)}M`;
const ms = (value: number) => value < 10 ? `${value.toFixed(2)} ms` : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
function age(value: number): string {
  const elapsed = Math.max(0, value);
  if (elapsed < 1000) return `${Math.round(elapsed)} ms`;
  if (elapsed < 60_000) return `${(elapsed / 1000).toFixed(1)} s`;
  const seconds = Math.floor(elapsed / 1000);
  return seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}
/** Consecutive repeats collapse: `subagents ×3 · shells`. */
function runs(labels: readonly string[]): string {
  const parts: string[] = [];
  for (let index = 0; index < labels.length;) {
    let end = index;
    while (end < labels.length && labels[end] === labels[index]) end++;
    parts.push(end - index > 1 ? `${labels[index]} ×${end - index}` : labels[index]!);
    index = end;
  }
  return parts.join(" · ") || "none";
}

/** `/jar perf`: one on-demand snapshot of the long-session budgets; sections without data are omitted. */
export function formatPerf(snapshot: PerfSnapshot): string {
  const lines = ["pi-jar perf"];
  const section = (title: string, rows: ReadonlyArray<readonly [string, string] | undefined>) => {
    lines.push("", title);
    for (const row of rows) if (row) lines.push(`  ${row[0].padEnd(20)}${row[1]}`);
  };
  const { render, sampling, subagents, shells, discussion, quota } = snapshot;
  section("session", [
    ["branch entries", count(snapshot.entries)],
    ["context", snapshot.context.replace(/^ctx /, "")],
    ["parent rss", mib(snapshot.rssBytes)]
  ]);
  if (subagents) section("subagents", [
    ["retained", count(subagents.retained)],
    ["live children", count(subagents.live) + (subagents.pids.length ? ` (pid ${subagents.pids.slice(0, 8).join(", ")}${subagents.pids.length > 8 ? ", …" : ""})` : "")],
    ["hibernated", count(subagents.hibernated)],
    ["child rss", snapshot.childRssBytes !== undefined ? mib(snapshot.childRssBytes) : subagents.live ? "unavailable" : "none"],
    ["recovery worktrees", `${count(subagents.recovery)} / ${count(subagents.recoveryLimit)}`]
  ]);
  if (render) section("render", [
    ["tier", `${render.tier} · ${render.focused ? "activity view focused" : render.intervalMs !== undefined ? `background ≥ ${render.intervalMs} ms` : "transitions only"} · activity ${render.focusedMs} ms`],
    ["requested", `${count(render.requested)} (foreground ${count(render.kinds.foreground)} · transition ${count(render.kinds.transition)} · background ${count(render.kinds.background)})`],
    ["coalesced", count(render.coalesced)],
    ["deferred", count(render.deferred)],
    ["actual", `${count(render.actual)} (background ${count(render.background)})` + (render.skipped ? ` · ${count(render.skipped)} without a view` : "")],
    ["frames painted", count(render.frames)],
    ["background rate", `${count(render.backgroundLastMinute)} / last minute`],
    ["sources", render.sources.slice(0, 5).map(([source, value]) => `${source} ${count(value)}`).join(" · ") || "none"],
    ["last sources", runs(render.recent)],
    ["pending", render.pending ? "repaint scheduled" : render.dirty ? "next frame" : "no"]
  ]);
  if (sampling) section("context sampling", [
    ["calls", count(sampling.calls) + (sampling.errors ? ` (${count(sampling.errors)} failed)` : "")],
    ["dirty marks", count(sampling.marks)],
    ["total time", ms(sampling.totalMs)],
    ["max time", ms(sampling.maxMs) + (sampling.medianMs !== undefined ? ` (median ${ms(sampling.medianMs)})` : "")],
    ["window", ms(sampling.windowMs) + " mid-turn"],
    ["last sample age", sampling.lastSampleAgeMs !== undefined ? age(sampling.lastSampleAgeMs) : "never"],
    ["pending", sampling.pending ? "sample scheduled" : sampling.dirty ? "yes" : "no"]
  ]);
  if (shells) section("shells", [
    ["live", count(shells.live) + (shells.services ? ` (${count(shells.services)} service${shells.services === 1 ? "" : "s"})` : "")],
    ["retained finished", count(shells.finished)],
    ["output retained", `${chars(shells.retainedChars)} / ${chars(shells.budgetChars)} chars`],
    shells.oldestLiveStartedAt !== undefined ? ["oldest live", age(snapshot.now - shells.oldestLiveStartedAt)] : undefined
  ]);
  if (discussion) section("discussion", [
    ["transport", discussion.transport + (discussion.listening ? "" : " (not listening)")],
    ["agents", count(discussion.agents)],
    ["messages", `${count(discussion.messages)} / ${count(discussion.maxMessages)}`
      + (discussion.oldestId !== undefined && discussion.newestId !== undefined ? ` (#${discussion.oldestId}–#${discussion.newestId})` : "")],
    ["bytes", `${kib(discussion.bytes)} / ${kib(discussion.maxBytes)}`],
    ["unanswered", count(discussion.unanswered) + (discussion.unread ? ` (${count(discussion.unread)} unread)` : "")],
    ["requests", count(discussion.requests) + (discussion.errors ? ` (${count(discussion.errors)} failed)` : "")]
  ]);
  if (quota) section("quota", [
    ["lookups", quota.enabled ? "on" : "off"],
    ...(quota.providers.length ? quota.providers.map((item) => [item.provider, [
      item.ageMs !== undefined ? `cached ${age(item.ageMs)} ago` : "not cached",
      item.ok === false ? `failed ×${item.failures}` : item.ok ? "ok" : "",
      item.retryInMs ? `next in ${age(item.retryInMs)}` : ""
    ].filter(Boolean).join(" · ")] as const) : [["provider cache", "empty"] as const]),
    ["pending", quota.providers.some((item) => item.pending) ? "yes" : "no"],
    ["requests", count(quota.requests) + (quota.failures ? ` (${count(quota.failures)} failed)` : "")],
    snapshot.sideCalls !== undefined ? ["side calls", count(snapshot.sideCalls)] : undefined
  ]);
  return lines.join("\n");
}
