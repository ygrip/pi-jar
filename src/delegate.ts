import { spawn, type ChildProcess } from "node:child_process";
import { signalProcessTree } from "./async-process.ts";
import { CHILD_TOOLS_ENV, RECURSIVE_TOOLS, WEB_TOOLS } from "./subagent-tools.ts";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
  WorktreeApplyError,
  type DelegateWorktree
} from "./delegate-worktree.ts";

export const DELEGATE_TOOL = "jar_delegate";
/** Set in child processes so a subagent never delegates again. */
export const CHILD_ENV = "PI_JAR_CHILD";
export const MAX_DELEGATES = 4;
export const SUBAGENT_LIMIT_CHOICES = [2, 4, 6, 8, 16] as const;
/** Read-only subagents also keep jar_todo so their checklist shows in the activity view. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "jar_todo", "jar_discuss"] as const;
/** Writable worktree children deliberately have no shell: edits stay inside path-guarded file tools. */
export const WORKTREE_TOOLS = ["read", "edit", "write", "multi_file_edit", "grep", "find", "ls", "jar_todo", "jar_discuss"] as const;
const READ_ONLY_SAFE_TOOLS = new Set<string>([...READ_ONLY_TOOLS, ...WEB_TOOLS, "ffgrep", "fffind", "lsp_diagnostics", "obs_recall"]);
const WORKTREE_SAFE_TOOLS = new Set<string>([...WORKTREE_TOOLS, ...WEB_TOOLS]);
const allowedInMode = (mode: DelegateExecutionMode, name: string) => !RECURSIVE_TOOLS.has(name)
  && (mode === "direct" || (mode === "worktree" ? WORKTREE_SAFE_TOOLS.has(name) : READ_ONLY_SAFE_TOOLS.has(name)));
export type DelegateMode = "scout" | "fork" | "worktree";
type DelegateExecutionMode = DelegateMode | "direct";
const MAX_OUTPUT_CHARS = 12_000;
/** A working child that sends no RPC event for this long is treated as hung and killed. */
const IDLE_TIMEOUT_MS = 10 * 60_000;
/** After exit, grandchildren (MCP servers, shells) can hold the stdio pipes open; stop waiting for close. */
const CLOSE_GRACE_MS = 2000;
/** How long pause waits for the child to settle after abort before reporting that it has not paused yet. */
const PAUSE_GRACE_MS = 15_000;
const STATUS_REFRESH_MS = 20_000;
const LIVE_UPDATE_MS = 1000;
/** Visible message that wakes the moderator when a resumed subagent's turn ends. */
export const SUBAGENT_MESSAGE = "pi-jar.subagent";
const NOTIFY_COALESCE_MS = 250;
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
/** Resumed assignments/ballots can include bounded evidence and multiple options. */
export const MAX_RESUME_CHARS = 40_000;
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
  fork?: DelegateForkOptions, toolOverride?: readonly string[]): string[] {
  const session = fork ? ["--fork", fork.source, "--session-dir", fork.sessionDir] : ["--no-session"];
  const extensions = extensionFlags(argv);
  // Worktree cwd/session forks do not inherit project extension discovery from the parent.
  if (fork) {
    const ownExtension = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
    if (!extensions.includes(ownExtension)) extensions.push("--extension", ownExtension);
  }
  const args = ["--mode", "rpc", ...session, ...extensions];
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  const tools = fork?.tools ?? toolOverride ?? (!write ? READ_ONLY_TOOLS : undefined);
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

/** Whether `promise` settles within `ms`; the timer never keeps the process alive. */
const settlesWithin = (promise: Promise<unknown>, ms: number): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  return Promise.race([promise.then(() => true, () => true), timeout]).finally(() => clearTimeout(timer));
};

