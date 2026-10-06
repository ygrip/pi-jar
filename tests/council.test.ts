import assert from "node:assert/strict";
import test from "node:test";
import { conductCouncil, parseBallot, registerCouncil, tallyBallots, validateCouncil, type CouncilRequest } from "../src/council.ts";
import type { DelegateController, SubagentReport } from "../src/delegate.ts";

const options = [{ id: "a", label: "Fix the state machine", evidence: "Addresses observed race; moderate change scope" },
  { id: "b", label: "Replace the protocol", evidence: "Larger rewrite; removes protocol ambiguity" }];
const request: CouncilRequest = { complexity: "super-complex", issue: "Persistent lifecycle race across processes",
  justification: "Three interacting process lifecycles with inconclusive fixes", failedApproaches: ["Retry serialized writes: race persisted", "Timer workaround: still reproduced"], options, voters: 4 };
const report = (id = "s1", output = "", state: SubagentReport["state"] = "idle"): SubagentReport =>
  ({ id, key: id, name: id, task: "inspect lifecycle", mode: "scout", state, output });
const ballot = (agent: string, option: string) => ({ agent, option, rationale: "observed evidence" });

function fakeController(choices: (string | Error)[], existing: SubagentReport[] = []) {
  const calls: string[] = [];
  const stopped: string[] = [];
  let index = 0;
  const answer = async (task: string, id: string) => {
    calls.push(id);
    const choice = choices[index++];
    if (choice instanceof Error) throw choice;
    const template = JSON.parse(task.split("JAR_BALLOT ")[1]!) as { round: string };
    await new Promise((resolve) => setImmediate(resolve));
    return report(id, 'JAR_BALLOT ' + JSON.stringify({ round: template.round, option: choice, rationale: "evidence supports " + choice }));
  };
  const controller: DelegateController = { list: () => existing,
    spawnScout: (task) => answer(task, "new-" + (index + 1)), resumeScout: (id, task) => answer(task, id),
    stop: async (id) => { stopped.push(id); } };
  return { controller, calls, stopped };
}

test("council rejects routine decisions, missing persistence evidence and duplicate options/nominations", () => {
  validateCouncil(request);
  for (const invalid of [{ ...request, complexity: "complex" }, { ...request, justification: " " },
    { ...request, failedApproaches: ["one"] }, { ...request, failedApproaches: ["one", "one"] },
    { ...request, options: [options[0], options[0]] }, { ...request, agents: ["s1", "s1"] }]) {
    assert.throws(() => validateCouncil(invalid as CouncilRequest));
  }
});

test("strict majority wins; ties, plurality, zero responses and insufficient ballots go to user", () => {
  assert.equal(tallyBallots(options, 4, [ballot("1", "a"), ballot("2", "a"), ballot("3", "a"), ballot("4", "b")]).winner, "a");
  assert.equal(tallyBallots(options, 4, [ballot("1", "a"), ballot("2", "a"), ballot("3", "b"), ballot("4", "b")]).status, "needs-user");
  assert.deepEqual(tallyBallots(options, 4, []).shortlist, ["a", "b"]);
  assert.equal(tallyBallots(options, 4, [ballot("1", "a"), ballot("2", "a")]).winner, undefined);
  assert.equal(tallyBallots(options, 2, [ballot("1", "a")]).winner, undefined);
  const three = [...options, { id: "c", label: "Other", evidence: "Alternative" }];
  assert.equal(tallyBallots(three, 4, [ballot("1", "a"), ballot("2", "a"), ballot("3", "b"), ballot("4", "c")]).status, "needs-user");
  assert.throws(() => tallyBallots(options, 4, [ballot("1", "a"), ballot("1", "b")]));
});

test("ballots reject malformed, stale, duplicated, errored or unknown choices", () => {
  const text = 'JAR_BALLOT ' + JSON.stringify({ round: "nonce", option: "a", rationale: "because" });
  assert.equal(parseBallot(report("s1", text), "nonce", options).option, "a");
  for (const value of [report("s1", "not JSON"), report("s1", text + "\n" + text), report("s1", text, "failed"),
    report("s1", text.replace('"a"', '"unknown"')), report("s1", text.replace("nonce", "old"))]) {
    assert.throws(() => parseBallot(value, "nonce", options));
  }
});

test("orchestration reuses relevant fresh scouts, spawns remaining voters and records failures without guessing", async () => {
  const { controller, calls, stopped } = fakeController(["a", "a", "b", new Error("provider unavailable")], [report()]);
  const result = await conductCouncil(controller, { ...request, agents: ["s1"] }, 4);
  assert.equal(calls[0], "s1");
  assert.equal(calls.length, 4);
  assert.equal(result.ballots.length, 3);
  assert.equal(result.failures.length, 1);
  assert.equal(result.winner, undefined, "2 of 4 invited is not a majority");
  assert.deepEqual(stopped.sort(), result.ballots.map((ballot) => ballot.agent).filter((id) => id !== "s1").sort(),
    "voters spawned for the round are retired so they never hold pool slots; the nominated scout stays");
});

