import { EventEmitter } from "node:events";
import { appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DelegateRegistry } from "../src/delegate.ts";

/** The stdin of a fake `pi --mode rpc`: records every JSONL command it is sent. */
export class FakeStdin extends EventEmitter {
  commands: Array<Record<string, unknown>> = [];
  writableEnded = false;
  destroyed = false;
  write(line: string): boolean {
    const command = JSON.parse(line) as Record<string, unknown>;
    this.commands.push(command);
    this.emit("command", command);
    return true;
  }
  end(): void {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.emit("finish");
  }
}

export interface FakeChild extends EventEmitter {
  stdin: FakeStdin;
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  killed: string[];
  kill(signal: string): void;
  exit(code: number, signal?: string, close?: boolean): void;
}

export interface SpawnCall { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string }

/** The session file a real child would use: `--session <file>`, or the file Pi would create in `--session-dir`. */
export const sessionFileOf = (args: readonly string[]): string | undefined => {
  const session = args.indexOf("--session");
  if (session >= 0) return args[session + 1];
  const dir = args.indexOf("--session-dir");
  return dir >= 0 ? join(args[dir + 1]!, "fake-session.jsonl") : undefined;
};

/**
 * A fake child Pi: `script` runs when the prompt arrives with the prompt text. Closing stdin (what
 * pi-jar does after `agent_settled`) exits 0; kill() exits 143. No pid, so nothing real is signalled.
 * With a session file it appends every prompt there, like Pi persisting turns, and reports it via get_state.
 */
export function fakeChild(script?: (child: FakeChild, prompt: string) => void, sessionFile?: string): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new FakeStdin();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = [];
  const exit = (code: number, signal?: string, close = true) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    queueMicrotask(() => {
      child.emit("exit", code, signal ?? null);
      if (close) child.emit("close", code, signal ?? null);
    });
  };
  child.exit = exit;
  child.kill = (signal: string) => { child.killed.push(signal); exit(143, signal); };
  child.stdin.on("finish", () => exit(0));
  child.stdin.on("command", (command: Record<string, unknown>) => {
    if (command.type === "clear_queue") {
      emit(child, { type: "response", id: command.id, command: "clear_queue", success: true, data: { steering: [], followUp: [] } });
      return;
    }
    if (command.type === "abort") {
      emit(child, { type: "response", id: command.id, command: "abort", success: true });
      queueMicrotask(() => settle(child));
      return;
    }
    if (command.type === "get_state") {
      emit(child, { type: "response", id: command.id, command: "get_state", success: true, data: sessionFile ? { sessionFile } : {} });
      return;
    }
    if (command.type !== "prompt") return;
    if (sessionFile && existsSync(dirname(sessionFile))) appendFileSync(sessionFile, JSON.stringify({ prompt: command.message }) + "\n");
    emit(child, { type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
    queueMicrotask(() => { if (child.exitCode === null) script?.(child, String(command.message)); });
  });
  return child;
}

export function fakeSpawn(script: (child: FakeChild, prompt: string, args: string[]) => void) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
    calls.push({ command, args, env: options.env ?? {}, ...(options.cwd ? { cwd: options.cwd } : {}) });
    const child = fakeChild((running, prompt) => script(running, prompt, args), sessionFileOf(args));
    children.push(child);
    return child as never;
  };
  return { spawn, calls, children };
}

export const emit = (child: FakeChild, event: object) => child.stdout.emit("data", JSON.stringify(event) + "\n");
export const settle = (child: FakeChild) => emit(child, { type: "agent_settled" });
export const say = (child: FakeChild, text: string, cost = 0) => emit(child, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { cost: { total: cost } } } });
/** The task line of a subagent prompt. */
export const taskOf = (prompt: string) => prompt.slice(prompt.lastIndexOf("Task: ") + 6);
/**
 * Resolves once `check` holds. Every subagent lifecycle step (hibernation, relaunch, cleanup) notifies the
 * registry, so this waits on that signal, not on time; the lifecycle's own timers are unref'd, so an idle
 * interval only keeps the test process alive meanwhile.
 */
export const until = (registry: DelegateRegistry, check: () => boolean) => new Promise<void>((resolve) => {
  if (check()) { resolve(); return; }
  const alive = setInterval(() => {}, 1000);
  const unsubscribe = registry.subscribe(() => { if (check()) { clearInterval(alive); unsubscribe(); resolve(); } });
});
