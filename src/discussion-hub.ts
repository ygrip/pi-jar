import { cleanText } from "./status.ts";

/** The moderator's fixed identity; subagents are registered under their delegate registry key. */
export const MODERATOR = "moderator";
export const MAX_DISCUSSION_MESSAGES = 128;
export const MAX_DISCUSSION_TEXT = 1600;
export const MAX_DISCUSSION_BYTES = 128 * 1024;
/** Questions stop this far below the hard bounds, so there is always room to answer: answering is the
 *  progress a capacity error demands, and it must never be blocked by the questions it would resolve. */
const ANSWER_RESERVE_MESSAGES = 16;
const ANSWER_RESERVE_BYTES = 16 * 1024;
/** The delegate registry bounds live agents; this only guards against a missed retire. */
const MAX_DISCUSSION_AGENTS = 64;
/** A list reply never exceeds this, however many messages match; each listed message is clipped too. */
export const MAX_LIST_CHARS = 4000;
export const MAX_LISTED_TEXT = 400;
/** A turn-start notice carries at most this much unread mail; the rest stays one `list` away. */
export const MAX_NOTICE_CHARS = 2000;
/** Unread mail piggybacked on an ask/answer reply never exceeds this. */
const MAX_PIGGYBACK_CHARS = 1000;
const BROADCAST: Record<string, true> = { all: true, "*": true, everyone: true, broadcast: true };

/** A rejected discussion operation; its message is terse, safe to show the model, and never echoes text. */
export class DiscussionError extends Error {}

/** A message as one agent is shown it: identities are display labels, text may be clipped. */
export interface MessageView { id: number; kind: "question" | "answer"; from: string; to?: string; replyTo?: number; text: string }
/** `delivered` is unread mail piggybacked on the reply (and now read); `unread` is what is still unread. */
export interface PostResult { id: number; to?: string; replyTo?: number; clipped: boolean; delivered: MessageView[]; unread: number }
export interface ListResult { messages: MessageView[]; more: number; latest?: number; unread: number }
export interface ThreadResult { id: number; missing: boolean; question?: MessageView; answers: MessageView[]; more: number }
export interface PendingResult {
  unread: number;
  /** Unanswered questions addressed to the caller (directly or by broadcast). */
  waiting: number[];
  /** The caller's own unanswered questions. */
  open: number[];
  messages: number;
  bytes: number;
  /** Moderator only: who has unread mail, and the oldest unanswered questions. No bodies. */
  agents?: Array<{ label: string; unread: number }>;
  unanswered?: { total: number; questions: Array<{ id: number; from: string; to?: string }> };
}
export interface UnreadResult { unread: number; newest?: number }
export interface HubStats { agents: number; messages: number; bytes: number; unanswered: number; unread: number; oldestId?: number; newestId?: number }

/** `cursor` covers every id at or below it; `seen` holds reads above it (thread, since), never more than retained ids. */
interface Agent { key: string; name: string; cursor: number; seen: Set<number> }
interface Stored {
  id: number;
  kind: "question" | "answer";
  from: string;
  fromName: string;
  text: string;
  bytes: number;
  /** Targeted question; absent means broadcast. */
  to?: string;
  toName?: string;
  /** Question: who answered it. Outlives evicted answers, so an answered question never looks open again. */
  answerers?: Set<string>;
  replyTo?: number;
  /** Answer: routes to the asker even after its question is evicted. */
  asker?: string;
}

const PENDING_LIMIT = 16;
const kib = (bytes: number) => (bytes / 1024).toFixed(1);
const utf8 = (value: string | undefined) => value ? Buffer.byteLength(value, "utf8") : 0;
/** Encoded size: UTF-8 text and identities plus a fixed allowance for id/kind/reference framing. */
const encodedSize = (message: Stored) => 64 + utf8(message.text) + utf8(message.from) + utf8(message.fromName)
  + utf8(message.to) + utf8(message.toName) + utf8(message.asker);

/** Accepts 12, "12", "d12" and "#d12"; ids render as d12. */
export function parseDiscussionId(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const match = typeof value === "string" ? /^\s*#?d?(\d{1,15})\s*$/i.exec(value) : null;
  return match ? Number(match[1]) : undefined;
}

