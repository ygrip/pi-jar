import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscussionError,
  DiscussionHub,
  MAX_DISCUSSION_BYTES,
  MAX_DISCUSSION_MESSAGES,
  MAX_DISCUSSION_TEXT,
  MAX_LIST_CHARS,
  MAX_LISTED_TEXT,
  messageLine,
  MODERATOR,
  type ListResult
} from "../src/discussion-hub.ts";

const hubWith = (...agents: Array<[key: string, name: string]>) => {
  const hub = new DiscussionHub();
  for (const [key, name] of agents) hub.register(key, name);
  return hub;
};
const ids = (result: ListResult) => result.messages.map((message) => message.id);

test("ids are parent-assigned and monotonic; failures and clear never consume or reuse one", () => {
  const hub = hubWith(["s", "scout"], ["w", "worker"]);
  assert.equal(hub.ask("s", "first", "w").id, 1);
  assert.throws(() => hub.ask("s", " \n ", "w"), /Discussion text is required/);
  assert.throws(() => hub.answer("w", 9, "x"), /Unknown discussion question d9\./);
  assert.equal(hub.answer("w", 1, "reply").id, 2);
  assert.equal(hub.ask(MODERATOR, "third").id, 3);
  hub.clear();
  assert.equal(hub.ask(MODERATOR, "after clear").id, 4, "a stale d1..d3 reference can never alias a new message");
});

test("posts validate the sender, text, target and reply reference", () => {
  const hub = hubWith(["delegate-1-1", "scout 1"], ["delegate-2-1", "scout 1"], ["delegate-3-1", "worker"]);
  assert.throws(() => hub.ask("ghost", "hi"), /Unknown discussion agent/);
  assert.throws(() => hub.ask("delegate-3-1", "hi", "nobody"),
    /^Error: Unknown discussion target\. Known: moderator, delegate-1-1 \(scout 1\), delegate-2-1 \(scout 1\); omit to broadcast\.$/);
  assert.throws(() => hub.ask("delegate-3-1", "hi", "Scout 1"), /Ambiguous discussion target; use one of: delegate-1-1, delegate-2-1\./);
  assert.throws(() => hub.ask("delegate-3-1", "hi", "worker"), /A question cannot target its sender/);

  const question = hub.ask("delegate-3-1", "hi", "delegate-1-1");
  assert.equal(question.to, "scout 1 (delegate-1-1)", "a shared name is labelled with its key");
  assert.equal(hub.ask("delegate-1-1", "hi", "WORKER").to, "worker", "a unique name resolves case-insensitively");
  assert.equal(hub.ask("delegate-1-1", "hi", "moderator").to, MODERATOR);
  assert.equal(hub.ask("delegate-1-1", "hi", "all").to, undefined, "all broadcasts");
  const answer = hub.answer("delegate-1-1", question.id, "ok");
  assert.throws(() => hub.answer("delegate-3-1", answer.id, "x"), new RegExp(`d${answer.id} is an answer; answer its question d${question.id}\\.`));

  assert.equal(hub.ask("delegate-3-1", "x".repeat(MAX_DISCUSSION_TEXT)).clipped, false);
  const long = hub.ask("delegate-3-1", "x".repeat(MAX_DISCUSSION_TEXT + 50));
  assert.equal(long.clipped, true);
  assert.equal(hub.thread(MODERATOR, long.id).question!.text.length, MAX_DISCUSSION_TEXT);
});

