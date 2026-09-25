import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ago, recentSessions, sessionWorkflow } from "../src/session-gallery.ts";
import { welcomeHit, welcomeLines } from "../src/welcome.ts";

const plain = (_color: string, text: string) => text;
const line = (value: object) => JSON.stringify(value);

test("session workflow replays the latest pi-jar goal and plan title", () => {
  const jsonl = [
    line({ type: "message", message: { role: "user", content: "hi" } }),
    line({ type: "custom", customType: "pi-jar.goal", data: { v: 2, op: "set", id: "g1", text: "Ship login" } }),
    line({ type: "custom", customType: "pi-jar.plan", data: { v: 2, enabled: false, title: "Login plan", steps: [] } }),
    line({ type: "custom", customType: "pi-jar.goal", data: { v: 2, op: "status", id: "g1", status: "complete", evidence: "tests pass" } }),
    "not json"
  ].join("\n");
  assert.deepEqual(sessionWorkflow(jsonl), { goal: "Ship login ✔", plan: "Login plan" });
  assert.deepEqual(sessionWorkflow(""), {});
  assert.equal(ago(new Date(0), 90 * 60_000), "2h");
  assert.equal(ago(new Date(0), 30_000), "now");
});

test("recent sessions skip the current and empty ones, newest first", async () => {
  const session = (path: string, minutes: number, messages = 3, name?: string) => ({ path, id: path, cwd: "/p", created: new Date(0), modified: new Date(minutes * 60_000),
    messageCount: messages, firstMessage: "first " + path, allMessagesText: "", ...(name ? { name } : {}) });
  const files: Record<string, string> = { b: line({ type: "custom", customType: "pi-jar.plan", data: { title: "B plan" } }) };
  const recent = await recentSessions([session("a", 1), session("b", 5, 3, "Named"), session("c", 9), session("d", 7, 0), session("e", 3)], "c", 3,
    async (path) => { if (!(path in files)) throw new Error("gone"); return files[path]!; }, async () => 10);
  assert.deepEqual(recent.map((item) => [item.path, item.title, item.plan]), [["b", "Named", "B plan"], ["e", "first e", undefined], ["a", "first a", undefined]]);
});

test("welcome lists recent sessions and a click on a row resumes it", () => {
  const recent = [{ title: "Fix login", age: "2h", goal: "Ship login ✔" }, { title: "Docs pass", age: "1d", plan: "Docs" }];
  for (const width of [80, 120]) {
    const lines = welcomeLines(width, 0, plain, { project: "jar", recent });
    assert.ok(lines.every((row) => visibleWidth(row) <= width));
    const text = lines.map(stripTerminalSequences);
    const first = text.findIndex((row) => row.includes("↺ 1 Fix login"));
    assert.ok(first > 0, `${width}: first recent row`);
    assert.match(text[first]!, width >= 120 ? /RECENT\s+↺ 1 Fix login · 2h · goal: Ship login ✔/ : /RECENT\s+↺ 1 Fix login · 2h/);
    assert.match(text[first + 1]!, /↺ 2 Docs pass · 1d · plan: Docs/);
    const x = text[first]!.indexOf("Fix");
    assert.equal(welcomeHit(lines, x, first), "resume:1");
    assert.equal(welcomeHit(lines, text[first + 1]!.indexOf("Docs"), first + 1), "resume:2");
  }
  const regular = welcomeLines(100, 0, plain, { recent, settingsClickable: false }).map(stripTerminalSequences).join("\n");
  assert.match(regular, /\/jar resume N to continue/);
});