export function messageLine(view: MessageView): string {
  return view.kind === "question"
    ? `[d${view.id}] Q · ${view.from}${view.to ? " → " + view.to : ""}: ${view.text}`
    : `[d${view.id}] A · ${view.from} → d${view.replyTo}: ${view.text}`;
}

/**
 * Session-local discussion state, owned by the parent and touched only synchronously, so ordering is
 * the call order: no locks, no files, no retries. Each agent gets the mail relevant to it (questions to
 * it, broadcasts, answers to its questions; never its own) through a per-agent read cursor.
 */
export class DiscussionHub {
  private readonly agents = new Map<string, Agent>();
  /** Lower-cased live agent names → count, so labels know when a name alone is ambiguous. */
  private readonly names = new Map<string, number>();
  private readonly byId = new Map<number, Stored>();
  private messages: Stored[] = [];
  private lastId = 0;
  private size = 0;
  /** Bumped on every state change, so an owner repaints only when something moved. */
  revision = 0;

  constructor() { this.register(MODERATOR, MODERATOR); }

  has(key: string): boolean { return this.agents.has(key); }

  /** Idempotent per key. A new agent's cursor starts at the newest id, so it never ingests earlier chatter. */
  register(key: string, name: string): void {
    const label = cleanText(name, 48) || key;
    const agent = this.agents.get(key);
    if (agent) {
      if (agent.name === label) return;
      this.count(agent.name, -1);
      agent.name = label;
      this.count(label, 1);
      this.revision++;
      return;
    }
    if (this.agents.size > MAX_DISCUSSION_AGENTS) throw new DiscussionError("Discussion agent limit reached.");
    this.agents.set(key, { key, name: label, cursor: this.lastId, seen: new Set() });
    this.count(label, 1);
    this.revision++;
  }

  /** Permanent. The mailbox goes; the agent's messages stay until normal retention evicts them. */
  retire(key: string): void {
    const agent = this.agents.get(key);
    if (!agent || key === MODERATOR) return;
    this.agents.delete(key);
    this.count(agent.name, -1);
    this.revision++;
  }

  /** Drops every message and subagent. Ids keep counting, so a stale reference never aliases a new message. */
  clear(): void {
    this.agents.clear();
    this.names.clear();
    this.byId.clear();
    this.messages = [];
    this.size = 0;
    this.register(MODERATOR, MODERATOR);
    this.revision++;
  }

  ask(from: string, text: string, to?: string): PostResult {
    const sender = this.agent(from);
    const body = this.body(text);
    const target = this.target(sender, to);
    const message: Stored = {
      id: this.lastId + 1, kind: "question", from: sender.key, fromName: sender.name, text: body.text, bytes: 0, answerers: new Set(),
      ...(target ? { to: target.key, toName: target.name } : {})
    };
    this.append(message);
    return { id: message.id, ...(target ? { to: this.label(target.key, target.name) } : {}), clipped: body.clipped, ...this.deliver(sender) };
  }

  answer(from: string, questionId: number, text: string): PostResult {
    const sender = this.agent(from);
    const body = this.body(text);
    const question = this.byId.get(questionId);
    if (question?.kind === "answer") throw new DiscussionError(`d${questionId} is an answer; answer its question d${question.replyTo}.`);
    if (!question) throw new DiscussionError(`Unknown discussion question d${questionId}.`);
    const message: Stored = {
      id: this.lastId + 1, kind: "answer", from: sender.key, fromName: sender.name, text: body.text, bytes: 0,
      replyTo: question.id, asker: question.from
    };
    this.append(message, question.id);
    question.answerers!.add(sender.key);
    return { id: message.id, replyTo: question.id, clipped: body.clipped, ...this.deliver(sender) };
  }

