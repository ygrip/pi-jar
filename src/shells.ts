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
const MAX_RETAINED_CHARS = 1024 * 1024;
const MAX_TOOL_OUTPUT_CHARS = 32 * 1024;
const KILL_GRACE_MS = 3000;

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
  matched?: string;
  /** Wake the agent when the pattern matches or the process ends. */
  notify: boolean;
  lines: string[];
  /** Lines dropped from the front of the ring buffer. */
  dropped: number;
}
export type ShellEvent = { kind: "match" | "exit"; job: ShellJob };
export interface StartOptions { command: string; cwd: string; name?: string; watch?: string; notify?: boolean }

const ANSI = /\x1b\][^\x07]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b./g;

interface ShellEntry {
  job: ShellJob;
  child?: ChildProcess;
  pattern?: RegExp;
  partial: string;
  timer?: ReturnType<typeof setTimeout>;
  closeTimer?: ReturnType<typeof setTimeout>;
  finished?: boolean;
}

/** Long-running shell commands with bounded output and optional pattern watches. */
export class ShellManager {
  private jobs = new Map<string, ShellEntry>();
  private next = 1;
  private lineChars = new Map<string, number>();
  private readonly onEvent: (event: ShellEvent) => void;
  private readonly spawnShell: typeof spawn;
  onChange?: () => void;
  constructor(onEvent: (event: ShellEvent) => void, spawnShell: typeof spawn = spawn) { this.onEvent = onEvent; this.spawnShell = spawnShell; }

  list(): ShellJob[] { return [...this.jobs.values()].map(({ job }) => ({ ...job, lines: [...job.lines] })); }
  /** Read by the footer on every render: one shallow copy per job, never the output lines. */
  summaries(): Array<Omit<ShellJob, "lines">> {
    return [...this.jobs.values()].map(({ job }) => {
      const { lines: _lines, ...summary } = job;
      return summary;
    });
  }
  get(id: string): ShellJob | undefined { const entry = this.jobs.get(id); return entry && { ...entry.job, lines: [...entry.job.lines] }; }
  running(): number {
    let count = 0;
    for (const { job } of this.jobs.values()) if (job.status === "running") count++;
    return count;
  }

  start(options: StartOptions): ShellJob {
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
      notify: options.notify ?? true, lines: [], dropped: 0, ...(options.watch ? { watch: options.watch } : {}) };
    const entry: ShellEntry = { job, partial: "", ...(pattern ? { pattern } : {}) };
    this.jobs.set(id, entry);
    this.lineChars.set(id, 0);
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

  private receive(entry: { job: ShellJob; pattern?: RegExp; partial: string }, text: string): void {
    const parts = (entry.partial + text.replace(/\r\n/g, "\n")).split("\n");
    entry.partial = parts.pop() ?? "";
    if (entry.partial.length > MAX_LINE_CHARS) { this.push(entry, entry.partial); entry.partial = ""; }
    for (const line of parts) this.push(entry, line);
  }

  private push(entry: { job: ShellJob; pattern?: RegExp }, raw: string): void {
    const line = raw.replace(ANSI, "").replace(/\r/g, "").slice(0, MAX_LINE_CHARS);
    const { job } = entry;
    job.lines.push(line);
    this.lineChars.set(job.id, (this.lineChars.get(job.id) ?? 0) + line.length);
    // Bound both line count and retained characters. A shell that prints very wide lines should
    // not quietly reserve several MiB forever just because it has not reached MAX_LINES yet.
    while (job.lines.length > MAX_LINES + LINE_PRUNE_BATCH || (this.lineChars.get(job.id) ?? 0) > MAX_RETAINED_CHARS) {
      const removed = job.lines.splice(0, Math.min(LINE_PRUNE_BATCH, job.lines.length));
      let removedChars = 0;
      for (const item of removed) removedChars += item.length;
      this.lineChars.set(job.id, Math.max(0, (this.lineChars.get(job.id) ?? 0) - removedChars));
      job.dropped += removed.length;
      if (!removed.length) break;
    }
    if (entry.pattern && !job.matched && entry.pattern.test(line)) {
      job.matched = line;
      this.onEvent({ kind: "match", job: { ...job, lines: job.lines.slice(-20) } });
    }
  }

  private finish(entry: ShellEntry): void {
    if (entry.finished) return;
    entry.finished = true;
    entry.job.endedAt ??= Date.now();
    clearTimeout(entry.timer);
    clearTimeout(entry.closeTimer);
    if (entry.child) signalProcessTree(entry.child);
    entry.child?.stdout?.destroy?.();
    entry.child?.stderr?.destroy?.();
    this.onEvent({ kind: "exit", job: { ...entry.job, lines: entry.job.lines.slice(-20) } });
    this.onChange?.();
  }

