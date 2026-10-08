import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  BREAK_COLD_TOKENS, BREAK_SHORTFALL_TOKENS, CacheBreakTracker, cacheBreakFile, diffSegments, fingerprintPayload, judgeCall,
  readCacheBreaks, registerCacheBreaks, rewriteCost, summarizeBreaks, systemSections, type CacheBreakRecord, type Segment
} from "../src/cache-breaks.ts";
import { cacheBreakLines } from "../src/cache-breaks-view.ts";
import { registerInfoPanels } from "../src/info-panels.ts";
import { anthropic, BASE, call, deepFreeze, reply, result, SYSTEM, tool, usage, user, type Message } from "./cache-payloads.ts";

type Handler = (event: object, ctx: unknown) => unknown;
const plain = (_color: string, text: string) => text;
const T0 = Date.UTC(2026, 9, 8, 10, 0, 0);
const MODEL = "anthropic/claude-sonnet";
const fp = (payload: unknown, provider = "anthropic"): Segment[] => fingerprintPayload(payload, provider)!;

test("a payload becomes ordered segments: model, tools, system sections, then messages, without keeping content", () => {
  const segments = fp(anthropic({ messages: BASE }));
  assert.deepEqual(segments.map((segment) => `${segment.kind}:${segment.label}`), [
    "model:anthropic/claude-sonnet", "tool:read", "tool:bash",
    "system:preamble", "system:<tools>", "system:<skills>", "system:<cwd>",
    "message:user", "message:assistant", "message:tool result: read", "message:assistant", "message:tool result: bash", "message:assistant"
  ]);
  const json = JSON.stringify(segments);
  for (const secret of ["fix the bug", "deploy: ship it", "xxxxxxxxxx", "src/a.ts"]) assert.ok(!json.includes(secret), `${secret} must not be stored`);
  assert.ok(segments.every((segment) => /^[A-Za-z0-9_-]{12}$/.test(segment.hash)));
  assert.ok(segments[9]!.size > 5000, "sizes count characters");
  assert.deepEqual(fp(anthropic({ messages: BASE })), segments, "fingerprints are deterministic");
});

test("fingerprinting only reads: frozen payloads pass and nothing is replaced", () => {
  const payload = deepFreeze(anthropic({ messages: BASE }));
  const before = JSON.stringify(payload);
  assert.ok(fingerprintPayload(payload, "anthropic"));
  assert.equal(JSON.stringify(payload), before);
});

test("appending messages is not a break, even though the cache marker moves to the newest block", () => {
  const before = fp(anthropic({ messages: BASE }));
  assert.equal(diffSegments(before, before), undefined, "identical prompt");
  assert.equal(diffSegments(before, fp(anthropic({ messages: [...BASE, user("now add a test")] }))), undefined);
  // The newest message is turned into a text block to carry the marker, and back into a string once it is older.
  const withUser = [...BASE, user("tail")];
  assert.equal(diffSegments(fp(anthropic({ messages: withUser })), fp(anthropic({ messages: [...withUser, reply("ok")] }))), undefined);
  // Moving the tool marker (a tool appended after the old last tool) is not a changed tool definition.
  const more = diffSegments(before, fp(anthropic({ tools: [tool("read"), tool("bash"), tool("grep")], messages: BASE })));
  assert.deepEqual(more && "changed" in more ? more.changed : undefined, []);
});

test("a long conversation, rebuilt from scratch for every call, never looks like a break", () => {
  const turns: Message[] = [];
  let previous: Segment[] | undefined;
  for (let turn = 0; turn < 25; turn++) {
    turns.push(user(`task ${turn}`), call(`c${turn}`, "read"), result(`c${turn}`, `output ${turn}`.repeat(50)), reply(`finished ${turn}`));
    const current = fp(anthropic({ messages: turns }));
    if (previous) assert.equal(diffSegments(previous, current), undefined, `turn ${turn}`);
    previous = current;
  }
});

test("a changed tool list names the added, removed, changed and reordered tools", () => {
  const base = fp(anthropic({ messages: BASE }));
  const names = Array.from({ length: 18 }, (_, index) => `mcp_tool_${index}`);
  const added = diffSegments(base, fp(anthropic({ tools: [tool("read"), tool("bash"), ...names.map((name) => tool(name))], messages: BASE })));
  assert.deepEqual(added, { kind: "tools", segment: 3, first: "tool mcp_tool_0", added: names, removed: [], changed: [], reordered: false });
  const removed = diffSegments(base, fp(anthropic({ tools: [tool("read")], messages: BASE })));
  assert.deepEqual(removed, { kind: "tools", segment: 2, first: "tool bash", added: [], removed: ["bash"], changed: [], reordered: false });
  const changed = diffSegments(base, fp(anthropic({ tools: [tool("read"), tool("bash", "a new description")], messages: BASE })));
  assert.deepEqual(changed, { kind: "tools", segment: 2, first: "tool bash", added: [], removed: [], changed: ["bash"], reordered: false });
  const reordered = diffSegments(base, fp(anthropic({ tools: [tool("bash"), tool("read")], messages: BASE })));
  assert.deepEqual(reordered, { kind: "tools", segment: 1, first: "tool bash", added: [], removed: [], changed: [], reordered: true });
});

