import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piJar from "../extensions/index.ts";
import { defaultVisualSettings, saveVisualSettings, type JarVisualSettings } from "../src/settings.ts";
import { anthropic, BASE, deepFreeze, reply, SYSTEM, tool, usage, user } from "./cache-payloads.ts";

type Handler = (event: object, ctx: unknown) => unknown;
const T0 = Date.UTC(2026, 9, 8, 10, 0, 0);

interface Harness {
  directory: string;
  notices: string[];
  commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
  /** One provider call: the payload is sent, then the assistant message ends with this usage. */
  call(payload: unknown, use: object, at: number): Promise<unknown>;
  logFile: string;
}

/** The whole extension on a fake Pi, in a throwaway agent directory. */
async function extension(run: (h: Harness) => Promise<void>, options: { settings?: Partial<JarVisualSettings>; child?: boolean } = {}): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "pi-jar-cache-wiring-"));
  const priorDirectory = process.env.PI_CODING_AGENT_DIR;
  const priorChild = process.env.PI_JAR_CHILD;
  process.env.PI_CODING_AGENT_DIR = directory;
  if (options.child) process.env.PI_JAR_CHILD = "1"; else delete process.env.PI_JAR_CHILD;
  saveVisualSettings(directory, { ...defaultVisualSettings(), animations: false, ...options.settings });
  const events = new Map<string, Handler[]>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const notices: string[] = [];
  const widgets = new Map<string, unknown>();
  const makeTheme = (name: string) => ({ name, fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text, borderColor: (text: string) => text });
  const ctx = {
    hasUI: true, mode: "tui", cwd: directory, isIdle: () => true,
    model: { provider: "anthropic", id: "claude-sonnet", cost: { cacheRead: 0.3 } }, modelRegistry: { find: () => undefined },
    getContextUsage: () => ({ percent: 0 }),
    sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => "wiring-test", getSessionName: () => undefined, getSessionFile: () => undefined },
    ui: {
      theme: makeTheme("dark"), notify: (text: string) => { notices.push(text); },
      getAllThemes: () => [{ name: "dark" }], getTheme: (name: string) => makeTheme(name), setTheme: () => ({ success: true }),
      getEditorComponent: () => undefined, setEditorComponent() {}, getEditorText: () => "", setEditorText() {},
      setWidget: (key: string, value?: unknown) => { if (value) widgets.set(key, value); else widgets.delete(key); },
      setFooter() {}, setHeader() {}, setStatus() {}, setWorkingIndicator() {}, setWorkingMessage() {}
    }
  };
  const emit = async (name: string, event: object = {}) => {
    let returned: unknown;
    for (const handler of events.get(name) ?? []) returned = (await handler(event, ctx)) ?? returned;
    return returned;
  };
  piJar({
    on: (name: string, handler: Handler) => { events.set(name, [...(events.get(name) ?? []), handler]); },
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands.set(name, command.handler); },
    registerShortcut() {}, registerTool() {}, getCommands: () => [], appendEntry() {}, getThinkingLevel: () => "off", setThinkingLevel() {}
  } as never);
  const call = async (payload: unknown, use: object, at: number) => {
    const sent = await emit("before_provider_request", { payload: deepFreeze(payload) });
    await emit("message_end", { message: { role: "assistant", provider: "anthropic", model: "claude-sonnet", timestamp: at, usage: use, content: [] } });
    return sent;
  };
  try {
    await emit("session_start", { reason: "startup" });
    await run({ directory, notices, commands, call, logFile: join(directory, "pi-jar-cache-breaks", "wiring-test.jsonl") });
  } finally {
    await emit("session_shutdown");
    if (priorDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorDirectory;
    if (priorChild === undefined) delete process.env.PI_JAR_CHILD; else process.env.PI_JAR_CHILD = priorChild;
    rmSync(directory, { recursive: true, force: true });
  }
}

const breakNotices = (h: Harness) => h.notices.filter((text) => text.startsWith("cache break:"));

/** Three calls whose second changes the tool list and re-reads nothing from the cache. */
async function toolsBreak(h: Harness): Promise<unknown[]> {
  const sent = [
    await h.call(anthropic({ messages: BASE }), usage(500, 0, 100_000), T0),
    await h.call(anthropic({ messages: [...BASE, user("next")] }), usage(300, 100_500, 400), T0 + 20_000),
    await h.call(anthropic({ tools: [tool("read"), tool("bash"), tool("jendral_build_get")], messages: [...BASE, user("next"), reply("ok"), user("more")] }), usage(400, 8_000, 105_000), T0 + 40_000)
  ];
  return sent;
}

test("by default a costly cache break is announced, logged for the session and listed by /cache-breaks, without touching any payload", () => extension(async (h) => {
  const sent = await toolsBreak(h);
  assert.deepEqual(sent, [undefined, undefined, undefined], "no handler replaces a payload");
  assert.equal(breakNotices(h).length, 1);
  assert.match(breakNotices(h)[0]!, /^cache break: tools changed \(\+jendral_build_get\) — rewrote 93k tokens \(~\$0\.32\)$/);
  const logged = readFileSync(h.logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(logged.length, 1);
  assert.deepEqual([logged[0].kind, logged[0].request, logged[0].first, logged[0].rewrittenTokens], ["tools", 3, "tool jendral_build_get", 93_200]);

  const before = h.notices.length;
  await h.commands.get("cache-breaks")!("", { hasUI: false, mode: "print", ui: { notify: (text: string) => h.notices.push(text) }, sessionManager: { getSessionId: () => "wiring-test" } });
  const panel = h.notices[before]!;
  assert.match(panel, /Costly cache breaks\s+1/);
  assert.match(panel, /tools changed \(\+jendral_build_get\)/);
  assert.match(panel, /first change: tool jendral_build_get \(segment 3\)/);
}));

test("the cache diagnostics setting turns the whole diagnostic off", () => extension(async (h) => {
  await toolsBreak(h);
  assert.equal(breakNotices(h).length, 0);
  assert.equal(existsSync(h.logFile), false);
  const before = h.notices.length;
  await h.commands.get("cache-breaks")!("", { hasUI: false, mode: "print", ui: { notify: (text: string) => h.notices.push(text) }, sessionManager: { getSessionId: () => "wiring-test" } });
  assert.match(h.notices[before]!, /Cache diagnostics are off\. Turn them on in \/jar settings → Pi\./);
}, { settings: { cacheDiagnostics: false } }));

test("subagent processes never run the diagnostic", () => extension(async (h) => {
  await toolsBreak(h);
  assert.equal(breakNotices(h).length, 0);
  assert.equal(existsSync(h.logFile), false);
}, { child: true }));

test("a system-prompt edit mid-session is named in the notice", () => extension(async (h) => {
  await h.call(anthropic({ messages: BASE }), usage(500, 0, 100_000), T0);
  await h.call(anthropic({ system: SYSTEM("deploy: ship it\n- lint: run it"), messages: [...BASE, user("next")] }), usage(300, 6_000, 95_000), T0 + 15_000);
  assert.equal(breakNotices(h).length, 1);
  assert.match(breakNotices(h)[0]!, /^cache break: system prompt changed \(~<skills>\) — rewrote 95k tokens \(~\$0\.33\)$/);
}));