  /** Unread mail, oldest first within the reply budget; the cursor moves past what was shown, so paging
   *  loses nothing. `since` rereads relevant messages newer than an id, read or not. */
  list(key: string, since?: number, budget = MAX_LIST_CHARS): ListResult {
    const agent = this.agent(key);
    const items = this.messages.filter((message) => this.relevant(agent, message)
      && (since === undefined ? !this.read(agent, message) : message.id > since));
    const { views, shown } = this.select(items, MAX_LISTED_TEXT, budget);
    this.markRead(agent, shown);
    const latest = this.messages.at(-1)?.id;
    return { messages: views, more: items.length - views.length, ...(latest ? { latest } : {}), unread: this.unreadOf(agent).length };
  }

  /** One question and its answers in full, oldest first within the reply budget. Marks only those
   *  messages read: unrelated unread mail stays unread. An answer id reads its question's thread. */
  thread(key: string, questionId: number, since?: number): ThreadResult {
    const agent = this.agent(key);
    const named = this.byId.get(questionId);
    const root = named?.kind === "answer" ? named.replyTo! : questionId;
    const question = this.byId.get(root);
    const answers = this.messages.filter((message) => message.replyTo === root);
    if (!question && !answers.length) throw new DiscussionError(`Unknown discussion question d${questionId}.`);
    const items = [...(question ? [question] : []), ...answers].filter((message) => since === undefined || message.id > since);
    const { views, shown } = this.select(items, MAX_DISCUSSION_TEXT);
    this.markRead(agent, shown.filter((message) => this.relevant(agent, message)));
    const head = question && shown[0] === question ? views[0] : undefined;
    return { id: root, missing: !question, ...(head ? { question: head } : {}), answers: head ? views.slice(1) : views, more: items.length - views.length };
  }

  pending(key: string): PendingResult {
    const agent = this.agent(key);
    const open = this.messages.filter((message) => message.kind === "question" && message.answerers!.size === 0);
    const result: PendingResult = {
      unread: this.unreadOf(agent).length,
      waiting: open.filter((message) => this.relevant(agent, message)).map((message) => message.id),
      open: open.filter((message) => message.from === agent.key).map((message) => message.id),
      messages: this.messages.length,
      bytes: this.size
    };
    if (agent.key !== MODERATOR) return result;
    const agents = [...this.agents.values()].filter((other) => other.key !== MODERATOR)
      .map((other) => ({ label: this.label(other.key, other.name), unread: this.unreadOf(other).length }))
      .filter((entry) => entry.unread > 0).slice(0, PENDING_LIMIT);
    const questions = open.slice(0, PENDING_LIMIT).map((message) => ({
      id: message.id, from: this.label(message.from, message.fromName), ...(message.to ? { to: this.label(message.to, message.toName!) } : {})
    }));
    return { ...result, agents, unanswered: { total: open.length, questions } };
  }

  /** `except` leaves that sender's mail out, so the moderator's view of a subagent's mailbox never echoes its own messages. */
  unread(key: string, except?: string): UnreadResult {
    const unread = this.unreadOf(this.agent(key)).filter((message) => message.from !== except);
    return { unread: unread.length, ...(unread.length ? { newest: unread.at(-1)!.id } : {}) };
  }

  stats(): HubStats {
    let unread = 0;
    for (const agent of this.agents.values()) unread += this.unreadOf(agent).length;
    const first = this.messages[0];
    const last = this.messages.at(-1);
    return {
      agents: this.agents.size - 1,
      messages: this.messages.length,
      bytes: this.size,
      unanswered: this.messages.filter((message) => message.kind === "question" && message.answerers!.size === 0).length,
      unread,
      ...(first && last ? { oldestId: first.id, newestId: last.id } : {})
    };
  }

  private agent(key: string): Agent {
    const agent = this.agents.get(key);
    if (!agent) throw new DiscussionError("Unknown discussion agent.");
    return agent;
  }

  private body(text: string): { text: string; clipped: boolean } {
    const full = cleanText(text, MAX_DISCUSSION_TEXT + 1);
    if (!full) throw new DiscussionError("Discussion text is required.");
    return { text: full.slice(0, MAX_DISCUSSION_TEXT).trimEnd(), clipped: full.length > MAX_DISCUSSION_TEXT };
  }