test("a changed system prompt names the section, whether edited, added or removed", () => {
  const base = fp(anthropic({ messages: BASE }));
  const edited = diffSegments(base, fp(anthropic({ system: SYSTEM("deploy: ship it\n- lint: run the linter"), messages: BASE })));
  assert.deepEqual(edited, { kind: "system", segment: 5, first: "system <skills>", added: [], removed: [], changed: ["<skills>"], reordered: false });
  const added = diffSegments(base, fp(anthropic({ system: SYSTEM() + "\n\n<mcp>\n\nservers\n\n</mcp>", messages: BASE })));
  assert.deepEqual(added, { kind: "system", segment: 7, first: "system <mcp>", added: ["<mcp>"], removed: [], changed: [], reordered: false });
  const dropped = diffSegments(fp(anthropic({ system: SYSTEM() + "\n\n<mcp>\n\nservers\n\n</mcp>", messages: BASE })), base);
  assert.deepEqual(dropped && "removed" in dropped ? dropped.removed : undefined, ["<mcp>"]);
});

test("a rewritten message in the middle of the history is located, sized and counted from the end", () => {
  const before = fp(anthropic({ messages: [...BASE, user("next")] }));
  const stubbed = BASE.map((message, index) => index === 2 ? result("t1", "[output cleared]") : message);
  const change = diffSegments(before, fp(anthropic({ messages: [...stubbed, user("next")] })));
  assert.equal(change?.kind, "message");
  assert.ok(change && change.kind === "message");
  assert.deepEqual({ ...change, before: 0, after: 0 }, { kind: "message", segment: 9, first: "message tool result: read", index: 2, total: 7, label: "tool result: read", before: 0, after: 0, dropped: 0 });
  assert.ok(change.before > 5000 && change.after < 200, "a stub is a much smaller message");

  // Dropping old messages shifts everything: the first one that differs is reported, with how many went.
  const dropped = diffSegments(before, fp(anthropic({ messages: [...BASE.slice(2), user("next")] })));
  assert.ok(dropped && dropped.kind === "message");
  assert.equal(dropped.index, 0);
  assert.equal(dropped.dropped, 2);

  // Only a shorter history that is otherwise unchanged is "truncated".
  const shortened = diffSegments(fp(anthropic({ messages: BASE })), fp(anthropic({ messages: BASE.slice(0, 4) })));
  assert.deepEqual(shortened, { kind: "truncated", segment: 11, first: "message tool result: bash", from: 6, to: 4 });
});

test("switching model or provider changes the first segment", () => {
  const base = fp(anthropic({ messages: BASE }));
  assert.deepEqual(diffSegments(base, fp(anthropic({ model: "claude-opus", messages: BASE }))),
    { kind: "model", segment: 0, first: "model anthropic/claude-opus", from: "anthropic/claude-sonnet", to: "anthropic/claude-opus" });
  const provider = diffSegments(base, fp(anthropic({ messages: BASE }), "openrouter"));
  assert.ok(provider && provider.kind === "model");
  assert.equal(provider.to, "openrouter/claude-sonnet");
  // A request without a known provider still fingerprints by model id.
  assert.equal(fingerprintPayload(anthropic({ messages: BASE }))![0]!.label, "claude-sonnet");
});

test("OpenAI Responses payloads: a leading developer item or instructions is the system prompt, calls and outputs are named", () => {
  const items = [
    { role: "user", content: [{ type: "input_text", text: "fix the bug" }] },
    { type: "reasoning", id: "rs_1", summary: [] },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "{\"path\":\"a.ts\"}" },
    { type: "function_call_output", call_id: "call_1", output: "file text" },
    { type: "message", role: "assistant", id: "msg_1", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] }
  ];
  const tools = [{ type: "function", name: "read", description: "Read", parameters: { type: "object" }, strict: false }];
  const responses = (input: unknown[]) => ({ model: "gpt-5", stream: true, store: false, prompt_cache_key: "s1", tools, input: [{ role: "developer", content: SYSTEM() }, ...input] });
  const labels = ["model:openai/gpt-5", "tool:read", "system:preamble", "system:<tools>", "system:<skills>", "system:<cwd>",
    "message:user", "message:reasoning", "message:tool call: read", "message:tool result: read", "message:assistant"];
  const segments = fp(responses(items), "openai");
  assert.deepEqual(segments.map((segment) => `${segment.kind}:${segment.label}`), labels);
  // `instructions` (Codex style) gives the same system sections.
  const codex = fp({ model: "gpt-5", instructions: SYSTEM(), input: items, tools }, "openai");
  assert.deepEqual(codex.map((segment) => segment.label), segments.map((segment) => segment.label));
  assert.deepEqual(codex.slice(2).map((segment) => segment.hash), segments.slice(2).map((segment) => segment.hash));

  assert.equal(diffSegments(segments, fp(responses([...items, { role: "user", content: [{ type: "input_text", text: "next" }] }]), "openai")), undefined);
  const cleared = items.map((item, index) => index === 3 ? { ...item, output: "[cleared]" } : item);
  const change = diffSegments(segments, fp(responses([...cleared, { role: "user", content: "next" }]), "openai"));
  assert.ok(change && change.kind === "message");
  assert.deepEqual([change.index, change.total, change.label], [3, 6, "tool result: read"]);
  const edited = diffSegments(segments, fp({ ...responses(items), tools: [...tools, { type: "function", name: "grep", parameters: {} }] }, "openai"));
  assert.ok(edited && edited.kind === "tools");
  assert.deepEqual(edited.added, ["grep"]);
  // A plain-string `input` is one user message.
  assert.deepEqual(fp({ model: "gpt-5", input: "hello" }, "openai").map((segment) => segment.label), ["openai/gpt-5", "user"]);
});