  /** Last `count` lines (1–400). */
  output(id: string, count = 40): string[] {
    const entry = this.jobs.get(id);
    if (!entry) throw new Error("no shell " + id);
    const limit = Math.max(1, Math.min(400, Math.floor(count)));
    if (!entry.partial) return entry.job.lines.slice(-limit);
    if (limit === 1) return [entry.partial];
    return [...entry.job.lines.slice(-(limit - 1)), entry.partial];
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

  /** Forget finished jobs beyond the retention limit (oldest first). */
  private prune(): void {
    const finished = [...this.jobs.values()].filter(({ job }) => job.status !== "running");
    for (const { job } of finished.slice(0, Math.max(0, this.jobs.size - MAX_KEPT_SHELLS + 1))) {
      this.jobs.delete(job.id);
      this.lineChars.delete(job.id);
    }
  }

  dispose(): void {
    for (const id of this.jobs.keys()) { try { this.kill(id); } catch { /* already gone */ } }
    this.jobs.clear();
    this.lineChars.clear();
  }
}

type ShellMeta = Omit<ShellJob, "lines">;
/** `12s` / `3m 4s` since `startedAt`, up to `endedAt` once finished. */
export const elapsed = (span: { startedAt: number; endedAt?: number }, now = Date.now()) => {
  const seconds = Math.max(0, Math.round(((span.endedAt ?? now) - span.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
export const shellState = (job: ShellMeta | ShellJob) => job.status === "running" ? "running"
  : job.status === "exited" ? `exited ${job.exitCode ?? "?"}` : job.status === "failed" ? `failed: ${cleanText(job.error ?? "", 60)}` : "killed";
export const describe = (job: ShellMeta | ShellJob) => `${job.id} · ${job.name} · ${shellState(job)} · ${elapsed(job)}${job.watch ? ` · watch /${job.watch}/${job.matched ? " matched" : ""}` : ""}`;
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
  action: Type.Unsafe<"start" | "list" | "output" | "kill">({ type: "string", enum: ["start", "list", "output", "kill"] }),
  command: Type.Optional(Type.String({ description: "Shell command to run in the background (start)." })),
  name: Type.Optional(Type.String({ description: "Short label, e.g. \"dev server\"." })),
  watch: Type.Optional(Type.String({ description: "Regex; when a line matches you are woken once, e.g. \"ready on|error\"." })),
  notify: Type.Optional(Type.Boolean({ description: "Wake you when the pattern matches or the process ends (default true)." })),
  id: Type.Optional(Type.String({ description: "Shell id for output/kill, e.g. s1." })),
  lines: Type.Optional(Type.Number({ description: "How many trailing output lines to return (default 40, max 400)." }))
});

export function registerShells(pi: ExtensionAPI, shells: () => ShellManager | undefined): void {
  if (typeof (pi as ExtensionAPI & { registerTool?: unknown }).registerTool !== "function") return;
  pi.registerTool({
    name: SHELL_TOOL,
    label: "shell",
    description: "Run long-lived commands (dev servers, watchers, long test runs) in the background. start returns immediately; you are woken when an optional watch pattern matches or the process exits. Use output to read recent lines and kill to stop it.",
    promptSnippet: "Use jar_shell for long-running or never-ending commands instead of blocking bash.",
    promptGuidelines: [
      "Use jar_shell start for servers, watchers and slow commands; set watch to a regex for the line you are waiting for (e.g. \"listening|ready|error\").",
      "Do not poll: after starting, continue other work or end your turn; a message wakes you when the watch matches or the process ends. Kill shells you no longer need."
    ],
    parameters: Parameters,
    async execute(_id, params, _signal, _update, ctx) {
      const manager = shells();
      const reply = (text: string) => ({ content: [{ type: "text" as const, text: text.slice(0, MAX_TOOL_OUTPUT_CHARS) }], details: {
        jobs: (manager?.summaries() ?? []).map((job) => ({ id: job.id, name: job.name, status: job.status, pid: job.pid, exitCode: job.exitCode }))
      } });
      if (!manager) return reply("Background shells are unavailable before a Pi session starts.");
      try {
        switch (params.action) {
          case "start": {
            const job = manager.start({ command: params.command ?? "", cwd: ctx.cwd, ...(params.name ? { name: params.name } : {}), ...(params.watch ? { watch: params.watch } : {}),
              ...(params.notify !== undefined ? { notify: params.notify } : {}) });
            return reply(`Started ${describe(job)} (pid ${job.pid ?? "?"}). ${job.notify ? "You will be woken when it " + (job.watch ? "matches or " : "") + "exits." : "Notifications are off; check it with output."}`);
          }
          case "output": {
            if (!params.id) return reply("output needs an id.");
            const lines = manager.output(params.id, params.lines ?? 40);
            return reply(`${describe(manager.get(params.id)!)}\n${lines.length ? boundedTail(lines) : "(no output yet)"}`);
          }
          case "kill":
            if (!params.id) return reply("kill needs an id.");
            return reply(manager.kill(params.id) ? `Stopping ${params.id}.` : `${params.id} is not running.`);
          default: {
            const jobs = manager.summaries();
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