test("each agent gets only relevant unread mail: questions to it, broadcasts, answers to its questions; never its own", () => {
  const hub = hubWith(["s", "scout"], ["w", "worker"], ["r", "reviewer"]);
  hub.ask("s", "to worker", "w");
  hub.ask("s", "to everyone");
  assert.deepEqual(ids(hub.list("r")), [2], "a bystander gets only the broadcast");
  assert.deepEqual(ids(hub.list("w")), [1, 2]);
  assert.deepEqual(ids(hub.list("s")), [], "own messages are never listed back");
  hub.ask("w", "to moderator", MODERATOR);
  assert.deepEqual(ids(hub.list(MODERATOR)), [2, 3]);

  hub.answer("w", 1, "answer one");
  assert.deepEqual(["s", "w", "r", MODERATOR].map((key) => hub.unread(key).unread), [1, 0, 0, 0], "an answer reaches only its asker");
  assert.deepEqual(hub.list("s").messages.map(messageLine), ["[d4] A · worker → d1: answer one"]);
  assert.deepEqual(ids(hub.list("s")), [], "the cursor moved past what was listed");

  hub.ask("r", "status?");
  hub.answer("w", 5, "fine");
  assert.equal(hub.unread("w").unread, 0, "answering a broadcast counts as reading it");
  assert.deepEqual(ids(hub.list("s")), [5], "others still get the broadcast");
  assert.deepEqual(hub.unread("r"), { unread: 1, newest: 6 });
});

test("list pages oldest first within its budget and loses nothing; since rereads without dropping unread mail", () => {
  const hub = hubWith(["s", "scout"], ["w", "worker"]);
  for (let i = 1; i <= 20; i++) hub.ask("w", `question ${i} ` + "x".repeat(MAX_DISCUSSION_TEXT), "s");
  const listed: number[] = [];
  let pages = 0;
  for (let page = hub.list("s"); page.messages.length; page = hub.list("s")) {
    pages++;
    assert.ok(page.messages.reduce((size, message) => size + messageLine(message).length + 1, 0) <= MAX_LIST_CHARS, "every page fits the budget");
    assert.ok(page.messages.every((message) => message.text.length <= MAX_LISTED_TEXT + 1), "listed text is clipped");
    assert.equal(page.unread, page.more);
    listed.push(...ids(page));
  }
  assert.ok(pages > 1);
  assert.deepEqual(listed, Array.from({ length: 20 }, (_, index) => index + 1), "every message arrives exactly once, in order");

  hub.ask("w", "late", "s");
  assert.deepEqual(ids(hub.list("s", 18)), [19, 20, 21], "since rereads read and unread mail alike");
  assert.equal(hub.unread("s").unread, 0);
  hub.ask("w", "skipped", "s");
  hub.ask("w", "newer", "s");
  assert.deepEqual(ids(hub.list("s", 22)), [23]);
  assert.deepEqual(ids(hub.list("s")), [22], "mail skipped by since stays unread");
});

test("thread reads one question in full and marks only that thread read", () => {
  const hub = hubWith(["s", "scout"], ["w", "worker"]);
  const question = hub.ask("s", "long " + "q".repeat(MAX_DISCUSSION_TEXT), "w").id;
  hub.ask("w", "unrelated", "s");
  hub.answer("w", question, "first " + "a".repeat(MAX_DISCUSSION_TEXT));
  hub.answer("w", question, "second " + "b".repeat(MAX_DISCUSSION_TEXT));

  const thread = hub.thread("s", question);
  assert.equal(thread.question!.text.length, MAX_DISCUSSION_TEXT, "thread text is not clipped to the list limit");
  assert.deepEqual(thread.answers.map((message) => message.id), [3]);
  assert.equal(thread.more, 1, "the reply budget still holds");
  assert.deepEqual(hub.thread("s", question, 3).answers.map((message) => message.id), [4], "since pages the remaining answers");
  assert.deepEqual(hub.unread("s"), { unread: 1, newest: 2 }, "the thread is read; unrelated mail is not");
  assert.deepEqual(ids(hub.list("s")), [2]);

  assert.equal(hub.thread("w", 4).id, question, "an answer id opens its question's thread");
  assert.throws(() => hub.thread("s", 99), /Unknown discussion question d99\./);
});

