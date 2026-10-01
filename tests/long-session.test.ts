import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piJar from "../extensions/index.ts";
import { DelegateRegistry } from "../src/delegate.ts";
import { ShellManager } from "../src/shells.ts";

const theme = { fg: (_color: string, text: string) => text };
const initialAgentDir = process.env.PI_CODING_AGENT_DIR;
const testDir = mkdtempSync(join(tmpdir(), "pi-jar-long-session-"));
process.env.PI_CODING_AGENT_DIR = testDir;
after(() => {
  if (initialAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = initialAgentDir;
  rmSync(testDir, { recursive: true, force: true });
});

/** Every timer the extension creates while the harness runs, so shutdown can be checked for leftovers. */
function trackTimers() {
  const live = new Set<unknown>();
  const mocked = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = mocked.setTimeout(() => { live.delete(handle); callback(...args); }, ms);
    live.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: NodeJS.Timeout) => { live.delete(handle); mocked.clearTimeout(handle); }) as typeof clearTimeout;
  globalThis.setInterval = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = mocked.setInterval(callback, ms, ...args);
    live.add(handle);
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle?: NodeJS.Timeout) => { live.delete(handle); mocked.clearInterval(handle); }) as typeof clearInterval;
  return { live, restore: () => { Object.assign(globalThis, mocked); } };
}

interface Workload { entries: number; turns: number; toolsPerTurn: number; turnMs: number; notifiesPerTool: number }
interface Measured {
  renders: number; contextCalls: number; branchWalks: number; messageEnds: number; quotaLookups: number;
  perf: string; timersAfterShutdown: number;
}

/**
 * One synthetic session through the extension entry: a resumed branch of `entries` messages, then
 * tool-heavy turns where every tool call also streams subagent registry and shell notifications.
 * No model, process or network: Pi's frames are simulated by painting the footer after each step.
 */
