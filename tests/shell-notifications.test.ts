import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { registerShellNotifications, shellNotification } from "../src/shell-notifications.ts";
import type { ShellEvent, ShellJob } from "../src/shells.ts";

function job(id: string, overrides: Partial<ShellJob> = {}): ShellJob {
  return { id, name: id, command: "check", cwd: "/tmp", startedAt: 0, status: "exited", exitCode: 0,
    notify: true, complete: true, purpose: "task", dropped: 0, lines: ["PRIVATE LOG MUST NOT REPLAY"], ...overrides };
}
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: ShellEvent[] = [], jobs: ShellJob[] = [], sent: any[] = [];
  const hooks = new Map<string, Function>();
  const manager = {
    takeNotifications: () => events.splice(0), pendingNotifications: () => events.length, notificationSnapshot: () => [...events],
    restoreNotifications: (items: ShellEvent[]) => events.unshift(...items),
    summaries: () => jobs, verificationPending: () => jobs.filter(j => !j.complete && j.purpose !== "service")
  };
  const controller = registerShellNotifications({
    on: (name: string, fn: Function) => hooks.set(name, fn),
    registerMessageRenderer() {}, sendMessage: (message: unknown, options: unknown) => sent.push({ message, options })
  } as never, () => manager as never);
  t.after(() => controller.dispose());
  return { events, jobs, sent, controller, hook: (name: string, event: unknown = {}, ctx?: unknown) => hooks.get(name)?.(event, ctx) };
}
const completed = { outcome: "completed", context: { canContinue: true } };

test("shell summary coalesces status without replaying logs", () => {
  const entry = shellNotification([{ kind: "exit", job: job("s1") }, { kind: "exit", job: job("s2", { exitCode: 1 }) }]);
  assert.match(String(entry.content), /2 completed · 1 failed/);
  assert.doesNotMatch(JSON.stringify(entry), /PRIVATE LOG/);
});

test("idle shell events debounce into one next-turn delivery", t => {
  const f = fixture(t);
  f.events.push({ kind: "exit", job: job("s1") }); f.controller.notify();
  f.events.push({ kind: "exit", job: job("s2") }); f.controller.notify();
  t.mock.timers.tick(299); assert.equal(f.sent.length, 0);
  t.mock.timers.tick(1); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].options.deliverAs, "nextTurn");
  assert.equal(f.events.length, 0);
  t.mock.timers.tick(1000); assert.equal(f.sent.length, 1);
});

test("active boundaries drain events once, rather than queuing follow-ups", t => {
  const f = fixture(t); f.hook("agent_start");
  f.events.push({ kind: "exit", job: job("s1") }); f.controller.notify();
  t.mock.timers.tick(1000); assert.equal(f.sent.length, 0);
  const result = f.hook("turn_end", completed);
  assert.equal(result.continue, true); assert.match(result.entries[0].content, /s1/);
  assert.equal(f.hook("agent_before_settle", completed), undefined);
  f.hook("agent_settled"); t.mock.timers.tick(1000); assert.equal(f.sent.length, 0);
});

test("completion UI feedback arrives during an in-flight model response without consuming its notification", t => {
  const f = fixture(t);
  const feedback: string[] = [];
  f.hook("agent_start", {}, { hasUI: true, ui: { notify: (text: string) => feedback.push(text) } });
  f.events.push({ kind: "exit", job: job("s1") }); f.controller.notify();
  t.mock.timers.tick(300);
  assert.equal(feedback.length, 1);
  assert.match(feedback[0]!, /s1.*safe turn boundary/);
  assert.doesNotMatch(feedback[0]!, /PRIVATE LOG/);
  assert.equal(f.sent.length, 0, "never enqueue an irrevocable mid-response follow-up");
  assert.equal(f.events.length, 1, "model can still acknowledge the previewed event");
  f.controller.notify(); t.mock.timers.tick(300);
  assert.equal(feedback.length, 1, "preview is coalesced and shown once");
  const boundary = f.hook("turn_end", completed);
  assert.match(boundary.entries[0].content, /s1/);
} );

test("acknowledgement and session replacement cancel pending UI completion previews", t => {
  const f = fixture(t);
  const feedback: string[] = [];
  f.hook("agent_start", {}, { hasUI: true, ui: { notify: (text: string) => feedback.push(text) } });
  f.events.push({ kind: "exit", job: job("s1") }); f.controller.notify();
  f.events.splice(0); t.mock.timers.tick(300);
  assert.equal(feedback.length, 0);
  f.events.push({ kind: "exit", job: job("s2") }); f.controller.notify();
  f.hook("session_start"); t.mock.timers.tick(300);
  assert.equal(feedback.length, 0);
});

test("acknowledged events do not produce obsolete idle wakeups", t => {
  const f = fixture(t);
  f.events.push({ kind: "exit", job: job("s1") }); f.controller.notify();
  f.events.splice(0); // Equivalent to output/peek/wait acknowledgement.
  t.mock.timers.tick(1000); assert.equal(f.sent.length, 0);
});

test("finite and draining checks get one reminder; services do not", t => {
  const f = fixture(t);
  f.jobs.push(job("s1", { complete: false }), job("s2", { status: "running", complete: false, purpose: "service" }));
  const result = f.hook("agent_before_settle", completed);
  assert.equal(result.continue, true); assert.match(result.entries[0].content, /s1/);
  assert.doesNotMatch(result.entries[0].content, /s2/);
  assert.equal(f.hook("agent_before_settle", completed), undefined);
});

test("interruption suppresses wakeups until a new user turn", t => {
  const f = fixture(t); f.hook("agent_start");
  f.hook("agent_before_settle", { outcome: "aborted" }); f.hook("agent_settled");
  f.events.push({ kind: "exit", job: job("s1") }); f.controller.notify();
  t.mock.timers.tick(1000); assert.equal(f.sent.length, 0);
  assert.match(f.hook("before_agent_start").message.content, /s1/);
});

test("non-continuable boundaries retain events for later observation", t => {
  const f = fixture(t); f.hook("agent_start"); f.events.push({ kind: "exit", job: job("s1") });
  assert.equal(f.hook("turn_end", { outcome: "completed", context: { canContinue: false } }), undefined);
  assert.equal(f.events.length, 1);
});