/** `promise`, or undefined as soon as `signal` aborts; the work itself continues in the background. */
const untilAborted = <T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(undefined);
  let onAbort = () => {};
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
};

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
  data?: { disposition?: unknown };
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
  alive(): boolean;
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
  let alive = false;
  let resolveFirst!: () => void;
  let firstResolved = false;
  const firstSettled = new Promise<void>((resolve) => { resolveFirst = resolve; });

  const closed = new Promise<void>((resolveClosed) => {
    const invocation = piInvocation(args);
    let child: ChildProcess;
    try {
      const env = { ...process.env };
      for (const key of [CHILD_BASELINE_ENV, CHILD_WORKTREE_ENV, CHILD_TOOLS_ENV, DISCUSSION_FILE_ENV, SUBAGENT_KEY_ENV, SUBAGENT_NAME_ENV]) delete env[key];
      child = spawnProcess(invocation.command, invocation.args, { cwd, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], env: { ...env, ...hooks.env, [CHILD_ENV]: "1" } });
    } catch (error) {
      run.state = "failed"; run.error = error instanceof Error ? error.message : String(error); run.endedAt = Date.now(); update();
      firstResolved = true; resolveFirst(); resolveClosed(); return;
    }

    alive = true;
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
    let closing = false;
    let shutdownPromise: Promise<void> | undefined;
    let askBusy = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let turnTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    /** Last RPC event while working; the watchdog only fires after this much silence. */
    let activityAt = Date.now();
    const settleWaiters: Array<() => void> = [];

    const send = (command: object): boolean => {
      const stdin = child.stdin;
      if (!alive || !stdin || stdin.destroyed || stdin.writableEnded) return false;
      // Node queues writes until drain. Bound that queue if a hung RPC child stops reading;
      // accepted commands remain complete JSONL records, never partial/manual framing.
      if (stdin.writableLength > 256 * 1024) return false;
      try { stdin.write(JSON.stringify(command) + "\n"); return true; } catch { return false; }
    };
    const clearTurnTimer = () => { if (turnTimer) clearTimeout(turnTimer); turnTimer = undefined; };
    const hardStop = () => {
      if (!alive) return;
      signalProcessTree(child, "SIGTERM");
      killTimer ??= setTimeout(() => {
        // Kill the group even if its leader exited: descendants can ignore SIGTERM and keep pipes.
        signalProcessTree(child, "SIGKILL");
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        exited(child.exitCode);
      }, 3000);
      killTimer.unref?.();
    };
    const armTurnTimer = (delay = IDLE_TIMEOUT_MS) => {
      clearTurnTimer();
      turnTimer = setTimeout(() => {
        turnTimer = undefined;
        const quiet = Date.now() - activityAt;
        if (quiet < IDLE_TIMEOUT_MS) { armTurnTimer(IDLE_TIMEOUT_MS - quiet); return; }
        hardStop();
        finish("failed", `timed out: no activity for ${duration(IDLE_TIMEOUT_MS)}`);
      }, delay);
      turnTimer.unref?.();
    };
    /** High-frequency stream events repaint at most every LIVE_REPAINT_MS. */
    const repaint = () => {
      const now = Date.now();
      if (now - liveAt >= LIVE_REPAINT_MS) {
        liveAt = now;
        if (liveTimer) { clearTimeout(liveTimer); liveTimer = undefined; }
        update();
        return;
      }
      if (liveTimer) return;
      liveTimer = setTimeout(() => { liveTimer = undefined; liveAt = Date.now(); if (!finished) update(); }, LIVE_REPAINT_MS - (now - liveAt));
      liveTimer.unref?.();
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
      update();
    };
    const abort = () => { hardStop(); finish("failed", signal?.reason === STOP_REASON ? "stopped" : "aborted"); };

    child.stdin?.on("error", (error) => { if (!finished) stderr = (stderr + "\n" + error.message).slice(-4000); });
    signal?.addEventListener("abort", abort, { once: true });
    armTurnTimer();

    const beginPrompt = (message: string, pauseAfter = false): boolean => {
      const clean = cleanBlock(message, MAX_RESUME_CHARS);
      if (finished || closing || !alive || !settled || !clean) return false;
      if (!send({ id: "prompt-" + (run.resumes + 1), type: "prompt", message: clean })) return false;
      settled = false;
      run.error = undefined;
      run.output = "";
      pauseRequested = pauseAfter;
      run.state = "working";
      run.resumes++;
      run.endedAt = undefined;
      run.activity = "resuming";
      activityAt = Date.now();
      armTurnTimer();
      update();
      return true;
    };

    const running = new Map<string, { entry: ToolEntry; path?: string }>();
    const settleTurn = () => {
      if (settled || finished) return;
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
      run.state = run.error ? "failed" : pauseRequested ? "paused" : "idle";
      pauseRequested = false;
      if (!firstResolved && !run.error) { firstResolved = true; resolveFirst(); }
      resolveSettled();
      update();
      if (run.error) { hardStop(); finish("failed", run.error); }
      else if (!persistent && child.stdin && !child.stdin.writableEnded) child.stdin.end();
    };
    const line = (raw: string) => {
      if (finished || !raw.trim()) return;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return; }
      if (!parsed || typeof parsed !== "object") return;
      const event = parsed as ChildEvent;
      activityAt = Date.now();
      switch (event.type) {
        case "response":
          // A handled prompt starts no run, so Pi deliberately sends no agent_settled event.
          if (event.success !== false) {
            if (event.command === "prompt" && event.data?.disposition === "handled") settleTurn();
            return;
          }
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
            run.live = (run.live + delta.delta).slice(-MAX_LIVE_CHARS);
            run.activity = "writing";
            repaint();
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
          repaint();
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
          if (event.message.stopReason === "error") run.error = cleanText(String(event.message.errorMessage ?? "assistant turn failed"), 200);
          if (event.message.stopReason === "aborted" && !pauseRequested && !closing) run.error = "assistant turn aborted";
          run.live = "";
          run.activity = "thinking";
          update();
          return;
        }
        case "agent_settled":
          settleTurn();
          return;
      }
    };

    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      let start = 0;
      for (let end = text.indexOf("\n", start); end >= 0; end = text.indexOf("\n", start)) {
        const item = buffer + text.slice(start, end);
        if (!overflow && item.length <= MAX_LINE_CHARS) line(item.endsWith("\r") ? item.slice(0, -1) : item);
        buffer = "";
        overflow = false;
        start = end + 1;
      }
      if (overflow) return;
      buffer += text.slice(start);
      if (buffer.length > MAX_LINE_CHARS) { buffer = ""; overflow = true; }
    });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4000); });
    let closedOnce = false;
    const exited = (code: number | null) => {
      if (closedOnce) return;
      closedOnce = true;
      alive = false;
      if (killTimer) signalProcessTree(child, "SIGKILL");
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      if (buffer && !overflow) { line(buffer); buffer = ""; }
      if ((closing || (code === 0 && settled)) && !run.error) finish("done");
      else finish("failed", run.error ?? (cleanText(stderr, 300) || (settled ? `exited ${code}` : `exited ${code} before finishing`)));
      if (!firstResolved) { firstResolved = true; resolveFirst(); }
      resolveClosed();
    };
    // A grandchild that inherited stdout/stderr keeps them open after the child is gone, and 'close'
    // then never fires; stop waiting after a short drain so stop/shutdown can never hang on it.
    const drainThenClose = (code: number | null) => {
      if (closedOnce || closeTimer) return;
      closeTimer = setTimeout(() => {
        signalProcessTree(child, "SIGKILL");
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        exited(code);
      }, CLOSE_GRACE_MS);
      closeTimer.unref?.();
    };
    child.on("error", (error) => {
      hardStop();
      finish("failed", error.message);
      // A process that never spawned has no exit event to wait for.
      if (child.pid === undefined) { alive = false; drainThenClose(null); }
    });
    // Exit retires control immediately, but finalization waits for close so stdio drains first.
    child.once("exit", (code) => {
      alive = false;
      clearTurnTimer();
      if (!finished) {
        run.state = (closing || (code === 0 && settled)) && !run.error ? "done" : "failed";
        if (run.state === "failed") run.error ??= `exited ${code}`;
        run.activity = undefined;
        resolveSettled();
        update();
      }
      drainThenClose(code);
    });
    child.once("close", exited);

    steer = (text) => {
      const message = cleanBlock(text, MAX_STEER_CHARS);
      if (finished || closing || !message || run.state !== "working" || !send({ type: "steer", message })) return false;
      pushEntry(run, { kind: "steer", rev: 0, text: message });
      run.steered++;
      update();
      return true;
    };
    pause = async () => {
      if (finished || closing || !alive) return false;
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
      // A child that ignores abort must not hang the moderator; it still pauses when it settles.
      if (!await settlesWithin(waiting, PAUSE_GRACE_MS)) return false;
      return (run.state as DelegateState) === "paused";
    };
    resume = (text) => {
      if (run.state !== "paused" && run.state !== "idle") return false;
      const message = text?.trim() || "Continue the assigned task from where you stopped. Review your current checklist and remaining work first.";
      return beginPrompt(message);
    };
    ask = async (text) => {
      const question = cleanBlock(text, MAX_STEER_CHARS);
      if (!question || finished || closing || askBusy) return undefined;
      askBusy = true;
      const wasPaused = run.state === "paused";
      try {
        // Cross a settled boundary so the active task's report cannot answer the question.
        if (run.state === "working" && !await pause()) return undefined;
        const instruction = "Moderator BTW: answer only this question in one compact paragraph. Preserve your assigned task scope for the next resume. Question: " + question;
        if (!beginPrompt(instruction, wasPaused)) return undefined;
        const answered = await settlesWithin(waitSettled(), 2 * 60_000);
        if (!answered) { void pause(); return undefined; }
        return !finished && !run.error ? run.output || undefined : undefined;
      } finally { askBusy = false; }
    };
    shutdown = () => {
      if (shutdownPromise) return shutdownPromise;
      closing = true;
      shutdownPromise = Promise.resolve().then(async () => {
      if (finished) { await closed; return; }
      if (run.state === "working") {
        const waiting = waitSettled();
        send({ type: "clear_queue" });
        if (send({ type: "abort" })) {
          if (!await settlesWithin(waiting, 3000) && !finished) hardStop();
        } else hardStop();
      }
      if (child.stdin && !child.stdin.writableEnded) child.stdin.end();
      const killer = setTimeout(() => { if (child.exitCode === null) hardStop(); }, 3000);
      killer.unref?.();
      await closed;
      clearTimeout(killer);
      });
      return shutdownPromise;
    };

    if (signal?.aborted) { abort(); return; }
    if (!send({ id: "prompt", type: "prompt", message: prompt })) { hardStop(); finish("failed", "could not send the task to the subagent"); }
  });
  return {
    firstSettled,
    closed,
    steer: (text) => steer(text),
    pause: () => pause(),
    resume: (text) => resume(text),
    ask: (text) => ask(text),
    shutdown: () => shutdown(),
    alive: () => alive
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
  alive?(): boolean;
  closed?(): Promise<void>;
}

