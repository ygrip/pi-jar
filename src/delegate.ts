import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ModelRoleManager } from "./model-roles.ts";
import { ROLE_PREFIX } from "./status.ts";
import { cleanText } from "./status.ts";

export const DELEGATE_TOOL = "jar_delegate";
/** Set in child processes so a subagent never delegates again. */
export const CHILD_ENV = "PI_JAR_CHILD";
export const MAX_DELEGATES = 4;
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const MAX_OUTPUT_CHARS = 12_000;
const TIMEOUT_MS = 20 * 60_000;
const STATUS_REFRESH_MS = 20_000;
const LIVE_UPDATE_MS = 1000;
const MAX_EVENT_TEXT = 16_000;
const MAX_LOG_LINES = 200;
const MAX_LOG_CHARS = 240;
/** Finished subagents the registry keeps for the activity view after their tool call returns. */
const MAX_FINISHED = 8;
/** Abort reason for stopping one subagent from the activity view (vs. aborting the whole tool call). */
const STOP_REASON = "stopped";
/** Tool arguments that best describe a call in the transcript, most telling first. */
const HINT_KEYS = ["command", "path", "file_path", "pattern", "query", "url"] as const;

export type DelegateState = "queued" | "working" | "done" | "failed";
export interface DelegateRun {
  index: number;
  name: string;
  task: string;
  role: string;
  model?: string;
  state: DelegateState;
  activity?: string;
  tools: number;
  turns: number;
  cost: number;
  output: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  /** Live transcript (tool calls, assistant text), last MAX_LOG_LINES; never copied into tool details. */
  log: string[];
}

type Spawn = (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;

/** How to run Pi again: the current script under the current runtime, or `pi` on PATH. */
export function piInvocation(args: string[], argv = process.argv, execPath = process.execPath): { command: string; args: string[] } {
  const script = argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script)) return { command: execPath, args: [script, ...args] };
  if (!/^(node|bun)(\.exe)?$/i.test(basename(execPath))) return { command: execPath, args };
  return { command: "pi", args };
}

/** CLI arguments for one subagent: JSON events, one-shot, no session, read-only tools unless `write`. */
export function delegateArgs(task: string, model: string | undefined, thinking: string | undefined, write: boolean): string[] {
  const args = ["--mode", "json", "-p", "--no-session"];
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  if (!write) args.push("--tools", READ_ONLY_TOOLS.join(","));
  const rules = write
    ? "You may edit files. Stay strictly within the task; other subagents may be working in the same repository at the same time."
    : "You are read-only: investigate and report, do not attempt to modify anything.";
  args.push(`You are a focused subagent working for another agent. ${rules} Finish with a concise, self-contained report of your findings or changes (include file paths).\n\nTask: ${task}`);
  return args;
}

const textOf = (message: { content?: unknown }, limit = MAX_EVENT_TEXT): string => {
  if (typeof message.content === "string") return message.content.slice(0, limit);
  if (!Array.isArray(message.content)) return "";
  let out = "";
  for (const part of message.content as Array<{ type?: string; text?: string }>) {
    if (part?.type !== "text" || typeof part.text !== "string" || !part.text) continue;
    const separator = out ? "\n" : "";
    const room = limit - out.length - separator.length;
    if (room <= 0) break;
    out += separator + part.text.slice(0, room);
    if (part.text.length > room) break;
  }
  return out;
};

/** Append transcript lines, cleaned and clipped, keeping only the newest MAX_LOG_LINES. */
const appendLog = (run: DelegateRun, lines: readonly string[]) => {
  for (const raw of lines) { const line = cleanText(raw, MAX_LOG_CHARS); if (line) run.log.push(line); }
  if (run.log.length > MAX_LOG_LINES) run.log.splice(0, run.log.length - MAX_LOG_LINES);
};

/** The argument that says what a tool call does: the bash command, the file path, the search pattern… */
const toolHint = (args: unknown): string => {
  if (!args || typeof args !== "object") return "";
  for (const key of HINT_KEYS) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
};

/** The slice of Pi's JSON event stream a run reads; leaves are unknown because it is another process's output. */
interface ChildEvent {
  type?: unknown;
  toolName?: unknown;
  args?: unknown;
  message?: { role?: unknown; content?: unknown; usage?: { cost?: { total?: unknown } }; stopReason?: unknown; errorMessage?: unknown };
}

