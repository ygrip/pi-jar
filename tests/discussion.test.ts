import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_DISCUSSION_BYTES, MAX_DISCUSSION_MESSAGES, MAX_DISCUSSION_TEXT, MAX_LIST_CHARS, MAX_NOTICE_CHARS } from "../src/discussion-hub.ts";
import {
  DISCUSSION_ENDPOINT_ENV,
  DISCUSSION_ENV_KEYS,
  DISCUSSION_NOTICE,
  DISCUSSION_TOKEN_ENV,
  DiscussionBroker,
  discussionClientFromEnv,
  registerDiscussionTool,
  SUBAGENT_KEY_ENV,
  SUBAGENT_NAME_ENV,
  type DiscussionTransport
} from "../src/discussion.ts";

interface Tool {
  name: string;
  execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}
type Notice = { message: { customType: string; display: boolean; content: string } } | undefined;

/** One Pi process's jar_discuss tool and turn-boundary hook, over the given transport. */
function agent(transport: () => DiscussionTransport | undefined) {
  let tool: Tool | undefined;
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const sent: unknown[] = [];
  registerDiscussionTool({
    registerTool(definition: Tool) { tool = definition; },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
    sendMessage(message: unknown) { sent.push(message); }
  } as never, transport);
  return {
    run: (params: Record<string, unknown>) => tool!.execute("call", params),
    say: async (params: Record<string, unknown>) => (await tool!.execute("call", params)).content[0]!.text,
    boundary: async () => await handlers.get("before_agent_start")!({ type: "before_agent_start", prompt: "next" }, {}) as Notice,
    sent
  };
}

const child = (broker: DiscussionBroker, key: string, name: string) => discussionClientFromEnv(broker.childEnv(key, name))!;
/** A subagent as delegate spawns it: registered with the broker before its first turn. */
const member = (broker: DiscussionBroker, key: string, name: string) => {
  const client = child(broker, key, name);
  return agent(() => client);
};
const withBroker = async (run: (broker: DiscussionBroker) => Promise<void>) => {
  const broker = new DiscussionBroker();
  await broker.start();
  try { await run(broker); } finally { await broker.close(); }
};
/** Raw bytes on their own connection; resolves with whatever came back before the connection closed. */
const raw = (endpoint: string, data: string, hangUp = false) => new Promise<string>((resolve) => {
  let reply = "";
  const socket = createConnection(endpoint, () => {
    socket.write(data);
    if (hangUp) socket.end();
  });
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => { reply += chunk; });
  socket.on("error", () => { /* the reply, if any, is what the test checks */ });
  socket.on("close", () => resolve(reply));
});
const count = (length: number, first = 1) => Array.from({ length }, (_, index) => index + first);

test("concurrent asks and answers from several children get unique ordered ids, one request each", () => withBroker(async (broker) => {
  const clients = [1, 2, 3].map((n) => child(broker, `delegate-1-${n}`, `agent ${n}`));
  const asked = await Promise.all(clients.flatMap((client, c) => count(10).map((i) => client.ask(`question ${c}.${i}`, "moderator"))));
  assert.deepEqual(asked.map((result) => result.id).sort((a, b) => a - b), count(30));
  const answered = await Promise.all(asked.map((question, index) => clients[(Math.floor(index / 10) + 1) % 3]!.answer(question.id, "answer")));
  assert.deepEqual(answered.map((result) => result.id).sort((a, b) => a - b), count(30, 31));
  assert.deepEqual([broker.stats().requests, broker.stats().errors], [60, 0], "nothing was retried or rejected");

  const listed: number[] = [];
  for (let page = await broker.local().list(); page.messages.length; page = await broker.local().list()) listed.push(...page.messages.map((message) => message.id));
  assert.deepEqual(listed, count(30), "the moderator reads its questions in parent-assigned order");
}));