test("OpenAI Chat Completions payloads: system message, function tools and named tool results", () => {
  const chatTool = (name: string) => ({ type: "function", function: { name, description: name, parameters: { type: "object" } } });
  const messages = [
    { role: "user", content: "run ls" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "a.ts" }
  ];
  const chat = (tools: unknown[], conversation: unknown[]) => ({ model: "gpt-4.1", stream: true, tools, messages: [{ role: "system", content: SYSTEM() }, ...conversation] });
  const segments = fp(chat([chatTool("bash")], messages), "openai");
  assert.deepEqual(segments.map((segment) => `${segment.kind}:${segment.label}`), [
    "model:openai/gpt-4.1", "tool:bash", "system:preamble", "system:<tools>", "system:<skills>", "system:<cwd>",
    "message:user", "message:assistant", "message:tool result: bash"
  ]);
  assert.equal(diffSegments(segments, fp(chat([chatTool("bash")], [...messages, { role: "assistant", content: "done" }]), "openai")), undefined);
  const grown = diffSegments(segments, fp(chat([chatTool("bash"), chatTool("grep")], messages), "openai"));
  assert.ok(grown && grown.kind === "tools");
  assert.deepEqual(grown.added, ["grep"]);
  // OpenRouter-style Anthropic caching turns the newest message into marked text parts and back again.
  const marked = [...messages.slice(0, 2), { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "a.ts", cache_control: { type: "ephemeral" } }] }];
  assert.equal(diffSegments(fp(chat([chatTool("bash")], marked), "openai"), fp(chat([chatTool("bash")], [...messages, user("go on")]), "openai")), undefined);
});

test("payloads of other shapes are skipped", () => {
  for (const payload of [undefined, null, "prompt", 42, [], {}, { model: "m" }, { messages: [] }, { model: 1, messages: [] },
    { model: "gemini", contents: [{ role: "user", parts: [{ text: "hi" }] }] }]) {
    assert.equal(fingerprintPayload(payload, "provider"), undefined);
  }
  assert.ok(fingerprintPayload({ model: "m", messages: [] }));
});

test("system prompts split into labelled sections that tile the text", () => {
  const text = "# Role\nYou are x.\n\n## Rules\n- a\n- b\n\nLoose paragraph.\n\n<cwd>\n\n/repo\n\n</cwd>\n\n<cwd>\n\n/other\n\n</cwd>";
  const sections = systemSections(text);
  assert.deepEqual(sections.map((section) => section.label), ["# Role", "# Rules", "<cwd>", "<cwd> #2"]);
  assert.equal(sections.map((section) => section.text).join("\n"), text);
  assert.ok(sections[1]!.text.includes("Loose paragraph."), "paragraphs after a heading belong to it");

  const plainText = "one\n\ntwo\nthree\n\n\nfour";
  assert.deepEqual(systemSections(plainText).map((section) => section.label), ["preamble", "text 1", "text 2"]);
  assert.equal(systemSections(plainText).map((section) => section.text).join("\n"), plainText);
  assert.deepEqual(systemSections(""), [], "no text, no sections");
  assert.equal(systemSections("a\n\n\n").length, 1, "trailing blank lines are not a section");
  // An unclosed tag runs to the end instead of being lost.
  assert.deepEqual(systemSections("intro\n<open>\nbody\nmore").map((section) => section.label), ["preamble", "<open>"]);

  // Appending a section leaves the earlier sections' text, and so their hashes, untouched.
  const grown = systemSections(SYSTEM() + "\n\n<mcp>\n\nservers\n\n</mcp>");
  assert.deepEqual(grown.slice(0, 4), systemSections(SYSTEM()));
  const crowded = systemSections(Array.from({ length: 400 }, (_, index) => `paragraph ${index}`).join("\n\n"));
  assert.equal(crowded.length, 128);
  assert.equal(crowded.at(-1)!.label, "rest");
});

