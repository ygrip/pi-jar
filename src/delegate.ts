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
import { DISCUSSION_FILE_ENV, SUBAGENT_KEY_ENV, SUBAGENT_NAME_ENV } from "./discussion.ts";
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
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "jar_todo", "jar_discuss"] as const;
/** Writable worktree children deliberately have no shell: edits stay inside path-guarded file tools. */
export const WORKTREE_TOOLS = ["read", "edit", "write", "grep", "find", "ls", "jar_todo", "jar_discuss"] as const;
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

export type DelegateState = "queued" | "working" | "idle" | "paused" | "stopped" | "done" | "failed";
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
  pauses: number;
  resumes: number;
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
    ? "You inherit the parent conversation but work inside an isolated disposable Git worktree. You may edit only with the provided file tools; shell tools are intentionally unavailable. Stay strictly within the task. Your changes remain private across idle/pause/resume and are reconciled into the parent for /diff review only when the moderator stops you."
    : mode === "fork"
      ? "You are a read-only fork of the parent conversation: use the inherited context, investigate, and report without modifying files."
      : write
        ? "You may edit files. Stay strictly within the task; other subagents may be working in the same repository at the same time."
        : "You are read-only: investigate and report, do not attempt to modify anything.";
  return [
    `You are a focused subagent working for another agent. ${rules}`,
    "Track multi-step work with jar_todo (when available) so your progress is visible. The moderator may steer, pause or resume you; preserve scope across those controls.",
    "Use jar_discuss when available for short cross-agent questions and answers. Keep discussion entries narrow; do not turn the shared paper into a transcript.",
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
export interface DelegateHandle {
  /** First point where the child is idle after its initial task. */
  firstSettled: Promise<void>;
  /** Process lifetime; persistent agents stay alive across many settled turns. */
  closed: Promise<void>;
  steer(text: string): boolean;
  pause(): Promise<boolean>;
  resume(text?: string): boolean;
  ask(text: string): Promise<string | undefined>;
  shutdown(): Promise<void>;
}

/**
 * Run one child Pi in RPC mode. Persistent children remain alive after agent_settled so the
 * moderator can peek, steer, pause, resume and ask them questions without rebuilding context.
 */
export function startDelegate(run: DelegateRun, args: string[], prompt: string, cwd: string, signal: AbortSignal | undefined,
  update: () => void, spawnProcess: Spawn = spawn as Spawn, hooks: DelegateHooks = {}, persistent = true): DelegateHandle {
  let steer: (text: string) => boolean = () => false;
  let pause: () => Promise<boolean> = async () => false;
  let resume: (text?: string) => boolean = () => false;
  let ask: (text: string) => Promise<string | undefined> = async () => undefined;
  let shutdown: () => Promise<void> = async () => {};
  let resolveFirst!: () => void;
  let firstResolved = false;
  const firstSettled = new Promise<void>((resolve) => { resolveFirst = resolve; });

  const closed = new Promise<void>((resolveClosed) => {
    const invocation = piInvocation(args);
    let child: ChildProcess;
    try {
      child = spawnProcess(invocation.command, invocation.args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...hooks.env, [CHILD_ENV]: "1" } });
    } catch (error) {
      run.state = "failed"; run.error = error instanceof Error ? error.message : String(error); run.endedAt = Date.now(); update();
      firstResolved = true; resolveFirst(); resolveClosed(); return;
    }

    run.state = "working";
    run.startedAt = Date.now();
    run.endedAt = undefined;
    run.activity = "starting";
    update();

    let buffer = "";
    let overflow = false;
    let liveAt = 0;
    let liveTimer: ReturnType<typeof setTimeout> | undefined;
    let stderr = "";
    let finished = false;
    let settled = false;
    let pauseRequested = false;
    let assistantOpen = false;
    let turnTimer: ReturnType<typeof setTimeout> | undefined;
    const settleWaiters: Array<() => void> = [];
    const messageWaiters: Array<{ after: number; resolve(value: string | undefined): void; timer: ReturnType<typeof setTimeout> }> = [];

    const send = (command: object): boolean => {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
      try { stdin.write(JSON.stringify(command) + "\n"); return true; } catch { return false; }
    };
    const clearTurnTimer = () => { if (turnTimer) clearTimeout(turnTimer); turnTimer = undefined; };
    const hardStop = () => {
      child.kill("SIGTERM");
      setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3000).unref?.();
    };
    const armTurnTimer = () => {
      clearTurnTimer();
      turnTimer = setTimeout(() => {
        hardStop();
        finish("failed", "timed out");
      }, TIMEOUT_MS);
      turnTimer.unref?.();
    };
    const resolveSettled = () => {
      for (const waiter of settleWaiters.splice(0)) waiter();
    };
    const waitSettled = () => settled || finished ? Promise.resolve() : new Promise<void>((resolve) => settleWaiters.push(resolve));
    const finish = (state: DelegateState, error?: string) => {
      if (finished) return;
      finished = true;
      clearTurnTimer();
      clearTimeout(liveTimer);
      signal?.removeEventListener("abort", abort);
      if (child.stdin && !child.stdin.writableEnded) child.stdin.end();
      run.state = state;
      if (error) run.error = error;
      run.activity = undefined;
      run.live = "";
      for (const entry of run.transcript) if (entry.kind === "tool" && entry.status === "running") { entry.status = "error"; entry.endedAt = Date.now(); entry.rev++; }
      run.endedAt = Date.now();
      resolveSettled();
      if (!firstResolved) { firstResolved = true; resolveFirst(); }
      for (const waiter of messageWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(undefined); }
      update();
      resolveClosed();
    };
    const abort = () => { hardStop(); finish("failed", signal?.reason === STOP_REASON ? "stopped" : "aborted"); };

    child.stdin?.on("error", (error) => { if (!finished) stderr = (stderr + "\n" + error.message).slice(-4000); });
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    armTurnTimer();

    const beginPrompt = (message: string, pauseAfter = false): boolean => {
      const clean = cleanBlock(message, MAX_STEER_CHARS);
      if (finished || !settled || !clean) return false;
      if (!send({ id: "prompt-" + (run.resumes + 1), type: "prompt", message: clean })) return false;
      settled = false;
      pauseRequested = pauseAfter;
      run.state = "working";
      run.resumes++;
      run.endedAt = undefined;
      run.activity = "resuming";
      armTurnTimer();
      update();
      return true;
    };

    const running = new Map<string, { entry: ToolEntry; path?: string }>();
    const line = (raw: string) => {
      if (finished || !raw.trim()) return;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return; }
      if (!parsed || typeof parsed !== "object") return;
      const event = parsed as ChildEvent;
      switch (event.type) {
        case "response":
          if (event.success !== false) return;
          if (event.command === "prompt") { hardStop(); finish("failed", cleanText(String(event.error ?? "prompt rejected"), 300)); return; }
          pushEntry(run, { kind: "note", rev: 0, text: `${cleanText(String(event.command ?? "command"), 24)} rejected: ${cleanText(String(event.error ?? ""), 200)}` });
          update();
          return;
        case "extension_ui_request":
          if (DIALOGS.has(String(event.method))) send({ type: "extension_ui_response", id: event.id, cancelled: true });
          return;
        case "message_update": {
          const delta = event.assistantMessageEvent;
          if (delta?.type === "text_delta" && typeof delta.delta === "string") {
            assistantOpen = true;
            run.live = (run.live + delta.delta).slice(-MAX_LIVE_CHARS);
            run.activity = "writing";
            const now = Date.now();
            if (now - liveAt >= LIVE_REPAINT_MS) { liveAt = now; update(); }
            else if (!liveTimer) {
              liveTimer = setTimeout(() => { liveTimer = undefined; liveAt = Date.now(); if (!finished) update(); }, LIVE_REPAINT_MS - (now - liveAt));
              liveTimer.unref?.();
            }
          } else if (delta?.type === "thinking_start" || delta?.type === "thinking_delta") {
            assistantOpen = true;
            if (run.activity !== "thinking") run.activity = "thinking";
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
          assistantOpen = false;
          run.turns++;
          run.cost += Number(event.message.usage?.cost?.total) || 0;
          const text = textOf(event.message).trim();
          if (text) { run.output = text.slice(0, MAX_OUTPUT_CHARS); pushEntry(run, { kind: "text", rev: 0, text: cleanBlock(text, MAX_ENTRY_TEXT) }); }
          if (event.message.stopReason === "error" && event.message.errorMessage) run.error = cleanText(String(event.message.errorMessage), 200);
          run.live = "";
          run.activity = "thinking";
          for (let index = messageWaiters.length - 1; index >= 0; index--) {
            const waiter = messageWaiters[index]!;
            if (run.turns <= waiter.after) continue;
            messageWaiters.splice(index, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(text || undefined);
          }
          update();
          return;
        }
        case "agent_settled": {
          settled = true;
          clearTurnTimer();
          for (const call of running.values()) {
            call.entry.status = "error";
            call.entry.endedAt = Date.now();
            call.entry.rev++;
          }
          running.clear();
          run.live = "";
          run.activity = undefined;
          run.endedAt = Date.now();
          run.state = pauseRequested ? "paused" : "idle";
          pauseRequested = false;
          if (!firstResolved) {
            firstResolved = true;
            signal?.removeEventListener("abort", abort);
            resolveFirst();
          }
          resolveSettled();
          update();
          if (!persistent && child.stdin && !child.stdin.writableEnded) child.stdin.end();
          return;
        }
      }
    };

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
      if (finished || !message || run.state !== "working" || !send({ type: "steer", message })) return false;
      pushEntry(run, { kind: "steer", rev: 0, text: message });
      run.steered++;
      update();
      return true;
    };
    pause = async () => {
      if (finished) return false;
      if (run.state === "paused") return true;
      if (run.state === "idle") { run.state = "paused"; run.pauses++; update(); return true; }
      if (run.state !== "working") return false;
      pauseRequested = true;
      run.pauses++;
      run.activity = "pausing";
      const waiting = waitSettled();
      send({ type: "clear_queue" });
      if (!send({ type: "abort" })) {
        pauseRequested = false;
        run.pauses = Math.max(0, run.pauses - 1);
        run.activity = "thinking";
        update();
        return false;
      }
      update();
      await waiting;
      return run.state === "paused";
    };
    resume = (text) => {
      if (run.state !== "paused" && run.state !== "idle") return false;
      const message = text?.trim() || "Continue the assigned task from where you stopped. Review your current checklist and remaining work first.";
      return beginPrompt(message);
    };
    ask = async (text) => {
      const question = cleanBlock(text, MAX_STEER_CHARS);
      if (!question || finished) return undefined;
      const after = run.turns + (assistantOpen ? 1 : 0);
      const answer = new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(() => {
          const index = messageWaiters.findIndex((item) => item.resolve === resolve);
          if (index >= 0) messageWaiters.splice(index, 1);
          resolve(undefined);
        }, 2 * 60_000);
        timer.unref?.();
        messageWaiters.push({ after, resolve, timer });
      });
      const instruction = "Moderator BTW: answer this question first in one compact paragraph, then continue your assigned task without changing scope. Question: " + question;
      const wasPaused = run.state === "paused";
      const sent = run.state === "working" ? steer(instruction)
        : (run.state === "idle" || run.state === "paused") ? beginPrompt(instruction, wasPaused) : false;
      if (!sent) {
        const waiter = messageWaiters.pop();
        if (waiter) { clearTimeout(waiter.timer); waiter.resolve(undefined); }
        return undefined;
      }
      return answer;
    };
    shutdown = async () => {
      if (finished) { await closed; return; }
      if (run.state === "working") {
        const waiting = waitSettled();
        send({ type: "clear_queue" });
        if (send({ type: "abort" })) {
          let settledInTime = false;
          const grace = new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 3000);
            timer.unref?.();
          });
          await Promise.race([waiting.then(() => { settledInTime = true; }), grace]);
          if (!settledInTime && !finished) hardStop();
        } else hardStop();
      }
      if (child.stdin && !child.stdin.writableEnded) child.stdin.end();
      const killer = setTimeout(() => { if (child.exitCode === null) hardStop(); }, 3000);
      killer.unref?.();
      await closed;
      clearTimeout(killer);
    };

    if (!send({ id: "prompt", type: "prompt", message: prompt })) { hardStop(); finish("failed", "could not send the task to the subagent"); }
  });
  return {
    firstSettled,
    closed,
    steer: (text) => steer(text),
    pause: () => pause(),
    resume: (text) => resume(text),
    ask: (text) => ask(text),
    shutdown: () => shutdown()
  };
}