  /** A key, `moderator`, or a unique case-insensitive name; empty or `all` broadcasts. */
  private target(sender: Agent, ref: string | undefined): Agent | undefined {
    const value = cleanText(ref ?? "", 64);
    const lower = value.toLowerCase();
    if (!value || Object.hasOwn(BROADCAST, lower)) return undefined;
    let target = this.agents.get(value) ?? this.agents.get(lower);
    if (!target) {
      const matches = [...this.agents.values()].filter((agent) => agent.name.toLowerCase() === lower);
      if (matches.length > 1) throw new DiscussionError(`Ambiguous discussion target; use one of: ${matches.slice(0, 8).map((agent) => agent.key).join(", ")}.`);
      target = matches[0];
    }
    if (!target) throw new DiscussionError(`Unknown discussion target. Known: ${this.known(sender)}; omit to broadcast.`);
    if (target === sender) throw new DiscussionError("A question cannot target its sender.");
    return target;
  }

  private known(sender: Agent): string {
    const others = [...this.agents.values()].filter((agent) => agent !== sender);
    const shown = others.slice(0, 8).map((agent) => agent.key === MODERATOR ? MODERATOR : `${agent.key} (${agent.name})`);
    return (shown.join(", ") || "none") + (others.length > shown.length ? `, +${others.length - shown.length} more` : "");
  }

  /** A live agent's name, with its key when the name alone could not address it. Retired agents keep their name. */
  private label(key: string, name: string): string {
    const agent = this.agents.get(key);
    if (!agent || key === MODERATOR) return agent?.name ?? name;
    const lower = agent.name.toLowerCase();
    return (this.names.get(lower) ?? 0) > 1 || lower === MODERATOR || Object.hasOwn(BROADCAST, lower) ? `${agent.name} (${key})` : agent.name;
  }

  private count(name: string, delta: number): void {
    const lower = name.toLowerCase();
    const next = (this.names.get(lower) ?? 0) + delta;
    if (next > 0) this.names.set(lower, next); else this.names.delete(lower);
  }

  private relevant(agent: Agent, message: Stored): boolean {
    if (message.from === agent.key) return false;
    if (message.kind === "answer") return message.asker === agent.key;
    return (!message.to || message.to === agent.key) && !message.answerers!.has(agent.key);
  }

  private read(agent: Agent, message: Stored): boolean { return message.id <= agent.cursor || agent.seen.has(message.id); }

  private unreadOf(agent: Agent): Stored[] {
    return this.messages.filter((message) => !this.read(agent, message) && this.relevant(agent, message));
  }

  /** Read by every live agent it is relevant to; retired agents can no longer read anything. */
  private acknowledged(message: Stored): boolean {
    for (const agent of this.agents.values()) if (this.relevant(agent, message) && !this.read(agent, message)) return false;
    return true;
  }

  private markRead(agent: Agent, messages: readonly Stored[]): void {
    if (!messages.length) return;
    for (const message of messages) if (message.id > agent.cursor) agent.seen.add(message.id);
    this.settle(agent);
    this.revision++;
  }

  /** Move the cursor up to the first unread relevant message (or the newest id), shrinking `seen`. */
  private settle(agent: Agent): void {
    const blocked = this.messages.find((message) => message.id > agent.cursor && !agent.seen.has(message.id) && this.relevant(agent, message));
    agent.cursor = Math.max(agent.cursor, blocked ? blocked.id - 1 : this.lastId);
    for (const id of agent.seen) if (id <= agent.cursor) agent.seen.delete(id);
  }

  /** Unread mail rides on an ask/answer reply only when all of it fits; otherwise only its count does. */
  private deliver(agent: Agent): { delivered: MessageView[]; unread: number } {
    const unread = this.unreadOf(agent);
    const views = unread.map((message) => this.view(message, MAX_LISTED_TEXT));
    if (!views.length || views.reduce((size, view) => size + messageLine(view).length + 1, 0) > MAX_PIGGYBACK_CHARS) {
      this.settle(agent);
      return { delivered: [], unread: unread.length };
    }
    this.markRead(agent, unread);
    return { delivered: views, unread: 0 };
  }