test("a call is a costly break only when its cache read falls short of the previous prompt by more than the threshold", () => {
  assert.deepEqual([BREAK_SHORTFALL_TOKENS, BREAK_COLD_TOKENS], [4096, 8192]);
  const previous = 100_000;
  assert.deepEqual(judgeCall(previous, usage(500, 99_500, 800)), { rewritten: 500, costly: false }, "normal turn");
  assert.deepEqual(judgeCall(previous, usage(500, previous - BREAK_SHORTFALL_TOKENS, BREAK_SHORTFALL_TOKENS)), { rewritten: 4096, costly: false }, "exactly the threshold");
  assert.deepEqual(judgeCall(previous, usage(500, previous - BREAK_SHORTFALL_TOKENS - 1, BREAK_SHORTFALL_TOKENS + 1)), { rewritten: 4097, costly: true });
  assert.deepEqual(judgeCall(previous, usage(500, 0, 100_000)), { rewritten: 100_000, costly: true }, "nothing read");
  // A smaller prompt (after compaction) can only have read what it contains.
  assert.deepEqual(judgeCall(previous, usage(0, 20_000, 0)), { rewritten: 0, costly: false });
  assert.deepEqual(judgeCall(previous, usage(100, 10_000, 9_900)), { rewritten: 10_000, costly: true });
  // Nothing read from a prompt over 8k is costly even after a small previous prompt.
  assert.deepEqual(judgeCall(3_000, usage(9_000, 0, 0)), { rewritten: 3_000, costly: true });
  assert.deepEqual(judgeCall(3_000, usage(BREAK_COLD_TOKENS, 0, 0)), { rewritten: 3_000, costly: false });
  assert.deepEqual(judgeCall(3_000, usage(BREAK_COLD_TOKENS + 1, 0, 0)), { rewritten: 3_000, costly: true });
  assert.deepEqual(judgeCall(0, undefined), { rewritten: 0, costly: false });
});

test("the wasted cost is the rewritten tokens at the call's own fresh price minus its cache-read price", () => {
  const sonnet = { input: 1_000, cacheRead: 4_096, cacheWrite: 235_000, cost: { input: 0.003, cacheRead: 0.0012288, cacheWrite: 0.88125 } };
  const cost = rewriteCost(sonnet, 235_000)!;
  assert.ok(Math.abs(cost - 0.81) < 0.001, `~$0.81, got ${cost}`);
  // Without a cache read the read price comes from the model, or counts as free.
  const cold = { ...sonnet, cacheRead: 0, cost: { ...sonnet.cost, cacheRead: 0 } };
  assert.ok(Math.abs(rewriteCost(cold, 235_000, 0.3)! - 0.81) < 0.001);
  assert.ok(Math.abs(rewriteCost(cold, 235_000)! - 0.8805) < 0.001);
  assert.equal(rewriteCost({ input: 1_000, cacheRead: 0, cacheWrite: 235_000 }, 235_000), undefined, "no reported cost");
  assert.equal(rewriteCost({ ...sonnet, cost: { input: 0, cacheRead: 0, cacheWrite: 0 } }, 235_000), undefined, "a free call wastes nothing");
  assert.equal(rewriteCost(sonnet, 0), undefined);
  assert.equal(rewriteCost(undefined, 100), undefined);
});

const BASE_SEGMENTS = fp(anthropic({ messages: BASE }));
const APPENDED = fp(anthropic({ messages: [...BASE, user("next")] }));
const WITH_MCP = fp(anthropic({ tools: [tool("read"), tool("bash"), tool("mcp_a")], messages: [...BASE, user("next")] }));

test("correlating requests with usage reports a costly tools break once, with its cost and tokens", () => {
  const tracker = new CacheBreakTracker();
  tracker.request(BASE_SEGMENTS);
  assert.equal(tracker.complete({ usage: usage(500, 0, 100_000), at: T0, model: MODEL }), undefined, "the first call has nothing to compare with");
  tracker.request(APPENDED);
  assert.equal(tracker.complete({ usage: usage(300, 100_500, 400), at: T0 + 20_000, model: MODEL }), undefined, "an appended prompt read from the cache");
  tracker.request(WITH_MCP);
  const found = tracker.complete({ usage: usage(400, 8_000, 105_000), at: T0 + 40_000, model: MODEL })!;
  assert.ok(found);
  assert.deepEqual({ ...found, costUsd: undefined }, {
    version: 1, timestamp: new Date(T0 + 40_000).toISOString(), request: 3, kind: "tools", summary: "tools changed (+mcp_a)", segment: 3, first: "tool mcp_a",
    model: MODEL, promptTokens: 113_400, cacheReadTokens: 8_000, rewrittenTokens: 93_200, costUsd: undefined, idleMs: 20_000
  });
  assert.ok(Math.abs(found.costUsd! - 0.3213) < 0.001, `cost ${found.costUsd}`);
  assert.equal(tracker.checked, 3);
  assert.deepEqual(tracker.breaks, [found]);
  assert.deepEqual(summarizeBreaks(tracker.breaks).kinds.get("tools"), { count: 1, rewritten: 93_200, cost: found.costUsd });
});