const isRunning = (state: DelegateState) => state === "queued" || state === "working";
const isRetained = (state: DelegateState) => isRunning(state) || state === "idle" || state === "paused";

export interface SubagentStopReport {
  key: string;
  name: string;
  state: DelegateState;
  task: string;
  workspace?: string;
  changed: string[];
  applied: string[];
  remaining: string[];
  last: string;
  error?: string;
}
export interface SubagentRecord {
  key: string;
  batch: number;
  run: DelegateRun;
  stop(): Promise<SubagentStopReport>;
  pause(): Promise<boolean>;
  resume(text?: string): boolean;
  steer(text: string): boolean;
  ask(text: string): Promise<string | undefined>;
  changed(): string[];
  discard(): void;
}

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
  /** Retained agents first (oldest first), then retired ones newest first. */
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
  resolve(ref: string): SubagentRecord | undefined {
    const exact = this.get(ref);
    if (exact) return exact;
    const name = cleanText(ref, 48).toLowerCase();
    const matches = this.records().filter((record) => record.run.name.toLowerCase() === name);
    return matches.length === 1 ? matches[0] : undefined;
  }
  async stop(key: string): Promise<SubagentStopReport | undefined> {
    const record = this.resolve(key);
    if (!record || record.run.state === "done" || record.run.state === "stopped") return undefined;
    const report = await record.stop();
    this.notify();
    return report;
  }
  async pause(key: string): Promise<boolean> {
    const record = this.resolve(key);
    if (!record || !isRetained(record.run.state)) return false;
    const paused = await record.pause();
    this.notify();
    return paused;
  }
  resume(key: string, text?: string): boolean {
    const record = this.resolve(key);
    if (!record || !isRetained(record.run.state)) return false;
    const resumed = record.resume(text);
    if (resumed) this.notify();
    return resumed;
  }
  steer(key: string, text: string): boolean {
    const record = this.resolve(key);
    return !!record && record.run.state === "working" && record.steer(text);
  }
  async ask(key: string, text: string): Promise<string | undefined> {
    const record = this.resolve(key);
    if (!record || !isRetained(record.run.state)) return undefined;
    return record.ask(text);
  }
  running(): number {
    let count = 0;
    for (const { record } of this.entries.values()) if (isRunning(record.run.state)) count++;
    return count;
  }
  retained(): number {
    let count = 0;
    for (const { record } of this.entries.values()) if (isRetained(record.run.state)) count++;
    return count;
  }
  /** Session changes discard retained workers and their private workspaces; they never auto-apply here. */
  clear(): void {
    const records = [...this.entries.values()].map(({ record }) => record);
    this.entries.clear();
    for (const record of records) {
      try { record.discard(); } catch { /* best effort */ }
    }
    this.notify();
  }
  add(...records: SubagentRecord[]): void {
    for (const record of records) this.entries.set(record.key, { record });
    this.notify();
  }
  notify(): void {
    this.sweep();
    for (const listener of this.listeners) {
      try { listener(); } catch { /* views are decoration; a broken one must not break the run */ }
    }
  }
  private sweep(): void {
    let finished = 0;
    for (const entry of this.entries.values()) {
      if (isRetained(entry.record.run.state)) { entry.finished = undefined; continue; }
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
  if (run.workspace) lines.push(`- workspace: ${run.workspace}`);
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
    role: Type.Optional(Type.String({ description: "pi-jar role override. Defaults by mode: scout→scout, fork→reviewer, worktree→worker; then role fallbacks/current model." })),
    mode: Type.Optional(DelegateModeSchema)
  }), { minItems: 1, maxItems: MAX_DELEGATES }),
  mode: Type.Optional(DelegateModeSchema),
  write: Type.Optional(Type.Boolean({ description: "Deprecated compatibility switch. true keeps the old shared-workspace editing mode; prefer mode=\"worktree\"." }))
});