test("the token is a child's only identity; bad tokens, targets and replies are rejected", () => withBroker(async (broker) => {
  const env = broker.childEnv("delegate-1-1", "scout");
  const endpoint = env[DISCUSSION_ENDPOINT_ENV]!;
  const token = env[DISCUSSION_TOKEN_ENV]!;
  const send = async (request: Record<string, unknown>) => JSON.parse(await raw(endpoint, JSON.stringify(request) + "\n"));

  assert.deepEqual(await send({ token, op: "ask", text: "who am I?", from: "moderator", key: "delegate-9-9" }),
    { ok: true, result: { id: 1, clipped: false, delivered: [], unread: 0 } });
  assert.equal((await broker.local().list()).messages[0]!.from, "scout", "request fields cannot choose the sender");
  for (const forged of [{ op: "list" }, { token: "forged", op: "list" }, { token: 7, op: "list" }]) {
    assert.deepEqual(await send(forged), { ok: false, error: "Unauthorized discussion request." });
  }
  assert.match((await send({ token, op: "ask", text: "hi", to: "nobody" })).error, /^Unknown discussion target/);
  assert.match((await send({ token, op: "answer", questionId: 42, text: "hi" })).error, /^Unknown discussion question d42\./);
  assert.match((await send({ token, op: "answer", questionId: "d1", text: "" })).error, /^Discussion text is required/);

  broker.retire("delegate-1-1");
  assert.deepEqual(await send({ token, op: "list" }), { ok: false, error: "Unauthorized discussion request." }, "retirement revokes the token");
  assert.equal(JSON.stringify([broker.stats(), await broker.local().pending()]).includes(token), false, "the token never surfaces");
}));

test("malformed, oversized and abandoned requests cannot crash the parent", () => withBroker(async (broker) => {
  const env = broker.childEnv("delegate-1-1", "scout");
  const endpoint = env[DISCUSSION_ENDPOINT_ENV]!;
  const token = env[DISCUSSION_TOKEN_ENV]!;
  assert.match(await raw(endpoint, "not json\n"), /Malformed discussion request/);
  assert.match(await raw(endpoint, "[1,2]\n"), /Malformed discussion request/);
  // One byte past the 16 KiB request bound, with no newline in sight.
  assert.match(await raw(endpoint, "x".repeat(16 * 1024 + 1)), /Discussion request too large/);
  assert.equal(await raw(endpoint, '{"token":', true), "", "a half request is dropped when its peer hangs up");
  assert.match(await raw(endpoint, JSON.stringify({ token, op: "explode" }) + "\n"), /Unknown discussion operation/);
  assert.match(await raw(endpoint, JSON.stringify({ token, op: "thread", questionId: { id: 1 } }) + "\n"), /questionId must be a discussion id/);

  assert.equal((await discussionClientFromEnv(env)!.ask("still serving")).id, 1);
  const stats = broker.stats();
  assert.equal(stats.listening, true);
  assert.equal(stats.errors, 5);
}));

test("the socket is the broker's only file; close removes it, revokes tokens and clears state", async () => {
  const exitListeners = process.listenerCount("exit");
  const idle = new DiscussionBroker();
  assert.deepEqual(idle.childEnv("delegate-1-1", "scout"), { [SUBAGENT_KEY_ENV]: "delegate-1-1", [SUBAGENT_NAME_ENV]: "scout" },
    "no endpoint or token before the broker listens");
  await idle.close();

  const broker = new DiscussionBroker();
  await Promise.all([broker.start(), broker.start()]);
  const env = broker.childEnv("delegate-1-1", "scout");
  assert.deepEqual(Object.keys(env).sort(), [...DISCUSSION_ENV_KEYS].sort(), "the scrub list covers everything a child inherits");
  assert.deepEqual(broker.childEnv("delegate-1-1", "scout"), env, "idempotent per key");
  assert.equal(broker.childEnv("moderator", "impostor")[DISCUSSION_TOKEN_ENV], undefined, "the moderator identity is never handed out");
  const endpoint = env[DISCUSSION_ENDPOINT_ENV]!;
  const client = discussionClientFromEnv(env)!;
  await client.ask("question", "moderator");
  await broker.local().answer(1, "answer");
  await client.list();
  if (process.platform !== "win32") {
    assert.equal(statSync(dirname(endpoint)).mode & 0o777, 0o700, "only the owner can reach the socket");
    assert.deepEqual(readdirSync(dirname(endpoint)), ["broker.sock"], "no paper, lock or snapshot file is ever written");
  }

  await broker.close();
  assert.equal(existsSync(endpoint), false);
  if (process.platform !== "win32") assert.equal(existsSync(dirname(endpoint)), false);
  assert.equal(process.listenerCount("exit"), exitListeners, "no exit hook outlives the broker");
  assert.deepEqual(broker.stats(), {
    transport: "broker", listening: false, agents: 0, messages: 0, maxMessages: MAX_DISCUSSION_MESSAGES, bytes: 0, maxBytes: MAX_DISCUSSION_BYTES,
    unanswered: 0, unread: 0, requests: 0, errors: 0
  });
  await assert.rejects(client.list(), /^Error: Discussion broker unavailable/);

  await broker.start();
  const fresh = broker.childEnv("delegate-1-1", "scout");
  assert.notEqual(fresh[DISCUSSION_ENDPOINT_ENV], endpoint);
  assert.notEqual(fresh[DISCUSSION_TOKEN_ENV], env[DISCUSSION_TOKEN_ENV], "a restarted broker issues new tokens");
  await assert.rejects(client.list(), /Discussion broker unavailable/, "an old endpoint stays dead after restart");
  await broker.close();
});

