import assert from "node:assert/strict";
import test from "node:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { filterSessions, pickSession, type SessionDetails } from "../src/session-ui.ts";

const sessions = [
  { path: "/tmp/a.jsonl", id: "abc12345-6789", cwd: "/work/jar", name: "Fix plan mode", firstMessage: "Review queueing", messageCount: 12, modified: new Date("2026-01-02T10:30:00") },
  { path: "/tmp/b.jsonl", id: "def", cwd: "", name: "Mascot animation", firstMessage: "Make the flame cute", messageCount: 1, modified: new Date("2026-01-01") }
] as SessionInfo[];
const theme = { fg: (_color: string, text: string) => text };
const click = (y: number, x = 4) => ({ type: "click", button: "left", x, y });

interface Picker { render(width: number): string[]; handleInput(data: string): void; handleMouse(event: object): unknown }

function harness() {
  const state = { component: undefined as unknown as Picker, renders: 0 };
  const ctx = { mode: "tui", hasUI: true, ui: { custom(factory: (tui: object, theme: object, keys: object, done: (value: unknown) => void) => Picker) {
    return new Promise((resolve) => { state.component = factory({ requestRender() { state.renders++; } }, theme, {}, resolve); });
  } } };
  return { ctx: ctx as never, state };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("session search matches titles and prompts case insensitively without matching JSONL paths", () => {
  assert.deepEqual(filterSessions(sessions, "FLAME").map((s) => s.path), ["/tmp/b.jsonl"]);
  assert.deepEqual(filterSessions(sessions, "fix queue").map((s) => s.path), ["/tmp/a.jsonl"]);
  assert.deepEqual(filterSessions(sessions, "/tmp/a"), []);
});

test("session picker filters as typed, stays width bounded, and click selects before a second click resumes", async () => {
  const { ctx, state } = harness();
  const chosen = pickSession(ctx, sessions);
  for (const width of [24, 80]) assert.ok(state.component.render(width).every((line: string) => visibleWidth(line) <= width), `width ${width}`);
  state.component.handleInput("f");
  state.component.handleInput("i");
  const filtered = state.component.render(80).join("\n");
  assert.match(filtered, /Search: fi/);
  assert.match(filtered, /Fix plan mode/);
  assert.doesNotMatch(filtered, /Mascot animation/);
  state.component.handleInput("\x7f");
  state.component.handleInput("\x7f");
  state.component.render(80);
  assert.deepEqual(state.component.handleMouse(click(2)), { handled: true }); // second list row: selects only
  assert.match(state.component.render(80).join("\n"), /Make the flame cute/);
  state.component.handleMouse(click(2));
  assert.equal(await chosen, "/tmp/b.jsonl");

  const cancelled = pickSession(ctx, sessions, "no match");
  assert.match(state.component.render(80).join(" "), /No matching sessions/);
  state.component.handleInput("\x1b");
  assert.equal(await cancelled, undefined);
});

test("session picker details pane shows the selected session and lazily loads goal and plan once per path", async () => {
  const { ctx, state } = harness();
  const calls: string[] = [];
  let resolveLate: (value: SessionDetails) => void = () => {};
  const late = new Promise<SessionDetails>((resolve) => { resolveLate = resolve; });
  const chosen = pickSession(ctx, sessions, "", async (session) => {
    calls.push(session.path);
    if (session.path === "/tmp/b.jsonl") return late;
    return { goal: "Ship split view", plan: "List left, details right" };
  });
  const loading = state.component.render(100).join("\n");
  assert.match(loading, /Review queueing/);
  assert.match(loading, /12 messages/);
  assert.match(loading, /abc12345/);
  assert.match(loading, /\/work\/jar/);
  assert.match(loading, /2026-01-02 10:30/);
  assert.match(loading, /Loading details/);

  const before = state.renders;
  await tick();
  assert.deepEqual(calls, ["/tmp/a.jsonl"]); // only the selected row is loaded
  assert.ok(state.renders > before, "resolved details request a repaint");
  const loaded = state.component.render(100);
  assert.ok(loaded.every((line: string) => visibleWidth(line) <= 100));
  assert.match(loaded.join("\n"), /Ship split view/);
  assert.match(loaded.join("\n"), /List left, details right/);

  state.component.handleInput("\x1b[B"); // down: loads b
  state.component.render(100);
  state.component.handleInput("\x1b[A"); // up: a is cached
  assert.match(state.component.render(100).join("\n"), /Ship split view/);
  await tick();
  assert.deepEqual(calls, ["/tmp/a.jsonl", "/tmp/b.jsonl"]);

  state.component.handleInput("\r");
  assert.equal(await chosen, "/tmp/a.jsonl");
  const closedAt = state.renders;
  resolveLate({ goal: "too late" });
  await tick();
  assert.equal(state.renders, closedAt, "results after close are ignored");
});

test("session picker collapses to the list when narrow and closes from the × button", async () => {
  const { ctx, state } = harness();
  let loads = 0;
  const chosen = pickSession(ctx, sessions, "", async () => { loads++; return {}; });
  const narrow = state.component.render(40);
  assert.ok(narrow.every((line: string) => visibleWidth(line) <= 40));
  assert.match(narrow.join("\n"), /Mascot animation/);
  assert.doesNotMatch(narrow.join("\n"), /Review queueing/); // details hidden
  assert.equal(loads, 0);
  state.component.handleMouse({ type: "wheel", wheelDelta: 1, x: 30, y: 5 });
  assert.match(state.component.render(40)[2]!, /▌ Mascot animation/);
  state.component.handleMouse(click(0, 38));
  assert.equal(await chosen, undefined);
});