const glyph = (state: DelegateState) => state === "done" ? "✔" : state === "failed" ? "✖" : state === "stopped" ? "■" : state === "working" ? "●" : "○";
const color = (state: DelegateState) => state === "done" ? "success" : state === "failed" ? "error" : state === "working" ? "accent" : "dim";
type RunDetails = Omit<DelegateRun, "transcript" | "live">;

export interface DelegateOptions {
  spawnProcess?: Spawn;
  /** The parent's change tracker: finalized worktree edits join /diff. */
  changes?: () => ChangeTracker | undefined;
  /** Called after a subagent edit was added to the tracker. */
  changed?: () => void;
  /** Session-scoped shared discussion paper. */
  discussionFile?: () => string | undefined;
}

const roleForMode = (mode: DelegateExecutionMode): string =>
  mode === "scout" ? "scout" : mode === "fork" ? "reviewer" : mode === "worktree" ? "worker" : "task";

const remainingTasks = (run: DelegateRun): string[] => {
  const leaves = leafTodos(run.todos);
  return leaves.filter((todo) => todo.status !== "completed").map((todo) => todo.title).slice(0, 20);
};

const controlReport = (report: SubagentStopReport): string => [
  `${report.key} · ${report.name} · ${report.state}`,
  `task: ${report.task}`,
  `workspace: ${report.workspace ?? "none"}`,
  `changed: ${report.changed.length ? report.changed.join(", ") : "none"}`,
  `applied: ${report.applied.length ? report.applied.join(", ") : "none"}`,
  `remaining: ${report.remaining.length ? report.remaining.join("; ") : "none explicitly tracked"}`,
  report.error ? `error: ${report.error}` : "",
  report.last ? `last: ${cleanBlock(report.last, 1200)}` : ""
].filter(Boolean).join("\n");