test("a ballot deadline turns hung voters into recorded failures instead of an endless round", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { controller } = fakeController(["a", "a"]);
  const answered = controller.spawnScout;
  let spawned = 0;
  controller.spawnScout = (task, signal) => ++spawned <= 2 ? answered(task, signal)
    : new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  const round = conductCouncil(controller, { ...request, voters: 3 }, 4, undefined, 1000);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1000);
  const result = await round;
  assert.equal(result.ballots.length, 2);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!.reason, /deadline/);
  assert.equal(result.winner, "a", "two of three valid ballots is a strict majority");
});

test("cap, busy/non-scout nominees and aborted calls reject before spawning", async () => {
  for (const existing of [[report("s1", "", "working")], [{ ...report(), mode: "fork" as const }],
    [report(), report("other"), report("third")]]) {
    const { controller, calls } = fakeController([], existing);
    await assert.rejects(conductCouncil(controller, { ...request, agents: ["s1"] }, 4));
    assert.equal(calls.length, 0);
  }
  const { controller, calls } = fakeController([]);
  await assert.rejects(conductCouncil(controller, request, 2));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(conductCouncil(controller, request, 4, abort.signal));
  assert.equal(calls.length, 0);
});

test("noninteractive tie is pending user choice and voting never executes a winning option", async () => {
  let tool: any;
  const { controller } = fakeController(["a", "a", "b", "b"]);
  registerCouncil({ registerTool: (definition: unknown) => { tool = definition; } } as never, () => controller, () => 4);
  const result = await tool.execute("vote", request, undefined, undefined, { hasUI: false, mode: "rpc" });
  assert.equal(result.details.status, "needs-user");
  assert.equal(result.details.winner, undefined);
  assert.match(result.content[0].text, /obtain an explicit user choice/);
});

test("only one round at a time and lock resets after errors", async () => {
  let tool: any;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const { controller } = fakeController(["a", "a", "a", "b"]);
  const spawn = controller.spawnScout;
  controller.spawnScout = async (...args) => { await blocked; return spawn(...args); };
  registerCouncil({ registerTool: (definition: unknown) => { tool = definition; } } as never, () => controller, () => 4);
  const first = tool.execute("one", request, undefined, undefined, { hasUI: false });
  assert.equal((await tool.execute("two", request, undefined, undefined, {})).isError, true);
  release();
  assert.equal((await first).details.winner, "a");
  const invalid = await tool.execute("bad", { ...request, failedApproaches: [] }, undefined, undefined, {});
  assert.equal(invalid.isError, true);
});

test("escaped oversized evidence rejects before any resumed or fresh voter launches", async () => {
  const { controller, calls } = fakeController([], [report()]);
  const oversized = { ...request, issue: '"'.repeat(4000), justification: '"'.repeat(2000),
    failedApproaches: Array.from({ length: 8 }, (_, index) => '"'.repeat(1999) + index), agents: ["s1"] };
  await assert.rejects(conductCouncil(controller, oversized, 4), /too large/);
  assert.equal(calls.length, 0);
});

test("a failed tie-selection TUI preserves the completed ballot evidence", async () => {
  let tool: any;
  const { controller } = fakeController(["a", "a", "b", "b"]);
  registerCouncil({ registerTool: (definition: unknown) => { tool = definition; } } as never, () => controller, () => 4);
  const result = await tool.execute("vote", request, undefined, undefined, { hasUI: true, mode: "tui",
    ui: { custom: async () => { throw new Error("dialog unavailable"); } } });
  assert.equal(result.details.status, "needs-user");
  assert.equal(result.details.ballots.length, 4);
  assert.match(result.details.selectionError, /dialog unavailable/);
});

test("abort closes the tie picker and releases the round lock without choosing", async () => {
  let tool: any;
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => { opened = resolve; });
  const { controller } = fakeController(["a", "a", "b", "b", "a", "a", "a", "b"]);
  registerCouncil({ registerTool: (definition: unknown) => { tool = definition; } } as never, () => controller, () => 4);
  let closed = false;
  const ctx = { hasUI: true, mode: "tui", ui: { custom: (factory: Function) => new Promise((resolve) => {
    factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, (value: unknown) => { closed = true; resolve(value); });
    opened();
  }) } };
  const abort = new AbortController();
  const pending = tool.execute("one", request, abort.signal, undefined, ctx);
  await ready; abort.abort();
  const result = await pending;
  assert.equal(closed, true);
  assert.equal(result.details.userChoice.cancelled, true);
  assert.equal(result.details.winner, undefined);
  assert.equal(result.details.ballots.length, 4);
  assert.equal((await tool.execute("two", request, undefined, undefined, { hasUI: false })).details.winner, "a");
});
