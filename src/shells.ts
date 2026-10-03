import { spawn, type ChildProcess } from "node:child_process";
import { signalProcessTree } from "./async-process.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { safeLine } from "./diff-view.ts";
import { cleanText } from "./status.ts";

export const SHELL_TOOL = "jar_shell";
export const SHELL_MESSAGE = "pi-jar.shell";
export const MAX_RUNNING_SHELLS = 8;
const MAX_KEPT_SHELLS = 20;
const MAX_LINES = 2000;
const LINE_PRUNE_BATCH = 128;
const MAX_LINE_CHARS = 2000;
/** Per-job cap. Alone it would let every retained job pin ~1 MiB of logs. */
const MAX_RETAINED_CHARS = 1024 * 1024;
/** All jobs together. Floors below (8 live tails + 20 compact tails) stay well under it. */
const DEFAULT_BUDGET_CHARS = 4 * 1024 * 1024;
/** Budget pressure never trims a live job below this, so services stay observable. */
const DEFAULT_LIVE_TAIL_CHARS = 64 * 1024;
const MAX_TOOL_OUTPUT_CHARS = 32 * 1024;
/** A surfaced finished job keeps exactly what one `output` call can return. */
const COMPACT_TAIL_CHARS = MAX_TOOL_OUTPUT_CHARS;
const MAX_OUTPUT_LINES = 400;
const KILL_GRACE_MS = 3000;
/** Trim 1/16 below a cap so a chatty job does not re-trim on every following line. */
const slack = (chars: number) => chars - (chars >> 4);

export type ShellStatus = "running" | "exited" | "killed" | "failed";
export interface ShellJob {
  id: string;
  name: string;
  command: string;
  cwd: string;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  status: ShellStatus;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  watch?: string;
  purpose?: "task" | "service";
  complete?: boolean;
  matched?: string;
  /** Wake the agent when the pattern matches or the process ends. */
  notify: boolean;
  lines: string[];
  /** Lines dropped from the front of the ring buffer. */
  dropped: number;
}
export type ShellEvent = { kind: "match" | "exit"; job: ShellJob };
export interface StartOptions { command: string; cwd: string; name?: string; watch?: string; notify?: boolean; purpose?: "task" | "service" }
export interface ShellManagerOptions { budgetChars?: number; liveTailChars?: number }
export interface ShellStats {
  /** Processes still alive, including killed jobs in their grace period and draining trees. */
  live: number;
  finished: number;
  retainedChars: number;
  budgetChars: number;
  /** Live jobs marked purpose: service — expected long-lived processes, not leftovers. */
  services: number;
  oldestLiveStartedAt?: number;
  /** `pid` is reported only while the process group is alive; a finished pid may be reused. */
  jobs: Array<{ id: string; name: string; status: ShellStatus; purpose: "task" | "service"; pid?: number; chars: number }>;
}

const ANSI = /\x1b\][^\x07]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b./g;

interface ShellEntry {
  job: ShellJob;
  child?: ChildProcess;
  pattern?: RegExp;
  partial: string;
  /** Retained line characters, maintained incrementally with the manager total. */
  chars: number;
  timer?: ReturnType<typeof setTimeout>;
  closeTimer?: ReturnType<typeof setTimeout>;
  finished?: boolean;
}

/** Long-running shell commands with bounded output and optional pattern watches. Retained logs
 * are bounded per job and globally; log pressure trims text, never processes. */
export class ShellManager {
  private jobs = new Map<string, ShellEntry>();
  private next = 1;
  private pending = new Map<string, ShellEvent>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private retained = 0;
  private readonly budgetChars: number;
  private readonly liveTailChars: number;
  private readonly onEvent: (event: ShellEvent) => void;
  private readonly spawnShell: typeof spawn;
  onChange?: () => void;
  constructor(onEvent: (event: ShellEvent) => void, spawnShell: typeof spawn = spawn, options: ShellManagerOptions = {}) {
    this.onEvent = onEvent;
    this.spawnShell = spawnShell;
    this.budgetChars = Math.max(1, Math.floor(options.budgetChars ?? DEFAULT_BUDGET_CHARS));
    this.liveTailChars = Math.max(0, Math.floor(options.liveTailChars ?? DEFAULT_LIVE_TAIL_CHARS));
  }