/** Run one child Pi, feeding progress into `run` and calling `update` on every change. */
export function runDelegate(run: DelegateRun, args: string[], cwd: string, signal: AbortSignal | undefined, update: () => void, spawnProcess: Spawn = spawn as Spawn): Promise<void> {
  return new Promise((resolve) => {
    const invocation = piInvocation(args);
    let child: ChildProcess;
    try {
      child = spawnProcess(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, [CHILD_ENV]: "1" } });
    } catch (error) {
      run.state = "failed"; run.error = error instanceof Error ? error.message : String(error); run.endedAt = Date.now(); update(); resolve(); return;
    }
    run.state = "working";
    run.startedAt = Date.now();
    run.activity = "starting";
    update();
    let buffer = "";
    let stderr = "";
    let finished = false;
    const finish = (state: DelegateState, error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      run.state = state;
      if (error) run.error = error;
      run.activity = undefined;
      run.endedAt = Date.now();
      update();
      resolve();
    };
    const stop = () => { child.kill("SIGTERM"); setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3000).unref?.(); };
    // Stopping one run from the activity view reads "stopped"; aborting the whole tool call reads "aborted".
    const abort = () => { stop(); finish("failed", signal?.reason === STOP_REASON ? "stopped" : "aborted"); };
    const timer = setTimeout(() => { stop(); finish("failed", "timed out"); }, TIMEOUT_MS);
    timer.unref?.();
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    const line = (raw: string) => {
      // Output that arrives after an abort or timeout must not revive a finished run's activity.
      if (finished || !raw.trim()) return;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return; }
      if (!parsed || typeof parsed !== "object") return;
      // Parsed child output: the object check above is all the cast assumes; every field stays unknown until read.
      const event = parsed as ChildEvent;
      if (event.type === "tool_execution_start") {
        run.tools++;
        run.activity = cleanText(String(event.toolName ?? "tool"), 24);
        appendLog(run, [`▸ ${run.activity} ${toolHint(event.args)}`]);
        update();
      }
      else if (event.type === "message_end" && event.message?.role === "assistant") {
        run.turns++;
        run.cost += Number(event.message.usage?.cost?.total) || 0;
        const text = textOf(event.message).trim();
        if (text) { run.output = text.slice(0, MAX_OUTPUT_CHARS); appendLog(run, text.split("\n").slice(-MAX_LOG_LINES)); }
        if (event.message.stopReason === "error" && event.message.errorMessage) run.error = cleanText(String(event.message.errorMessage), 200);
        run.activity = "thinking";
        update();
      }
    };
    child.stdout?.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const item of lines) line(item);
    });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4000); });
    child.on("error", (error) => finish("failed", error.message));
    child.on("close", (code) => {
      if (buffer) line(buffer);
      if (code === 0 && !run.error) finish("done");
      else finish("failed", run.error ?? (cleanText(stderr, 300) || `exited ${code}`));
    });
  });
}

const isActive = (state: DelegateState) => state === "queued" || state === "working";

export interface SubagentRecord { key: string; batch: number; run: DelegateRun; stop(): void }

/**
 * Live subagents for the activity view. Tool details are saved in the session, so they stay small;
 * the transcript and the per-run stop handle live only here, for this process.
 */
