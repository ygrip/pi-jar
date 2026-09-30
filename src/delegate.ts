import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ChangeTracker } from "./changes.ts";
import { CHILD_BASELINE_ENV, readChildBaseline } from "./child-baselines.ts";
import type { ModelRoleManager } from "./model-roles.ts";
import { cleanText, ROLE_PREFIX } from "./status.ts";
import type { Todo } from "./tasks.ts";
import {
  applyDelegateWorktree,
  CHILD_WORKTREE_ENV,
  createDelegateWorktree,
  disposeDelegateWorktree,
  worktreeChangedFiles,
  type DelegateWorktree
} from "./delegate-worktree.ts";

export const DELEGATE_TOOL = "jar_delegate";
/** Set in child processes so a subagent never delegates again. */
export const CHILD_ENV = "PI_JAR_CHILD";
export const MAX_DELEGATES = 4;
/** Read-only subagents also keep jar_todo so their checklist shows in the activity view. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "jar_todo"] as const;
/** Writable worktree children deliberately have no shell: edits stay inside path-guarded file tools. */
export const WORKTREE_TOOLS = ["read", "edit", "write", "grep", "find", "ls", "jar_todo"] as const;
export type DelegateMode = "scout" | "fork" | "worktree";
type DelegateExecutionMode = DelegateMode | "direct";
const MAX_OUTPUT_CHARS = 12_000;
const TIMEOUT_MS = 20 * 60_000;
const STATUS_REFRESH_MS = 20_000;
const LIVE_UPDATE_MS = 1000;
const MAX_EVENT_TEXT = 16_000;
/** Transcript entries kept per run; tool output and text are clipped so a run stays well under 2 MiB. */
const MAX_ENTRIES = 200;
const MAX_ENTRY_TEXT = 4000;
const MAX_ARGS_CHARS = 2000;
/** Tail of the assistant text still streaming, shown so a long answer never looks stuck. */
const MAX_LIVE_CHARS = 1200;
const LIVE_REPAINT_MS = 50;
/** One RPC record larger than this (a huge tool result) is skipped instead of buffered. */
const MAX_LINE_CHARS = 16 * 1024 * 1024;
const MAX_FILES = 50;
const MAX_TODOS = 50;
const MAX_STEER_CHARS = 4000;
/** Finished subagents the registry keeps for the activity view after their tool call returns. */
const MAX_FINISHED = 8;
/** Abort reason for stopping one subagent from the activity view (vs. aborting the whole tool call). */
const STOP_REASON = "stopped";
/** Tool arguments that best describe a call in the transcript, most telling first. */
const HINT_KEYS = ["command", "path", "file_path", "pattern", "query", "url"] as const;
/** RPC dialogs a subagent cannot show: answered as cancelled so the child never blocks on them. */
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);
const ANSI = /\x1b\][^\x07]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b./g;

export type DelegateState = "queued" | "working" | "done" | "failed";
export type ToolStatus = "running" | "done" | "error";
/** One transcript row; `rev` changes whenever the entry does, so views can cache their rendering. */
export type TranscriptEntry =
  | { kind: "tool"; rev: number; id: string; name: string; hint: string; args: string; status: ToolStatus; output: string; startedAt: number; endedAt?: number }
  | { kind: "text" | "steer" | "note"; rev: number; text: string };
export type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

export interface DelegateRun {
  index: number;
  name: string;
  task: string;
  role: string;
  model?: string;
  mode: DelegateExecutionMode;
  state: DelegateState;
  activity?: string;
  tools: number;
  turns: number;
  cost: number;
  output: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  /** Tool calls by name, for the report. */
  toolCounts: Record<string, number>;
  filesRead: string[];
  filesEdited: string[];
  /** Worktree changes successfully copied back into the parent workspace. */
  appliedFiles: string[];
  /** Kept only when isolated changes could not safely be applied automatically. */
  workspace?: string;
  /** The subagent's own jar_todo checklist, mirrored from its tool results. */
  todos: Todo[];
  steered: number;
  /** Live transcript (tool calls with output, assistant text, steering); never copied into tool details. */
  transcript: TranscriptEntry[];
  /** Assistant text still streaming; never copied into tool details. */
  live: string;
}

type Spawn = (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;

/** How to run Pi again: the current script under the current runtime, or `pi` on PATH. */
export function piInvocation(args: string[], argv = process.argv, execPath = process.execPath): { command: string; args: string[] } {
  const script = argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script)) return { command: execPath, args: [script, ...args] };
  if (!/^(node|bun)(\.exe)?$/i.test(basename(execPath))) return { command: execPath, args };
  return { command: "pi", args };
}