async function runSession(t: TestContext, live: Set<unknown>, workload: Workload): Promise<Measured> {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  let registry: DelegateRegistry | undefined;
  let shells: ShellManager | undefined;
  // The harness drives the extension's own registry and shell manager through their public notify paths.
  const subscribe = DelegateRegistry.prototype.subscribe;
  const summaries = ShellManager.prototype.summaries;
  DelegateRegistry.prototype.subscribe = function (this: DelegateRegistry, listener: () => void) { registry ??= this; return subscribe.call(this, listener); };
  ShellManager.prototype.summaries = function (this: ShellManager) { shells = this; return summaries.call(this); };
  try {
    piJar({
      on: (name: string, handler: Function) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands.set(name, options.handler); },
      registerTool() {}, registerShortcut() {}, getCommands: () => [], getAllTools: () => [], getActiveTools: () => [],
      setActiveTools() {}, appendEntry() {}, sendMessage() {}, getThinkingLevel: () => "off"
    } as unknown as Parameters<typeof piJar>[0]);
    DelegateRegistry.prototype.subscribe = subscribe;

    const branch = Array.from({ length: workload.entries }, (_, index) => index % 2
      ? { type: "message", id: `e${index}`, message: { role: "assistant", content: [], usage: { cost: { total: 0 } } } }
      : { type: "message", id: `e${index}`, message: { role: "user", content: "synthetic" } });
    let renders = 0;
    let contextCalls = 0;
    let branchWalks = 0;
    let messageEnds = 0;
    let quotaLookups = 0;
    let frameDue = false;
    const notes: string[] = [];
    let footer: { render(width: number): string[]; dispose?(): void } | undefined;
    const tui = { requestRender() { renders++; frameDue = true; } };
    const ctx = {
      hasUI: true, mode: "tui", cwd: testDir, isIdle: () => false,
      // A supported provider without OAuth: every lookup fails before any network request, then backs off.
      model: { provider: "anthropic", id: "synthetic" },
      modelRegistry: { async getProviderAuth() { quotaLookups++; return undefined; } },
      sessionManager: { getBranch: () => { branchWalks++; return branch; }, getSessionName: () => "Long session" },
      getContextUsage: () => { contextCalls++; return { tokens: 42_000, contextWindow: 100_000, percent: 42 }; },
      ui: {
        theme, notify: (message: string) => { notes.push(message); }, setWidget() {}, setStatus() {}, setWorkingIndicator() {}, setWorkingMessage() {},
        setFooter(factory?: (tui: unknown, theme: unknown, data: unknown) => typeof footer) {
          footer?.dispose?.();
          footer = factory?.(tui, theme, { getExtensionStatuses: () => new Map(), getGitBranch: () => "main", onBranchChange: () => () => {} });
        }
      }
    };
    const emit = (name: string, event: object = {}) => {
      for (const handler of handlers.get(name) ?? []) void Promise.resolve(handler(event, ctx));
    };
    // Pi draws a requested frame on its next tick; the harness draws it after each synchronous step.
    const paint = () => { if (frameDue) { frameDue = false; footer?.render(120); } };
    const advance = (ms: number) => { paint(); t.mock.timers.tick(ms); paint(); };

    emit("session_start", { reason: "resume" });
    advance(2000); // past the startup grace: the deferred quota lookup has started
    const baseline = { renders, contextCalls, branchWalks };
    assert.ok(registry && shells, "the harness reached the extension's registry and shell manager");
    for (let turn = 0; turn < workload.turns; turn++) {
      emit("agent_start");
      emit("turn_start");
      emit("message_end", { message: { role: "user", content: "next step" } });
      messageEnds++;
      for (let call = 0; call < workload.toolsPerTurn; call++) {
        emit("message_end", { message: { role: "assistant", content: [], usage: { output: 20, cost: { total: 0.0001 } } } });
        emit("tool_execution_start", { toolCallId: `c${call}`, toolName: "read" });
        for (let notify = 0; notify < workload.notifiesPerTool; notify++) registry.notify();
        shells.onChange?.();
        emit("tool_execution_end", { toolCallId: `c${call}` });
        emit("message_end", { message: { role: "toolResult", content: [] } });
        messageEnds += 2;
        advance(workload.turnMs / workload.toolsPerTurn);
      }
      emit("turn_end");
      emit("agent_end");
      emit("agent_settled");
      advance(1000);
      // Let async work (the failed quota lookup) settle between turns, as Pi's event loop would.
      await new Promise((resolve) => setImmediate(resolve));
    }
    const measured = { renders: renders - baseline.renders, contextCalls: contextCalls - baseline.contextCalls,
      branchWalks: branchWalks - baseline.branchWalks, messageEnds, quotaLookups };
    await commands.get("jar")!("perf", ctx);
    const perf = notes.at(-1) ?? "";
    emit("session_shutdown");
    // Draining children and disposed shells may still notify after shutdown; nothing may schedule a repaint.
    registry.notify();
    shells.onChange?.();
    return { ...measured, perf, timersAfterShutdown: live.size };
  } finally {
    DelegateRegistry.prototype.subscribe = subscribe;
    ShellManager.prototype.summaries = summaries;
  }
}