test("ask and answer carry all unread mail when it fits, otherwise only its count", () => {
  const hub = hubWith(["s", "scout"], ["w", "worker"]);
  hub.ask("s", "Where is auth?", "w");
  assert.deepEqual(hub.answer("w", 1, "middleware.ts").delivered, [], "answering does not deliver the question back");
  const next = hub.ask("s", "Which tests cover it?", "w");
  assert.deepEqual(next.delivered.map(messageLine), ["[d2] A · worker → d1: middleware.ts"]);
  assert.equal(next.unread, 0);
  assert.deepEqual(ids(hub.list("s")), [], "delivered mail is read");

  for (let i = 0; i < 3; i++) hub.ask("w", "y".repeat(500), "s");
  const busy = hub.ask("s", "anything else?");
  assert.deepEqual([busy.delivered, busy.unread], [[], 3]);
  assert.deepEqual(ids(hub.list("s")), [4, 5, 6], "mail that did not fit stays unread for list");
});

test("retention evicts read answered groups, then read broadcasts, and refuses questions rather than evict awaited ones", () => {
  const hub = hubWith(["s", "scout"], ["w", "worker"]);
  hub.ask("s", "answered", "w");
  hub.answer("w", 1, "done");
  hub.list("s");
  hub.ask("w", "read broadcast");
  hub.list("s");
  hub.list(MODERATOR);
  for (let id = 4; id <= 112; id++) hub.ask("s", `open ${id}`, "w");
  const window = () => [hub.stats().messages, hub.stats().oldestId];
  assert.deepEqual(window(), [112, 1]);

  hub.ask("s", "113", "w");
  assert.deepEqual(window(), [111, 3], "the read answered group goes first");
  hub.ask("s", "114", "w");
  hub.ask("s", "115", "w");
  assert.deepEqual(window(), [112, 4], "then the read broadcast");
  assert.throws(() => hub.ask("s", "one too many", "w"), /^Error: Discussion is full: 112 retained messages \([\d.]+ KiB\) are unread or awaiting answers\./);
  hub.list("w");
  assert.throws(() => hub.ask("s", "still too many", "w"), /Discussion is full/, "a read but unanswered question is still awaited");
  assert.equal(hub.stats().newestId, 115, "a refused question consumes no id");

  // Questions stop short of the hard bound, so answering — the progress the error asks for — still fits.
  assert.equal(hub.answer("w", 4, "finally").id, 116);
  assert.equal(hub.stats().messages, 113);
  assert.throws(() => hub.ask("s", "not yet", "w"), /Discussion is full/, "the answer is unread by its asker, so nothing is disposable");
  hub.list("s");
  hub.ask("s", "room again", "w");
  assert.deepEqual(window(), [112, 5], "once read, the answered group is disposable");
});

test("eviction never drops unread answers or the question being answered", () => {
  const hub = hubWith(["s", "scout"], ["w", "worker"]);
  hub.ask(MODERATOR, "answer me");
  hub.list("s");
  hub.list("w");
  for (let id = 2; id <= 112; id++) hub.ask("s", `question ${id}`, "w");
  for (let id = 2; id <= 17; id++) hub.answer("w", id, `answer ${id}`);
  assert.equal(hub.stats().messages, MAX_DISCUSSION_MESSAGES);

  hub.answer("w", 1, "answered at the hard bound");
  assert.equal(hub.stats().oldestId, 1, "the read broadcast being answered stays");
  const orphan = hub.thread("w", 2);
  assert.deepEqual([orphan.missing, orphan.answers.map((message) => message.id)], [true, [113]], "a read answered question went; its answer still routes");

  let answers = 16;
  for (let id = 18; id <= 112; id++) {
    hub.answer("w", id, `answer ${id}`);
    answers++;
    assert.ok(hub.stats().messages <= MAX_DISCUSSION_MESSAGES);
  }
  assert.equal(hub.unread("s").unread, answers, "every unread answer survived");
});

test("the byte bound holds for multibyte text and keeps the newest messages", () => {
  const hub = hubWith(["s", "scout"], ["w", "worker"]);
  for (let i = 0; i < 64; i++) {
    hub.ask("w", "界".repeat(MAX_DISCUSSION_TEXT));
    hub.list("s");
    hub.list(MODERATOR);
    assert.ok(hub.stats().bytes <= MAX_DISCUSSION_BYTES, "byte bound broken at message " + (i + 1));
  }
  const stats = hub.stats();
  assert.equal(stats.newestId, 64);
  assert.ok(stats.messages > 0 && stats.messages < 32, "multibyte text hits the byte bound long before the count bound");
});