  list(): ShellJob[] { return [...this.jobs.values()].map(({ job }) => ({ ...job, lines: [...job.lines] })); }
  /** Read by the footer on every render: one shallow copy per job, never the output lines. */
  summaries(): Array<Omit<ShellJob, "lines">> {
    return [...this.jobs.values()].map(({ job }) => {
      const { lines: _lines, ...summary } = job;
      return summary;
    });
  }
  get(id: string): ShellJob | undefined { const entry = this.jobs.get(id); return entry && { ...entry.job, lines: [...entry.job.lines] }; }
  /** The agent saw these results: finished jobs drop everything but their compact summary. */
  acknowledge(ids: readonly string[]): void {
    for (const id of ids) { this.pending.delete(id); this.compact(id); }
  }
  /** Taken events are being delivered to the agent, which surfaces their results. */
  takeNotifications(): ShellEvent[] {
    const events = [...this.pending.values()];
    this.pending.clear();
    for (const event of events) this.compact(event.job.id);
    return events;
  }
  restoreNotifications(events: readonly ShellEvent[]): void {
    for (const event of events) if (this.jobs.has(event.job.id) && !this.pending.has(event.job.id)) this.pending.set(event.job.id, event);
  }
  pendingNotifications(): number { return this.pending.size; }
  /** Non-consuming status snapshots for immediate UI feedback; never copy or expose log lines. */
  notificationSnapshot(): ShellEvent[] { return [...this.pending.values()].map(event => ({ ...event, job: { ...event.job, lines: [] } })); }
  verificationPending(): Array<Omit<ShellJob, "lines">> {
    return [...this.jobs.values()].filter(entry => !entry.finished && entry.job.purpose !== "service").map(({ job }) => {
      const { lines: _lines, ...summary } = job;
      return summary;
    });
  }
  private emitEvent(kind: ShellEvent["kind"], job: ShellJob): void {
    if (!this.jobs.has(job.id) || this.disposed) return;
    // Terminal state supersedes readiness; queue metadata only, not duplicated log buffers.
    if (job.notify) this.pending.set(job.id, { kind, job: { ...job, lines: [] } });
    this.onEvent({ kind, job: { ...job, lines: job.lines.slice(-20) } });
  }
  async wait(ids: readonly string[], timeoutMs = 1000, signal?: AbortSignal): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) throw new Error("waitMs must be between 0 and 30000");
    for (const id of ids) if (!this.jobs.has(id)) throw new Error("no shell " + id);
    if (this.disposed) throw new Error("shell session disposed");
    if (signal?.aborted) throw signal.reason ?? new Error("wait cancelled");
    const ready = () => ids.every(id => this.jobs.get(id)?.finished === true);
    if (ready() || timeoutMs === 0) return ready();
    return new Promise<boolean>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(check); signal?.removeEventListener("abort", abort); };
      const check = () => {
        if (this.disposed || ids.some(id => !this.jobs.has(id))) { cleanup(); reject(new Error("shell session disposed or result expired")); }
        else if (ready()) { cleanup(); resolve(true); }
      };
      const abort = () => { cleanup(); reject(signal?.reason ?? new Error("wait cancelled")); };
      const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
      this.listeners.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else check();
    });
  }
  running(): number {
    let count = 0;
    for (const { job } of this.jobs.values()) if (job.status === "running") count++;
    return count;
  }

  start(options: StartOptions): ShellJob {
    if (this.disposed) throw new Error("shell session disposed");
    const command = options.command.trim();
    if (!command) throw new Error("command is required");
    if (this.running() >= MAX_RUNNING_SHELLS) throw new Error(`at most ${MAX_RUNNING_SHELLS} shells can run at once; kill one first`);
    let pattern: RegExp | undefined;
    if (options.watch) {
      if (options.watch.length > 200) throw new Error("watch pattern is too long");
      try { pattern = new RegExp(options.watch); } catch (error) { throw new Error("invalid watch pattern: " + (error instanceof Error ? error.message : String(error))); }
    }
    this.prune();
    const id = "s" + this.next++;
    const job: ShellJob = { id, name: cleanText(options.name || command, 40), command, cwd: options.cwd, startedAt: Date.now(), status: "running",
      notify: options.notify ?? true, complete: false, purpose: options.purpose ?? (options.watch ? "service" : "task"), lines: [], dropped: 0, ...(options.watch ? { watch: options.watch } : {}) };
    const entry: ShellEntry = { job, partial: "", chars: 0, ...(pattern ? { pattern } : {}) };
    this.jobs.set(id, entry);
    // Own process group so kill() stops the whole tree (dev servers spawn children).
    const child = this.spawnShell("/bin/sh", ["-c", command], { cwd: options.cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: process.env });
    entry.child = child;
    if (child.pid !== undefined) job.pid = child.pid;
    const receive = (chunk: Buffer | string) => { if (!entry.finished) this.receive(entry, String(chunk)); };
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", receive);
    child.stderr?.on("data", receive);
    child.on("error", (error) => {
      if (job.status !== "running") return;
      job.status = "failed";
      job.error = error.message;
      job.endedAt = Date.now();
      this.finish(entry);
    });
    const complete = (code: number | null, signal: NodeJS.Signals | null) => {
      if (entry.finished) return;
      if (entry.partial) { this.push(entry, entry.partial); entry.partial = ""; }
      if (job.status === "running") job.status = "exited";
      job.exitCode = code;
      job.signal = signal;
      job.endedAt ??= Date.now();
      this.finish(entry);
    };
    child.once("close", complete);
    child.once("exit", (code, signal) => {
      if (entry.finished) return;
      if (job.status === "running") job.status = "exited";
      job.exitCode = code;
      job.signal = signal;
      job.endedAt ??= Date.now();
      // Grandchildren may keep stdio open after the shell exits. Drain briefly, then reclaim
      // the entire group and emit exactly one terminal event even if close never arrives.
      entry.closeTimer = setTimeout(() => {
        signalProcessTree(child);
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        complete(code, signal);
      }, 250);
      entry.closeTimer.unref();
    });
    this.onChange?.();
    return { ...job, lines: [] };
  }

  private receive(entry: ShellEntry, text: string): void {
    const parts = (entry.partial + text.replace(/\r\n/g, "\n")).split("\n");
    entry.partial = parts.pop() ?? "";
    if (entry.partial.length > MAX_LINE_CHARS) { this.push(entry, entry.partial); entry.partial = ""; }
    for (const line of parts) this.push(entry, line);
  }

  private push(entry: ShellEntry, raw: string): void {
    // Disposed jobs are forgotten while their trees wind down; late output must not be counted.
    if (this.disposed) return;
    const line = raw.replace(ANSI, "").replace(/\r/g, "").slice(0, MAX_LINE_CHARS);
    const { job } = entry;
    job.lines.push(line);
    entry.chars += line.length;
    this.retained += line.length;
    // Bound both line count and retained characters. A shell that prints very wide lines should
    // not quietly reserve several MiB forever just because it has not reached MAX_LINES yet.
    if (job.lines.length > MAX_LINES + LINE_PRUNE_BATCH || entry.chars > MAX_RETAINED_CHARS) this.trim(entry, slack(MAX_RETAINED_CHARS), MAX_LINES);
    if (this.retained > this.budgetChars) this.enforceBudget();
    if (entry.pattern && !job.matched && entry.pattern.test(line)) {
      job.matched = line;
      this.emitEvent("match", job);
    }
  }

  /** Drop oldest lines until at most `chars` characters and `lines` lines remain. One splice. */
  private trim(entry: ShellEntry, chars: number, lines = Infinity): void {
    const buffer = entry.job.lines;
    let count = 0;
    let released = 0;
    while (count < buffer.length && (entry.chars - released > chars || buffer.length - count > lines)) released += buffer[count++]!.length;
    if (!count) return;
    buffer.splice(0, count);
    entry.chars -= released;
    this.retained -= released;
    entry.job.dropped += count;
  }

  /** Over budget: shrink oldest finished jobs to their compact tail, then oldest live jobs to
   * their protected tail, then empty finished jobs. Jobs (≤ MAX_KEPT_SHELLS) iterate oldest
   * first; the slack target keeps this off the per-line path. Processes are never touched. */
  private enforceBudget(): void {
    const target = slack(this.budgetChars);
    for (const [floor, finished] of [[COMPACT_TAIL_CHARS, true], [this.liveTailChars, false], [0, true]] as const) {
      for (const entry of this.jobs.values()) {
        if (this.retained <= target) return;
        if (!!entry.finished === finished) this.trim(entry, Math.max(floor, entry.chars - (this.retained - target)));
      }
    }
  }

  /** Keep exit status, command, timestamps, watch match and a bounded tail once surfaced. */
  private compact(id: string): void {
    const entry = this.jobs.get(id);
    if (!entry?.finished) return;
    this.trim(entry, COMPACT_TAIL_CHARS, MAX_OUTPUT_LINES);
    // A finished job never reads its stream or matches again; release the process handle.
    delete entry.child;
    delete entry.pattern;
  }

  private finish(entry: ShellEntry): void {
    if (entry.finished) return;
    entry.finished = true;
    entry.job.complete = true;
    entry.job.endedAt ??= Date.now();
    clearTimeout(entry.timer);
    clearTimeout(entry.closeTimer);
    if (entry.child) signalProcessTree(entry.child);
    entry.child?.stdout?.destroy?.();
    entry.child?.stderr?.destroy?.();
    this.emitEvent("exit", entry.job);
    for (const listener of [...this.listeners]) listener();
    this.onChange?.();
  }

  /** Last `count` lines (1–400). */
  output(id: string, count = 40): string[] {
    const entry = this.jobs.get(id);
    if (!entry) throw new Error("no shell " + id);
    const limit = Math.max(1, Math.min(MAX_OUTPUT_LINES, Math.floor(count)));
    if (!entry.partial) return entry.job.lines.slice(-limit);
    if (limit === 1) return [entry.partial];
    return [...entry.job.lines.slice(-(limit - 1)), entry.partial];
  }

  /** Diagnostics snapshot, computed on demand in one pass over ≤ MAX_KEPT_SHELLS jobs. */
  stats(): ShellStats {
    let live = 0;
    let services = 0;
    let partials = 0;
    let oldestLiveStartedAt: number | undefined;
    const jobs: ShellStats["jobs"] = [];
    for (const entry of this.jobs.values()) {
      const { job } = entry;
      const purpose = job.purpose ?? "task";
      partials += entry.partial.length;
      if (!entry.finished) {
        live++;
        if (purpose === "service") services++;
        if (oldestLiveStartedAt === undefined || job.startedAt < oldestLiveStartedAt) oldestLiveStartedAt = job.startedAt;
      }
      jobs.push({ id: job.id, name: job.name, status: job.status, purpose, chars: entry.chars + entry.partial.length, ...(!entry.finished && job.pid !== undefined ? { pid: job.pid } : {}) });
    }
    return { live, finished: this.jobs.size - live, retainedChars: this.retained + partials, budgetChars: this.budgetChars, services,
      ...(oldestLiveStartedAt !== undefined ? { oldestLiveStartedAt } : {}), jobs };
  }

  kill(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry) throw new Error("no shell " + id);
    if (entry.job.status !== "running" || !entry.child) return false;
    entry.job.status = "killed";
    entry.job.endedAt = Date.now();
    signalProcessTree(entry.child, "SIGTERM");
    entry.timer = setTimeout(() => {
      signalProcessTree(entry.child!);
      entry.child?.stdout?.destroy?.();
      entry.child?.stderr?.destroy?.();
      this.finish(entry);
    }, KILL_GRACE_MS);
    entry.timer.unref?.();
    this.onChange?.();
    return true;
  }

  /** Forget finished jobs beyond the retention limit (oldest first). A killed job still in its
   * grace period or a draining tree is alive and stays managed until it finishes. */
  private prune(): void {
    let excess = this.jobs.size - MAX_KEPT_SHELLS + 1;
    for (const [id, entry] of this.jobs) {
      if (excess <= 0) return;
      if (!entry.finished) continue;
      this.jobs.delete(id);
      this.retained -= entry.chars;
      this.pending.delete(id);
      excess--;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    for (const listener of [...this.listeners]) listener();
    for (const entry of this.jobs.values()) {
      if (entry.finished) continue;
      // Running trees get SIGTERM plus the bounded SIGKILL grace. A draining tree (leader gone,
      // descendants holding pipes) is reclaimed now rather than after its drain timer.
      if (!this.kill(entry.job.id) && entry.job.status !== "killed") this.finish(entry);
    }
    this.jobs.clear();
    this.retained = 0;
  }
}