export class DelegateRegistry {
  private entries = new Map<string, { record: SubagentRecord; finished?: number }>();
  private listeners = new Set<() => void>();
  private sequence = 0;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  /** Queued/working first (oldest first), then finished ones newest first. */
  records(): SubagentRecord[] {
    this.sweep();
    const live: SubagentRecord[] = [];
    const finished: Array<{ record: SubagentRecord; finished: number }> = [];
    for (const { record, finished: at } of this.entries.values()) {
      if (at === undefined) live.push(record); else finished.push({ record, finished: at });
    }
    finished.sort((a, b) => b.finished - a.finished);
    return [...live, ...finished.map((entry) => entry.record)];
  }
  get(key: string): SubagentRecord | undefined { return this.entries.get(key)?.record; }
  /** Abort one queued/working run, leaving the rest of its batch alone; false when unknown or already finished. */
  stop(key: string): boolean {
    const record = this.entries.get(key)?.record;
    if (!record || !isActive(record.run.state)) return false;
    record.stop();
    this.notify();
    return true;
  }
  running(): number {
    let count = 0;
    for (const { record } of this.entries.values()) if (isActive(record.run.state)) count++;
    return count;
  }
  /** Stop outstanding runs on session changes/shutdown and forget their transcript. */
  clear(): void {
    const stopping = [...this.entries.values()].filter(({ record }) => isActive(record.run.state)).map(({ record }) => record.stop);
    this.entries.clear();
    for (const stop of stopping) stop();
    this.notify();
  }
  /** jar_delegate's side: list new runs. */
  add(...records: SubagentRecord[]): void {
    for (const record of records) this.entries.set(record.key, { record });
    this.notify();
  }
  /** jar_delegate's side: a run changed. */
  notify(): void {
    this.sweep();
    for (const listener of this.listeners) {
      try { listener(); } catch { /* views are decoration; a broken one must not break the run */ }
    }
  }
  /** Stamp runs in the order they finish and keep only the newest MAX_FINISHED of them. */
  private sweep(): void {
    let finished = 0;
    for (const entry of this.entries.values()) {
      if (isActive(entry.record.run.state)) continue;
      entry.finished ??= ++this.sequence;
      finished++;
    }
    if (finished <= MAX_FINISHED) return;
    const oldest = [...this.entries].filter(([, entry]) => entry.finished !== undefined).sort((a, b) => a[1].finished! - b[1].finished!);
    for (const [key] of oldest.slice(0, finished - MAX_FINISHED)) this.entries.delete(key);
  }
}

const Parameters = Type.Object({
  tasks: Type.Array(Type.Object({
    task: Type.String({ description: "A complete, self-contained instruction: the subagent sees nothing else." }),
    name: Type.Optional(Type.String({ description: "Short label, e.g. \"auth scout\"." })),
    role: Type.Optional(Type.String({ description: "pi-jar role for the model (default \"task\", falls back to the current model)." }))
  }), { minItems: 1, maxItems: MAX_DELEGATES }),
  write: Type.Optional(Type.Boolean({ description: "Allow file edits (default false: read-only tools)." }))
});

const glyph = (state: DelegateState) => state === "done" ? "✔" : state === "failed" ? "✖" : state === "working" ? "●" : "○";
const color = (state: DelegateState) => state === "done" ? "success" : state === "failed" ? "error" : state === "working" ? "accent" : "dim";