test("without a reachable broker jar_discuss says so and never falls back to a file", async () => {
  assert.equal(discussionClientFromEnv({}), undefined);
  assert.equal(discussionClientFromEnv({ [DISCUSSION_ENDPOINT_ENV]: "/tmp/x.sock" }), undefined, "an endpoint without a token is no transport");
  const orphan = agent(() => undefined);
  const result = await orphan.run({ action: "ask", text: "anyone?" });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /^Discussion broker unavailable/);

  const missing = join(tmpdir(), "pi-jar-no-such-broker", "broker.sock");
  const stranded = agent(() => discussionClientFromEnv({ [DISCUSSION_ENDPOINT_ENV]: missing, [DISCUSSION_TOKEN_ENV]: "token" }));
  const failed = await stranded.run({ action: "list" });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0]!.text, /^Discussion broker unavailable \(\w+\)\.$/);
  assert.equal(await stranded.boundary(), undefined, "an unreachable broker never fails or delays a turn with an error");
  assert.equal(existsSync(dirname(missing)), false);
});

test("ask and answer replies name the new id without echoing text; the caller's mail rides along", () => withBroker(async (broker) => {
  const scout = member(broker, "delegate-1-1", "scout");
  const worker = member(broker, "delegate-1-2", "worker");
  const moderator = agent(() => broker.local());
  assert.equal(await scout.say({ action: "ask", text: "Where is auth handled?", to: "worker" }), "Added d1 (→ worker).");
  assert.equal(await scout.say({ action: "ask", text: "Anyone own the cache?" }), "Added d2.");
  assert.equal(await worker.say({ action: "answer", questionId: "d1", text: "middleware.ts line 40" }),
    "Answered d1 as d3.\n[d2] Q · scout: Anyone own the cache?");
  assert.equal(await scout.say({ action: "ask", text: "Which tests cover it?", to: "worker" }),
    "Added d4 (→ worker).\n[d3] A · worker → d1: middleware.ts line 40");
  assert.equal(await moderator.say({ action: "answer", questionId: "2", text: "the moderator does" }), "Answered d2 as d5.", "plain numbers are ids too");
  assert.equal(await scout.say({ action: "ask", text: "z".repeat(MAX_DISCUSSION_TEXT + 10) }),
    `Added d6 (clipped to ${MAX_DISCUSSION_TEXT} chars).\n[d5] A · moderator → d2: the moderator does`);

  const missing = await worker.run({ action: "answer", text: "orphan" });
  assert.deepEqual([missing.isError, missing.content[0]!.text], [true, "questionId is required (e.g. d12)."]);
  const unknown = await worker.run({ action: "answer", questionId: "d99", text: "nope" });
  assert.deepEqual([unknown.isError, unknown.content[0]!.text], [true, "Unknown discussion question d99."]);
  const empty = await worker.run({ action: "ask", text: "   " });
  assert.deepEqual([empty.isError, empty.content[0]!.text], [true, "Discussion text is required."]);
}));