/**
 * Live subagents for the activity view. Tool details are saved in the session, so they stay small;
 * the transcript and the per-run stop and steer handles live only here, for this process.
 */
export class DelegateRegistry {
  private entries = new Map<string, { record: SubagentRecord; finished?: number }>();
  private listeners = new Set<() => void>();
  private sequence = 0;
  private reservations = 0;
  private draining = new Set<SubagentRecord>();

  /** Synchronous reservation prevents concurrent/reentrant batches from oversubscribing. */
  reserve(count: number, maximum: number): (() => void) | undefined {
    if (count < 1 || this.retained() + this.reservations + count > maximum) return undefined;
    this.reservations += count;
    let released = false;
    return () => { if (!released) { released = true; this.reservations -= count; } };
  }

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
    if (!record || record.run.state === "stopped" || (record.run.state === "done" && !record.run.workspace)) return undefined;
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
    let count = this.draining.size;
    for (const { record } of this.entries.values()) if (isRetained(record.run.state) || record.alive?.()) count++;
    return count;
  }
  /** Session changes discard retained workers and their private workspaces; they never auto-apply here. */
  clear(): void {
    const records = [...this.entries.values()].map(({ record }) => record);
    this.entries.clear();
    for (const record of records) {
      if (record.closed && (isRetained(record.run.state) || record.alive?.())) {
        this.draining.add(record);
        void record.closed().finally(() => { this.draining.delete(record); this.notify(); });
      }
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
      if (isRetained(entry.record.run.state) || entry.record.alive?.()) { entry.finished = undefined; continue; }
      entry.finished ??= ++this.sequence;
      finished++;
    }
    if (finished <= MAX_FINISHED) return;
    // Conflicted/failed workspaces are recovery state, not disposable transcript history.
    const oldest = [...this.entries].filter(([, entry]) => entry.finished !== undefined && !entry.record.run.workspace)
      .sort((a, b) => a[1].finished! - b[1].finished!);
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
    mode: Type.Optional(DelegateModeSchema),
    tools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 64, uniqueItems: true,
      description: "Explicit child tool allowlist. scout/fork remain read-only; worktree accepts only sandbox-aware file tools. Browser/web tools may be enabled when active in the parent." })),
    inheritTools: Type.Optional(Type.Boolean({ description: "Inherit the parent's currently active tool names, subject to mode safety restrictions. Recursive pi-jar delegation tools are always removed." }))
  }), { minItems: 1, maxItems: 16 }),
  mode: Type.Optional(DelegateModeSchema),
  write: Type.Optional(Type.Boolean({ description: "Deprecated compatibility switch. true keeps the old shared-workspace editing mode; prefer mode=\"worktree\"." }))
});

const glyph = (state: DelegateState) => state === "done" ? "✔" : state === "failed" ? "✖" : state === "stopped" ? "■" : state === "working" ? "●" : "○";
const color = (state: DelegateState) => state === "done" ? "success" : state === "failed" ? "error" : state === "working" ? "accent" : "dim";
type RunDetails = Omit<DelegateRun, "transcript" | "live">;

/** Plain orchestration snapshots. id/key are the stable registry key. */
export interface SubagentReport {
  id: string;
  key: string;
  name: string;
  task: string;
  mode: DelegateExecutionMode;
  state: DelegateState;
  output: string;
  error?: string;
}
export interface DelegateController {
  list(): SubagentReport[];
  spawnScout(task: string, signal?: AbortSignal): Promise<SubagentReport>;
  resumeScout(id: string, prompt: string, signal?: AbortSignal): Promise<SubagentReport>;
  /** Retire an agent the orchestration spawned for itself, releasing its pool slot. */
  stop(id: string): Promise<void>;
}