type ShellMeta = Omit<ShellJob, "lines">;
/** `12s` / `3m 4s` since `startedAt`, up to `endedAt` once finished. */
export const elapsed = (span: { startedAt: number; endedAt?: number }, now = Date.now()) => {
  const seconds = Math.max(0, Math.round(((span.endedAt ?? now) - span.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
export const shellState = (job: ShellMeta | ShellJob) => job.status === "running" ? "running"
  : job.status === "exited" ? `exited ${job.exitCode ?? "?"}${job.complete === false ? " (draining)" : ""}` : job.status === "failed" ? `failed: ${cleanText(job.error ?? "", 60)}` : "killed";
// Services are labelled so a long-lived process reads as intended, not as a forgotten leftover.
export const describe = (job: ShellMeta | ShellJob) => `${job.id} · ${job.name} · ${shellState(job)} · ${elapsed(job)}${job.purpose === "service" ? " · service" : ""}${job.watch ? ` · watch /${job.watch}/${job.matched ? " matched" : ""}` : ""}`;
const boundedTail = (lines: readonly string[], limit = MAX_TOOL_OUTPUT_CHARS): string => {
  let size = 0;
  const kept: string[] = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    const cost = line.length + (kept.length ? 1 : 0);
    if (size + cost > limit) break;
    kept.push(line);
    size += cost;
  }
  kept.reverse();
  const omitted = lines.length - kept.length;
  return (omitted ? `… ${omitted} earlier line(s) omitted\n` : "") + kept.join("\n");
};

/** The message that wakes the agent when a watched shell matches or ends. */
export function shellEventMessage(event: ShellEvent): string {
  const { job } = event;
  const head = event.kind === "match"
    ? `Background shell ${job.id} (${job.name}) matched /${job.watch}/: ${job.matched}`
    : `Background shell ${job.id} (${job.name}) ${shellState(job)} after ${elapsed(job)}.`;
  const tail = job.lines.slice(-20);
  return head + (tail.length ? `\nLast ${tail.length} line(s):\n` + tail.join("\n") : "") + `\nUse ${SHELL_TOOL} output/kill with id ${job.id} as needed.`;
}

const Parameters = Type.Object({
  action: Type.Unsafe<"start" | "list" | "peek" | "wait" | "output" | "kill">({ type: "string", enum: ["start", "list", "peek", "wait", "output", "kill"] }),
  command: Type.Optional(Type.String({ description: "Shell command to run in the background (start)." })),
  name: Type.Optional(Type.String({ description: "Short label, e.g. \"dev server\"." })),
  watch: Type.Optional(Type.String({ description: "Regex; when a line matches you are woken once, e.g. \"ready on|error\"." })),
  notify: Type.Optional(Type.Boolean({ description: "Wake you when the pattern matches or the process ends (default true)." })),
  purpose: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("service")], { description: "task is finite and must be checked before claiming completion; service is intentionally long-lived (default with watch)." })),
  id: Type.Optional(Type.String({ description: "Shell id for output/kill/wait/peek, e.g. s1." })),
  ids: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: "Selected ids for wait/peek. Omit to inspect all jobs or wait for finite tasks only." })),
  waitMs: Type.Optional(Type.Number({ minimum: 0, maximum: 30000, description: "Bounded event-driven wait (default 1000ms, maximum 30000). Esc cancels the wait, not the shell." })),
  lines: Type.Optional(Type.Number({ description: "How many trailing output lines to return (default 40, max 400)." }))
});