test("a changed prompt that still read from the cache is not a break", () => {
  const tracker = new CacheBreakTracker();
  tracker.request(BASE_SEGMENTS);
  tracker.complete({ usage: usage(500, 0, 100_000), at: T0, model: MODEL });
  tracker.request(WITH_MCP);
  assert.equal(tracker.complete({ usage: usage(2_000, 100_000, 1_500), at: T0 + 10_000, model: MODEL }), undefined);
  assert.deepEqual(tracker.breaks, []);
});

test("an unchanged prompt that missed is unexplained, or an expired cache after a long idle gap", () => {
  const miss = (gap: number, warmedAt?: number) => {
    const tracker = new CacheBreakTracker();
    tracker.request(BASE_SEGMENTS);
    tracker.complete({ usage: usage(500, 0, 50_000), at: T0, model: MODEL });
    if (warmedAt !== undefined) tracker.warmed(warmedAt);
    tracker.request(APPENDED);
    return tracker.complete({ usage: usage(40_000, 0, 10_500), at: T0 + gap, model: MODEL })!;
  };
  const unexplained = miss(60_000);
  assert.deepEqual([unexplained.kind, unexplained.summary, unexplained.segment, unexplained.first], ["unknown", "no prompt change found", undefined, undefined]);
  const idle = miss(10 * 60_000);
  assert.deepEqual([idle.kind, idle.summary, idle.idleMs], ["idle", "cache expired after 10m idle", 600_000]);
  // Pi's cache warming restarted the cache lifetime, so ten minutes since the last call is not an expiry.
  assert.equal(miss(10 * 60_000, T0 + 9 * 60_000).kind, "unknown");
  assert.equal(miss(10 * 60_000, T0 + 9 * 60_000).idleMs, 60_000);
});

test("a prompt change after a long idle gap is reported as the change, with the idle time", () => {
  const tracker = new CacheBreakTracker();
  tracker.request(BASE_SEGMENTS);
  tracker.complete({ usage: usage(500, 0, 50_000), at: T0, model: MODEL });
  tracker.request(WITH_MCP);
  const found = tracker.complete({ usage: usage(40_000, 0, 10_500), at: T0 + 12 * 60_000, model: MODEL })!;
  assert.equal(found.kind, "tools");
  assert.equal(found.summary, "tools changed (+mcp_a), after 12m idle");
});

test("providers that never report cache activity never produce breaks", () => {
  const tracker = new CacheBreakTracker();
  for (let call = 0; call < 4; call++) {
    tracker.request(call % 2 ? WITH_MCP : BASE_SEGMENTS);
    assert.equal(tracker.complete({ usage: usage(60_000, 0, 0), at: T0 + call * 30_000, model: "local/model" }), undefined);
  }
  assert.equal(tracker.checked, 4);
});

test("a call that never reached the provider neither moves the baseline nor counts", () => {
  const tracker = new CacheBreakTracker();
  tracker.request(BASE_SEGMENTS);
  tracker.complete({ usage: usage(500, 0, 50_000), at: T0, model: MODEL });
  tracker.request(WITH_MCP); // fails before any token is processed
  assert.equal(tracker.complete({ usage: usage(0, 0, 0), at: T0 + 5_000, model: MODEL }), undefined);
  assert.equal(tracker.complete({ usage: undefined, at: T0 + 5_000, model: MODEL }), undefined);
  tracker.request(APPENDED);
  const found = tracker.complete({ usage: usage(40_000, 0, 10_500), at: T0 + 30_000, model: MODEL })!;
  assert.equal(found.kind, "unknown", "compared with the last completed call, not with the failed request");
  assert.equal(tracker.checked, 2);
});

test("compaction, unknown payloads and resets start a fresh baseline", () => {
  const costly = () => ({ usage: usage(40_000, 0, 10_500), at: T0 + 30_000, model: MODEL });
  const tracker = new CacheBreakTracker();
  tracker.request(BASE_SEGMENTS);
  tracker.complete({ usage: usage(500, 0, 50_000), at: T0, model: MODEL });
  tracker.rebase();
  tracker.request(APPENDED);
  assert.equal(tracker.complete(costly()), undefined, "history was rewritten on purpose");

  tracker.request(APPENDED);
  tracker.complete({ usage: usage(500, 50_000, 500), at: T0 + 40_000, model: MODEL });
  const checked = tracker.checked;
  tracker.request(undefined); // a payload shape this module does not know
  assert.equal(tracker.complete(costly()), undefined);
  assert.equal(tracker.checked, checked, "a call that could not be fingerprinted was not checked");
  tracker.request(APPENDED);
  assert.equal(tracker.complete({ ...costly(), at: T0 + 60_000 }), undefined, "nothing to compare with after an unknown payload");
});