export interface DelegateOptions {
  /** Snapshot names of tools active in the parent session. */
  getActiveToolNames?: () => readonly string[];
  /** Allowed sizes: 2, 4, 6, 8, 16; defaults to 4. Read on every launch. */
  getMaxSubagents?: () => number;
  /** Shares the delegate lifecycle and capacity with scout orchestration. */
  onController?: (controller: DelegateController) => void;
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

/** Peek is task progress only, read from memory: no git, transcript or report reads. */
const peekRecord = (record: SubagentRecord): string => {
  const run = record.run;
  const leaves = leafTodos(run.todos);
  const open = leaves.filter((todo) => todo.status !== "completed");
  const current = open.find((todo) => todo.status === "in_progress");
  const next = open.filter((todo) => todo !== current).slice(0, 3).map((todo) => cleanText(todo.title, 80));
  const more = open.length - (current ? 1 : 0) - next.length;
  return [
    `${record.key} · ${run.name} · ${run.state}`,
    `progress: ${leaves.length ? `${leaves.length - open.length}/${leaves.length} tasks` : "no checklist"}`
      + (current ? ` · now: ${cleanText(current.title, 80)}` : "") + (run.activity ? ` · ${cleanText(run.activity, 60)}` : ""),
    next.length ? `next: ${next.join("; ")}${more > 0 ? ` (+${more} more)` : ""}` : ""
  ].filter(Boolean).join("\n");
};
/** The wake-up after a resumed turn: its progress plus the bounded report the turn produced. */
const settledRecord = (record: SubagentRecord): string =>
  peekRecord(record) + (record.run.output ? `\nlast: ${cleanBlock(record.run.output, 1200)}` : "");

/** jar_delegate plus jar_subagent: the parent remains a moderator while retained workers do the work. */
export function registerDelegate(pi: ExtensionAPI, roles: ModelRoleManager, registry: DelegateRegistry, options: DelegateOptions = {}): void {
  if (process.env[CHILD_ENV] || typeof (pi as ExtensionAPI & { registerTool?: unknown }).registerTool !== "function") return;
  let batch = 0;
  let controllerContext: ExtensionContext | undefined;
  const maxSubagents = () => {
    const value = options.getMaxSubagents?.() ?? MAX_DELEGATES;
    return SUBAGENT_LIMIT_CHOICES.includes(value as never) ? value : MAX_DELEGATES;
  };
  pi.on?.("session_start", (_event, ctx) => { controllerContext = ctx; });
  const roleCandidates = (role: string) => {
    const manager = roles as ModelRoleManager & { resolveCandidates?: (name: string) => ReturnType<ModelRoleManager["resolveCandidates"]> };
    if (typeof manager.resolveCandidates === "function") return manager.resolveCandidates(role);
    const resolved = roles.resolve(role);
    return resolved ? [resolved] : [];
  };

  pi.on?.("before_agent_start", (_event, ctx) => {
    controllerContext = ctx;
    const retained = registry.records().filter((record) => isRetained(record.run.state));
    if (!retained.length) return;
    const fleet = retained.map((record) =>
      `- ${record.key} · ${record.run.name} · ${record.run.state} · ${record.run.role}: ${cleanText(record.run.task, 140)}`).join("\n");
    return { message: { customType: "pi-jar.moderator-context", display: false, content: [
      "[PI-JAR MODERATOR MODE]",
      "You are the coordinator while retained subagents do delegated work. Decompose and route work, steer only to correct direction, use ask for terse BTW questions, and use jar_discuss for structured cross-agent Q/A.",
      "Initial/resumed turns and asynchronous ask/pause/stop operations wake you with pi-jar.subagent events. Accepted receipts are not completion: do not poll peek or claim files applied before the final event. Keep responding to user steering or do other work.",
      "Do not duplicate work already owned by a retained subagent. Stop completed workers to obtain their handoff and reconcile worktree changes into /diff. Synthesize the final answer from their reports and evidence.",
      "Retained fleet:",
      fleet
    ].join("\n") } };
  });
  // Context rewrites apply to one LLM call only, so the stale copies must be pruned on every call.
  pi.on?.("context", (event) => {
    const active = registry.retained() > 0;
    let latest = -1;
    let prune = false;
    for (let index = event.messages.length - 1; index >= 0; index--) {
      if ((event.messages[index] as { customType?: string }).customType !== "pi-jar.moderator-context") continue;
      if (!active || latest >= 0) prune = true;
      else latest = index;
    }
    if (!prune) return;
    return { messages: event.messages.filter((raw, index) =>
      (raw as { customType?: string }).customType !== "pi-jar.moderator-context" || (active && index === latest)) };
  });

  /** Native RPC drives registry state; Pi's message bus delivers frozen completion events to the moderator. */
  const eventBusAvailable = typeof pi.sendMessage === "function";
  const watched = new Map<string, SubagentRecord>();
  const settledQueue = new Map<string, { record: SubagentRecord; content: string; turn: number }>();
  const deleteSettled = (key: string) => {
    for (const [eventKey, event] of settledQueue) if (event.record.key === key) settledQueue.delete(eventKey);
  };
  let notifyTimer: NodeJS.Timeout | undefined;
  const flushSettled = () => {
    notifyTimer = undefined;
    const records = [...settledQueue.values()].filter(({ record }) => registry.get(record.key) === record);
    settledQueue.clear();
    if (!records.length) return;
    try {
      pi.sendMessage?.({
        customType: SUBAGENT_MESSAGE, display: true, details: {
          keys: [...new Set(records.map(({ record }) => record.key))],
          turns: records.map(({ record, turn }) => ({ key: record.key, turn }))
        },
        content: ["[PI-JAR SUBAGENT] A subagent turn ended. Review, then resume, ask or stop:", ...records.map(event => event.content)].join("\n\n")
      }, { triggerTurn: true, deliverAs: "followUp" });
    } catch (error) { console.error("pi-jar: could not deliver a subagent event", error); }
  };
  registry.subscribe(() => {
    if (!watched.size) return;
    for (const [key, record] of watched) {
      if (registry.get(key) !== record) { watched.delete(key); continue; }
      if (isRunning(record.run.state)) continue;
      watched.delete(key);
      if (record.run.state !== "stopped") {
        // Freeze reports at the settled boundary. A fast resume must not overwrite a queued
        // initial report, and multiple turns in the coalescing window must each be delivered.
        settledQueue.set(`${key}:${record.run.resumes}`, { record, turn: record.run.resumes, content: settledRecord(record) });
      }
    }
    if (settledQueue.size && !notifyTimer) {
      notifyTimer = setTimeout(flushSettled, NOTIFY_COALESCE_MS);
      notifyTimer.unref?.();
    }
  });

  const delegateTool: ToolDefinition<typeof Parameters> = {
    name: DELEGATE_TOOL,
    label: "delegate",
    description: `Start retained session-scoped subagents within the configured live pool limit and return immediately. scout is fresh/read-only and defaults to the scout role; fork inherits the parent conversation read-only and defaults to reviewer; worktree inherits context, defaults to worker, and edits in an isolated Git worktree. Each task may provide an explicit tools allowlist or inheritTools=true to filter the parent's active tools by mode. Turn completions arrive as pi-jar.subagent event messages; control workers with jar_subagent. Worktree changes apply only when the moderator stops that agent.`,
    promptSnippet: "Act as moderator: delegate parallel work, then continue responding to the user while subagents run. Their turn completions arrive as pi-jar.subagent event messages; steer, pause or stop them with jar_subagent without polling.",
    promptGuidelines: [
      "When useful work can be delegated, act as the moderator: decompose, assign, monitor, resolve disagreements, and synthesize. Do not redo a delegated implementation yourself while its worker is active.",
      "Use scout for cheap independent discovery, fork/reviewer for context-aware review, and worktree/worker for implementation. Explicit task.role overrides these mode defaults. Grant optional task.tools narrowly; task.inheritTools snapshots active parent tools then filters by mode. Scout/fork stay read-only; worktree only accepts path-guarded tools.",
      "Retained agents become idle after each turn. Initial and resumed turn completions arrive as pi-jar.subagent event messages, so keep responding to user steering while they work; do not poll jar_subagent peek. Reuse them with jar_subagent resume instead of spawning replacements; pause them when priorities change; stop completed workers to reconcile their worktree into /diff.",
      "Use jar_subagent ask for a brief BTW question to one worker. For agent-to-agent questions, have them use the bounded jar_discuss paper so answers stay structured and cheap.",
      "Respect the configured pool limit, including idle and paused agents. Stop agents you no longer need."
    ],
    parameters: Parameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      controllerContext = ctx;
      const requested = params.tasks;
      const parentToolNames = (): string[] | undefined => {
        try {
          const supplied = options.getActiveToolNames?.();
          if (supplied) return [...new Set(supplied.filter(name => typeof name === "string" && name.trim()).map(name => name.trim()))];
          const tools = pi.getActiveTools?.();
          return tools ? [...new Set(tools.filter(name => typeof name === "string" && name.trim()))] : undefined;
        } catch { return undefined; }
      };
      const activeNames = parentToolNames();
      const defaultWorktreeTools = WORKTREE_TOOLS.filter(name => name !== "multi_file_edit" || activeNames?.includes(name));
      for (const [index, item] of requested.entries()) {
        const mode = item.mode ?? params.mode ?? (params.write === true ? "direct" : "scout");
        const selected = item.tools ?? (item.inheritTools && activeNames ? activeNames.filter(name =>
          allowedInMode(mode, name)) : undefined);
        if ((item.inheritTools || item.tools) && !activeNames) {
          return { content: [{ type: "text", text: `Task ${index + 1}: this Pi host does not expose active tool names; configurable tools cannot be validated. Use default tools or a host with getActiveTools().` }], details: { runs: [], write: false }, isError: true };
        }
        if (item.inheritTools && !selected?.length) {
          return { content: [{ type: "text", text: `Task ${index + 1}: no active tools remain after applying ${mode} safety filters. Choose explicit safe tools or use the mode defaults.` }], details: { runs: [], write: false }, isError: true };
        }
        if (selected) {
          if (activeNames) {
            const missing = selected.filter(name => !activeNames.includes(name));
            if (missing.length) return { content: [{ type: "text", text: `Task ${index + 1}: tools are not currently active in the parent: ${missing.join(", ")}. Enable their extensions/tools first.` }], details: { runs: [], write: false }, isError: true };
          } else if (item.inheritTools) {
            return { content: [{ type: "text", text: `Task ${index + 1}: cannot resolve inherited tools from this Pi host.` }], details: { runs: [], write: false }, isError: true };
          }
          const recursive = selected.filter(name => RECURSIVE_TOOLS.has(name));
          if (recursive.length) return { content: [{ type: "text", text: `Task ${index + 1}: recursive delegation tools are never available to subagents: ${recursive.join(", ")}.` }], details: { runs: [], write: false }, isError: true };
          if ((mode === "scout" || mode === "fork") && selected.some(name => !READ_ONLY_SAFE_TOOLS.has(name))) {
            return { content: [{ type: "text", text: `Task ${index + 1}: ${mode} is read-only; remove edit/write/shell tools or use mode="worktree" for sandboxed code changes.` }], details: { runs: [], write: false }, isError: true };
          }
          if (mode === "worktree") {
            const unsafe = selected.filter(name => !WORKTREE_SAFE_TOOLS.has(name));
            if (unsafe.length) return { content: [{ type: "text", text: `Task ${index + 1}: worktree cannot safely use tools outside its path-guarded allowlist: ${unsafe.join(", ")}. Arbitrary extension tools remain disabled unless the worktree boundary validates them.` }], details: { runs: [], write: false }, isError: true };
          }
        }
      }
      const maximum = maxSubagents();
      const releaseReservation = registry.reserve(requested.length, maximum);
      if (!releaseReservation) {
        return { content: [{ type: "text", text: `Subagent pool is full: ${registry.retained()}/${maximum} retained. Reuse or stop an existing agent with jar_subagent.` }], details: { runs: [], write: false }, isError: true };
      }
      try {

      const id = ++batch;
      const defaultMode: DelegateExecutionMode = params.mode ?? (params.write === true ? "direct" : "scout");
      let available = new Set<string>();
      try { available = new Set(ctx.modelRegistry.getAvailable().map((model) => model.provider + "/" + model.id)); } catch { /* current model remains the fallback */ }
      const thinkingByRun = new Map<number, string | undefined>();
      const toolsByRun = new Map<number, readonly string[] | undefined>();
      const runs: DelegateRun[] = requested.map((item, index) => {
        const mode: DelegateExecutionMode = item.mode ?? defaultMode;
        toolsByRun.set(index + 1, item.tools ?? (item.inheritTools && activeNames ? activeNames.filter(name =>
          allowedInMode(mode, name)) : mode === "worktree" ? defaultWorktreeTools : undefined));
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

      /** Last footer state per record: child streams fire many updates, the status changes rarely. */
      const published = new Map<string, string>();
      const publish = () => {
        if (!ctx.hasUI) return;
        for (const { key, run } of records) {
          const state = run.state === "done" || run.state === "failed" || run.state === "stopped" ? ""
            : run.state === "queued" || run.state === "paused" ? "waiting" : run.state === "idle" ? "idle" : "working";
          if (published.get(key) === state) continue;
          published.set(key, state);
          try {
            ctx.ui.setStatus(`${ROLE_PREFIX}${key}`, !state ? undefined : JSON.stringify({
              name: run.name, label: run.name.slice(0, 12), state,
              task: cleanText(run.task, 60), expiresAt: Date.now() + 24 * 60 * 60_000
            }));
          } catch { /* status is decoration */ }
        }
      };
      const details = (includeOutput = true) => ({
        batch: id,
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
        resume: () => false, ask: async () => undefined, shutdown: async () => {}, alive: () => false
      });
      const cleanupPrivate = async (index: number, discardWorktree: boolean) => {
        const dir = sessionDirs.get(index);
        if (dir) { await rm(dir, { recursive: true, force: true }); sessionDirs.delete(index); }
        if (discardWorktree) {
          const worktree = worktrees.get(index);
          if (worktree) {
            try { await disposeDelegateWorktree(worktree); } catch { /* best effort */ }
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

      let discarded = false;
      const markStartStopped = (run: DelegateRun) => {
        run.state = "stopped";
        run.error = undefined;
        run.endedAt = Date.now();
        update();
      };
      handles = runs.map(failedHandle);
      const started = new Set<number>();
      const readyResolvers: Array<() => void> = [];
      const ready = runs.map(() => new Promise<void>((resolve) => readyResolvers.push(resolve)));
      const startRuns = async () => Promise.all(runs.map(async (run, index) => {
        try {
        if (discarded) { run.state = "stopped"; readyResolvers[index]!(); return; }
        const start = async (): Promise<DelegateHandle> => {
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
        const effectiveTools = toolsByRun.get(run.index) ?? (run.mode === "worktree" ? WORKTREE_TOOLS : run.mode === "direct" ? undefined : READ_ONLY_TOOLS);
        if (effectiveTools) env[CHILD_TOOLS_ENV] = JSON.stringify(effectiveTools);
        const discussion = options.discussionFile?.();
        if (discussion) env[DISCUSSION_FILE_ENV] = discussion;
        const hooks: DelegateHooks = {};
        const write = run.mode === "direct" || run.mode === "worktree";

        if (run.mode === "fork" || run.mode === "worktree") {
          try {
            const sessionDir = mkdtempSync(join(tmpdir(), "pi-jar-fork-"));
            sessionDirs.set(run.index, sessionDir);
            const requestedTools = toolsByRun.get(run.index);
            fork = { source: parentSession!, sessionDir,
              ...((run.mode === "worktree" || run.mode === "fork") ? { tools: requestedTools ?? (run.mode === "worktree" ? WORKTREE_TOOLS : READ_ONLY_TOOLS) } : {}) };
          } catch (error) {
            failBeforeStart(run, error);
            return failedHandle();
          }
        }
        if (run.mode === "worktree") {
          try {
            const worktree = await createDelegateWorktree(ctx.cwd, controllers[index]!.signal);
            worktrees.set(run.index, worktree);
            run.workspace = worktree.root;
            cwd = worktree.cwd;
            env[CHILD_WORKTREE_ENV] = worktree.root;
          } catch (error) {
            await cleanupPrivate(run.index, true);
            if (discarded || stopRequested.has(index)) markStartStopped(run);
            else failBeforeStart(run, error);
            return failedHandle();
          }
        } else if (run.mode === "direct" && baselines) {
          env[CHILD_BASELINE_ENV] = baselines;
          hooks.edited = edited;
        }
        hooks.env = env;
        return startDelegate(run, delegateArgs(run.model, thinkingByRun.get(run.index), write, process.argv, fork,
          run.mode === "scout" ? toolsByRun.get(run.index) : undefined),
          delegatePrompt(run.task, write, run.mode), cwd, controllers[index]!.signal, update, options.spawnProcess, hooks, run.mode !== "direct");
        };
        let handle: DelegateHandle;
        try { handle = await start(); }
        catch (error) {
          if (discarded || stopRequested.has(index)) markStartStopped(run);
          else failBeforeStart(run, error);
          handle = failedHandle();
        }
        handles[index] = handle;
        started.add(index);
        readyResolvers[index]!();
        void handle.closed.then(async () => {
          await cleanupPrivate(run.index, discarded || run.mode !== "worktree");
          update();
        }).catch((error) => {
          run.error ??= "subagent cleanup failed: " + cleanText(error instanceof Error ? error.message : String(error), 240);
          update();
        });
        if (discarded) void handle.shutdown().finally(() => cleanupPrivate(run.index, true))
          .catch(error => console.error("pi-jar: subagent cleanup failed", error));
        } catch (error) {
          failBeforeStart(run, error);
        } finally {
          // Even a filesystem cleanup or decoration failure must release lifecycle waiters.
          readyResolvers[index]!();
        }
      }));

      const stopping = new Map<number, Promise<SubagentStopReport>>();
      const stopRequested = new Set<number>();
      const stopRun = (index: number): Promise<SubagentStopReport> => {
        const existing = stopping.get(index);
        if (existing) return existing;
        stopRequested.add(index);
        // Cancel asynchronous worktree setup as well as an already-running child before waiting
        // for ready; otherwise stop can queue behind a stalled startup operation.
        if (!started.has(index)) controllers[index]!.abort(STOP_REASON);
        const promise = finalizeRun(index);
        stopping.set(index, promise);
        // A reconciliation conflict is retryable after the parent drift is resolved.
        void promise.then(() => { if (worktrees.has(runs[index]!.index)) stopping.delete(index); }, () => { stopping.delete(index); });
        return promise;
      };
      const finalizeRun = async (index: number): Promise<SubagentStopReport> => {
        const run = runs[index]!;
        const key = `delegate-${id}-${run.index}`;
        const workspace = run.workspace;
        if (run.error?.startsWith("changes not applied:")) run.error = undefined;
        await ready[index];
        const handle = handles[index]!;
        await handle.shutdown();

        let changed: string[] = [];
        const worktree = worktrees.get(run.index);
        if (worktree && !discarded) {
          try { changed = await worktreeChangedFiles(worktree, controllers[index]!.signal); run.filesEdited = changed; }
          catch (error) { run.error = "could not inspect isolated changes: " + cleanText(String(error), 240); }
          if (changed.length && !run.error) {
            try {
              run.appliedFiles = await applyDelegateWorktree(worktree, ctx.cwd, changed, options.changes?.(), controllers[index]!.signal);
              if (run.appliedFiles.length) {
                try { options.changed?.(); } catch (error) { console.error("pi-jar: could not refresh parent change UI", error); }
              }
              await disposeDelegateWorktree(worktree);
              worktrees.delete(run.index);
              run.workspace = undefined;
            } catch (error) {
              if (error instanceof WorktreeApplyError) run.appliedFiles = error.appliedFiles;
              run.error = "changes not applied: " + cleanText(error instanceof Error ? error.message : String(error), 240);
            }
          } else if (!changed.length) {
            try { await disposeDelegateWorktree(worktree); } catch { /* best effort */ }
            worktrees.delete(run.index);
            run.workspace = undefined;
          }
        }
        await cleanupPrivate(run.index, discarded);
        if (discarded) { run.error = undefined; run.workspace = undefined; }
        run.state = run.error ? "failed" : "stopped";
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
        pause: async () => {
          await ready[index];
          return discarded || stopRequested.has(index) ? false : handles[index]!.pause();
        },
        resume: (text) => !discarded && !stopRequested.has(index) && handles[index]!.resume(text),
        steer: (text) => !discarded && !stopRequested.has(index) && handles[index]!.steer(text),
        ask: async (text) => {
          await ready[index];
          return discarded || stopRequested.has(index) ? undefined : handles[index]!.ask(text);
        },
        alive: () => handles[index]!.alive(),
        closed: () => ready[index]!.then(() => handles[index]!.closed),
        changed: () => {
          const worktree = worktrees.get(run.index);
          if (!worktree) return [...run.filesEdited];
          return [...run.filesEdited]; // synchronous activity snapshots never launch subprocesses
        },
        discard: () => {
          discarded = true;
          // Cancellation is synchronous: a concurrent stop must never apply discarded edits.
          controllers[index]!.abort(STOP_REASON);
          void ready[index]!.then(() => handles[index]!.shutdown()).finally(() => cleanupPrivate(run.index, true))
            .catch(error => console.error("pi-jar: subagent discard failed", error));
        }
      }));
      // Initial turns are event-driven too: the retained launch returns immediately so the
      // moderator can act on user messages instead of remaining trapped in this tool call.
      // The Pi RPC stream continues independently and the registry wakes the moderator on settle.
      if (eventBusAvailable) for (const record of records) watched.set(record.key, record);
      // Transfer the reservation into queued records before notifying reentrant listeners.
      releaseReservation();
      registry.add(...records);
      const startup = startRuns();
      if (eventBusAvailable) {
        void startup.then(async () => {
          // Legacy direct writers also run off the main tool path. Remove their shared baseline
          // directory only after all direct streams drained and their edit events were adopted.
          await Promise.all(handles.map((handle, index) => runs[index]!.mode === "direct" ? handle.closed : Promise.resolve()));
          if (baselines) await rm(baselines, { recursive: true, force: true });
        }).catch((error) => console.error("pi-jar: subagent startup/cleanup failed", error));
        signal?.removeEventListener("abort", abortAll);
        publish();
        toolReturned = true;
        return { content: [{ type: "text", text: runs.map((run) => runReport(run)).join("\n\n") + "\n\nSubagent launch is asynchronous; turn reports arrive as pi-jar.subagent events. You can continue working or steer the fleet with jar_subagent." }], details: details() };
      }
      await startup;
      publish();

      try {
        await Promise.all(handles.map((handle, index) => runs[index]!.mode === "direct" ? handle.closed : handle.firstSettled));
      } finally {
        signal?.removeEventListener("abort", abortAll);
        if (baselines) await rm(baselines, { recursive: true, force: true });
        await Promise.all(runs.map(run => run.mode === "direct" || run.state === "failed"
          ? cleanupPrivate(run.index, run.mode === "direct") : Promise.resolve()));
        registry.notify();
        flushUpdate();
        toolReturned = true;
      }
      return { content: [{ type: "text", text: runs.map((run) => runReport(run)).join("\n\n") }], details: details(),
        ...(runs.some((run) => run.state === "failed") ? { isError: true } : {}) };
      } finally { releaseReservation(); }
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
  };
  pi.registerTool(delegateTool);

  const snapshot = (record: SubagentRecord): SubagentReport => ({
    id: record.key, key: record.key, name: record.run.name, task: record.run.task,
    mode: record.run.mode, state: record.run.state, output: record.run.output,
    ...(record.run.error ? { error: record.run.error } : {})
  });
  options.onController?.({
    list: () => registry.records().map(snapshot),
    async stop(id) { await registry.stop(id); },
    async spawnScout(task, signal) {
      if (!controllerContext) throw new Error("Delegate controller has no active session context");
      if (signal?.aborted) throw new Error("Scout launch aborted");
      const result = await delegateTool.execute("scout", { tasks: [{ task, mode: "scout" }] }, signal, undefined, controllerContext);
      const launched = (result.details as { batch?: number }).batch;
      if (!launched) throw new Error(result.content.map((part) => "text" in part ? part.text : "").join("\n"));
      const record = registry.get(`delegate-${launched}-1`);
      if (!record) throw new Error("Scout session was discarded");
      // This launch is an internal democracy vote; its caller is already awaiting the result,
      // so the moderator does not need a duplicate unsolicited completion notification.
      watched.delete(record.key);
      deleteSettled(record.key);
      await new Promise<void>((resolve, reject) => {
        let unsubscribe = () => {};
        const cleanup = () => { unsubscribe(); signal?.removeEventListener("abort", abort); };
        const check = () => {
          if (registry.get(record.key) !== record) { cleanup(); reject(new Error("Scout session was discarded")); return; }
          if (isRunning(record.run.state)) return;
          cleanup();
          if (record.run.error || record.run.state !== "idle") reject(new Error(record.run.error ?? "Scout failed to settle"));
          else resolve();
        };
        const abort = () => { cleanup(); void registry.stop(record.key); reject(new Error("Scout launch aborted")); };
        unsubscribe = registry.subscribe(check);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort(); else check();
      });
      return snapshot(record);
    },
    async resumeScout(id, prompt, signal) {
      const record = registry.get(id);
      if (!record || record.run.mode !== "scout") throw new Error("Only fresh read-only scouts can vote");
      if (!prompt.trim()) throw new Error("Scout resume requires a prompt");
      if (signal?.aborted) throw new Error("Scout resume aborted");
      const result = new Promise<SubagentReport>((resolve, reject) => {
        let unsubscribe = () => {};
        const cleanup = () => { unsubscribe(); signal?.removeEventListener("abort", abort); };
        const check = () => {
          if (registry.get(id) !== record) { cleanup(); reject(new Error("Scout session was discarded")); return; }
          if (isRunning(record.run.state)) return;
          cleanup();
          if (record.run.error || !isRetained(record.run.state)) reject(new Error(record.run.error ?? "Scout exited before reporting"));
          else resolve(snapshot(record));
        };
        const abort = () => { cleanup(); void registry.stop(id); reject(new Error("Scout resume aborted")); };
        unsubscribe = registry.subscribe(check);
        signal?.addEventListener("abort", abort, { once: true });
        if (!registry.resume(id, prompt)) { cleanup(); reject(new Error("Scout is not idle or paused")); }
        else check();
      });
      return result;
    }
  });

  let operationSequence = 0;
  const pendingControls = new Map<string, { id: string; action: string; message?: string }>();
  const deliverControl = (record: SubagentRecord, operation: { id: string; action: string }, result: { content: Array<{ text: string }>; details?: unknown; isError?: boolean }) => {
    // A session switch discards the old fleet. Never wake a new session with stale handoffs.
    if (registry.get(record.key) !== record) return;
    try {
      pi.sendMessage({
        customType: SUBAGENT_MESSAGE, display: true,
        details: { operationId: operation.id, action: operation.action, key: record.key, status: result.isError ? "failed" : "completed", report: result.details },
        content: `[PI-JAR SUBAGENT] ${operation.action} ${operation.id} completed:\n${result.content.map(part => part.text).join("\n")}`
      }, { triggerTurn: true, deliverAs: "followUp" });
    } catch (error) { console.error("pi-jar: could not deliver a control event", error); }
  };

  pi.registerTool({
    name: "jar_subagent",
    label: "subagent",
    description: "Non-blocking moderator control for retained subagents. peek, steer and resume return immediately. ask, pause and stop return an accepted operation receipt; the final answer or handoff arrives as a pi-jar.subagent event. Stop completion safely reconciles worktree changes; acceptance does not mean changes are applied yet.",
    promptSnippet: "Use jar_subagent as the moderator control plane. Prefer peek over rereading transcripts; reuse paused/idle agents with resume; stop finished workers to reconcile their work.",
    promptGuidelines: [
      "peek returns only task progress. Do not poll: initial/resumed turns and control completions send pi-jar.subagent events. Stop returns an accepted receipt first, then changed files and the full handoff in its completion event.",
      "Use steer for active direction and ask for a brief BTW question. ask, pause and stop do not wait on the child; continue responding to the user until their completion event arrives.",
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
    async execute(_id, params, signal) {
      if (signal?.aborted) return { content: [{ type: "text" as const, text: "Cancelled before accepting the operation." }], details: undefined, isError: true };
      const work = (async () => {
      if (params.action === "peek") {
        const targets = params.agent ? [registry.resolve(params.agent)].filter((item): item is SubagentRecord => !!item)
          : registry.records().filter((record) => isRetained(record.run.state));
        if (!targets.length) return { content: [{ type: "text", text: params.agent ? "Subagent not found: " + params.agent : "No retained subagents." }] };
        return { content: [{ type: "text", text: targets.map(peekRecord).join("\n\n") }] };
      }
      const agent = params.agent ?? "";
      const record = registry.resolve(agent);
      if (!record) return { content: [{ type: "text", text: "Subagent not found or name is ambiguous: " + agent }], isError: true };
      const stopping = pendingControls.get(record.key + ":stop");
      const controlling = pendingControls.get(record.key + ":control");
      if (stopping || (controlling && params.action !== "stop")) {
        const pending = stopping ?? controlling!;
        if (pending.action === params.action && pending.message === params.message) {
          return { content: [{ type: "text", text: `${pending.action} already accepted (${pending.id}); completion will arrive as an event.` }], details: { operationId: pending.id, status: "accepted", action: pending.action, key: record.key } };
        }
        return { content: [{ type: "text", text: `${record.run.name} has pending ${pending.action} (${pending.id}). Stop may preempt other controls; otherwise wait for its event.` }], isError: true };
      }
      if (params.action === "steer") {
        const message = cleanBlock(params.message ?? "", MAX_STEER_CHARS);
        if (!message) return { content: [{ type: "text", text: "steer requires message." }], isError: true };
        return { content: [{ type: "text", text: registry.steer(record.key, message) ? "Steered " + record.run.name + "." : "Subagent is not currently working; use resume instead." }] };
      }
      // The moderator is handling this agent directly now; its settle no longer needs a wake-up.
      if (params.action !== "resume") watched.delete(record.key);
      const controlWork = async () => {
      if (params.action === "ask") {
        const message = cleanBlock(params.message ?? "", MAX_STEER_CHARS);
        if (!message) return { content: [{ type: "text", text: "ask requires message." }], isError: true };
        const answer = await registry.ask(record.key, message);
        return { content: [{ type: "text", text: answer ? record.run.name + ": " + cleanBlock(answer, 2000) : "No answer arrived before the BTW timeout or the worker stopped." }], isError: !answer };
      }
      if (params.action === "pause") {
        const paused = await registry.pause(record.key);
        if (!paused && isRunning(record.run.state) && !pendingControls.has(record.key + ":stop")) watched.set(record.key, record);
        const text = paused ? "Paused " + record.run.name + "; context and workspace are retained."
          : record.run.state === "working" ? record.run.name + " has not settled yet; it pauses when its current turn ends."
          : "Could not pause " + record.run.name + ".";
        return { content: [{ type: "text", text }], isError: !paused };
      }
      if (params.action === "resume") {
        const resumed = registry.resume(record.key, params.message);
        if (resumed) watched.set(record.key, record);
        return { content: [{ type: "text", text: resumed ? "Resumed " + record.run.name + ". You will be woken when its turn ends; do not poll peek." : record.run.name + " is not idle or paused." }] };
      }
      const report = await registry.stop(record.key);
      if (!report) return { content: [{ type: "text", text: "Subagent is already retired: " + record.run.name }] };
      return { content: [{ type: "text", text: controlReport(report) }], details: report, isError: !!report.error };
      };
      // Internal registry APIs remain awaited for shutdown/reconciliation correctness. Only the
      // external tool boundary is detached, so parent steering never waits on a child turn or Git.
      if (eventBusAvailable && params.action !== "resume") {
        if (params.action === "ask" && !params.message?.trim()) return { content: [{ type: "text", text: "ask requires message." }], isError: true };
        const operation = { id: `subagent-op-${++operationSequence}`, action: params.action, message: params.message };
        const pendingKey = record.key + (params.action === "stop" ? ":stop" : ":control");
        pendingControls.set(pendingKey, operation);
        deleteSettled(record.key);
        void Promise.resolve().then(controlWork).then(result => {
          if (pendingControls.get(pendingKey) === operation) pendingControls.delete(pendingKey);
          deliverControl(record, operation, result);
        }, error => {
          if (pendingControls.get(pendingKey) === operation) pendingControls.delete(pendingKey);
          deliverControl(record, operation, { content: [{ text: error instanceof Error ? error.message : String(error) }], isError: true });
        });
        return { content: [{ type: "text", text: `${params.action} accepted for ${record.run.name} (${operation.id}). Completion and any reconciled changes will arrive as an event; keep responding to the user, do not poll.` }], details: { operationId: operation.id, status: "accepted", action: params.action, key: record.key } };
      }
      return controlWork();
      })();
      // Pi waits on a tool until it resolves, so Esc must never be stuck behind a child that ignores abort.
      const result = await untilAborted(work, signal)
        ?? { content: [{ type: "text", text: "Cancelled; the subagent keeps its state. Check it with peek." }], isError: true };
      return { ...result, content: result.content.map((part) => ({ ...part, type: "text" as const })), details: "details" in result ? result.details : undefined };
    }
  });
}