/**
 * The parent's extension flags (`-e`, `--extension`, `-ne`), so a subagent loads the same extensions.
 * In particular pi-jar itself, which records edit baselines for the parent's /diff and runs jar_todo.
 */
export function extensionFlags(argv = process.argv, cwd = process.cwd()): string[] {
  const flags: string[] = [];
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "-ne" || arg === "--no-extensions") flags.push(arg);
    else if ((arg === "-e" || arg === "--extension") && argv[index + 1]) flags.push("--extension", resolve(cwd, argv[++index]!));
    else if (arg.startsWith("--extension=")) flags.push("--extension", resolve(cwd, arg.slice(12)));
  }
  return flags;
}

export interface DelegateForkOptions {
  source: string;
  sessionDir: string;
  tools?: readonly string[];
}

/** CLI arguments for one subagent: fresh ephemeral session or a real Pi session fork. */
export function delegateArgs(model: string | undefined, thinking: string | undefined, write: boolean, argv = process.argv,
  fork?: DelegateForkOptions): string[] {
  const session = fork ? ["--fork", fork.source, "--session-dir", fork.sessionDir] : ["--no-session"];
  const args = ["--mode", "rpc", ...session, ...extensionFlags(argv)];
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  const tools = fork?.tools ?? (!write ? READ_ONLY_TOOLS : undefined);
  if (tools) args.push("--tools", tools.join(","));
  return args;
}

/** The subagent's prompt: its rules, how to report back, then the task. */
export function delegatePrompt(task: string, write: boolean, mode: DelegateExecutionMode = write ? "direct" : "scout"): string {
  const rules = mode === "worktree"
    ? "You inherit the parent conversation but work inside an isolated disposable Git worktree. You may edit only with the provided file tools; shell tools are intentionally unavailable. Stay strictly within the task. Successful non-conflicting changes are copied back to the parent for /diff review."
    : mode === "fork"
      ? "You are a read-only fork of the parent conversation: use the inherited context, investigate, and report without modifying files."
      : write
        ? "You may edit files. Stay strictly within the task; other subagents may be working in the same repository at the same time."
        : "You are read-only: investigate and report, do not attempt to modify anything.";
  return [
    `You are a focused subagent working for another agent. ${rules}`,
    "Track multi-step work with jar_todo (when available) so your progress is visible. The user may steer you while you work; follow their messages.",
    "Finish with a self-contained report in these sections:",
    "## Summary — the outcome in one to three sentences.",
    "## Details — findings or changes, with file paths (and line numbers where useful).",
    "## Verification — what you checked or ran, and the results.",
    "## Open issues — risks, unknowns and follow-ups, or \"none\".",
    "",
    `Task: ${task}`
  ].join("\n");
}

/** Text without terminal controls, keeping line breaks; clipped to `limit`. */
const cleanBlock = (value: string, limit: number): string => value.slice(0, limit * 2)
  .replace(ANSI, "").replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, limit);

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

/** The argument that says what a tool call does: the bash command, the file path, the search pattern… */
const toolHint = (args: unknown): string => {
  if (!args || typeof args !== "object") return "";
  for (const key of HINT_KEYS) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
};
const toolPath = (args: unknown): string | undefined => {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>).path ?? (args as Record<string, unknown>).file_path;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};
const argsText = (args: unknown): string => {
  if (args === undefined) return "";
  try { return cleanBlock(JSON.stringify(args, null, 1) ?? "", MAX_ARGS_CHARS); } catch { return ""; }
};

const pushEntry = (run: DelegateRun, entry: TranscriptEntry) => {
  run.transcript.push(entry);
  if (run.transcript.length > MAX_ENTRIES) run.transcript.splice(0, run.transcript.length - MAX_ENTRIES);
};
const addFile = (list: string[], path: string) => {
  const clean = cleanText(path, 300);
  if (clean && !list.includes(clean) && list.length < MAX_FILES) list.push(clean);
};