  private view(message: Stored, limit: number): MessageView {
    const text = message.text.length > limit ? message.text.slice(0, limit) + "…" : message.text;
    const from = this.label(message.from, message.fromName);
    if (message.kind === "answer") return { id: message.id, kind: "answer", from, replyTo: message.replyTo!, text };
    return { id: message.id, kind: "question", from, ...(message.to ? { to: this.label(message.to, message.toName!) } : {}), text };
  }

  /** Oldest first into the budget; at least one message, so paging always progresses. */
  private select(items: readonly Stored[], limit: number, budget = MAX_LIST_CHARS): { views: MessageView[]; shown: Stored[] } {
    const views: MessageView[] = [];
    let used = 0;
    for (const message of items) {
      const view = this.view(message, limit);
      const size = messageLine(view).length + 1;
      if (views.length && used + size > budget) break;
      views.push(view);
      used += size;
    }
    return { views, shown: items.slice(0, views.length) };
  }

  private append(message: Stored, replyTarget?: number): void {
    message.bytes = encodedSize(message);
    const question = message.kind === "question";
    const evicted = this.eviction(message.bytes,
      question ? MAX_DISCUSSION_MESSAGES - ANSWER_RESERVE_MESSAGES : MAX_DISCUSSION_MESSAGES,
      question ? MAX_DISCUSSION_BYTES - ANSWER_RESERVE_BYTES : MAX_DISCUSSION_BYTES, replyTarget);
    if (!evicted) {
      throw new DiscussionError(`Discussion is full: ${this.messages.length} retained messages (${(this.size / 1024).toFixed(1)} KiB) are unread or awaiting answers. `
        + `Answer or list pending messages (jar_discuss pending) before ${question ? "asking" : "answering"} more.`);
    }
    if (evicted.length) this.remove(new Set(evicted.map((item) => item.id)));
    this.lastId = message.id;
    this.messages.push(message);
    this.byId.set(message.id, message);
    this.size += message.bytes;
    this.revision++;
  }

  /**
   * What to evict so one more message fits the limits, by priority: answered groups everyone relevant has
   * read, then read broadcasts, then any other read message, oldest first. Unread mail, a question awaiting
   * a live target and the question being answered are never evicted; undefined means only they remain.
   */
  private eviction(bytes: number, maxMessages: number, maxBytes: number, replyTarget?: number): Stored[] | undefined {
    let count = this.messages.length + 1;
    let size = this.size + bytes;
    const fits = () => count <= maxMessages && size <= maxBytes;
    const chosen: Stored[] = [];
    if (fits()) return chosen;
    const taken = new Set<number>();
    const take = (items: readonly Stored[]) => {
      for (const item of items) { taken.add(item.id); chosen.push(item); count--; size -= item.bytes; }
    };
    // A question and its answers form one group; answers whose question was evicted form their own.
    const groups = new Map<number, Stored[]>();
    for (const message of this.messages) {
      const root = message.replyTo ?? message.id;
      const group = groups.get(root);
      if (group) group.push(message); else groups.set(root, [message]);
    }
    // Never evicted: unread mail, the question being answered, and an unanswered question still waiting on a live target.
    const disposable = (message: Stored) => message.id !== replyTarget && this.acknowledged(message);
    for (const [root, group] of groups) {
      if (fits()) return chosen;
      const question = this.byId.get(root);
      if ((!question || question.answerers!.size > 0) && group.every(disposable)) take(group);
    }
    for (const [root, group] of groups) {
      if (fits()) return chosen;
      const question = this.byId.get(root);
      if (question && !question.to && question.answerers!.size === 0 && group.every(disposable)) take(group);
    }
    for (const message of this.messages) {
      if (fits()) return chosen;
      const awaiting = message.kind === "question" && !!message.to && message.answerers!.size === 0 && this.agents.has(message.to);
      if (!taken.has(message.id) && !awaiting && disposable(message)) take([message]);
    }
    return fits() ? chosen : undefined;
  }

  private remove(ids: ReadonlySet<number>): void {
    this.messages = this.messages.filter((message) => !ids.has(message.id));
    for (const id of ids) {
      this.size -= this.byId.get(id)!.bytes;
      this.byId.delete(id);
    }
    for (const agent of this.agents.values()) for (const id of ids) agent.seen.delete(id);
  }
}