const peekRecord = (record: SubagentRecord): string => {
  const run = record.run;
  const leaves = leafTodos(run.todos);
  const done = leaves.filter((todo) => todo.status === "completed").length;
  const changed = (() => { try { return record.changed(); } catch { return run.filesEdited; } })();
  const remaining = remainingTasks(run);
  return [
    `${record.key} · ${run.name} · ${run.state} · ${run.role}${run.model ? " · " + run.model : ""} · ${run.mode}`,
    `task: ${cleanText(run.task, 300)}`,
    `progress: ${leaves.length ? done + "/" + leaves.length + " tasks" : "no checklist"}${run.activity ? " · " + cleanText(run.activity, 100) : ""}`,
    `changed: ${changed.length ? fileList(changed, 12) : "none"}`,
    remaining.length ? `remaining: ${remaining.join("; ")}` : "remaining: none explicitly tracked",
    run.workspace ? `workspace: ${run.workspace}` : "",
    run.output ? `last: ${cleanBlock(run.output, 700)}` : ""
  ].filter(Boolean).join("\n");
};

/** jar_delegate plus jar_subagent: the parent remains a moderator while retained workers do the work. */
export function registerDelegate(pi: ExtensionAPI, roles: ModelRoleManager, registry: DelegateRegistry, options: DelegateOptions = {}): void {
  if (process.env[CHILD_ENV] || typeof (pi as ExtensionAPI & { registerTool?: unknown }).registerTool !== "function") return;
  let batch = 0;
  const roleCandidates = (role: string) => {
    const manager = roles as ModelRoleManager & { resolveCandidates?: (name: string) => ReturnType<ModelRoleManager["resolveCandidates"]> };
    if (typeof manager.resolveCandidates === "function") return manager.resolveCandidates(role);
    const resolved = roles.resolve(role);
    return resolved ? [resolved] : [];
  };

  let moderatorContextDirty = true;
  registry.subscribe(() => { moderatorContextDirty = true; });
  pi.on("before_agent_start", () => {
    moderatorContextDirty = true;
    const retained = registry.records().filter((record) => isRetained(record.run.state));
    if (!retained.length) return;
    const fleet = retained.map((record) =>
      `- ${record.key} · ${record.run.name} · ${record.run.state} · ${record.run.role}: ${cleanText(record.run.task, 140)}`).join("\n");
    return { message: { customType: "pi-jar.moderator-context", display: false, content: [
      "[PI-JAR MODERATOR MODE]",
      "You are the coordinator while retained subagents do delegated work. Decompose and route work, inspect with jar_subagent peek, steer only to correct direction, use ask for terse BTW questions, and use jar_discuss for structured cross-agent Q/A.",
      "Do not duplicate work already owned by a retained subagent. Stop completed workers to obtain their handoff and reconcile worktree changes into /diff. Synthesize the final answer from their reports and evidence.",
      "Retained fleet:",
      fleet
    ].join("\n") } };
  });
  pi.on("context", (event) => {
    if (!moderatorContextDirty) return;
    const active = registry.retained() > 0;
    let latest = -1;
    let prune = false;
    for (let index = event.messages.length - 1; index >= 0; index--) {
      if ((event.messages[index] as { customType?: string }).customType !== "pi-jar.moderator-context") continue;
      if (!active || latest >= 0) prune = true;
      else latest = index;
    }
    moderatorContextDirty = false;
    if (!prune) return;
    return { messages: event.messages.filter((raw, index) =>
      (raw as { customType?: string }).customType !== "pi-jar.moderator-context" || (active && index === latest)) };
  });

  pi.registerTool({
    name: DELEGATE_TOOL,
    label: "delegate",
    description: `Spawn retained session-scoped subagents (maximum ${MAX_DELEGATES} alive at once). scout is fresh/read-only and defaults to the scout role; fork inherits the parent conversation read-only and defaults to reviewer; worktree inherits context, defaults to worker, and edits in an isolated Git worktree. Retained agents become idle after a turn and are controlled with jar_subagent. Worktree changes apply only when the moderator stops that agent.`,
    promptSnippet: "Act as moderator: delegate parallel work, inspect progress with jar_subagent peek, steer only when needed, and synthesize results instead of duplicating subagent work.",
    promptGuidelines: [
      "When useful work can be delegated, act as the moderator: decompose, assign, monitor, resolve disagreements, and synthesize. Do not redo a delegated implementation yourself while its worker is active.",
      "Use scout for cheap independent discovery, fork/reviewer for context-aware review, and worktree/worker for implementation. Explicit task.role overrides these mode defaults.",
      "Retained agents become idle after each turn. Reuse them with jar_subagent resume instead of spawning replacements; pause them when priorities change; stop completed workers to reconcile their worktree into /diff.",
      "Use jar_subagent ask for a brief BTW question to one worker. For agent-to-agent questions, have them use the bounded jar_discuss paper so answers stay structured and cheap.",
      "Keep at most four retained agents. Stop agents you no longer need."
    ],
    parameters: Parameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      const requested = params.tasks.slice(0, MAX_DELEGATES);
      if (registry.retained() + requested.length > MAX_DELEGATES) {
        return { content: [{ type: "text", text: `Subagent pool is full: ${registry.retained()}/${MAX_DELEGATES} retained. Reuse or stop an existing agent with jar_subagent.` }], isError: true };
      }

      const id = ++batch;
      const defaultMode: DelegateExecutionMode = params.mode ?? (params.write === true ? "direct" : "scout");
      let available = new Set<string>();
      try { available = new Set(ctx.modelRegistry.getAvailable().map((model) => model.provider + "/" + model.id)); } catch { /* current model remains the fallback */ }
      const thinkingByRun = new Map<number, string | undefined>();
      const runs: DelegateRun[] = requested.map((item, index) => {
        const mode: DelegateExecutionMode = item.mode ?? defaultMode;
        const role = cleanText(item.role ?? roleForMode(mode), 32) || roleForMode(mode);
        const candidates = [...roleCandidates(role), ...roleCandidates("default")];
        const selected = candidates.find((candidate) => available.has(candidate.provider + "/" + candidate.model));
        const model = selected ? `${selected.provider}/${selected.model}` : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        thinkingByRun.set(index + 1, selected?.thinking);
        return {
          index: index + 1, name: cleanText(item.name ?? `${role} ${index + 1}`, 24), task: item.task, role, mode, ...(model ? { model } : {}),
          state: "queued", tools: 0, turns: 0, cost: 0, output: "", toolCounts: {}, filesRead: [], filesEdited: [], appliedFiles: [],
          pauses: 0, resumes: 0, todos: [], steered: 0, transcript: [], live: ""
        };
      });

      const controllers = runs.map(() => new AbortController());
      const abortAll = () => { for (const controller of controllers) controller.abort(); };
      if (signal?.aborted) abortAll(); else signal?.addEventListener("abort", abortAll, { once: true });
      let handles: DelegateHandle[] = [];
      let records: SubagentRecord[] = [];
      const worktrees = new Map<number, DelegateWorktree>();
      const sessionDirs = new Map<number, string>();
      const parentSession = ctx.sessionManager?.getSessionFile?.();

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

      const publish = () => {
        if (!ctx.hasUI) return;
        for (const { key, run } of records) {
          try {
            ctx.ui.setStatus(`${ROLE_PREFIX}${key}`, run.state === "done" || run.state === "failed" ? undefined : JSON.stringify({
              name: run.name, label: run.name.slice(0, 12),
              state: run.state === "queued" || run.state === "paused" ? "waiting" : run.state === "idle" ? "idle" : "working",
              task: cleanText(run.task, 60), expiresAt: Date.now() + 24 * 60 * 60_000
            }));
          } catch { /* status is decoration */ }
        }
      };
      const details = (includeOutput = true) => ({
        runs: runs.map(({ transcript: _transcript, live: _live, ...run }): RunDetails => includeOutput ? run : { ...run, output: "" }),
        write: runs.some((run) => run.mode === "direct" || run.mode === "worktree")
      });
      let updateTimer: ReturnType<typeof setTimeout> | undefined;
      let lastUpdateAt = 0;
      let toolReturned = false;
      const emitUpdate = () => {
        updateTimer = undefined;
        lastUpdateAt = Date.now();
        publish();
        onUpdate?.({ content: [{ type: "text", text: runs.map((run) => `${run.name}: ${run.state}${run.activity ? " · " + run.activity : ""}`).join("\n") }], details: details(false) });
      };
      const update = () => {
        registry.notify();
        if (toolReturned || !onUpdate) { publish(); return; }
        const wait = Math.max(0, LIVE_UPDATE_MS - (Date.now() - lastUpdateAt));
        if (wait === 0) { if (updateTimer) clearTimeout(updateTimer); emitUpdate(); return; }
        if (!updateTimer) { updateTimer = setTimeout(emitUpdate, wait); updateTimer.unref?.(); }
      };
      const flushUpdate = () => {
        if (updateTimer) { clearTimeout(updateTimer); updateTimer = undefined; }
        emitUpdate();
      };
      const failedHandle = (): DelegateHandle => ({
        firstSettled: Promise.resolve(), closed: Promise.resolve(), steer: () => false, pause: async () => false,
        resume: () => false, ask: async () => undefined, shutdown: async () => {}
      });
      const cleanupPrivate = (index: number, discardWorktree: boolean) => {
        const dir = sessionDirs.get(index);
        if (dir) { rmSync(dir, { recursive: true, force: true }); sessionDirs.delete(index); }
        if (discardWorktree) {
          const worktree = worktrees.get(index);
          if (worktree) {
            try { disposeDelegateWorktree(worktree); } catch { /* best effort */ }
            worktrees.delete(index);
          }
        }
      };
      const failBeforeStart = (run: DelegateRun, error: unknown) => {
        run.state = "failed";
        run.error = cleanText(error instanceof Error ? error.message : String(error), 300);
        run.endedAt = Date.now();
        update();
      };

      handles = runs.map((run, index) => {
        if ((run.mode === "fork" || run.mode === "worktree") && !parentSession) {
          failBeforeStart(run, "fork/worktree mode requires a persisted parent Pi session");
          return failedHandle();
        }
        let cwd = ctx.cwd;
        let fork: DelegateForkOptions | undefined;
        const env: Record<string, string> = {
          [SUBAGENT_KEY_ENV]: `delegate-${id}-${run.index}`,
          [SUBAGENT_NAME_ENV]: run.name
        };
        const discussion = options.discussionFile?.();
        if (discussion) env[DISCUSSION_FILE_ENV] = discussion;
        const hooks: DelegateHooks = {};
        const write = run.mode === "direct" || run.mode === "worktree";

        if (run.mode === "fork" || run.mode === "worktree") {
          try {
            const sessionDir = mkdtempSync(join(tmpdir(), "pi-jar-fork-"));
            sessionDirs.set(run.index, sessionDir);
            fork = { source: parentSession!, sessionDir, ...(run.mode === "worktree" ? { tools: WORKTREE_TOOLS } : {}) };
          } catch (error) {
            failBeforeStart(run, error);
            return failedHandle();
          }
        }
        if (run.mode === "worktree") {
          try {
            const worktree = createDelegateWorktree(ctx.cwd);
            worktrees.set(run.index, worktree);
            run.workspace = worktree.root;
            cwd = worktree.cwd;
            env[CHILD_WORKTREE_ENV] = worktree.root;
          } catch (error) {
            cleanupPrivate(run.index, true);
            failBeforeStart(run, error);
            return failedHandle();
          }
        } else if (run.mode === "direct" && baselines) {
          env[CHILD_BASELINE_ENV] = baselines;
          hooks.edited = edited;
        }
        hooks.env = env;
        return startDelegate(run, delegateArgs(run.model, thinkingByRun.get(run.index), write, process.argv, fork),
          delegatePrompt(run.task, write, run.mode), cwd, controllers[index]!.signal, update, options.spawnProcess, hooks, run.mode !== "direct");
      });

      const stopRun = async (index: number): Promise<SubagentStopReport> => {
        const run = runs[index]!;
        const key = `delegate-${id}-${run.index}`;
        const workspace = run.workspace;
        const handle = handles[index]!;
        await handle.shutdown();

        let changed: string[] = [];
        const worktree = worktrees.get(run.index);
        if (worktree) {
          try { changed = worktreeChangedFiles(worktree); run.filesEdited = changed; }
          catch (error) { run.error = "could not inspect isolated changes: " + cleanText(String(error), 240); }
          if (changed.length && !run.error) {
            try {
              run.appliedFiles = applyDelegateWorktree(worktree, ctx.cwd, changed, options.changes?.());
              if (run.appliedFiles.length) {
                try { options.changed?.(); } catch (error) { console.error("pi-jar: could not refresh parent change UI", error); }
              }
              disposeDelegateWorktree(worktree);
              worktrees.delete(run.index);
              run.workspace = undefined;
            } catch (error) {
              run.error = "changes not applied: " + cleanText(error instanceof Error ? error.message : String(error), 240);
            }
          } else if (!changed.length) {
            try { disposeDelegateWorktree(worktree); } catch { /* best effort */ }
            worktrees.delete(run.index);
            run.workspace = undefined;
          }
        }
        cleanupPrivate(run.index, false);
        if (run.state !== "failed") run.state = run.error ? "failed" : "stopped";
        run.endedAt ??= Date.now();
        update();
        return {
          key, name: run.name, state: run.state, task: run.task, ...(workspace ? { workspace } : {}),
          changed, applied: [...run.appliedFiles], remaining: remainingTasks(run), last: run.output, ...(run.error ? { error: run.error } : {})
        };
      };

      records = runs.map((run, index) => ({
        key: `delegate-${id}-${run.index}`, batch: id, run,
        stop: () => stopRun(index),
        pause: () => handles[index]!.pause(),
        resume: (text) => handles[index]!.resume(text),
        steer: (text) => handles[index]!.steer(text),
        ask: (text) => handles[index]!.ask(text),
        changed: () => {
          const worktree = worktrees.get(run.index);
          if (!worktree) return [...run.filesEdited];
          try { return worktreeChangedFiles(worktree); } catch { return [...run.filesEdited]; }
        },
        discard: () => {
          void handles[index]!.shutdown().finally(() => cleanupPrivate(run.index, true));
        }
      }));
      registry.add(...records);
      publish();

      try {
        await Promise.all(handles.map((handle, index) => runs[index]!.mode === "direct" ? handle.closed : handle.firstSettled));
      } finally {
        signal?.removeEventListener("abort", abortAll);
        if (baselines) rmSync(baselines, { recursive: true, force: true });
        for (const run of runs) {
          if (run.mode === "direct") cleanupPrivate(run.index, true);
          else if (run.state === "failed") cleanupPrivate(run.index, false);
        }
        registry.notify();
        flushUpdate();
        toolReturned = true;
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
          run.cost ? `$${run.cost.toFixed(3)}` : "", run.error].filter(Boolean).join(" · ");
        let row = theme.fg(color(run.state) as never, `  ${glyph(run.state)} ${run.name}`) + theme.fg("dim", " · " + meta);
        if (expanded && run.output) row += "\n" + run.output.split("\n").map((line) => theme.fg("muted", "    " + line)).join("\n");
        return row;
      });
      return new Text(rows.join("\n") || theme.fg("dim", "No subagents."), 0, 0);
    }
  });

  pi.registerTool({
    name: "jar_subagent",
    label: "subagent",
    description: "Moderator control for retained subagents: peek high-level progress, steer a working agent, ask a brief BTW question, pause without losing context, resume the same agent, or stop it and receive a progress/change/remaining-work handoff. Stopping a worktree agent safely applies reviewable changes to the parent.",
    promptSnippet: "Use jar_subagent as the moderator control plane. Prefer peek over rereading transcripts; reuse paused/idle agents with resume; stop finished workers to reconcile their work.",
    promptGuidelines: [
      "Use peek periodically instead of polling constantly. It returns task progress, current activity, changed files, remaining checklist items and last report.",
      "Use steer to correct direction while an agent is working. Use ask for a short BTW question; it waits for the agent's next compact answer.",
      "Pause when an agent should stop spending tokens but keep its context/workspace. Resume the same agent later instead of spawning a replacement.",
      "Stop when an agent is no longer needed. Stop aborts any active turn, retires the process, reports progress/workspace/changes/remaining work, and reconciles safe worktree changes into /diff."
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("peek"), Type.Literal("steer"), Type.Literal("ask"),
        Type.Literal("pause"), Type.Literal("resume"), Type.Literal("stop")
      ]),
      agent: Type.Optional(Type.String({ description: "Subagent key or unique name. Omit only for peek to show all retained agents." })),
      message: Type.Optional(Type.String({ description: "Direction, BTW question, or resume instruction." }))
    }),
    async execute(_id, params) {
      if (params.action === "peek") {
        const targets = params.agent ? [registry.resolve(params.agent)].filter((item): item is SubagentRecord => !!item)
          : registry.records().filter((record) => isRetained(record.run.state));
        if (!targets.length) return { content: [{ type: "text", text: params.agent ? "Subagent not found: " + params.agent : "No retained subagents." }] };
        return { content: [{ type: "text", text: targets.map(peekRecord).join("\n\n") }] };
      }
      const agent = params.agent ?? "";
      const record = registry.resolve(agent);
      if (!record) return { content: [{ type: "text", text: "Subagent not found or name is ambiguous: " + agent }], isError: true };
      if (params.action === "steer") {
        const message = cleanBlock(params.message ?? "", MAX_STEER_CHARS);
        if (!message) return { content: [{ type: "text", text: "steer requires message." }], isError: true };
        return { content: [{ type: "text", text: registry.steer(record.key, message) ? "Steered " + record.run.name + "." : "Subagent is not currently working; use resume instead." }] };
      }
      if (params.action === "ask") {
        const message = cleanBlock(params.message ?? "", MAX_STEER_CHARS);
        if (!message) return { content: [{ type: "text", text: "ask requires message." }], isError: true };
        const answer = await registry.ask(record.key, message);
        return { content: [{ type: "text", text: answer ? record.run.name + ": " + cleanBlock(answer, 2000) : "No answer arrived before the BTW timeout." }] };
      }
      if (params.action === "pause") {
        const paused = await registry.pause(record.key);
        return { content: [{ type: "text", text: paused ? "Paused " + record.run.name + "; context and workspace are retained." : "Could not pause " + record.run.name + "." }] };
      }
      if (params.action === "resume") {
        const resumed = registry.resume(record.key, params.message);
        return { content: [{ type: "text", text: resumed ? "Resumed " + record.run.name + "." : record.run.name + " is not idle or paused." }] };
      }
      const report = await registry.stop(record.key);
      if (!report) return { content: [{ type: "text", text: "Subagent is already retired: " + record.run.name }] };
      return { content: [{ type: "text", text: controlReport(report) }], details: report };
    }
  });
}