test("long tool-heavy sessions: context sampling, repaints and quota stay bounded, and shutdown leaves no timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const timers = trackTimers();
  try {
    const turns = 5;
    const workload = { turns, toolsPerTurn: 20, turnMs: 2000, notifiesPerTool: 5 };
    const sparse = await runSession(t, timers.live, { entries: 100, ...workload });
    const dense = await runSession(t, timers.live, { entries: 100, ...workload, toolsPerTurn: 200 });
    const large = await runSession(t, timers.live, { entries: 1000, ...workload });
    const veryLarge = await runSession(t, timers.live, { entries: 5000, ...workload });

    // Context usage: bounded by time and boundaries, not by how many tool results a turn produced.
    assert.equal(dense.messageEnds, 10 * sparse.messageEnds - 9 * turns);
    assert.ok(sparse.contextCalls <= turns * (Math.ceil(workload.turnMs / 750) + 2), `sparse: ${sparse.contextCalls} calls`);
    assert.ok(dense.contextCalls <= sparse.contextCalls + turns, `dense: ${dense.contextCalls} vs sparse ${sparse.contextCalls}`);
    assert.ok(dense.contextCalls * 50 < dense.messageEnds, `${dense.contextCalls} calls for ${dense.messageEnds} message ends`);
    // The branch is walked on lifecycle boundaries only, never per message.
    assert.equal(dense.branchWalks, sparse.branchWalks);

    // Repaints: the same background workload asks Pi for fewer frames as the session grows.
    assert.ok(dense.renders <= sparse.renders + turns, `background frequency is bounded: ${dense.renders} vs ${sparse.renders}`);
    assert.ok(sparse.renders > large.renders, `small ${sparse.renders} > large ${large.renders}`);
    assert.ok(large.renders > veryLarge.renders, `large ${large.renders} > very large ${veryLarge.renders}`);
    assert.ok(veryLarge.renders <= 2 * turns, `very large sessions render transitions only: ${veryLarge.renders}`);
    assert.match(veryLarge.perf, /^render$/m);
    assert.match(veryLarge.perf, /tier\s+very large · transitions only/);
    assert.match(veryLarge.perf, /actual\s+\d+ \(background 0\)/);
    assert.match(sparse.perf, /^context sampling$/m);
    assert.match(sparse.perf, /branch entries\s+305/, "entries are counted per message without re-walking the branch");

    // Quota: thousands of frames and boundaries, one failed lookup, then backoff; never render-bound.
    for (const [name, run] of Object.entries({ sparse, dense, large, veryLarge })) {
      assert.equal(run.quotaLookups, 1, name);
      assert.match(run.perf, /requests\s+1 \(1 failed\)/, name);
      assert.equal(run.timersAfterShutdown, 0, `${name}: no repaint, sampling or quota timer outlives the session`);
    }
  } finally { timers.restore(); }
});

test("a session switch starts fresh render, sampling and quota counters", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const handlers = new Map<string, Function[]>();
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const notes: string[] = [];
  piJar({
    on: (name: string, handler: Function) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand: (name: string, options: { handler: typeof command }) => { if (name === "jar") command = options.handler; },
    getCommands: () => []
  } as unknown as Parameters<typeof piJar>[0]);
  const ctx = {
    hasUI: true, mode: "tui", cwd: testDir, isIdle: () => true, model: { provider: "test", id: "synthetic" },
    sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "resumed" } }] },
    getContextUsage: () => ({ percent: 7 }),
    ui: { theme, notify: (message: string) => { notes.push(message); }, setWidget() {}, setWorkingIndicator() {}, setWorkingMessage() {},
      setFooter(factory?: Function) { factory?.({ requestRender() {} }, theme, { getExtensionStatuses: () => new Map(), getGitBranch: () => null, onBranchChange: () => () => {} }); } }
  };
  const emit = (name: string, event: object = {}) => { for (const handler of handlers.get(name) ?? []) handler(event, ctx); };
  const perf = async () => { await command!("perf", ctx); return notes.at(-1) ?? ""; };
  emit("session_start");
  for (let index = 0; index < 3; index++) emit("message_end", { message: { role: "assistant", content: [], usage: { output: 1, cost: { total: 0 } } } });
  t.mock.timers.tick(1000);
  const first = await perf();
  assert.match(first, /branch entries\s+4/);
  assert.match(first, /dirty marks\s+3/);
  assert.match(first, /^\s+calls\s+2$/m, "the session-start sample plus one throttled sample for the burst");
  emit("session_shutdown");
  emit("session_start");
  const second = await perf();
  assert.match(second, /branch entries\s+1/);
  assert.match(second, /dirty marks\s+0/);
  assert.match(second, /^\s+calls\s+1$/m);
  assert.match(second, /requested\s+1 \(foreground 0 · transition 1 · background 0\)/, "only the new session's start repaint");
  emit("session_shutdown");
});