test("list returns only the caller's unread mail in bounded pages; thread reads one question in full", () => withBroker(async (broker) => {
  const worker = member(broker, "delegate-1-1", "worker");
  const reader = member(broker, "delegate-1-2", "reader");
  for (let i = 0; i < 20; i++) await worker.run({ action: "ask", text: `question ${i} ` + "x".repeat(MAX_DISCUSSION_TEXT) });
  const first = await reader.say({ action: "list" });
  assert.ok(first.length <= MAX_LIST_CHARS + 100, "the reply budget holds however much is unread");
  assert.match(first, /^\[d1\] Q · worker: question 0 x+…$/m, "oldest first, clipped");
  assert.doesNotMatch(first, /x{401}/);
  assert.match(first, /\(\d+ more unread; list again\)$/);
  let last = first;
  while (/list again/.test(last)) last = await reader.say({ action: "list" });
  assert.match(last, /\[d20\] Q · worker: question 19/, "paging reaches the newest message");
  assert.equal(await reader.say({ action: "list" }), "No unread messages (latest d20).");
  assert.match(await reader.say({ action: "list", since: "d19" }), /^\[d20\] Q · worker: question 19 x+…$/);
  assert.equal(await reader.say({ action: "list", since: "d20" }), "No messages for you newer than d20.");
  const invalid = await reader.run({ action: "list", since: "yesterday" });
  assert.deepEqual([invalid.isError, invalid.content[0]!.text], [true, "since must be a discussion id like d12."]);

  await reader.run({ action: "ask", text: "How does question 2 relate?", to: "worker" });
  await worker.run({ action: "answer", questionId: "d21", text: "answer " + "y".repeat(MAX_DISCUSSION_TEXT) });
  const thread = await reader.say({ action: "thread", questionId: "d21" });
  assert.match(thread, /^\[d21\] Q · reader → worker: How does question 2 relate\?\n\[d22\] A · worker → d21: answer y{1593}$/, "a thread shows answers in full");
  assert.equal(await reader.say({ action: "list" }), "No unread messages (latest d22).", "reading the thread read its answer");
  assert.equal(await reader.say({ action: "list", questionId: "d21" }), thread, "list with questionId still reads one thread");
  assert.equal(await reader.say({ action: "thread", questionId: "d22", since: "d22" }), "No answers newer than d22.");
}));

test("pending gives compact summaries without message bodies", () => withBroker(async (broker) => {
  const scout = member(broker, "delegate-1-1", "scout");
  const moderator = agent(() => broker.local());
  await scout.run({ action: "ask", text: "private detail alpha", to: "moderator" });
  await moderator.run({ action: "ask", text: "private detail beta", to: "scout" });
  const mine = await scout.say({ action: "pending" });
  assert.match(mine, /^Unread for you: 1 \(list to read\)\.\nWaiting on you: d2\.\nYour unanswered questions: d1\.\nRetained: 2\/128 messages, [\d.]+\/128 KiB\.$/);
  const fleet = await moderator.say({ action: "pending" });
  assert.match(fleet, /^Unread for you: 0\.\nWaiting on you: d1\.\nYour unanswered questions: d2\.\nUnread by agent: scout 1\.\n/);
  assert.match(fleet, /\nUnanswered: 2 \(d1 scout → moderator · d2 moderator → scout\)\.\n/);
  assert.doesNotMatch(mine + fleet, /private/);
}));

