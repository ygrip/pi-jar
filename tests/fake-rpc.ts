import { EventEmitter } from "node:events";

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
}

export interface SpawnCall { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string }

/**
 * A fake child Pi: `script` runs when the prompt arrives with the prompt text. Closing stdin (what
 * pi-jar does after `agent_settled`) exits 0; kill() exits 143. No pid, so nothing real is signalled.
 */
export function fakeChild(script?: (child: FakeChild, prompt: string) => void): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new FakeStdin();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = [];
  const exit = (code: number, signal?: string) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    queueMicrotask(() => child.emit("close", code, signal ?? null));
  };
  child.kill = (signal: string) => { child.killed.push(signal); exit(143, signal); };
  child.stdin.on("finish", () => exit(0));
  child.stdin.on("command", (command: Record<string, unknown>) => {
    if (command.type !== "prompt") return;
    emit(child, { type: "response", id: command.id, command: "prompt", success: true });
    queueMicrotask(() => script?.(child, String(command.message)));
  });
  return child;
}

export function fakeSpawn(script: (child: FakeChild, prompt: string, args: string[]) => void) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
    calls.push({ command, args, env: options.env ?? {}, ...(options.cwd ? { cwd: options.cwd } : {}) });
    const child = fakeChild((running, prompt) => script(running, prompt, args));
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