/** A subagent's jar_todo items from a tool result, or undefined when the result is not a checklist. */
export function childTodos(details: unknown): Todo[] | undefined {
  const items = details && typeof details === "object" ? (details as { items?: unknown }).items : undefined;
  if (!Array.isArray(items)) return undefined;
  const todos: Todo[] = [];
  for (const raw of items.slice(0, MAX_TODOS)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const status = item.status;
    if (typeof item.id !== "string" || typeof item.title !== "string" || (status !== "pending" && status !== "in_progress" && status !== "completed")) continue;
    todos.push({
      id: cleanText(item.id, 64), title: cleanText(item.title, 120), status, done: status === "completed",
      ...(typeof item.activeForm === "string" && item.activeForm.trim() ? { activeForm: cleanText(item.activeForm, 80) } : {}),
      ...(typeof item.parentId === "string" && item.parentId ? { parentId: cleanText(item.parentId, 64) } : {})
    });
  }
  return todos;
}

/** Tasks that count toward completion: subtasks, and top-level tasks without subtasks. */
export const leafTodos = (todos: readonly Todo[]): Todo[] => {
  const parents = new Set<string>();
  for (const todo of todos) if (todo.parentId) parents.add(todo.parentId);
  return todos.filter((todo) => !parents.has(todo.id));
};

/** The slice of Pi's RPC stream a run reads; leaves are unknown because it is another process's output. */
interface ChildEvent {
  type?: unknown;
  id?: unknown;
  command?: unknown;
  success?: unknown;
  error?: unknown;
  method?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  args?: unknown;
  isError?: unknown;
  result?: { content?: unknown; details?: unknown };
  partialResult?: { content?: unknown };
  assistantMessageEvent?: { type?: unknown; delta?: unknown };
  message?: { role?: unknown; content?: unknown; usage?: { cost?: { total?: unknown } }; stopReason?: unknown; errorMessage?: unknown };
}

export interface DelegateHooks {
  /** Extra environment for the child (the baseline directory for /diff). */
  env?: Record<string, string>;
  /** A successful edit/write by the child, with the path it gave. */
  edited?(path: string): void;
}
export interface DelegateHandle { done: Promise<void>; steer(text: string): boolean }

/**
 * Run one child Pi in RPC mode, feeding progress into `run` and calling `update` on every change.
 * RPC keeps stdin open so the user can steer the subagent; it is closed once the child settles.
 */
