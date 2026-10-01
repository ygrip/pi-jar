import { spawn, type ChildProcess } from "node:child_process";

export class ProcessExecutionError extends Error {
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals | null;
  constructor(message: string, exitCode?: number, signal?: NodeJS.Signals | null) {
    super(message);
    this.name = "ProcessExecutionError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export interface ProcessOptions {
  cwd?: string;
  input?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

/** The caller must spawn POSIX children with detached:true so they own their process group. */
export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try { process.kill(-child.pid, signal); return; } catch { /* group may already have exited */ }
  } else if (child.pid !== undefined && process.platform === "win32") {
    // Node's kill() only terminates the leader on Windows. taskkill /T includes descendants.
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => { try { child.kill(signal); } catch { /* already exited */ } });
      const timer = setTimeout(() => { try { killer.kill(); } catch { /* already exited */ } }, 1000);
      killer.once("close", () => clearTimeout(timer));
      timer.unref();
      return;
    } catch { /* fall back to killing the leader */ }
  }
  if (child.exitCode !== null || child.signalCode) return;
  try { child.kill(signal); } catch { /* already exited */ }
}

/** Bounded, cancellable execution. Neither a hung leader nor inherited pipes can hold the caller. */
export function runProcess(command: string, args: readonly string[], options: ProcessOptions = {}): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return Promise.reject(new RangeError("timeoutMs must be a finite positive timer duration"));
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) {
    return Promise.reject(new RangeError("maxOutputBytes must be a non-negative safe integer"));
  }
  if (options.signal?.aborted) return Promise.reject(abortError(options.signal.reason));

  return new Promise<Buffer>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32", windowsHide: true
      });
    } catch (error) { reject(error); return; }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    let stdinError: Error | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(exitTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const destroyPipes = () => {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      signalProcessTree(child);
      destroyPipes();
      reject(error);
    };
    const complete = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      destroyPipes();
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) reject(new ProcessExecutionError(`${command} exited ${code ?? signal ?? "unknown"}${detail ? `: ${detail}` : ""}`, code ?? undefined, signal));
      else if (stdinError) reject(new ProcessExecutionError(`${command} stdin failed: ${stdinError.message}`, code, signal));
      else resolve(Buffer.concat(stdout));
    };
    const onAbort = () => fail(abortError(options.signal?.reason));
    const timer = setTimeout(() => fail(new ProcessExecutionError(`${command} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > maxOutputBytes) {
        fail(new ProcessExecutionError(`${command} exceeded ${maxOutputBytes} output bytes`));
      } else target.push(buffer);
    };
    child.stdout!.on("data", collect(stdout));
    child.stderr!.on("data", collect(stderr));
    child.stdout!.on("error", fail);
    child.stderr!.on("error", fail);
    child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
      // An early exit often produces EPIPE. Consume it and preserve the child's exit/stderr;
      // it must never become an uncaught stream error that crashes Pi.
      stdinError = error;
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") fail(error);
    });
    child.once("error", fail);
    child.once("close", complete);
    child.once("exit", (code, signal) => {
      if (settled) return;
      // A descendant can retain stdout after its leader exits. Drain briefly, then kill the
      // remaining group and settle explicitly rather than relying on a never-arriving close.
      exitTimer = setTimeout(() => {
        signalProcessTree(child);
        complete(code, signal);
      }, 250);
      exitTimer.unref();
    });

    if (options.signal?.aborted) { onAbort(); return; }
    // end() writes the complete buffer using Node stream backpressure, then supplies EOF.
    try { child.stdin!.end(options.input); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(reason === undefined ? "process aborted" : String(reason));
  error.name = "AbortError";
  return error;
}
