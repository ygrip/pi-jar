import assert from "node:assert/strict";
import test from "node:test";
import { ActivityClock, activityDelay } from "../src/activity-clock.ts";
import { withinDeadline, INBOX_DEADLINE_MS } from "../src/discussion.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piJar from "../extensions/index.ts";
import { ProfileStore, PROFILE_ENTRY } from "../src/profiles.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const [label, now, tier, mascot, expected] of [
  ["advances the elapsed label on the next whole second", 10_400, 250, undefined, 600],
  ["moves the mascot sooner than the next second", 10_000, 250, 300, 300],
  ["never redraws faster than the small-session tier", 10_000, 250, 40, 250],
  ["medium sessions halve the cadence", 10_000, 500, 120, 500],
  ["very large sessions only tick the label every two seconds", 10_000, undefined, 120, 2000]
] as const) {
  test(`activity delay ${label}`, () => {
    assert.equal(activityDelay(now, 10_000, tier, mascot), expected);
  });
}

test("activity clock ticks while a silent turn runs, then stops without leaking a timer", async () => {
  let ticks = 0;
  let running = true;
  const clock = new ActivityClock({ tick: () => { ticks++; }, nextDelay: () => running ? 20 : undefined });
  clock.start();
  await sleep(110);
  assert.ok(ticks >= 3, `ticked ${ticks} times during silence`);
  running = false;
  clock.reschedule();
  const stopped = ticks;
  await sleep(60);
  assert.equal(ticks, stopped, "an undefined deadline pauses the clock");
  clock.stop();
  assert.equal(clock.active, false);
});

test("a failing tick is reported but does not stop liveness", async (t) => {
  const errors: unknown[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
  let ticks = 0;
  const clock = new ActivityClock({ tick: () => { ticks++; throw new Error("boom"); }, nextDelay: () => 15 });
  clock.start();
  await sleep(80);
  clock.stop();
  assert.ok(ticks >= 2);
  assert.ok(errors.length >= 2);
});

test("a slow discussion broker cannot hold the turn start, and late mail is not lost", async () => {
  let late: string | undefined;
  const started = Date.now();
  const value = await withinDeadline(sleep(400).then(() => "mail"), INBOX_DEADLINE_MS, (notice) => { late = notice; });
  assert.equal(value, undefined);
  assert.ok(Date.now() - started < 380, "the turn waited only the deadline");
  await sleep(250);
  assert.equal(late, "mail");
  assert.equal(await withinDeadline(Promise.resolve("fast"), INBOX_DEADLINE_MS, () => {}), "fast");
  assert.equal(await withinDeadline(Promise.reject(new Error("down")), INBOX_DEADLINE_MS, () => {}), undefined);
});

test("prompts and turn starts read the session for the profile pin once, not per prompt", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-jar-responsive-"));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  // A saved profile document enables profile pinning even without an interactive UI.
  new ProfileStore(directory, "dark", { version: 2, roles: {} });
  t.after(() => {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    rmSync(directory, { recursive: true, force: true });
  });
  const events = new Map<string, Function[]>();
  let walks = 0;
  const entries: unknown[] = Array.from({ length: 5000 }, () => ({ type: "message", message: { role: "assistant" } }));
  const ctx = {
    hasUI: false, mode: "print", isIdle: () => true, cwd: "/tmp", model: { provider: "p", id: "m" },
    getContextUsage: () => ({ percent: 0 }),
    modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => { walks++; return entries; }
    },
    ui: { notify() {}, setStatus() {} }
  };
  piJar({
    on: (name: string, handler: Function) => events.set(name, [...(events.get(name) ?? []), handler]),
    registerCommand() {}, registerShortcut() {}, registerTool() {}, getCommands: () => [],
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data })
  } as never);
  const emit = async (name: string, event: unknown = {}) => { for (const handler of events.get(name) ?? []) await handler(event, ctx); };
  await emit("session_start");
  const baseline = walks;
  for (let index = 0; index < 20; index++) {
    await emit("input", { source: "interactive", text: "hi" });
    await emit("agent_start");
    await emit("message_end", { message: { role: "user" } });
    await emit("agent_end");
  }
  assert.ok(walks - baseline <= 1, `session walked ${walks - baseline} times for 20 prompts`);
  const pins = entries.filter((entry) => (entry as { customType?: string }).customType === PROFILE_ENTRY);
  assert.equal(pins.length, 1, "the profile is still pinned exactly once");
  await emit("session_shutdown");
});