test("a new session continues request numbers and the listed breaks from its earlier log", () => {
  const earlier: CacheBreakRecord = { version: 1, timestamp: new Date(T0).toISOString(), request: 7, kind: "tools", summary: "tools changed (+x)", model: MODEL,
    promptTokens: 50_000, cacheReadTokens: 1_000, rewrittenTokens: 49_000, idleMs: 0 };
  const tracker = new CacheBreakTracker();
  tracker.reset([earlier]);
  assert.deepEqual(tracker.breaks, [earlier]);
  tracker.request(BASE_SEGMENTS);
  tracker.complete({ usage: usage(500, 0, 50_000), at: T0, model: MODEL });
  tracker.request(APPENDED);
  const found = tracker.complete({ usage: usage(40_000, 0, 10_500), at: T0 + 30_000, model: MODEL })!;
  assert.equal(found.request, 9);
  assert.equal(tracker.breaks.length, 2);
  tracker.reset();
  assert.deepEqual(tracker.breaks, []);
  assert.equal(tracker.checked, 0);
});

function harness(enabled: () => boolean = () => true) {
  const handlers = new Map<string, Handler[]>();
  const directory = mkdtempSync(join(tmpdir(), "pi-jar-cache-breaks-"));
  const notices: { text: string; level?: string }[] = [];
  const pi = { on: (name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } };
  const monitor = registerCacheBreaks(pi as never, { enabled: () => enabled(), directory });
  const ctx = {
    model: { provider: "anthropic", id: "claude-sonnet", cost: { cacheRead: 0.3 } }, modelRegistry: { find: () => undefined },
    sessionManager: { getSessionId: () => "019a-session/1" },
    ui: { notify: (text: string, level?: string) => { notices.push({ text, level }); } }
  };
  const emit = async (name: string, event: object = {}) => {
    let returned: unknown;
    for (const handler of handlers.get(name) ?? []) returned = (await handler(event, ctx)) ?? returned;
    return returned;
  };
  const message = (use: object, at: number, role = "assistant") => ({ message: { role, provider: "anthropic", model: "claude-sonnet", timestamp: at, usage: use } });
  return { emit, notices, ctx, monitor, directory, handlers, message, file: join(directory, "019a-session1.jsonl"), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("the registered handlers never touch the payload and announce one costly break with its log record", async () => {
  const h = harness();
  try {
    await h.emit("session_start", { reason: "startup" });
    const request = async (segments: unknown) => {
      const payload = deepFreeze(segments);
      const before = JSON.stringify(payload);
      assert.equal(await h.emit("before_provider_request", { payload }), undefined, "the payload is not replaced");
      assert.equal(JSON.stringify(payload), before);
    };
    await request(anthropic({ messages: BASE }));
    await h.emit("message_end", h.message(usage(500, 0, 100_000), T0));
    await request(anthropic({ messages: [...BASE, user("next")] }));
    await h.emit("message_end", h.message(usage(300, 100_500, 400), T0 + 20_000));
    assert.equal(h.notices.length, 0, "ordinary calls are silent");
    await request(anthropic({ tools: [tool("read"), tool("bash"), tool("mcp_a")], messages: [...BASE, user("next"), reply("ok"), user("more")] }));
    await h.emit("message_end", h.message(usage(400, 8_000, 105_000), T0 + 40_000));
    await h.emit("message_end", h.message(usage(1, 1, 1), T0 + 50_000, "user"));

    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0]!.text, /^cache break: tools changed \(\+mcp_a\) — rewrote 93k tokens \(~\$0\.32\)$/);
    assert.equal(h.notices[0]!.level, "warning");
    const lines = readFileSync(h.file, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "one JSONL line per break, in a file named for the session");
    const logged = JSON.parse(lines[0]!);
    assert.deepEqual({ ...logged, costUsd: 0 }, { version: 1, timestamp: new Date(T0 + 40_000).toISOString(), request: 3, kind: "tools", summary: "tools changed (+mcp_a)",
      segment: 3, first: "tool mcp_a", model: MODEL, promptTokens: 113_400, cacheReadTokens: 8_000, rewrittenTokens: 93_200, costUsd: 0, idleMs: 20_000 });
    assert.deepEqual(h.monitor.state(h.ctx), { enabled: true, calls: 3, breaks: [logged], file: h.file });
    assert.deepEqual(readCacheBreaks(h.file), [logged]);
  } finally { h.cleanup(); }
});

test("a session resumed later lists its earlier breaks and keeps numbering", async () => {
  const h = harness();
  try {
    const send = async (payload: unknown, use: object, at: number) => { await h.emit("before_provider_request", { payload }); await h.emit("message_end", h.message(use, at)); };
    await send(anthropic({ messages: BASE }), usage(500, 0, 100_000), T0);
    await send(anthropic({ system: SYSTEM("changed skills"), messages: BASE }), usage(500, 0, 100_000), T0 + 10_000);
    assert.equal(h.monitor.state(h.ctx).breaks.length, 1);
    await h.emit("session_start", { reason: "resume" });
    assert.equal(h.monitor.state(h.ctx).breaks.length, 1, "read back from the session's log");
    assert.equal(h.monitor.state(h.ctx).calls, 0);
    await send(anthropic({ messages: BASE }), usage(500, 0, 100_000), T0 + 20_000);
    await send(anthropic({ model: "claude-opus", messages: BASE }), usage(500, 0, 100_000), T0 + 30_000);
    assert.deepEqual(h.monitor.state(h.ctx).breaks.map((entry) => [entry.request, entry.kind]), [[2, "system"], [4, "model"]]);
  } finally { h.cleanup(); }
});