export function startDelegate(run: DelegateRun, args: string[], prompt: string, cwd: string, signal: AbortSignal | undefined,
  update: () => void, spawnProcess: Spawn = spawn as Spawn, hooks: DelegateHooks = {}): DelegateHandle {
  let steer: (text: string) => boolean = () => false;
  const done = new Promise<void>((resolveDone) => {
    const invocation = piInvocation(args);
    let child: ChildProcess;
    try {
      child = spawnProcess(invocation.command, invocation.args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...hooks.env, [CHILD_ENV]: "1" } });
    } catch (error) {
      run.state = "failed"; run.error = error instanceof Error ? error.message : String(error); run.endedAt = Date.now(); update(); resolveDone(); return;
    }
    run.state = "working";
    run.startedAt = Date.now();
    run.activity = "starting";
    update();
    let buffer = "";
    // A JSON line past this is dropped whole rather than buffered without bound.
    let overflow = false;
    // Streamed text repaints at most every LIVE_REPAINT_MS; the trailing timer shows the last tokens.
    let liveAt = 0;
    let liveTimer: ReturnType<typeof setTimeout> | undefined;
    let stderr = "";
    let finished = false;
    let settled = false;
    const send = (command: object): boolean => {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
      try { stdin.write(JSON.stringify(command) + "\n"); return true; } catch { return false; }
    };
    // EPIPE after the child exits is expected; anything else is kept for the failure message.
    child.stdin?.on("error", (error) => { if (!finished) stderr = (stderr + "\n" + error.message).slice(-4000); });
    const finish = (state: DelegateState, error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(liveTimer);
      signal?.removeEventListener("abort", abort);
      if (child.stdin && !child.stdin.writableEnded) child.stdin.end();
      run.state = state;
      if (error) run.error = error;
      run.activity = undefined;
      run.live = "";
      for (const entry of run.transcript) if (entry.kind === "tool" && entry.status === "running") { entry.status = "error"; entry.endedAt = Date.now(); entry.rev++; }
      run.endedAt = Date.now();
      update();
      resolveDone();
    };
    const stop = () => { child.kill("SIGTERM"); setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3000).unref?.(); };
    // Stopping one run from the activity view reads "stopped"; aborting the whole tool call reads "aborted".
    const abort = () => { stop(); finish("failed", signal?.reason === STOP_REASON ? "stopped" : "aborted"); };
    const timer = setTimeout(() => { stop(); finish("failed", "timed out"); }, TIMEOUT_MS);
    timer.unref?.();
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    const running = new Map<string, { entry: ToolEntry; path?: string }>();
    const line = (raw: string) => {
      // Output that arrives after an abort or timeout must not revive a finished run's activity.
      if (finished || !raw.trim()) return;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return; }
      if (!parsed || typeof parsed !== "object") return;
      // Parsed child output: the object check above is all the cast assumes; every field stays unknown until read.
      const event = parsed as ChildEvent;
      switch (event.type) {
        case "response":
          if (event.success !== false) return;
          if (event.command === "prompt") { stop(); finish("failed", cleanText(String(event.error ?? "prompt rejected"), 300)); return; }
          pushEntry(run, { kind: "note", rev: 0, text: `${cleanText(String(event.command ?? "command"), 24)} rejected: ${cleanText(String(event.error ?? ""), 200)}` });
          update();
          return;
        case "extension_ui_request":
          if (DIALOGS.has(String(event.method))) send({ type: "extension_ui_response", id: event.id, cancelled: true });
          return;
        case "message_update": {
          const delta = event.assistantMessageEvent;
          if (delta?.type === "text_delta" && typeof delta.delta === "string") {
            run.live = (run.live + delta.delta).slice(-MAX_LIVE_CHARS);
            run.activity = "writing";
            const now = Date.now();
            if (now - liveAt >= LIVE_REPAINT_MS) { liveAt = now; update(); }
            else if (!liveTimer) {
              liveTimer = setTimeout(() => { liveTimer = undefined; liveAt = Date.now(); if (!finished) update(); }, LIVE_REPAINT_MS - (now - liveAt));
              liveTimer.unref?.();
            }
          } else if ((delta?.type === "thinking_start" || delta?.type === "thinking_delta") && run.activity !== "thinking") {
            run.activity = "thinking";
            update();
          }
          return;
        }
        case "tool_execution_start": {
          const name = cleanText(String(event.toolName ?? "tool"), 24) || "tool";
          const hint = cleanText(toolHint(event.args), 200);
          const id = typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : `call-${run.tools}`;
          const entry: ToolEntry = { kind: "tool", rev: 0, id, name, hint, args: argsText(event.args), status: "running", output: "", startedAt: Date.now() };
          const path = toolPath(event.args);
          run.tools++;
          run.toolCounts[name] = (run.toolCounts[name] ?? 0) + 1;
          if (name === "read" && path) addFile(run.filesRead, path);
          running.set(id, { entry, ...(path ? { path } : {}) });
          pushEntry(run, entry);
          run.activity = cleanText(hint ? `${name} ${hint}` : name, 60);
          update();
          return;
        }
        case "tool_execution_update": {
          const call = typeof event.toolCallId === "string" ? running.get(event.toolCallId) : undefined;
          if (!call || !event.partialResult) return;
          call.entry.output = cleanBlock(textOf(event.partialResult, MAX_ENTRY_TEXT * 2), MAX_ENTRY_TEXT);
          call.entry.rev++;
          update();
          return;
        }
        case "tool_execution_end": {
          const call = typeof event.toolCallId === "string" ? running.get(event.toolCallId) : undefined;
          if (call) running.delete(event.toolCallId as string);
          const failed = event.isError === true;
          const name = call?.entry.name ?? cleanText(String(event.toolName ?? ""), 24);
          if (call) {
            call.entry.status = failed ? "error" : "done";
            call.entry.output = event.result ? cleanBlock(textOf(event.result, MAX_ENTRY_TEXT * 2), MAX_ENTRY_TEXT) : call.entry.output;
            call.entry.endedAt = Date.now();
            call.entry.rev++;
          }
          if (name === "jar_todo" && !failed) { const todos = childTodos(event.result?.details); if (todos) run.todos = todos; }
          if ((name === "edit" || name === "write") && !failed && call?.path) {
            addFile(run.filesEdited, call.path);
            try { hooks.edited?.(call.path); } catch (error) { console.error("pi-jar: could not track a subagent edit", error); }
          }
          run.activity = "thinking";
          update();
          return;
        }
        case "message_end": {
          if (event.message?.role !== "assistant") return;
          run.turns++;
          run.cost += Number(event.message.usage?.cost?.total) || 0;
          const text = textOf(event.message).trim();
          if (text) { run.output = text.slice(0, MAX_OUTPUT_CHARS); pushEntry(run, { kind: "text", rev: 0, text: cleanBlock(text, MAX_ENTRY_TEXT) }); }
          if (event.message.stopReason === "error" && event.message.errorMessage) run.error = cleanText(String(event.message.errorMessage), 200);
          run.live = "";
          run.activity = "thinking";
          update();
          return;
        }
        case "agent_settled":
          // Nothing more will run on its own: close stdin so Pi shuts down in order.
          settled = true;
          run.activity = "finishing";
          if (child.stdin && !child.stdin.writableEnded) child.stdin.end();
          update();
          return;
      }
    };
    // Decode as UTF-8 across chunk boundaries, and scan only each new chunk for line ends.
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      let start = 0;
      for (let end = text.indexOf("\n", start); end >= 0; end = text.indexOf("\n", start)) {
        const item = buffer + text.slice(start, end);
        if (!overflow) line(item.endsWith("\r") ? item.slice(0, -1) : item);
        buffer = "";
        overflow = false;
        start = end + 1;
      }
      if (overflow) return;
      buffer += text.slice(start);
      if (buffer.length > MAX_LINE_CHARS) { buffer = ""; overflow = true; }
    });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4000); });
    child.on("error", (error) => finish("failed", error.message));
    child.on("close", (code) => {
      if (buffer && !overflow) line(buffer);
      if (code === 0 && settled && !run.error) finish("done");
      else finish("failed", run.error ?? (cleanText(stderr, 300) || (settled ? `exited ${code}` : `exited ${code} before finishing`)));
    });
    steer = (text) => {
      const message = cleanBlock(text, MAX_STEER_CHARS);
      if (finished || settled || !message || !send({ type: "steer", message })) return false;
      pushEntry(run, { kind: "steer", rev: 0, text: message });
      run.steered++;
      update();
      return true;
    };
    if (!send({ id: "prompt", type: "prompt", message: prompt })) { stop(); finish("failed", "could not send the task to the subagent"); }
  });
  return { done, steer: (text) => steer(text) };
}