/** jar_delegate. Every run is listed live in `registry` (with its transcript and a stop handle) for the activity view. */
export function registerDelegate(pi: ExtensionAPI, roles: ModelRoleManager, registry: DelegateRegistry, spawnProcess?: Spawn): void {
  if (process.env[CHILD_ENV] || typeof (pi as ExtensionAPI & { registerTool?: unknown }).registerTool !== "function") return;
  let batch = 0;
  pi.registerTool({
    name: DELEGATE_TOOL,
    label: "delegate",
    description: `Run up to ${MAX_DELEGATES} subagents in parallel, each an isolated Pi with a fresh context, on a pi-jar model role (default "task"). Read-only unless write is true. Returns each subagent's report.`,
    promptSnippet: "Use jar_delegate to fan out independent investigations to parallel subagents.",
    promptGuidelines: [
      "Use jar_delegate for independent, parallelizable investigation (scouting several areas, reviewing, researching); give each task complete context because subagents see nothing else.",
      "Keep delegated work read-only by default. Only set write for clearly separated edits that cannot conflict; never have two subagents edit the same files."
    ],
    parameters: Parameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      const id = ++batch;
      const write = params.write === true;
      const runs: DelegateRun[] = params.tasks.slice(0, MAX_DELEGATES).map((item, index) => {
        const role = cleanText(item.role ?? "task", 32) || "task";
        const resolved = roles.resolve(role) ?? roles.resolve("default");
        const model = resolved ? `${resolved.provider}/${resolved.model}` : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        return { index: index + 1, name: cleanText(item.name ?? `agent ${index + 1}`, 24), task: item.task, role, ...(model ? { model } : {}),
          state: "queued", tools: 0, turns: 0, cost: 0, output: "", log: [] };
      });
      // One controller per run: aborting the tool call stops them all, the activity view stops one.
      const controllers = runs.map(() => new AbortController());
      const abortAll = () => { for (const controller of controllers) controller.abort(); };
      if (signal?.aborted) abortAll(); else signal?.addEventListener("abort", abortAll, { once: true });
      // The key doubles as the role-status id, so views can tell our own teammates from other extensions'.
      const records: SubagentRecord[] = runs.map((run, index) => ({ key: `delegate-${id}-${run.index}`, batch: id, run, stop: () => controllers[index]!.abort(STOP_REASON) }));
      registry.add(...records);
      const thinking = (role: string) => (roles.resolve(role) ?? roles.resolve("default"))?.thinking;
      // Live teammates: the welcome TEAM row and the footer read this public status contract.
      const publish = () => {
        if (!ctx.hasUI) return;
        for (const { key, run } of records) {
          try {
            ctx.ui.setStatus(`${ROLE_PREFIX}${key}`, run.state === "done" || run.state === "failed" ? undefined : JSON.stringify({
              name: run.name, label: run.name.slice(0, 12), state: run.state === "queued" ? "waiting" : "working", task: cleanText(run.task, 60), expiresAt: Date.now() + 25_000
            }));
          } catch { /* status is decoration */ }
        }
      };
      // Details are persisted with the session: never the transcript, which the registry holds instead.
      const details = (includeOutput = true) => ({ runs: runs.map(({ log: _log, ...run }) => includeOutput ? run : { ...run, output: "" }), write });
      let updateTimer: ReturnType<typeof setTimeout> | undefined;
      let lastUpdateAt = 0;
      const emitUpdate = () => {
        updateTimer = undefined;
        lastUpdateAt = Date.now();
        publish();
        onUpdate?.({ content: [{ type: "text", text: runs.map((run) => `${run.name}: ${run.state}`).join("\n") }], details: details(false) });
      };
      const update = () => {
        registry.notify();
        if (!onUpdate) { publish(); return; }
        const wait = Math.max(0, LIVE_UPDATE_MS - (Date.now() - lastUpdateAt));
        if (wait === 0) { if (updateTimer) { clearTimeout(updateTimer); updateTimer = undefined; } emitUpdate(); return; }
        if (!updateTimer) {
          updateTimer = setTimeout(emitUpdate, wait);
          updateTimer.unref?.();
        }
      };
      const flushUpdate = () => {
        if (updateTimer) { clearTimeout(updateTimer); updateTimer = undefined; }
        emitUpdate();
      };
      const refresh = setInterval(publish, STATUS_REFRESH_MS);
      refresh.unref?.();
      try {
        await Promise.all(runs.map((run, index) => runDelegate(run, delegateArgs(run.task, run.model, thinking(run.role), write), ctx.cwd, controllers[index]!.signal, update, spawnProcess)));
      } finally {
        clearInterval(refresh);
        signal?.removeEventListener("abort", abortAll);
        for (const run of runs) if (run.state !== "done") { run.state = "failed"; run.endedAt ??= Date.now(); }
        registry.notify();
        flushUpdate();
      }
      const report = runs.map((run) => `## [${run.index}] ${run.name} (${run.role}${run.model ? " · " + run.model : ""}) — ${run.state}${run.error ? ": " + run.error : ""}\n${run.output || "(no report)"}`).join("\n\n");
      return { content: [{ type: "text", text: report }], details: details() };
    },
    renderCall(args, theme) {
      const count = Array.isArray(args.tasks) ? args.tasks.length : 0;
      return new Text(theme.fg("toolTitle", theme.bold("delegate")) + " " + theme.fg("accent", `${count} subagent${count === 1 ? "" : "s"}`)
        + theme.fg("dim", args.write ? " · can edit" : " · read-only"), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const runs = (result.details as { runs?: Array<Omit<DelegateRun, "log">> } | undefined)?.runs ?? [];
      const rows = runs.map((run) => {
        const meta = [run.role, run.activity, run.tools ? `${run.tools} tools` : "", run.cost ? `$${run.cost.toFixed(3)}` : "", run.error].filter(Boolean).join(" · ");
        let row = theme.fg(color(run.state) as never, `  ${glyph(run.state)} ${run.name}`) + theme.fg("dim", " · " + meta);
        if (expanded && run.output) row += "\n" + run.output.split("\n").map((line) => theme.fg("muted", "    " + line)).join("\n");
        return row;
      });
      return new Text(rows.join("\n") || theme.fg("dim", "No subagents."), 0, 0);
    }
  });
}
