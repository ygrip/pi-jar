import assert from "node:assert/strict";
import test from "node:test";
import { advisorPrompt, callKey, loopExempt, registerAdvisor, StuckDetector, transcript } from "../src/advisor.ts";
import { SideUsage } from "../src/side-model.ts";

test("transcript keeps the newest messages within the cap and labels tool results", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "old question " + "x".repeat(500) } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "trying" }, { type: "toolCall", name: "bash", arguments: { command: "npm test" } }] } },
    { type: "message", message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "boom" }] } },
    { type: "custom" }
  ];
  const text = transcript(entries, 200);
  assert.match(text, /### assistant\ntrying\n\[tool bash command=npm test\]/);
  assert.match(text, /### tool result \(bash, error\)\nboom/);
  assert.ok(text.length <= 260);
  assert.match(advisorPrompt({ question: "Q?", draft: "D", trigger: "loop" }, "conv", "## main"), /Automatic consultation: loop[\s\S]*Q\?[\s\S]*D[\s\S]*## main[\s\S]*conv/);
});

test("stuck detector fires on repeated calls and failure streaks, within a per-prompt budget", () => {
  const stuck = new StuckDetector();
  const key = callKey("grep", { pattern: "a" });
  assert.equal(stuck.call(key), undefined);
  assert.equal(stuck.call(callKey("grep", { pattern: "b" })), undefined);
  assert.equal(stuck.call(key), undefined);
  assert.equal(stuck.call(key), undefined, "three repeats are not yet a loop");
  assert.match(stuck.call(key)!, /same tool call 4 times/);
  assert.equal(stuck.call(key), undefined, "history resets after a gate");
  assert.equal(stuck.result(true, "bash"), undefined);
  assert.equal(stuck.result(false, "bash"), undefined, "a success breaks the streak");
  stuck.result(true, "bash"); stuck.result(true, "bash");
  assert.match(stuck.result(true, "bash")!, /3 tool calls in a row failed/);
  stuck.result(true, "x"); stuck.result(true, "x");
  assert.equal(stuck.result(true, "x"), undefined, "budget of two gates per prompt");
  stuck.reset();
  stuck.result(true, "x"); stuck.result(true, "x");
  assert.ok(stuck.result(true, "x"));
});

test("loop keys for huge inputs stay small but still tell calls apart", () => {
  const content = "x".repeat(100_000);
  const key = callKey("write", { path: "a.ts", content });
  assert.ok(key.length < 1500, "the recent-call window never pins whole file contents");
  assert.ok(key.startsWith('write {"path":"a.ts","content":"xxx'), "the loop message keeps a readable prefix");
  assert.equal(callKey("write", { path: "a.ts", content }), key);
  assert.notEqual(callKey("write", { path: "a.ts", content: content.slice(1) + "y" }), key);
  const stuck = new StuckDetector();
  stuck.call(key); stuck.call(key); stuck.call(key);
  assert.match(stuck.call(callKey("write", { path: "a.ts", content }))!, /same tool call 4 times: write \{"path":"a\.ts"/);
});

test("re-reads, shell polls and test reruns never count as loops; other repeats do", () => {
  assert.equal(loopExempt("read", { path: "a.ts" }), true);
  for (const action of ["output", "wait", "peek"]) assert.equal(loopExempt("jar_shell", { action, id: "s1" }), true, action);
  for (const command of ["npm test", "npm run build && npm test", "pnpm run test:unit", "node --experimental-strip-types --test tests/a.test.ts",
    "npx vitest run", "pytest -q tests", "python -m pytest", "go test ./...", "cargo test", "./gradlew clean test", "make -C api test"]) {
    assert.equal(loopExempt("bash", { command }), true, command);
  }
  assert.equal(loopExempt("jar_shell", { action: "start", command: "npm test" }), true);
  for (const [tool, input] of [["jar_shell", { action: "start", command: "npm run dev" }], ["jar_shell", { action: "kill", id: "s1" }],
    ["bash", { command: "git status" }], ["bash", { command: "cat latest-tests.log" }], ["bash", { command: "npm run testify" }],
    ["edit", { path: "a.ts" }], ["bash", {}]] as const) {
    assert.equal(loopExempt(tool, input), false, JSON.stringify(input));
  }
});

test("advisor consultation uses the configured fallback after a provider error", async () => {
  const calls: string[] = [];
  let command: Function | undefined;
  const pi = { registerTool() {}, registerCommand(_name: string, spec: any) { command = spec.handler; }, on() {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
  const roles = {
    resolve: () => ({ provider: "p", model: "primary", via: [] }),
    fallbackSpecs: () => ["p/backup:high"],
    resolveSpec: () => ({ provider: "p", model: "backup", thinking: "high", via: [] })
  };
  const ctx = { hasUI: false, sessionManager: { getBranch: () => [] }, modelRegistry: {
    find: (provider: string, id: string) => ({ provider, id }),
    streamSimple: (model: any) => ({ result: async () => {
      calls.push(model.id);
      if (model.id === "primary") throw new Error("429 rate limited");
      return { content: [{ type: "text", text: "Fallback review" }], stopReason: "stop" };
    } })
  } };
  const advisor = registerAdvisor(pi as never, roles as never, { enabled: () => true, gates: () => true, usage: new SideUsage() });
  assert.deepEqual(await advisor.consult(ctx as never, { question: "Review?" }), { text: "Fallback review", model: "p/backup" });
  assert.deepEqual(calls, ["primary", "backup"]);
  const controller = new AbortController();
  controller.abort();
  await command!("Review?", { ...ctx, signal: controller.signal, ui: { notify() {} } });
  assert.deepEqual(calls, ["primary", "backup"], "cancelled /advisor command starts no model attempts");
});

test("advisor tool, /advisor and the loop gate consult the advisor role", async () => {
  const tools = new Map<string, any>();
  const commands = new Map<string, Function>();
  const events = new Map<string, Function>();
  const sent: any[] = [];
  const asked: { model: string; prompt: string }[] = [];
  let enabled = true;
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, spec: any) => commands.set(name, spec.handler),
    on: (name: string, handler: Function) => events.set(name, handler),
    sendMessage: (message: any, options: any) => sent.push({ message, options })
  };
  const roles = { resolve: (role: string) => role === "advisor" ? { provider: "p", model: "opus", thinking: "high", via: ["advisor"] } : undefined };
  const usage = new SideUsage();
  const advisor = registerAdvisor(pi as never, roles as never, { enabled: () => enabled, gates: () => true, usage,
    processRunner: async (_command, _args, options) => {
      assert.equal(options?.timeoutMs, 5000, "advisor Git reads are bounded");
      return Buffer.from("## main\n M a.ts");
    }
  });
  const ctx = {
    hasUI: true, cwd: "/w", model: { provider: "p", id: "main" }, isIdle: () => true,
    ui: { notify() {}, setStatus() {} },
    sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "fix login" } }] },
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      streamSimple: (model: any, context: any, options: any) => {
        asked.push({ model: `${model.id}:${options.reasoning}`, prompt: context.messages[0].content });
        return { result: async () => ({ content: [{ type: "text", text: "Revise: check the token expiry." }], stopReason: "stop",
          usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { total: 0.02 } } }) };
      }
    }
  };
  const result = await tools.get("jar_advisor").execute("1", { question: "Is this right?", draft: "patch" }, undefined, undefined, ctx);
  assert.equal(result.details.state, "running");
  assert.match(result.content[0].text, /Advisor a1 started/);
  const collected = await tools.get("jar_advisor").execute("wait", { action: "wait", id: result.details.id }, undefined, undefined, ctx);
  assert.match(collected.content[0].text, /Revise: check the token expiry/);
  assert.equal(asked[0]!.model, "opus:high");
  assert.match(asked[0]!.prompt, /Is this right\?[\s\S]*patch[\s\S]*## main[\s\S]*fix login/);

  events.get("agent_start")!({}, ctx);
  await commands.get("advisor")!("auth flow", ctx);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(advisor.get("a2")?.state, "completed");
  const boundary = events.get("turn_end")!({ outcome: "completed", context: { canContinue: true } }, ctx);
  assert.equal(boundary.entries[0].customType, "pi-jar.advisor");
  assert.match(boundary.entries[0].content, /◆ Advisor a2 · p\/opus · auth flow[\s\S]*token expiry/);
  assert.equal(sent.length, 0, "active results are delivered once at a safe boundary, not an irrevocable follow-up");

  const call = { toolName: "bash", input: { command: "git status" } };
  for (let repeat = 0; repeat < 3; repeat++) assert.equal(events.get("tool_call")!(call, ctx), undefined);
  const gate = events.get("tool_call")!(call, ctx);
  assert.equal(gate.block, true);
  assert.match(gate.reason, /Loop detected[\s\S]*Advisor a3 is reviewing in the background/);
  assert.equal((await advisor.wait("a3")).state, "completed");
  assert.equal(usage.all().length, 3);

  enabled = false;
  await assert.rejects(tools.get("jar_advisor").execute("2", {}, undefined, undefined, ctx), /turned off/);
  advisor.dispose();
});