export function registerShells(pi: ExtensionAPI, shells: () => ShellManager | undefined): void {
  if (typeof (pi as ExtensionAPI & { registerTool?: unknown }).registerTool !== "function") return;
  pi.registerTool({
    name: SHELL_TOOL,
    label: "shell",
    description: "Run background jobs. start returns immediately; notifications are compact and coalesced. peek reads status, wait checks selected tasks with a bounded event-driven wait, output loads logs and kill stops a process. Observed results are acknowledged so stale notifications do not replay. Verify relevant checks before claiming completion; do not wait for long-lived services.",
    promptSnippet: "Use jar_shell for long-running or never-ending commands instead of blocking bash.",
    promptGuidelines: [
      "Use jar_shell start for servers, watchers and slow commands; set watch to a regex for the line you are waiting for (e.g. \"listening|ready|error\").",
      "Do not poll: work while commands run, then use wait with explicit ids for relevant checks before the final summary. A bounded wait returns pending jobs honestly; never claim success without their exit codes. Do not wait for services/watchers. output, peek, list and wait acknowledge observed events, preventing stale replay.",
      "Completion events cannot interrupt an in-flight model response. If no useful work remains, call wait for the relevant finite jobs immediately instead of thinking or waiting for an automatic wake-up.",
      "Notifications contain coalesced status, not log dumps. Inspect output only for relevant diagnostics. Mark never-ending jobs purpose: service and kill shells you no longer need."
    ],
    parameters: Parameters,
    async execute(_id, params, signal, _update, ctx) {
      const manager = shells();
      const reply = (text: string) => ({ content: [{ type: "text" as const, text: text.slice(0, MAX_TOOL_OUTPUT_CHARS) }], details: {
        jobs: (manager?.summaries() ?? []).map((job) => ({ id: job.id, name: job.name, status: job.status, purpose: job.purpose, complete: job.complete, pid: job.pid, exitCode: job.exitCode })),
        pendingNotifications: manager?.pendingNotifications() ?? 0
      } });
      if (!manager) return reply("Background shells are unavailable before a Pi session starts.");
      try {
        switch (params.action) {
          case "start": {
            const job = manager.start({ command: params.command ?? "", cwd: ctx.cwd, ...(params.name ? { name: params.name } : {}), ...(params.watch ? { watch: params.watch } : {}),
              ...(params.notify !== undefined ? { notify: params.notify } : {}), ...(params.purpose ? { purpose: params.purpose } : {}) });
            return reply(`Started ${describe(job)} (pid ${job.pid ?? "?"}). ${job.notify ? "Completion reaches the model at the next safe turn boundary (or wakes it when idle). If no other useful work remains, use wait now." : "Notifications are off; check it with output."}`);
          }
          case "output": {
            if (!params.id) return reply("output needs an id.");
            const lines = manager.output(params.id, params.lines ?? 40);
            manager.acknowledge([params.id]);
            return reply(`${describe(manager.get(params.id)!)}\n${lines.length ? boundedTail(lines) : "(no output yet)"}`);
          }
          case "kill":
            if (!params.id) return reply("kill needs an id.");
            return reply(manager.kill(params.id) ? `Stopping ${params.id}.` : `${params.id} is not running.`);
          case "wait": {
            const ids = params.ids ?? (params.id ? [params.id] : manager.summaries().filter(job => job.purpose !== "service").map(job => job.id));
            const completed = await manager.wait(ids, params.waitMs ?? 1000, signal);
            const jobs = manager.summaries().filter(job => ids.includes(job.id));
            manager.acknowledge(ids);
            return reply((completed ? "Selected jobs completed." : "Wait timed out; jobs still pending. Do not claim they passed.") + (jobs.length ? "\n" + jobs.map(describe).join("\n") : " No finite tasks selected."));
          }
          default: {
            const ids = params.ids ?? (params.id ? [params.id] : undefined);
            const jobs = manager.summaries().filter(job => !ids || ids.includes(job.id));
            if (ids?.some(id => !jobs.some(job => job.id === id))) return reply("Unknown shell id in selection.");
            manager.acknowledge(jobs.map(job => job.id));
            return reply(jobs.length ? jobs.map(describe).join("\n") : "No background shells.");
          }
        }
      } catch (error) {
        return reply(`${params.action} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("shell")) + " " + theme.fg("accent", args.action);
      if (args.command) text += " " + theme.fg("muted", cleanText(args.command, 80));
      if (args.id) text += " " + theme.fg("muted", args.id);
      if (args.watch) text += theme.fg("dim", ` watch /${cleanText(args.watch, 40)}/`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const text = result.content.find((part) => part.type === "text")?.text ?? "";
      if (expanded) {
        const lines = text.split("\n");
        return new Text(lines.map((line, index) => theme.fg(index ? "muted" : "accent", safeLine(line))).join("\n"), 0, 0);
      }
      // Historical shell cards are rebuilt on resume. Split only enough text to draw the collapsed
      // card instead of counting every stored output line.
      const sample = text.split("\n", 7);
      const more = sample.length > 6;
      const shown = sample.slice(0, 6);
      return new Text(shown.map((line, index) => theme.fg(index ? "muted" : "accent", safeLine(line))).join("\n")
        + (more ? "\n" + theme.fg("dim", "… more lines (expand)") : ""), 0, 0);
    }
  });
}
