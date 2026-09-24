import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVisualSettings } from "../src/settings.ts";
import piJar from "../extensions/index.ts";

const theme = { fg: (_color: string, value: string) => value };
const initialAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-jar-lifecycle-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
after(() => {
  if (initialAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = initialAgentDir;
  rmSync(testAgentDir, { recursive: true, force: true });
});

test("quota starts enabled without contacting unsupported providers and can be disabled", async () => {
  const events = new Map<string, Function>();
  let footer: { render(width: number): string[] } | undefined;
  let authCalls = 0;
  let command: Function | undefined;
  const ctx = {
    hasUI: true, mode: "tui", cwd: "/tmp/pi-jar", isIdle: () => true,
    model: { provider: "openai-codex", id: "test-model" },
    modelRegistry: { async getProviderAuth() { authCalls++; return undefined; } },
    getContextUsage: () => ({ percent: 25 }),
    sessionManager: { getBranch: () => [] },
    ui: { setWorkingIndicator() {}, setWidget() {}, notify() {},
      setFooter(factory?: Function) { footer = factory?.({ requestRender() {} }, theme, {
        getExtensionStatuses: () => new Map(), getGitBranch: () => null, onBranchChange: () => () => {}
      }); }
    }
  };
  piJar({ on(name: string, fn: Function) { events.set(name, fn); }, getCommands: () => [],
    registerCommand(_name: string, options: { handler: Function }) { command = options.handler; }
  } as never);
  events.get("session_start")?.({}, ctx);
  footer?.render(80);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authCalls, 1);
  await command?.("quota off", ctx);
  footer?.render(80);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authCalls, 1);
  ctx.model.provider = "unsupported";
  await command?.("quota on", ctx);
  footer?.render(80);
  assert.equal(authCalls, 1);
  events.get("session_shutdown")?.({}, ctx);
});