test("memory stays bounded and traffic keeps flowing under sustained random load", () => {
  const keys = [MODERATOR, "a", "b", "c"];
  const hub = hubWith(["a", "alpha"], ["b", "beta"], ["c", "gamma"]);
  let seed = 7;
  const random = (limit: number) => (seed = (seed * 48271) % 2147483647) % limit;
  for (let step = 0; step < 3000; step++) {
    const key = keys[random(keys.length)]!;
    const roll = random(10);
    try {
      if (roll < 4) hub.ask(key, "q".repeat(random(MAX_DISCUSSION_TEXT) + 1), random(2) ? keys[random(keys.length)] : undefined);
      else if (roll < 7) {
        const waiting = hub.pending(key).waiting;
        if (waiting.length) hub.answer(key, waiting[random(waiting.length)]!, "界".repeat(random(800) + 1));
      } else hub.list(key);
    } catch (error) {
      assert.ok(error instanceof DiscussionError, String(error));
    }
    const stats = hub.stats();
    assert.ok(stats.messages <= MAX_DISCUSSION_MESSAGES && stats.bytes <= MAX_DISCUSSION_BYTES, "bound broken at step " + step);
  }
  assert.ok(hub.stats().newestId! > 1000, "capacity errors never wedge the discussion for good");
});

test("retire revokes an agent and releases what waited on it; clear keeps only the moderator", () => {
  const hub = hubWith(["s", "scout"], ["w", "worker"]);
  hub.ask("s", "for the worker", "w");
  hub.ask("w", "from the worker");
  hub.retire("w");
  hub.retire(MODERATOR);
  assert.deepEqual([hub.has("w"), hub.has(MODERATOR)], [false, true], "the moderator cannot be retired");
  assert.throws(() => hub.list("w"), /Unknown discussion agent/);
  assert.throws(() => hub.ask("s", "again", "w"), /Unknown discussion target/);
  assert.deepEqual(hub.list("s").messages.map(messageLine), ["[d2] Q · worker: from the worker"], "a retired sender keeps its name");

  for (let i = 0; i < 110; i++) hub.ask(MODERATOR, "fill", "s");
  // The moderator's first ask piggybacked the worker's broadcast, so that read broadcast goes first.
  hub.ask(MODERATOR, "one more", "s");
  hub.ask(MODERATOR, "and another", "s");
  assert.equal(hub.stats().oldestId, 3, "a question to a retired agent no longer blocks eviction");

  hub.clear();
  assert.deepEqual(hub.stats(), { agents: 0, messages: 0, bytes: 0, unanswered: 0, unread: 0 });
  assert.deepEqual([hub.has("s"), hub.has(MODERATOR)], [false, true]);
});

test("pending summarizes open work without bodies; only the moderator sees the fleet", () => {
  const hub = hubWith(["s", "scout"], ["w", "worker"]);
  hub.ask("s", "private one", "w");
  hub.ask("w", "private two");
  hub.ask(MODERATOR, "private three", "s");
  const worker = hub.pending("w");
  assert.deepEqual(worker, { unread: 0, waiting: [1], open: [2], messages: 3, bytes: worker.bytes });
  const moderator = hub.pending(MODERATOR);
  assert.deepEqual(moderator, {
    unread: 0, waiting: [2], open: [3], messages: 3, bytes: moderator.bytes,
    agents: [{ label: "scout", unread: 2 }],
    unanswered: { total: 3, questions: [{ id: 1, from: "scout", to: "worker" }, { id: 2, from: "worker" }, { id: 3, from: MODERATOR, to: "scout" }] }
  });
  assert.doesNotMatch(JSON.stringify([worker, moderator]), /private/);
});