const isActive = (state: DelegateState) => state === "queued" || state === "working";

export interface SubagentRecord { key: string; batch: number; run: DelegateRun; stop(): void; steer(text: string): boolean }

/**
 * Live subagents for the activity view. Tool details are saved in the session, so they stay small;
 * the transcript and the per-run stop and steer handles live only here, for this process.
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
  /** Send a steering message to one working run; false when it cannot take one. */
  steer(key: string, text: string): boolean {
    const record = this.entries.get(key)?.record;
    return !!record && record.run.state === "working" && record.steer(text);
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

/** `12s` / `3m 4s`. */
export const duration = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const fileList = (files: readonly string[], limit: number) => files.slice(0, limit).join(", ") + (files.length > limit ? ` (+${files.length - limit} more)` : "");
const todoLine = (todo: Todo) => `${todo.parentId ? "    " : "  "}${todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[~]" : "[ ]"} ${todo.title}`;

/** What the parent agent reads back: the run's facts (time, tools, files, tasks, failures), then its own report. */
export function runReport(run: DelegateRun, now = Date.now()): string {
  const counts = Object.entries(run.toolCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}×${count}`).join(", ");
  const facts = [
    run.startedAt !== undefined ? `took ${duration((run.endedAt ?? now) - run.startedAt)}` : "never started",
    plural(run.turns, "turn"), `${plural(run.tools, "tool call")}${counts ? ` (${counts})` : ""}`,
    run.cost ? `$${run.cost.toFixed(3)}` : "", run.steered ? `steered ${run.steered}×` : ""
  ].filter(Boolean).join(" · ");
  const lines = [`## [${run.index}] ${run.name} (${run.role}${run.model ? " · " + run.model : ""}) — ${run.state}${run.error ? ": " + run.error : ""}`, `- ${facts}`];
  if (run.mode === "fork" || run.mode === "worktree") lines.push(`- mode: ${run.mode}`);
  if (run.filesEdited.length) lines.push(`- files edited: ${fileList(run.filesEdited, 20)}`);
  if (run.appliedFiles.length) lines.push(`- applied to parent: ${fileList(run.appliedFiles, 20)}`);
  if (run.workspace) lines.push(`- isolated worktree kept: ${run.workspace}`);
  if (run.filesRead.length) lines.push(`- files read: ${fileList(run.filesRead, 12)}`);
  if (run.todos.length) {
    const leaves = leafTodos(run.todos);
    lines.push(`- tasks: ${leaves.filter((todo) => todo.done).length}/${leaves.length} done`, ...run.todos.map(todoLine));
  }
  const failures = run.transcript.filter((entry): entry is ToolEntry => entry.kind === "tool" && entry.status === "error").slice(-5);
  if (failures.length) lines.push(`- failed tool calls: ${failures.map((entry) => cleanText(`${entry.name} ${entry.hint}`, 80)).join("; ")}`);
  lines.push("", run.output || "(no report)");
  return lines.join("\n");
}

const DelegateModeSchema = Type.Union([Type.Literal("scout"), Type.Literal("fork"), Type.Literal("worktree")]);
const Parameters = Type.Object({
  tasks: Type.Array(Type.Object({
    task: Type.String({ description: "Task instruction. scout sees only this task; fork/worktree also inherit the parent's active conversation branch." }),
    name: Type.Optional(Type.String({ description: "Short label, e.g. \"auth scout\"." })),
    role: Type.Optional(Type.String({ description: "pi-jar role for the model (default \"task\", falls back to the current model)." })),
    mode: Type.Optional(DelegateModeSchema)
  }), { minItems: 1, maxItems: MAX_DELEGATES }),
  mode: Type.Optional(DelegateModeSchema),
  write: Type.Optional(Type.Boolean({ description: "Deprecated compatibility switch. true keeps the old shared-workspace editing mode; prefer mode=\"worktree\"." }))
});

const glyph = (state: DelegateState) => state === "done" ? "✔" : state === "failed" ? "✖" : state === "working" ? "●" : "○";
const color = (state: DelegateState) => state === "done" ? "success" : state === "failed" ? "error" : state === "working" ? "accent" : "dim";
type RunDetails = Omit<DelegateRun, "transcript" | "live">;

export interface DelegateOptions {
  spawnProcess?: Spawn;
  /** The parent's change tracker: subagent edits join /diff. */
  changes?: () => ChangeTracker | undefined;
  /** Called after a subagent edit was added to the tracker. */
  changed?: () => void;
}

/** jar_delegate. Every run is listed live in `registry` (with its transcript and stop/steer handles) for the activity view. */
export function registerDelegate(pi: ExtensionAPI, roles: ModelRoleManager, registry: DelegateRegistry, options: DelegateOptions = {}): void {
  if (process.env[CHILD_ENV] || typeof (pi as ExtensionAPI & { registerTool?: unknown }).registerTool !== "function") return;
  let batch = 0;
  pi.registerTool({
    name: DELEGATE_TOOL,
    label: "delegate",
    description: `Run up to ${MAX_DELEGATES} parallel subagents on pi-jar model roles. mode=scout is fresh/read-only; mode=fork inherits the parent's active Pi session branch read-only; mode=worktree inherits context and edits in a path-guarded disposable Git worktree whose non-conflicting changes are applied back into /diff. The old write=true shared-workspace mode remains only for compatibility.`,
    promptSnippet: "Use jar_delegate to fan out work: scout for cheap fresh investigation, fork for context-aware review, worktree for isolated implementation.",
    promptGuidelines: [
      "Use scout for independent investigation that needs no conversation history; make its task self-contained.",
      "Use fork when a read-only reviewer or investigator should inherit the current conversation and decisions.",
      "Use worktree for implementation. Each writer gets an isolated Git worktree with no shell tool and path-guarded file access; non-conflicting changes are copied back to the parent and join /diff.",
      "Parallel worktree tasks should own separate files or concerns. If two children touch the same path, pi-jar keeps their worktrees instead of choosing a winner."
    ],
    parameters: Parameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      const id = ++batch;
      const defaultMode: DelegateExecutionMode = params.mode ?? (params.write === true ? "direct" : "scout");
      const runs: DelegateRun[] = params.tasks.slice(0, MAX_DELEGATES).map((item, index) => {
        const role = cleanText(item.role ?? "task", 32) || "task";
        const resolved = roles.resolve(role) ?? roles.resolve("default");
        const model = resolved ? `${resolved.provider}/${resolved.model}` : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        const mode: DelegateExecutionMode = item.mode ?? defaultMode;
        return { index: index + 1, name: cleanText(item.name ?? `agent ${index + 1}`, 24), task: item.task, role, mode, ...(model ? { model } : {}),
          state: "queued", tools: 0, turns: 0, cost: 0, output: "", toolCounts: {}, filesRead: [], filesEdited: [], appliedFiles: [],
          todos: [], steered: 0, transcript: [], live: "" };
      });
      // One controller per run: aborting the tool call stops them all, the activity view stops one.
      const controllers = runs.map(() => new AbortController());
      const abortAll = () => { for (const controller of controllers) controller.abort(); };
      if (signal?.aborted) abortAll(); else signal?.addEventListener("abort", abortAll, { once: true });
      let handles: DelegateHandle[] = [];
      // The key doubles as the role-status id, so views can tell our own teammates from other extensions'.
      const records: SubagentRecord[] = runs.map((run, index) => ({
        key: `delegate-${id}-${run.index}`, batch: id, run,
        stop: () => controllers[index]!.abort(STOP_REASON),
        steer: (text) => handles[index]?.steer(text) ?? false
      }));
      registry.add(...records);
      const thinking = (role: string) => (roles.resolve(role) ?? roles.resolve("default"))?.thinking;
      const parentSession = ctx.sessionManager?.getSessionFile?.();
      let forkSessions: string | undefined;
      if (runs.some((run) => run.mode === "fork" || run.mode === "worktree")) {
        try { forkSessions = mkdtempSync(join(tmpdir(), "pi-jar-forks-")); }
        catch (error) { console.error("pi-jar: could not create temporary fork session directory", error); }
      }
      // Deprecated direct-write children keep the old baseline bridge. Worktree children are applied
      // from their isolated snapshot after all parallel runs finish.
      let baselines: string | undefined;
      if (runs.some((run) => run.mode === "direct") && options.changes) {
        try { baselines = mkdtempSync(join(tmpdir(), "pi-jar-baselines-")); }
        catch (error) { console.error("pi-jar: direct subagent edits will not join /diff", error); }
      }
      const edited = (path: string) => {
        const tracker = options.changes?.();
        if (!baselines || !tracker) return;
        const absolute = isAbsolute(path) ? resolve(path) : resolve(ctx.cwd, path);
        const baseline = readChildBaseline(baselines, absolute);
        if (baseline !== undefined && tracker.adopt(absolute, baseline)) options.changed?.();
      };
      const worktrees = new Map<number, DelegateWorktree>();
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
      // Details are persisted with the session: never the transcript or live text, which the registry holds instead.
      const details = (includeOutput = true) => ({
        runs: runs.map(({ transcript: _transcript, live: _live, ...run }): RunDetails => includeOutput ? run : { ...run, output: "" }),
        write: params.write === true
      });
      let updateTimer: ReturnType<typeof setTimeout> | undefined;
      let lastUpdateAt = 0;
      const emitUpdate = () => {
        updateTimer = undefined;
        lastUpdateAt = Date.now();
        publish();
        onUpdate?.({ content: [{ type: "text", text: runs.map((run) => `${run.name}: ${run.state}${run.activity ? ` · ${run.activity}` : ""}`).join("\n") }], details: details(false) });
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
      const failedHandle = (): DelegateHandle => ({ done: Promise.resolve(), steer: () => false });
      const failBeforeStart = (run: DelegateRun, error: unknown) => {
        run.state = "failed";
        run.error = cleanText(error instanceof Error ? error.message : String(error), 300);
        run.endedAt = Date.now();
        update();
      };
      try {
        handles = runs.map((run, index) => {
          if ((run.mode === "fork" || run.mode === "worktree") && (!parentSession || !forkSessions)) {
            failBeforeStart(run, "fork/worktree mode requires a persisted parent Pi session");
            return failedHandle();
          }
          let cwd = ctx.cwd;
          let fork: DelegateForkOptions | undefined;
          const env: Record<string, string> = {};
          const hooks: DelegateHooks = {};
          const write = run.mode === "direct" || run.mode === "worktree";

          if (run.mode === "fork") fork = { source: parentSession!, sessionDir: forkSessions! };
          if (run.mode === "worktree") {
            try {
              const worktree = createDelegateWorktree(ctx.cwd);
              worktrees.set(run.index, worktree);
              run.workspace = worktree.root;
              cwd = worktree.cwd;
              env[CHILD_WORKTREE_ENV] = worktree.root;
              fork = { source: parentSession!, sessionDir: forkSessions!, tools: WORKTREE_TOOLS };
            } catch (error) {
              failBeforeStart(run, error);
              return failedHandle();
            }
          } else if (run.mode === "direct" && baselines) {
            env[CHILD_BASELINE_ENV] = baselines;
            hooks.edited = edited;
          }
          if (Object.keys(env).length) hooks.env = env;
          return startDelegate(run, delegateArgs(run.model, thinking(run.role), write, process.argv, fork),
            delegatePrompt(run.task, write, run.mode), cwd, controllers[index]!.signal, update, options.spawnProcess, hooks);
        });
        await Promise.all(handles.map((handle) => handle.done));

        // Worktree writers are reconciled only after every child stops. This makes overlap detection
        // deterministic and prevents "last writer wins" from quietly eating another agent's work.
        const filesByRun = new Map<number, string[]>();
        const owners = new Map<string, number[]>();
        for (const run of runs) {
          const worktree = worktrees.get(run.index);
          if (!worktree) continue;
          try {
            const files = worktreeChangedFiles(worktree);
            filesByRun.set(run.index, files);
            run.filesEdited = files;
            if (run.state === "done") for (const file of files) {
              const list = owners.get(file) ?? [];
              list.push(run.index);
              owners.set(file, list);
            }
          } catch (error) {
            run.state = "failed";
            run.error = "could not inspect isolated changes: " + cleanText(error instanceof Error ? error.message : String(error), 240);
          }
        }
        const overlaps = new Map<number, string[]>();
        for (const [file, indexes] of owners) if (indexes.length > 1) for (const index of indexes) {
          const list = overlaps.get(index) ?? [];
          list.push(file);
          overlaps.set(index, list);
        }

        for (const run of runs) {
          const worktree = worktrees.get(run.index);
          if (!worktree) continue;
          const files = filesByRun.get(run.index) ?? [];
          if (run.state !== "done") {
            if (!files.length) { disposeDelegateWorktree(worktree); run.workspace = undefined; }
            continue;
          }
          const overlap = overlaps.get(run.index);
          if (overlap?.length) {
            run.state = "failed";
            run.error = "changes not applied because another worktree edited: " + fileList(overlap, 8);
            continue;
          }
          try {
            run.appliedFiles = applyDelegateWorktree(worktree, ctx.cwd, files, options.changes?.());
            if (run.appliedFiles.length) options.changed?.();
            disposeDelegateWorktree(worktree);
            run.workspace = undefined;
          } catch (error) {
            run.state = "failed";
            run.error = "changes not applied: " + cleanText(error instanceof Error ? error.message : String(error), 240);
          }
        }
      } finally {
        clearInterval(refresh);
        signal?.removeEventListener("abort", abortAll);
        if (baselines) rmSync(baselines, { recursive: true, force: true });
        if (forkSessions) rmSync(forkSessions, { recursive: true, force: true });
        for (const run of runs) if (run.state !== "done" && run.state !== "failed") { run.state = "failed"; run.endedAt ??= Date.now(); }
        registry.notify();
        flushUpdate();
      }
      return { content: [{ type: "text", text: runs.map((run) => runReport(run)).join("\n\n") }], details: details() };
    },
    renderCall(args, theme) {
      const count = Array.isArray(args.tasks) ? args.tasks.length : 0;
      const requested = args.mode ?? (args.write ? "direct" : "scout");
      return new Text(theme.fg("toolTitle", theme.bold("delegate")) + " " + theme.fg("accent", `${count} subagent${count === 1 ? "" : "s"}`)
        + theme.fg("dim", ` · ${requested}`), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const runs = (result.details as { runs?: Array<Partial<RunDetails> & Pick<DelegateRun, "name" | "state" | "role">> } | undefined)?.runs ?? [];
      const rows = runs.map((run) => {
        const leaves = leafTodos(run.todos ?? []);
        const meta = [run.role, run.mode === "fork" || run.mode === "worktree" ? run.mode : "", run.activity, run.tools ? `${run.tools} tools` : "",
          leaves.length ? `${leaves.filter((todo) => todo.done).length}/${leaves.length} tasks` : "",
          run.appliedFiles?.length ? `${run.appliedFiles.length} applied` : run.filesEdited?.length ? `${run.filesEdited.length} edited` : "",
          run.cost ? `${run.cost.toFixed(3)}` : "", run.error].filter(Boolean).join(" · ");
        let row = theme.fg(color(run.state) as never, `  ${glyph(run.state)} ${run.name}`) + theme.fg("dim", " · " + meta);
        if (expanded && run.output) row += "\n" + run.output.split("\n").map((line) => theme.fg("muted", "    " + line)).join("\n");
        return row;
      });
      return new Text(rows.join("\n") || theme.fg("dim", "No subagents."), 0, 0);
    }
  });
}