test("idle has no timer; demo motion stops on toggle, reset and session shutdown", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals = new Set<ReturnType<typeof setInterval>>();
  globalThis.setInterval = ((callback: () => void) => {
    const handle = { callback } as unknown as ReturnType<typeof setInterval>;
    intervals.add(handle);
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => { intervals.delete(handle); }) as typeof clearInterval;
  try {
    const events = new Map<string, Function>();
    const commands = new Map<string, (command: string, ctx: unknown) => Promise<void>>();
    let footer: { render(width: number): string[]; dispose(): void } | undefined;
    let indicator: { frames: string[] } | undefined;
    let subscribed = 0;
    let defaultFooter = false;
    const statuses = new Map<string, string>();
    const data = {
      getExtensionStatuses: () => statuses,
      getGitBranch: () => null,
      onBranchChange: (_listener: () => void) => {
        subscribed++;
        return () => { subscribed--; };
      }
    };
    let sessionName = "Initial session";
    let effort: "medium" | "high" = "medium";
    let renders = 0;
    const ctx = {
      hasUI: true,
      mode: "tui",
      isIdle: () => true,
      model: { id: "model" },
      sessionManager: { getSessionName: () => sessionName },
      getContextUsage: () => ({ percent: 50 }),
      ui: {
        setWorkingIndicator: (value: { frames: string[] }) => { indicator = value; },
        setFooter: (factory: ((tui: unknown, theme: unknown, data: unknown) => typeof footer) | undefined) => {
          footer?.dispose();
          footer = factory?.({ requestRender() { renders++; } }, theme, data);
          defaultFooter = factory === undefined;
        },
        notify() {}
      }
    };
    piJar({
      on: (name: string, handler: Function) => { events.set(name, handler); },
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands.set(name, command.handler); },
      getThinkingLevel: () => effort
    } as unknown as Parameters<typeof piJar>[0]);
    events.get("session_start")?.({}, ctx);
    assert.match(footer?.render(80).join(" ") ?? "", /Initial session/);
    effort = "high";
    const beforeEffort = renders;
    events.get("thinking_level_select")?.({ level: "high", previousLevel: "medium" }, ctx);
    assert.equal(renders, beforeEffort + 1);
    assert.match(footer?.render(80).join(" ") ?? "", /model · high/);
    sessionName = "Renamed session";
    assert.match(footer?.render(80).join(" ") ?? "", /Renamed session/);
    assert.equal(intervals.size, 0);
    assert.equal(subscribed, 1);
    const command = commands.get("jar")!;
    await command("demo", ctx);
    assert.match(footer?.render(80).join(" ") ?? "", /DEMO/);
    assert.equal(intervals.size, 1);
    await command("animations off", ctx);
    assert.equal(intervals.size, 0);
    assert.deepEqual(indicator?.frames, ["✢"]);
    footer?.render(80);
    assert.equal(intervals.size, 0);
    await command("ui off", ctx);
    assert.equal(defaultFooter, true);
    assert.equal(subscribed, 0);
    await command("ui on", ctx);
    await command("demo", ctx);
    footer?.render(80);
    assert.equal(intervals.size, 0); // still animation-off
    await command("animations on", ctx);
    footer?.render(80);
    assert.equal(intervals.size, 1);
    events.get("session_shutdown")?.({}, ctx);
    assert.equal(intervals.size, 0);
    assert.equal(subscribed, 0);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("footer menu toggles and persists fields, refreshes the render, and exits on Done", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jar-menu-"));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const events = new Map<string, Function>();
    let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    let footer: { render(width: number): string[] } | undefined;
    let renders = 0;
    const choices = ["[x] Working directory", "[ ] Working directory", "[x] Working directory", "[x] Session name", "Done"];
    const ctx = {
      hasUI: true, mode: "tui", cwd: "/a/project", isIdle: () => true,
      model: { id: "model" }, sessionManager: { getSessionName: () => "Named session" },
      getContextUsage: () => ({ percent: 20 }),
      ui: {
        setWorkingIndicator() {}, notify() {},
        setFooter: (factory: Function) => { footer = factory({ requestRender() { renders++; } }, theme, {
          getExtensionStatuses: () => new Map(), getGitBranch: () => null, onBranchChange: () => () => {}
        }); },
        select: async (_title: string, options: string[]) => {
          assert.ok(options.includes("Done"));
          return choices.shift();
        }
      }
    };
    piJar({
      on: (name: string, handler: Function) => events.set(name, handler),
      registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; }
    } as never);
    events.get("session_start")?.({}, ctx);
    assert.match(footer?.render(80).join(" ") ?? "", /Named session/);
    assert.match(footer?.render(80).join(" ") ?? "", /project/);
    await command?.("footer", ctx);
    assert.equal(loadVisualSettings(dir).footer.cwd, false);
    assert.equal(loadVisualSettings(dir).footer.sessionName, false);
    assert.doesNotMatch(footer?.render(80).join(" ") ?? "", /Named session|project/);
    assert.ok(renders >= 4);
    const beforeRename = renders;
    events.get("session_info_changed")?.({}, ctx);
    assert.equal(renders, beforeRename + 1);
    await command?.("footer", { ...ctx, ui: { ...ctx.ui, select: async () => undefined } });
    await command?.("footer", { ...ctx, mode: "rpc", ui: { notify() {}, select: () => { throw Error("not TUI"); } } });
    events.get("session_shutdown")?.({}, ctx);
  } finally {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("standalone flame above large π freezes on motion-off and replays safely", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals = new Set<{ callback: () => void }>();
  globalThis.setInterval = ((callback: () => void) => {
    const handle = { callback };
    intervals.add(handle);
    return handle as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
    intervals.delete(handle as unknown as { callback: () => void });
  }) as typeof clearInterval;
  try {
    const events = new Map<string, Function>();
    const commands = new Map<string, Function>();
    const widgets = new Map<string, { render(width: number): string[] }>();
    const welcome = () => widgets.get("pi-jar.welcome");
    const ctx = {
      hasUI: true, mode: "tui", cwd: "/tmp/pi-jar", isIdle: () => true,
      model: { provider: "test", id: "test-model" },
      sessionManager: { getBranch: () => [] },
      getContextUsage: () => ({ percent: 28 }),
      ui: {
        setWorkingIndicator() {}, setFooter() {}, notify() {},
        setWidget(key: string, factory: Function | undefined) {
          if (factory) widgets.set(key, factory({ requestRender() {} }, theme));
          else widgets.delete(key);
        }
      }
    };
    piJar({
      on: (name: string, handler: Function) => { events.set(name, handler); },
      getCommands: () => [],
      registerCommand: (name: string, command: { handler: Function }) => { commands.set(name, command.handler); }
    } as unknown as Parameters<typeof piJar>[0]);
    events.get("session_start")?.({}, ctx);
    assert.equal(intervals.size, 1);
    const still = welcome()?.render(80);
    intervals.values().next().value?.callback();
    assert.notDeepEqual(welcome()?.render(80)?.slice(0, 6), still?.slice(0, 6));
    await commands.get("jar")?.("animations off", ctx);
    assert.equal(intervals.size, 0);
    const frozen = welcome()?.render(80);
    assert.deepEqual(welcome()?.render(80), frozen);
    await commands.get("jar")?.("welcome", ctx);
    assert.equal(intervals.size, 0);
    const replay = welcome()?.render(80);
    assert.deepEqual(welcome()?.render(80), replay);
    events.get("input")?.({ source: "extension", text: "automated" }, ctx);
    assert.ok(welcome()); // Only a user's interactive prompt dismisses the welcome.
    events.get("input")?.({ source: "interactive", text: "hello" }, ctx);
    assert.equal(welcome(), undefined); // Motion-off hides immediately.
    await commands.get("jar")?.("animations on", ctx);
    await commands.get("jar")?.("welcome", ctx);
    assert.equal(intervals.size, 1);
    events.get("input")?.({ source: "interactive", text: "hello again" }, ctx);
    assert.ok(welcome());
    assert.ok((welcome()?.render(80).length ?? 0) < (still?.length ?? 0));
    for (let step = 0; step < 4; step++) intervals.values().next().value?.callback();
    assert.equal(welcome(), undefined);
    assert.equal(intervals.size, 0);
    events.get("session_shutdown")?.({}, ctx);
    assert.equal(welcome(), undefined);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("Pi lifecycle keeps activity wording steady while icons animate without idle repaint", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals = new Set<{ callback: () => void }>();
  globalThis.setInterval = ((callback: () => void) => {
    const handle = { callback };
    intervals.add(handle);
    return handle as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
    intervals.delete(handle as unknown as { callback: () => void });
  }) as typeof clearInterval;
  try {
    const events = new Map<string, Function>();
    let command: Function | undefined;
    let message: string | undefined;
    let frames: string[] = [];
    let frameResets = 0;
    const ctx = {
      hasUI: true, mode: "tui", isIdle: () => true,
      model: { provider: "test", id: "test" },
      sessionManager: { getBranch: () => [] },
      getContextUsage: () => ({ percent: 0 }),
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setWorkingMessage(value?: string) { message = value; },
        setWorkingIndicator(value?: { frames: string[] }) { frames = value?.frames ?? []; frameResets++; },
        setWidget() {}, setFooter() {}, notify() {}
      }
    };
    piJar({
      on: (name: string, callback: Function) => { events.set(name, callback); },
      getCommands: () => [],
      registerCommand: (_name: string, options: { handler: Function }) => { command = options.handler; }
    } as unknown as Parameters<typeof piJar>[0]);
    events.get("session_start")?.({}, ctx);
    await command?.("animations off", ctx);
    await command?.("animations on", ctx);
    assert.equal(intervals.size, 0);
    events.get("agent_start")?.({}, ctx);
    assert.match(message ?? "", /A spark remains… \(0s\)/);
    assert.ok(frames.length > 1);
    assert.equal(intervals.size, 1); // one elapsed-time clock, no idle repaint
    const resetsBeforeTick = frameResets;
    intervals.values().next().value?.callback();
    assert.equal(frameResets, resetsBeforeTick, "clock does not restart spinner frames");
    events.get("message_end")?.({ message: { role: "assistant", usage: { output: 1700 } } }, ctx);
    assert.match(message ?? "", /↓ 1\.7k tokens/);
    events.get("tool_execution_start")?.({ toolCallId: "a", toolName: "read" }, ctx);
    assert.match(message ?? "", /read/);
    await command?.("animations off", ctx);
    assert.equal(frames.length, 1);
    assert.equal(intervals.size, 1); // duration updates even with animation disabled
    events.get("turn_end")?.({}, ctx);
    assert.match(message ?? "", /↓ 1\.7k tokens/); // keep totals across tool turns
    events.get("agent_end")?.({}, ctx);
    assert.equal(message, undefined);
    assert.equal(intervals.size, 0);
    events.get("session_shutdown")?.({}, ctx);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("status provider failure renders a safe fallback", () => {
  let startup: Function | undefined;
  let component: { render(width: number): string[] } | undefined;
  piJar({
    on: (name: string, handler: Function) => { if (name === "session_start") startup = handler; },
    registerCommand() {}
  } as unknown as Parameters<typeof piJar>[0]);
  startup?.({}, {
    mode: "tui", hasUI: true,
    ui: {
      setWorkingIndicator() {},
      setFooter(factory: Function) {
        component = factory({ requestRender() {} }, theme, {
          onBranchChange: () => () => {},
          getExtensionStatuses: () => { throw new Error("publisher error"); }
        });
      },
      notify() {}
    }
  });
  assert.deepEqual(component?.render(80), ["pi-jar: UI unavailable (run /jar ui off)"]);
});

test("noninteractive contexts do not install a footer", () => {
  let installs = 0;
  let startup: Function | undefined;
  piJar({
    on: (name: string, handler: Function) => { if (name === "session_start") startup = handler; },
    registerCommand() {}
  } as unknown as Parameters<typeof piJar>[0]);
  startup?.({}, {
    mode: "rpc", hasUI: true,
    ui: { setFooter() { installs++; }, setWorkingIndicator() { installs++; } }
  });
  assert.equal(installs, 0);
});
