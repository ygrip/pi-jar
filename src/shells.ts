import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { safeLine } from "./diff-view.ts";
import { cleanText } from "./status.ts";
import { contentRows, optionList, sidebarWidth, splitFrame } from "./split-view.ts";

export const SHELL_TOOL = "jar_shell";
export const SHELL_MESSAGE = "pi-jar.shell";
export const MAX_RUNNING_SHELLS = 8;
const MAX_KEPT_SHELLS = 20;
const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
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

/** Long-running shell commands with bounded output and optional pattern watches. */
export class ShellManager {
  private jobs = new Map<string, { job: ShellJob; child?: ChildProcess; pattern?: RegExp; partial: string; timer?: ReturnType<typeof setTimeout> }>();
  private next = 1;
  private readonly onEvent: (event: ShellEvent) => void;
  private readonly spawnShell: typeof spawn;
  onChange?: () => void;
  constructor(onEvent: (event: ShellEvent) => void, spawnShell: typeof spawn = spawn) { this.onEvent = onEvent; this.spawnShell = spawnShell; }

  list(): ShellJob[] { return [...this.jobs.values()].map(({ job }) => ({ ...job, lines: [...job.lines] })); }
  get(id: string): ShellJob | undefined { const entry = this.jobs.get(id); return entry && { ...entry.job, lines: [...entry.job.lines] }; }
  running(): number { return [...this.jobs.values()].filter(({ job }) => job.status === "running").length; }

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
    const entry: { job: ShellJob; child?: ChildProcess; pattern?: RegExp; partial: string; timer?: ReturnType<typeof setTimeout> } = { job, partial: "", ...(pattern ? { pattern } : {}) };
    this.jobs.set(id, entry);
    // Own process group so kill() stops the whole tree (dev servers spawn children).
    const child = this.spawnShell("/bin/sh", ["-c", command], { cwd: options.cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: process.env });
    entry.child = child;
    if (child.pid !== undefined) job.pid = child.pid;
    const receive = (chunk: Buffer | string) => this.receive(entry, String(chunk));
    child.stdout?.on("data", receive);
    child.stderr?.on("data", receive);
    child.on("error", (error) => {
      if (job.status !== "running") return;
      job.status = "failed";
      job.error = error.message;
      job.endedAt = Date.now();
      this.finish(entry);
    });
    child.on("close", (code, signal) => {
      if (entry.partial) { this.push(entry, entry.partial); entry.partial = ""; }
      if (job.status === "running") job.status = "exited";
      job.exitCode = code;
      job.signal = signal;
      job.endedAt ??= Date.now();
      this.finish(entry);
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
    if (job.lines.length > MAX_LINES) { job.lines.splice(0, job.lines.length - MAX_LINES); job.dropped++; }
    if (entry.pattern && !job.matched && entry.pattern.test(line)) {
      job.matched = line;
      this.onEvent({ kind: "match", job: { ...job, lines: [...job.lines] } });
    }
  }

  private finish(entry: { job: ShellJob; timer?: ReturnType<typeof setTimeout> }): void {
    if (entry.timer) clearTimeout(entry.timer);
    this.onEvent({ kind: "exit", job: { ...entry.job, lines: [...entry.job.lines] } });
    this.onChange?.();
  }

  /** Last `count` lines (1–400). */
  output(id: string, count = 40): string[] {
    const entry = this.jobs.get(id);
    if (!entry) throw new Error("no shell " + id);
    const lines = [...entry.job.lines, ...(entry.partial ? [entry.partial] : [])];
    return lines.slice(-Math.max(1, Math.min(400, Math.floor(count))));
  }

  kill(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry) throw new Error("no shell " + id);
    if (entry.job.status !== "running" || !entry.child) return false;
    entry.job.status = "killed";
    entry.job.endedAt = Date.now();
    const signal = (name: NodeJS.Signals) => {
      const pid = entry.child?.pid;
      try { if (pid && process.platform !== "win32") process.kill(-pid, name); else entry.child?.kill(name); }
      catch { entry.child?.kill(name); }
    };
    signal("SIGTERM");
    entry.timer = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
    entry.timer.unref?.();
    this.onChange?.();
    return true;
  }

  /** Forget finished jobs beyond the retention limit (oldest first). */
  private prune(): void {
    const finished = [...this.jobs.values()].filter(({ job }) => job.status !== "running");
    for (const { job } of finished.slice(0, Math.max(0, this.jobs.size - MAX_KEPT_SHELLS + 1))) this.jobs.delete(job.id);
  }

  dispose(): void {
    for (const id of this.jobs.keys()) { try { this.kill(id); } catch { /* already gone */ } }
    this.jobs.clear();
  }
}

const elapsed = (job: ShellJob, now = Date.now()) => {
  const seconds = Math.max(0, Math.round(((job.endedAt ?? now) - job.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
export const shellState = (job: ShellJob) => job.status === "running" ? "running"
  : job.status === "exited" ? `exited ${job.exitCode ?? "?"}` : job.status === "failed" ? `failed: ${cleanText(job.error ?? "", 60)}` : "killed";
const describe = (job: ShellJob) => `${job.id} · ${job.name} · ${shellState(job)} · ${elapsed(job)}${job.watch ? ` · watch /${job.watch}/${job.matched ? " matched" : ""}` : ""}`;

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
      const reply = (text: string, jobs: ShellJob[] = manager?.list() ?? []) => ({ content: [{ type: "text" as const, text }], details: { jobs } });
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
            return reply(`${describe(manager.get(params.id)!)}\n${lines.length ? lines.join("\n") : "(no output yet)"}`);
          }
          case "kill":
            if (!params.id) return reply("kill needs an id.");
            return reply(manager.kill(params.id) ? `Stopping ${params.id}.` : `${params.id} is not running.`);
          default: {
            const jobs = manager.list();
            return reply(jobs.length ? jobs.map(describe).join("\n") : "No background shells.", jobs);
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
      const text = result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
      const lines = text.split("\n");
      const shown = expanded ? lines : lines.slice(0, 6);
      return new Text(shown.map((line, index) => theme.fg(index ? "muted" : "accent", safeLine(line))).join("\n")
        + (shown.length < lines.length ? "\n" + theme.fg("dim", `… +${lines.length - shown.length} lines (expand)`) : ""), 0, 0);
    }
  });
}

