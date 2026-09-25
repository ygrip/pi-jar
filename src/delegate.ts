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
const STATUS_REFRESH_MS = 10_000;

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

const textOf = (message: { content?: unknown }) => Array.isArray(message.content)
  ? message.content.filter((part: { type?: string }) => part?.type === "text").map((part: { text?: string }) => part.text ?? "").join("\n")
  : typeof message.content === "string" ? message.content : "";

/** Run one child Pi, feeding progress into `run` and calling `update` on every change. */
export function runDelegate(run: DelegateRun, args: string[], cwd: string, signal: AbortSignal | undefined, update: () => void, spawnProcess: Spawn = spawn as Spawn): Promise<void> {
  return new Promise((resolve) => {
    const invocation = piInvocation(args);
    let child: ChildProcess;
    try {
      child = spawnProcess(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, [CHILD_ENV]: "1" } });
    } catch (error) {
      run.state = "failed"; run.error = error instanceof Error ? error.message : String(error); update(); resolve(); return;
    }
    run.state = "working";
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
      update();
      resolve();
    };
    const stop = () => { child.kill("SIGTERM"); setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3000).unref?.(); };
    const abort = () => { stop(); finish("failed", "aborted"); };
    const timer = setTimeout(() => { stop(); finish("failed", "timed out"); }, TIMEOUT_MS);
    timer.unref?.();
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    const line = (raw: string) => {
      if (!raw.trim()) return;
      let event: any;
      try { event = JSON.parse(raw); } catch { return; }
      if (event.type === "tool_execution_start") { run.tools++; run.activity = cleanText(String(event.toolName ?? "tool"), 24); update(); }
      else if (event.type === "message_end" && event.message?.role === "assistant") {
        run.turns++;
        run.cost += Number(event.message.usage?.cost?.total) || 0;
        const text = textOf(event.message).trim();
        if (text) run.output = text.slice(0, MAX_OUTPUT_CHARS);
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

export function registerDelegate(pi: ExtensionAPI, roles: ModelRoleManager, spawnProcess?: Spawn): void {
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
          state: "queued", tools: 0, turns: 0, cost: 0, output: "" };
      });
      const thinking = (role: string) => (roles.resolve(role) ?? roles.resolve("default"))?.thinking;
      // Live teammates: the welcome TEAM row and the footer read this public status contract.
      const publish = () => {
        if (!ctx.hasUI) return;
        for (const run of runs) {
          try {
            ctx.ui.setStatus(`${ROLE_PREFIX}delegate-${id}-${run.index}`, run.state === "done" || run.state === "failed" ? undefined : JSON.stringify({
              name: run.name, label: run.name.slice(0, 12), state: run.state === "queued" ? "waiting" : "working", task: cleanText(run.task, 60), expiresAt: Date.now() + 25_000
            }));
          } catch { /* status is decoration */ }
        }
      };
      const details = () => ({ runs: runs.map((run) => ({ ...run })), write });
      const update = () => {
        publish();
        onUpdate?.({ content: [{ type: "text", text: runs.map((run) => `${run.name}: ${run.state}`).join("\n") }], details: details() });
      };
      const refresh = setInterval(publish, STATUS_REFRESH_MS);
      refresh.unref?.();
      try {
        update();
        await Promise.all(runs.map((run) => runDelegate(run, delegateArgs(run.task, run.model, thinking(run.role), write), ctx.cwd, signal, update, spawnProcess)));
      } finally {
        clearInterval(refresh);
        for (const run of runs) if (run.state !== "done") run.state = "failed";
        publish();
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
      const runs = (result.details as { runs?: DelegateRun[] } | undefined)?.runs ?? [];
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