test("compaction and tree navigation start a new baseline; cache warming restarts the idle clock", async () => {
  const h = harness();
  try {
    const send = async (payload: unknown, use: object, at: number) => { await h.emit("before_provider_request", { payload }); await h.emit("message_end", h.message(use, at)); };
    await send(anthropic({ messages: BASE }), usage(500, 0, 100_000), T0);
    await h.emit("session_compact");
    await send(anthropic({ messages: BASE.slice(3) }), usage(500, 0, 60_000), T0 + 10_000);
    await h.emit("session_tree");
    await send(anthropic({ messages: BASE.slice(1) }), usage(500, 0, 60_000), T0 + 20_000);
    assert.equal(h.notices.length, 0, "an expected rewrite is not announced");

    // Two calls 20 minutes apart: an expired cache, unless Pi refreshed it in between.
    const now = Date.now();
    await send(anthropic({ messages: BASE }), usage(500, 0, 60_000), now - 20 * 60_000);
    await send(anthropic({ messages: [...BASE, user("a")] }), usage(500, 0, 60_000), now);
    assert.equal(h.monitor.state(h.ctx).breaks.at(-1)!.kind, "idle");
    await h.emit("cache_warming_decision", { action: "warm" });
    const later = Date.now();
    await send(anthropic({ messages: [...BASE, user("a"), reply("b")] }), usage(500, 0, 60_000), later);
    assert.equal(h.monitor.state(h.ctx).breaks.at(-1)!.kind, "unknown");
    assert.ok(h.monitor.state(h.ctx).breaks.at(-1)!.idleMs < 60_000);
  } finally { h.cleanup(); }
});

test("disabled diagnostics observe nothing, and a throwing notice cannot disturb a run", async () => {
  let on = false;
  const h = harness(() => on);
  try {
    const send = async (payload: unknown, use: object, at: number) => { await h.emit("before_provider_request", { payload }); await h.emit("message_end", h.message(use, at)); };
    await send(anthropic({ messages: BASE }), usage(500, 0, 100_000), T0);
    await send(anthropic({ system: SYSTEM("changed"), messages: BASE }), usage(500, 0, 100_000), T0 + 10_000);
    assert.equal(h.notices.length, 0);
    assert.equal(existsSync(h.file), false);
    assert.deepEqual(h.monitor.state(h.ctx), { enabled: false, calls: 0, breaks: [], file: h.file });

    on = true;
    h.ctx.ui.notify = () => { throw new Error("no terminal"); };
    await send(anthropic({ messages: BASE }), usage(500, 0, 100_000), T0 + 20_000);
    await send(anthropic({ system: SYSTEM("changed again"), messages: BASE }), usage(500, 0, 100_000), T0 + 30_000);
    assert.equal(readFileSync(h.file, "utf8").trim().split("\n").length, 1, "still logged");
    // Payloads this module cannot read, even unserializable ones, are ignored.
    const circular: Record<string, unknown> = { model: "m", messages: [{ role: "user", content: "x" }] };
    (circular.messages as unknown[]).push(circular);
    await h.emit("before_provider_request", { payload: circular });
    await h.emit("before_provider_request", { payload: 12 });
  } finally { h.cleanup(); }
});