const SHELL_ACTIONS = [
  { key: "x", label: "Kill the selected shell" },
  { key: "f", label: "Follow the latest output" }
] as const;

/** Overlay: shells on the left, the selected shell's live output on the right; k kills. */
export async function openShellsView(ctx: ExtensionContext, manager: ShellManager): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  if (!manager.list().length) { ctx.ui.notify("pi-jar: no background shells (the agent starts them with jar_shell)", "info"); return; }
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let selected = 0;
    let follow = true;
    let scroll = 0;
    let rows = 0;
    let width = 80;
    let layout = { top: 1, rows: 0, leftWidth: 0, bodyX: 2, footerTop: 0 };
    const fg = (color: string, text: string) => theme.fg(color as never, text);
    const previous = manager.onChange;
    const timer = setInterval(() => tui.requestRender(), 500);
    timer.unref?.();
    manager.onChange = () => { previous?.(); tui.requestRender(); };
    const close = () => { clearInterval(timer); manager.onChange = previous; done(); };
    const component = {
      invalidate() {},
      handleInput(data: string) {
        const jobs = manager.list();
        if (matchesKey(data, Key.escape) || data === "q") return close();
        if (matchesKey(data, Key.up) || data === "k") selected = Math.max(0, selected - 1);
        else if (matchesKey(data, Key.down) || data === "j") selected = Math.min(jobs.length - 1, selected + 1);
        else if (data === "x" || data === "K") { const job = jobs[selected]; if (job) { try { manager.kill(job.id); } catch (error) { ctx.ui.notify("pi-jar: " + String(error), "error"); } } }
        else if (matchesKey(data, Key.pageUp)) { follow = false; scroll = Math.max(0, scroll - Math.max(1, rows - 2)); }
        else if (matchesKey(data, Key.pageDown)) scroll += Math.max(1, rows - 2);
        else if (data === "f" || data === "G") follow = true;
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        const row = event.y - layout.top;
        if (event.type === "wheel" && event.wheelDelta) { follow = false; scroll = Math.max(0, scroll + Math.sign(event.wheelDelta) * 3); tui.requestRender(); return { handled: true }; }
        if (event.type !== "click" || event.button !== "left") return;
        if (event.y === 0 && event.x >= width - 3) { close(); return { handled: true }; }
        if (row >= 0 && row < layout.rows && layout.leftWidth && event.x < layout.leftWidth + 3 && row < manager.list().length) { selected = row; follow = true; tui.requestRender(); return { handled: true, focus: true }; }
        const action = SHELL_ACTIONS[event.y - layout.footerTop];
        if (action) { component.handleInput(action.key); return { handled: true }; }
      },
      render(available: number): string[] {
        width = Math.max(24, available);
        rows = contentRows(6 + SHELL_ACTIONS.length, 6);
        const jobs = manager.list();
        selected = Math.min(selected, Math.max(0, jobs.length - 1));
        const job = jobs[selected];
        const listWidth = sidebarWidth(width, 20, 34);
        const bodyWidth = listWidth ? width - listWidth - 6 : width - 4;
        const output = job ? manager.output(job.id, 400) : [];
        const maxScroll = Math.max(0, output.length - rows);
        scroll = follow ? maxScroll : Math.min(scroll, maxScroll);
        if (scroll >= maxScroll) follow = true;
        const list = jobs.slice(0, rows).map((item, index) => {
          const color = item.status === "running" ? "accent" : item.status === "exited" && item.exitCode === 0 ? "success" : item.status === "killed" ? "dim" : "error";
          const glyph = item.status === "running" ? "●" : item.status === "exited" && item.exitCode === 0 ? "✔" : item.status === "killed" ? "■" : "✖";
          return fg(index === selected ? "accent" : "muted", (index === selected ? "▌" : " ")) + fg(color, glyph + " ") + fg(index === selected ? "accent" : "muted", truncateToWidth(`${item.id} ${item.name}`, Math.max(4, listWidth - 4)));
        });
        const body = output.slice(scroll, scroll + rows).map((line) => fg("muted", truncateToWidth(safeLine(line), bodyWidth)));
        if (job && !output.length) body.push(fg("dim", "(no output yet)"));
        const title = `⚙ SHELLS · ${manager.running()} running` + (job ? ` · ${describe(job)}` : "");
        const footer = [
          ...optionList(theme, SHELL_ACTIONS.map((item) => item.label), -1, SHELL_ACTIONS.map((item) => item.key)),
          fg("dim", (job ? "$ " + truncateToWidth(cleanText(job.command, 400), Math.max(8, width - 60)) + "   " : "") + "↑↓ shell · PgUp/PgDn scroll · Esc close")
        ];
        const split = splitFrame(theme, width, title, list, body, footer, rows, listWidth);
        layout = split.layout;
        return split.lines;
      }
    };
    return component;
  }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } });
}
