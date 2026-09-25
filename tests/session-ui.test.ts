import assert from "node:assert/strict";
import test from "node:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { filterSessions, pickSession } from "../src/session-ui.ts";

const sessions = [
  { path: "/tmp/a.jsonl", id: "abc", name: "Fix plan mode", firstMessage: "Review queueing", modified: new Date("2026-01-02") },
  { path: "/tmp/b.jsonl", id: "def", name: "Mascot animation", firstMessage: "Make the flame cute", modified: new Date("2026-01-01") }
] as SessionInfo[];
const theme = { fg: (_color: string, text: string) => text };
const click = (y: number) => ({ type: "click", button: "left", x: 4, y });

test("session search matches titles and prompts case insensitively without matching JSONL paths", () => {
  assert.deepEqual(filterSessions(sessions, "FLAME").map((s) => s.path), ["/tmp/b.jsonl"]);
  assert.deepEqual(filterSessions(sessions, "fix queue").map((s) => s.path), ["/tmp/a.jsonl"]);
  assert.deepEqual(filterSessions(sessions, "/tmp/a"), []);
});

test("session picker filters as typed, supports keyboard and mouse, and stays width bounded", async () => {
  let component: any;
  const ctx = { mode: "tui", hasUI: true, ui: { custom(factory: Function) {
    return new Promise((resolve) => { component = factory({ requestRender() {} }, theme, {}, resolve); });
  } } };
  const chosen = pickSession(ctx as never, sessions);
  assert.ok(component.render(24).every((line: string) => visibleWidth(line) <= 24));
  component.handleInput("f");
  assert.match(component.render(80).join(" "), /Fix plan mode/);
  component.handleInput("\x7f");
  component.render(80);
  component.handleMouse(click(4)); // second result begins after the first title + prompt
  assert.equal(await chosen, "/tmp/b.jsonl");

  const cancelled = pickSession(ctx as never, sessions, "no match");
  assert.match(component.render(80).join(" "), /No matching sessions/);
  component.handleInput("\x1b");
  assert.equal(await cancelled, undefined);
});
