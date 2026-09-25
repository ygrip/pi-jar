import assert from "node:assert/strict";
import test from "node:test";
import { advisorPrompt, callKey, registerAdvisor, StuckDetector, transcript } from "../src/advisor.ts";
import { SideUsage } from "../src/side-model.ts";

test("transcript keeps the newest messages within the cap and labels tool results", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "old question " + "x".repeat(500) } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "trying" }, { type: "toolCall", name: "bash", arguments: { command: "npm test" } }] } },
    { type: "message", message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "boom" }] } },
    { type: "custom" }
  ];
  const text = transcript(entries, 200);
  assert.match(text, /### assistant\ntrying\n\[tool bash \{"command":"npm test"\}\]/);
  assert.match(text, /### tool result \(bash, error\)\nboom/);
  assert.ok(text.length <= 260);
  assert.match(advisorPrompt({ question: "Q?", draft: "D", trigger: "loop" }, "conv", "## main"), /Automatic consultation: loop[\s\S]*Q\?[\s\S]*D[\s\S]*## main[\s\S]*conv/);
});

test("stuck detector fires on repeated calls and failure streaks, within a per-prompt budget", () => {
  const stuck = new StuckDetector();
  const key = callKey("read", { path: "a" });
  assert.equal(stuck.call(key), undefined);
  assert.equal(stuck.call(callKey("read", { path: "b" })), undefined);
  assert.equal(stuck.call(key), undefined);
  assert.match(stuck.call(key)!, /same tool call 3 times/);
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
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
    exec: async () => ({ code: 0, stdout: "## main\n M a.ts", stderr: "" })
  };
  const roles = { resolve: (role: string) => role === "advisor" ? { provider: "p", model: "opus", thinking: "high", via: ["advisor"] } : undefined };
  const usage = new SideUsage();
  registerAdvisor(pi as never, roles as never, { enabled: () => enabled, gates: () => true, usage });
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
  assert.equal(result.content[0].text, "Revise: check the token expiry.");
  assert.equal(asked[0]!.model, "opus:high");
  assert.match(asked[0]!.prompt, /Is this right\?[\s\S]*patch[\s\S]*## main[\s\S]*fix login/);

  await commands.get("advisor")!("auth flow", ctx);
  assert.equal(sent[0].message.customType, "pi-jar.advisor");
  assert.match(sent[0].message.content, /◆ Advisor · p\/opus · auth flow[\s\S]*token expiry/);
  assert.deepEqual(sent[0].options, { deliverAs: "nextTurn" });

  const call = { toolName: "bash", input: { command: "npm test" } };
  assert.equal(await events.get("tool_call")!(call, ctx), undefined);
  assert.equal(await events.get("tool_call")!(call, ctx), undefined);
  const gate = await events.get("tool_call")!(call, ctx);
  assert.equal(gate.block, true);
  assert.match(gate.reason, /Loop detected[\s\S]*token expiry/);
  assert.equal(usage.all().length, 3);

  enabled = false;
  await assert.rejects(tools.get("jar_advisor").execute("2", {}, undefined, undefined, ctx), /turned off/);
});