test("unread mail arrives batched in one notice per turn start, read once shown, never echoing its sender or waking anyone", () => withBroker(async (broker) => {
  const moderator = agent(() => broker.local());
  const scout = member(broker, "delegate-1-1", "scout");
  const worker = member(broker, "delegate-1-2", "worker");
  assert.equal(await moderator.boundary(), undefined, "no notice without unread mail");
  await scout.run({ action: "ask", text: "ping", to: "moderator" });
  await scout.run({ action: "ask", text: "anyone own the cache?" });
  await worker.run({ action: "answer", questionId: "d2", text: "the worker does" });
  assert.deepEqual(await moderator.boundary(), { message: { customType: DISCUSSION_NOTICE, display: false,
    content: "Discussion mail (now read; reply with jar_discuss answer):\n[d1] Q · scout → moderator: ping\n[d2] Q · scout: anyone own the cache?" } },
    "every unread message rides in one notice");
  assert.equal(await moderator.boundary(), undefined, "shown mail is read, so it is never announced twice");
  assert.equal(await moderator.say({ action: "list" }), "No unread messages (latest d3).", "no list call is needed");
  const scoutNotice = (await scout.boundary())!.message.content;
  assert.match(scoutNotice, /^\[d3\] A · worker → d2: the worker does$/m, "children get it over IPC");
  assert.doesNotMatch(scoutNotice, /ping|cache/, "a sender is never notified of its own question or broadcast");
  assert.equal(await worker.boundary(), undefined, "answering read the broadcast, and the worker's own answer is not echoed");

  await moderator.run({ action: "ask", text: "status, everyone?" });
  assert.equal(await moderator.boundary(), undefined, "the moderator's own broadcast is not echoed to it");
  assert.deepEqual([broker.unreadFor("delegate-1-1"), broker.unreadFor("delegate-1-2")], [0, 0], "nor counted on its fleet line");
  await scout.run({ action: "ask", text: "which tests cover it?", to: "worker" });
  assert.equal(broker.unreadFor("delegate-1-2"), 1, "mail from other agents still counts; the moderator's broadcast does not");

  for (let i = 0; i < 10; i++) await scout.run({ action: "ask", text: `question ${i} ` + "x".repeat(MAX_DISCUSSION_TEXT), to: "moderator" });
  const page = (await moderator.boundary())!.message.content;
  assert.ok(page.length <= MAX_NOTICE_CHARS + 120, `one bounded notice (${page.length})`);
  assert.match(page, /^\[d6\] Q · scout → moderator: question 0 x+…$/m, "oldest first, clipped like list");
  assert.match(page, /\n\(\d+ more unread messages; jar_discuss list\)$/);
  assert.match((await moderator.boundary())!.message.content, /question \d+ x+…/, "the next turn start carries the next page");
  assert.deepEqual([moderator.sent, scout.sent, worker.sent], [[], [], []], "discussion never sends a message, so it can never trigger a turn");
}));

test("the moderator's digest batches its unread mail for a subagent event and marks it read", () => withBroker(async (broker) => {
  const scout = child(broker, "delegate-1-1", "scout");
  assert.equal(broker.digest(), undefined, "no mail, no digest");
  await scout.ask("which config wins?", "moderator");
  await scout.ask("anyone own the cache?");
  assert.equal(broker.digest(), "Discussion mail (now read; reply with jar_discuss answer):\n[d1] Q · scout → moderator: which config wins?\n[d2] Q · scout: anyone own the cache?");
  assert.equal(broker.digest(), undefined, "digested mail is read");
  assert.equal(broker.unreadFor("moderator"), 0);
}));

test("change notifications fire on state changes only, and a failing listener never fails a request", (t) => withBroker(async (broker) => {
  let changes = 0;
  broker.onChange = () => { changes++; };
  const scout = child(broker, "delegate-1-1", "scout");
  assert.equal(changes, 1, "registration");
  await broker.local().list();
  assert.equal(changes, 1, "an empty read changes nothing");
  await scout.ask("hello", "moderator");
  assert.deepEqual([changes, broker.unreadFor("moderator"), broker.unreadFor("delegate-9-9")], [2, 1, 0]);
  await broker.local().list();
  assert.deepEqual([changes, broker.unreadFor("moderator")], [3, 0]);

  const logged = t.mock.method(console, "error", () => {});
  broker.onChange = () => { throw new Error("repaint bug"); };
  assert.equal((await scout.ask("still fine")).id, 2);
  assert.equal(logged.mock.callCount(), 1);
}));