test("session logs are per session, under the pi-jar cache directory, with a safe file name", () => {
  assert.equal(cacheBreakFile("abc-123_X", "/logs"), join("/logs", "abc-123_X.jsonl"));
  assert.equal(cacheBreakFile("../../etc/passwd", "/logs"), join("/logs", "etcpasswd.jsonl"));
  assert.equal(cacheBreakFile(undefined, "/logs"), join("/logs", "session.jsonl"));
  assert.match(cacheBreakFile("s1"), /pi-jar-cache-breaks[\\/]s1\.jsonl$/);
  const dir = mkdtempSync(join(tmpdir(), "pi-jar-cache-log-"));
  try {
    assert.deepEqual(readCacheBreaks(join(dir, "missing.jsonl")), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const entry = (over: Partial<CacheBreakRecord> = {}): CacheBreakRecord => ({
  version: 1, timestamp: new Date(T0).toISOString(), request: 12, kind: "tools", summary: "tools changed (+jendral_build_get, +17 more)", segment: 31,
  first: "tool jendral_build_get", model: "anthropic/claude-opus", promptTokens: 240_000, cacheReadTokens: 4096, rewrittenTokens: 235_000, costUsd: 1.89, idleMs: 12_000, ...over
});

test("the Cache tab totals the breaks, ranks causes by cost and lists each with its first changed segment", () => {
  const breaks = [entry(), entry({ request: 31, kind: "message", summary: "message 14/87 shrank (tool result: read, 52k → 98 chars, 73 from the end)",
    first: "message tool result: read", segment: 44, rewrittenTokens: 171_000, costUsd: 0.75 }), entry({ request: 40, kind: "unknown", summary: "no prompt change found", rewrittenTokens: 9_000, costUsd: undefined })];
  const { first: _first, segment: _segment, ...unexplained } = breaks[2]!;
  breaks[2] = unexplained as CacheBreakRecord;
  const lines = cacheBreakLines({ enabled: true, calls: 57, breaks, file: "/var/pi/s1.jsonl", now: T0 + 60_000 }, 80, plain);
  const text = lines.join("\n");
  assert.match(text, /Calls checked\s+57/);
  assert.match(text, /Costly cache breaks\s+3/);
  assert.match(text, /Tokens rewritten\s+415k/);
  assert.match(text, /Estimated extra cost\s+~\$2\.64/);
  assert.match(text, /By cause\n\s+tool list changed\s+1 · 235k · ~\$1\.89\n\s+message changed\s+1 · 171k · ~\$0\.75\n\s+no prompt change found\s+1 · 9k\n/);
  assert.match(text, /#12\s+\d\d:\d\d:\d\d\s+235k tokens · ~\$1\.89\n\s+tools changed \(\+jendral_build_get, \+17 more\)\n\s+first change: tool jendral_build_get \(segment 31\)/);
  assert.match(text, /#31[\s\S]*message 14\/87 shrank[\s\S]*first change: message tool result: read \(segment 44\)/);
  assert.match(text, /#40[\s\S]*no prompt change found/);
  assert.match(text, /Log: \/var\/pi\/s1\.jsonl/);
  assert.match(text, /more than 4,096 tokens short of the\s+previous prompt/);
  const longPath = "/var/folders/ys/yhg5j9_j4bl16cmjnqbs_gzm0000gp/T/pi-jar-cache-breaks/019a1234-5678-7abc-9def-0123456789ab.jsonl";
  for (const width of [40, 60, 80, 120]) {
    for (const enabled of [true, false]) {
      assert.ok(cacheBreakLines({ enabled, calls: 1, breaks, file: longPath, now: T0 }, width, plain).every((line) => visibleWidth(line) <= width), `width ${width}`);
    }
  }
  // An older break shows its date.
  assert.match(cacheBreakLines({ enabled: true, calls: 1, breaks: [entry()], file: undefined, now: T0 + 3 * 86_400_000 }, 80, plain).join("\n"), /#12\s+10-\d\d \d\d:\d\d\s/);
});

test("the Cache tab explains an empty session and a disabled diagnostic", () => {
  const empty = cacheBreakLines({ enabled: true, calls: 5, breaks: [], file: undefined, now: T0 }, 80, plain).join("\n");
  assert.match(empty, /Calls checked\s+5/);
  assert.match(empty, /None so far\./);
  assert.match(cacheBreakLines({ enabled: true, calls: 0, breaks: [], file: undefined, now: T0 }, 80, plain).join("\n"), /Calls checked\s+0\n\s+Costly cache breaks\s+0\n\s+No call checked yet \(Anthropic and OpenAI requests are read\)\./);
  assert.match(empty, /A break is a call whose cache read fell more than 4,096 tokens/);
  const off = cacheBreakLines({ enabled: false, calls: 0, breaks: [entry()], file: undefined, now: T0 }, 80, plain).join("\n");
  assert.match(off, /Cache diagnostics are off\. Turn them on in \/jar settings → Pi\./);
  assert.match(off, /Costly cache breaks\s+1/);
});

test("/cache-breaks opens the Cache tab next to Usage and Context", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void>; description: string }>();
  const pi = { on() {}, registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void>; description: string }) => { commands.set(name, options); } };
  registerInfoPanels(pi as never, { side: { all: () => [] } as never, quota: () => undefined, quotaFailure: () => undefined, quotaEnabled: () => false, refreshQuota() {},
    cacheBreaks: () => ({ enabled: true, calls: 9, breaks: [entry()], file: undefined }) });
  assert.deepEqual([...commands.keys()].sort(), ["cache-breaks", "context", "usage"]);
  assert.match(commands.get("cache-breaks")!.description, /prompt-cache breaks/);
  const notices: string[] = [];
  await commands.get("cache-breaks")!.handler("", { hasUI: false, mode: "print", ui: { notify: (text: string) => notices.push(text) } });
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Costly cache breaks\s+1[\s\S]*tools changed \(\+jendral_build_get, \+17 more\)/);

  // Without the diagnostic the command and the tab are absent.
  const bare = new Map<string, unknown>();
  registerInfoPanels({ on() {}, registerCommand: (name: string) => { bare.set(name, true); } } as never,
    { side: { all: () => [] } as never, quota: () => undefined, quotaFailure: () => undefined, quotaEnabled: () => false, refreshQuota() {} });
  assert.deepEqual([...bare.keys()].sort(), ["context", "usage"]);
});
