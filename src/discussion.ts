import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DiscussionError, DiscussionHub, MAX_DISCUSSION_BYTES, MAX_DISCUSSION_MESSAGES, MAX_DISCUSSION_TEXT, MAX_LIST_CHARS, messageLine,
  MODERATOR, parseDiscussionId, type ListResult, type PendingResult, type PostResult, type ThreadResult, type UnreadResult
} from "./discussion-hub.ts";
import { cleanText } from "./status.ts";

export const SUBAGENT_KEY_ENV = "PI_JAR_SUBAGENT_KEY";
export const SUBAGENT_NAME_ENV = "PI_JAR_SUBAGENT_NAME";
export const DISCUSSION_ENDPOINT_ENV = "PI_JAR_DISCUSSION_ENDPOINT";
/** Session-local capability that maps a child's requests to the identity the parent registered. Never logged. */
export const DISCUSSION_TOKEN_ENV = "PI_JAR_DISCUSSION_TOKEN";
/** Everything a child inherits for discussion; scrubbed from the parent's own env before each spawn. */
export const DISCUSSION_ENV_KEYS: readonly string[] = [DISCUSSION_ENDPOINT_ENV, DISCUSSION_TOKEN_ENV, SUBAGENT_KEY_ENV, SUBAGENT_NAME_ENV];
/** Custom message type of the unread notice injected at a natural turn boundary. */
export const DISCUSSION_NOTICE = "pi-jar.discussion-notice";

export interface DiscussionStats {
  transport: "broker";
  listening: boolean;
  agents: number;
  messages: number;
  maxMessages: number;
  bytes: number;
  maxBytes: number;
  unanswered: number;
  unread: number;
  oldestId?: number;
  newestId?: number;
  requests: number;
  errors: number;
}

/** One agent's view of the broker: in-process for the moderator, local IPC for a subagent. */
export interface DiscussionTransport {
  ask(text: string, to?: string): Promise<PostResult>;
  answer(questionId: number, text: string): Promise<PostResult>;
  list(since?: number): Promise<ListResult>;
  thread(questionId: number, since?: number): Promise<ThreadResult>;
  pending(): Promise<PendingResult>;
  unread(): Promise<UnreadResult>;
}

/** A 1600-character message JSON-escapes to well under this; anything larger is not from our client. */
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_REPLY_BYTES = 256 * 1024;
const MAX_CONNECTIONS = 64;
const IO_TIMEOUT_MS = 5_000;
const SOCKET_NAME = "broker.sock";
/** macOS caps a Unix socket path near 104 bytes. */
const MAX_SOCKET_PATH = 100;

type Reply = { ok: true; result: unknown } | { ok: false; error: string };
type Request = (op: string, args: Record<string, unknown>) => Promise<unknown>;

const transportOf = (request: Request): DiscussionTransport => ({
  ask: (text, to) => request("ask", to === undefined ? { text } : { text, to }) as Promise<PostResult>,
  answer: (questionId, text) => request("answer", { questionId, text }) as Promise<PostResult>,
  list: (since) => request("list", since === undefined ? {} : { since }) as Promise<ListResult>,
  thread: (questionId, since) => request("thread", since === undefined ? { questionId } : { questionId, since }) as Promise<ThreadResult>,
  pending: () => request("pending", {}) as Promise<PendingResult>,
  unread: () => request("unread", {}) as Promise<UnreadResult>
});

/** Shared by the tool adapter and the broker, so a bad id is rejected the same way on both sides. */
function idArgument(value: unknown, name: string, required: boolean): number | undefined {
  if (value === undefined || value === "") {
    if (required) throw new DiscussionError(`${name} is required (e.g. d12).`);
    return undefined;
  }
  const id = parseDiscussionId(value);
  if (id === undefined) throw new DiscussionError(`${name} must be a discussion id like d12.`);
  return id;
}

/**
 * Parent-owned discussion broker: the in-memory hub behind a local IPC endpoint (a Unix socket in an
 * owner-only temp directory, or a named pipe on Windows). Children connect once per call and speak one
 * newline-delimited JSON request/reply; each is authenticated by its own session token, so a child can
 * never choose its identity. The socket is the only file it ever creates; nothing polls.
 */
export class DiscussionBroker {
  /** Called after any change (new message, read, agent registered or retired), for a cheap repaint. */
  onChange?: () => void;
  private readonly hub = new DiscussionHub();
  private notified = this.hub.revision;
  /** token → agent key, and key → token so childEnv is idempotent per key. */
  private readonly keys = new Map<string, string>();
  private readonly tokens = new Map<string, string>();
  private readonly sockets = new Set<Socket>();
  private server?: Server;
  /** start/close run strictly one after another, so a session replacement can never interleave them. */
  private lifecycle: Promise<void> = Promise.resolve();
  private dir?: string;
  private endpoint?: string;
  private localTransport?: DiscussionTransport;
  private requests = 0;
  private errors = 0;
  /** A crash that skips close() must still not leave the socket directory behind. */
  private readonly removeOnExit = () => {
    try { this.removeEndpoint(); } catch { /* the process is exiting; there is no one left to report to */ }
  };

  /** Idempotent: creates the endpoint and starts accepting connections. */
  start(): Promise<void> {
    return this.serial(async () => { if (!this.server) await this.listen(); });
  }

  /** Registers the agent (idempotent per key) and returns the env its child process needs. Endpoint and
   *  token are omitted until the broker is started, so that child reports the broker unavailable. */
  childEnv(key: string, name: string): Record<string, string> {
    const env: Record<string, string> = { [SUBAGENT_KEY_ENV]: key, [SUBAGENT_NAME_ENV]: name };
    // The moderator's identity is never handed to a child.
    if (key === MODERATOR) return env;
    try { this.hub.register(key, name); }
    catch (error) {
      if (!(error instanceof DiscussionError)) throw error;
      // Past the agent cap the delegation still starts; only its jar_discuss reports the broker unavailable.
      this.errors++;
      return env;
    }
    let token = this.tokens.get(key);
    if (!token) {
      token = randomBytes(24).toString("base64url");
      this.tokens.set(key, token);
      this.keys.set(token, key);
    }
    this.notify();
    if (this.endpoint) Object.assign(env, { [DISCUSSION_ENDPOINT_ENV]: this.endpoint, [DISCUSSION_TOKEN_ENV]: token });
    return env;
  }

  /** Permanent: revokes the agent's token and mailbox; its messages age out through normal retention. */
  retire(key: string): void {
    const token = this.tokens.get(key);
    if (token) {
      this.tokens.delete(key);
      this.keys.delete(token);
    }
    this.hub.retire(key);
    this.notify();
  }

  unreadFor(key: string): number { return this.hub.has(key) ? this.hub.unread(key).unread : 0; }

  stats(): DiscussionStats {
    return {
      transport: "broker", listening: this.server?.listening ?? false, ...this.hub.stats(),
      maxMessages: MAX_DISCUSSION_MESSAGES, maxBytes: MAX_DISCUSSION_BYTES, requests: this.requests, errors: this.errors
    };
  }

  /** Stops serving, removes the endpoint and drops all state and counters; start() may be called again. */
  close(): Promise<void> {
    return this.serial(async () => {
      const server = this.server;
      this.server = undefined;
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      this.removeEndpoint();
      this.tokens.clear();
      this.keys.clear();
      this.hub.clear();
      this.requests = 0;
      this.errors = 0;
      this.notify();
    });
  }

  /** The moderator's in-process transport: the same validation and accounting as IPC, minus the socket. */
  local(): DiscussionTransport {
    this.localTransport ??= transportOf((op, args) => new Promise((resolve) => resolve(this.call(MODERATOR, op, args))));
    return this.localTransport;
  }

  private serial(step: () => Promise<void>): Promise<void> {
    const run = this.lifecycle.then(step);
    // The caller of `run` receives a failure; the chain itself must keep going for the next step.
    this.lifecycle = run.catch(() => undefined);
    return run;
  }

  private async listen(): Promise<void> {
    let dir: string | undefined;
    let endpoint: string;
    if (process.platform === "win32") endpoint = `\\\\.\\pipe\\pi-jar-discussion-${process.pid}-${randomBytes(8).toString("hex")}`;
    else {
      // A long TMPDIR would overflow sun_path and fail listen(); /tmp always fits.
      const base = Buffer.byteLength(join(tmpdir(), "pi-jar-discussion-XXXXXX", SOCKET_NAME)) <= MAX_SOCKET_PATH ? tmpdir() : "/tmp";
      // mkdtemp creates the directory owner-only (0700), so no other local user can reach the socket.
      dir = mkdtempSync(join(base, "pi-jar-discussion-"));
      endpoint = join(dir, SOCKET_NAME);
    }
    this.dir = dir;
    this.endpoint = endpoint;
    process.on("exit", this.removeOnExit);
    const server = createServer((socket) => this.serve(socket));
    server.maxConnections = MAX_CONNECTIONS;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.removeEndpoint();
      throw error;
    }
    // After listen, failures belong to one connection: counted and logged, never fatal to the parent.
    server.on("error", (error) => {
      this.errors++;
      console.error("pi-jar: discussion broker error", error);
    });
    // The broker alone never keeps the parent process alive.
    server.unref();
    this.server = server;
  }

  private removeEndpoint(): void {
    process.off("exit", this.removeOnExit);
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = undefined;
    this.endpoint = undefined;
  }

  private notify(): void {
    if (this.hub.revision === this.notified) return;
    this.notified = this.hub.revision;
    try { this.onChange?.(); }
    catch (error) { console.error("pi-jar: discussion change listener failed", error); } // a repaint bug must not fail the request
  }

  /** The one entry point for both transports; `key` is already authenticated. */
  private call(key: string, op: unknown, args: Record<string, unknown>): unknown {
    this.requests++;
    try {
      switch (op) {
        case "ask":
          if (typeof args.text !== "string") throw new DiscussionError("Discussion text is required.");
          if (args.to !== undefined && typeof args.to !== "string") throw new DiscussionError("to must be an agent key or name.");
          return this.hub.ask(key, args.text, args.to);
        case "answer":
          if (typeof args.text !== "string") throw new DiscussionError("Discussion text is required.");
          return this.hub.answer(key, idArgument(args.questionId, "questionId", true)!, args.text);
        case "list": return this.hub.list(key, idArgument(args.since, "since", false));
        case "thread": return this.hub.thread(key, idArgument(args.questionId, "questionId", true)!, idArgument(args.since, "since", false));
        case "pending": return this.hub.pending(key);
        case "unread": return this.hub.unread(key);
        default: throw new DiscussionError("Unknown discussion operation.");
      }
    } catch (error) {
      this.errors++;
      throw error;
    } finally {
      this.notify();
    }
  }

  /** One newline-terminated JSON request per connection, one reply line back. Nothing a peer sends can
   *  throw out of here: oversized, malformed or abandoned requests cost a counter tick, not the parent. */
  private serve(socket: Socket): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => { this.errors++; });
    // A peer that never finishes its request is an error; one that lingers after its reply is merely closed.
    socket.setTimeout(IO_TIMEOUT_MS, () => {
      if (!done) this.errors++;
      socket.destroy();
    });
    socket.on("data", (chunk: Buffer) => {
      if (done) return;
      // UTF-8 never encodes a newline inside a multi-byte sequence, so splitting raw bytes is safe.
      const newline = chunk.indexOf(10);
      const part = newline < 0 ? chunk : chunk.subarray(0, newline);
      size += part.length;
      if (size > MAX_REQUEST_BYTES) {
        done = true;
        this.requests++;
        this.errors++;
        // Destroy once the reply flushes, so a peer that keeps streaming cannot hold the connection.
        socket.end(JSON.stringify({ ok: false, error: "Discussion request too large." } satisfies Reply) + "\n", () => socket.destroy());
        return;
      }
      chunks.push(part);
      if (newline < 0) return;
      done = true;
      socket.end(JSON.stringify(this.handle(Buffer.concat(chunks).toString("utf8"))) + "\n");
    });
  }

  private handle(line: string): Reply {
    let request: unknown;
    try { request = JSON.parse(line); } catch { /* answered as malformed below */ }
    const fields = request && typeof request === "object" && !Array.isArray(request) ? request as Record<string, unknown> : undefined;
    // Identity comes only from the token the parent handed this child, never from a request field.
    const key = typeof fields?.token === "string" ? this.keys.get(fields.token) : undefined;
    if (!fields || !key) {
      this.requests++;
      this.errors++;
      return { ok: false, error: fields ? "Unauthorized discussion request." : "Malformed discussion request." };
    }
    const { token: _token, op, ...args } = fields;
    try { return { ok: true, result: this.call(key, op, args) }; }
    catch (error) {
      if (error instanceof DiscussionError) return { ok: false, error: error.message };
      console.error("pi-jar: discussion request failed", error);
      return { ok: false, error: "Discussion broker error." };
    }
  }
}

/** One connection per call: write one request line, read one reply line. No retries, no polling. */
function brokerRequest(endpoint: string, token: string, op: string, args: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const socket = createConnection(endpoint, () => socket.write(JSON.stringify({ ...args, op, token }) + "\n"));
    const settle = (error: Error | undefined, result?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.setTimeout(IO_TIMEOUT_MS, () => settle(new DiscussionError("Discussion broker unavailable (timed out).")));
    // Node's connect error names the endpoint path; the model only needs to know the broker is gone.
    socket.on("error", (error: NodeJS.ErrnoException) => settle(new DiscussionError(`Discussion broker unavailable (${error.code ?? "connection failed"}).`)));
    socket.on("close", () => settle(new DiscussionError("Discussion broker unavailable (connection closed).")));
    socket.on("data", (chunk: Buffer) => {
      const newline = chunk.indexOf(10);
      const part = newline < 0 ? chunk : chunk.subarray(0, newline);
      size += part.length;
      chunks.push(part);
      if (size > MAX_REPLY_BYTES) return settle(new DiscussionError("Discussion broker reply too large."));
      if (newline < 0) return;
      type Parsed = { ok?: unknown; result?: unknown; error?: unknown } | null;
      let reply: Parsed = null;
      try { reply = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Parsed; } catch { /* reported as malformed below */ }
      if (reply?.ok === true) settle(undefined, reply.result);
      else settle(new DiscussionError(typeof reply?.error === "string" ? reply.error : "Malformed discussion broker reply."));
    });
  });
}

/** A subagent's transport, from the env its parent broker issued; undefined outside a brokered child. */
export function discussionClientFromEnv(env: NodeJS.ProcessEnv = process.env): DiscussionTransport | undefined {
  const endpoint = env[DISCUSSION_ENDPOINT_ENV];
  const token = env[DISCUSSION_TOKEN_ENV];
  return endpoint && token ? transportOf((op, args) => brokerRequest(endpoint, token, op, args)) : undefined;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function registerDiscussionTool(pi: ExtensionAPI, transport: () => DiscussionTransport | undefined): void {
  const parameters = Type.Object({
    action: Type.Union([Type.Literal("ask"), Type.Literal("answer"), Type.Literal("list"), Type.Literal("thread"), Type.Literal("pending")]),
    text: Type.Optional(Type.String({ description: `ask/answer: one concise question or answer (≤${MAX_DISCUSSION_TEXT} chars).` })),
    to: Type.Optional(Type.String({ description: "ask: moderator, a subagent key or unique name; omit to broadcast." })),
    questionId: Type.Optional(Type.String({ description: "answer: the question being answered (e.g. d12). thread: the question to read in full." })),
    since: Type.Optional(Type.String({ description: "list: reread your messages newer than this id, read or not (d0 = all retained). thread: only answers after this id." }))
  });
  const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
  const failure = (text: string) => ({ ...reply(text), isError: true });
  pi.registerTool?.<typeof parameters, Record<string, never>>({
    name: "jar_discuss",
    label: "discuss",
    description: `Parent-brokered Q/A between this session's moderator and subagents; not a transcript, and it never wakes anyone. ask/answer reply with the new id only. list returns only unread messages for you: questions to you, broadcasts, answers to your questions (≤${MAX_LIST_CHARS} chars).`,
    promptSnippet: "Ask or answer one concrete cross-agent question through the session discussion broker.",
    promptGuidelines: [
      "jar_discuss: one precise question or answer per call. ask to moderator, a subagent key or unique name, or omit to to broadcast; answer needs the questionId. Replies never echo your text.",
      "Answers to your questions also arrive on your next ask/answer. list shows only unread messages for you; thread reads one question in full; pending summarizes open items. Don't poll."
    ],
    parameters,
    async execute(_id, params) {
      const broker = transport();
      if (!broker) return failure("Discussion broker unavailable: this session has no Pi Jar moderator broker.");
      try {
        // `list` with a questionId keeps its old meaning: read that one thread.
        const action = params.action === "list" && params.questionId ? "thread" : params.action;
        if (action === "ask" || action === "answer") {
          // One past the cap, so the broker can report clipping without receiving an unbounded string.
          const text = cleanText(params.text ?? "", MAX_DISCUSSION_TEXT + 1);
          if (!text) return failure("Discussion text is required.");
          const answering = action === "answer" ? idArgument(params.questionId, "questionId", true)! : undefined;
          const result = answering === undefined ? await broker.ask(text, params.to) : await broker.answer(answering, text);
          const notes = [result.to ? `→ ${result.to}` : "", result.clipped ? `clipped to ${MAX_DISCUSSION_TEXT} chars` : ""].filter(Boolean).join("; ");
          const head = (answering === undefined ? `Added d${result.id}` : `Answered d${answering} as d${result.id}`) + (notes ? ` (${notes}).` : ".");
          const delivered = result.delivered.length ? "\n" + result.delivered.map(messageLine).join("\n")
            : result.unread ? `\n(${plural(result.unread, "unread message")}; list to read)` : "";
          return reply(head + delivered);
        }
        if (action === "pending") {
          const result = await broker.pending();
          const lines = [`Unread for you: ${result.unread}${result.unread ? " (list to read)" : ""}.`];
          for (const [label, ids] of [["Waiting on you", result.waiting], ["Your unanswered questions", result.open]] as const) {
            if (ids.length) lines.push(`${label}: ${ids.slice(0, 16).map((id) => "d" + id).join(", ")}${ids.length > 16 ? `, +${ids.length - 16} more` : ""}.`);
          }
          if (result.agents?.length) lines.push(`Unread by agent: ${result.agents.map((agent) => `${agent.label} ${agent.unread}`).join(" · ")}.`);
          if (result.unanswered?.total) {
            const shown = result.unanswered.questions.map((question) => `d${question.id} ${question.from}${question.to ? " → " + question.to : ""}`);
            lines.push(`Unanswered: ${result.unanswered.total} (${shown.join(" · ")}${result.unanswered.total > shown.length ? " · …" : ""}).`);
          }
          lines.push(`Retained: ${result.messages}/${MAX_DISCUSSION_MESSAGES} messages, ${(result.bytes / 1024).toFixed(1)}/${MAX_DISCUSSION_BYTES / 1024} KiB.`);
          return reply(lines.join("\n"));
        }
        const since = idArgument(params.since, "since", false);
        if (action === "thread") {
          const result = await broker.thread(idArgument(params.questionId, "questionId", true)!, since);
          const lines = [
            ...(result.missing && since === undefined ? [`(question d${result.id} is no longer retained)`] : []),
            ...(result.question ? [messageLine(result.question)] : []),
            ...result.answers.map(messageLine)
          ];
          if (since === undefined && !result.answers.length && !result.more) lines.push("(no answers yet)");
          if (!lines.length) lines.push(`No answers newer than d${since}.`);
          const last = result.answers.at(-1)?.id ?? result.question?.id;
          if (result.more) lines.push(`(${plural(result.more, "more answer")}; thread since d${last})`);
          return reply(lines.join("\n"));
        }
        const result = await broker.list(since);
        if (!result.messages.length) {
          return reply(since === undefined ? `No unread messages${result.latest ? ` (latest d${result.latest})` : ""}.` : `No messages for you newer than d${since}.`);
        }
        const more = result.more ? `\n(${result.more} more${since === undefined ? " unread; list again" : `; list since d${result.messages.at(-1)!.id}`})` : "";
        return reply(result.messages.map(messageLine).join("\n") + more);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    }
  });

  // At a natural boundary only: a hidden notice joins the turn that is starting anyway. Discussion
  // traffic never sends a message or triggers a turn, so agents cannot wake each other into a loop.
  let notified: number | undefined;
  pi.on?.("before_agent_start", async () => {
    const broker = transport();
    if (!broker) return;
    let state: UnreadResult;
    // Advisory only: a broker failure surfaces on the agent's next jar_discuss call instead of delaying this turn.
    try { state = await broker.unread(); } catch { return; }
    // Once per newest unread message: ignored mail is not re-announced every turn.
    if (!state.unread || state.newest === notified) return;
    notified = state.newest;
    return { message: { customType: DISCUSSION_NOTICE, display: false,
      content: `You have ${plural(state.unread, "unread discussion message")}. Use jar_discuss list when relevant.` } };
  });
}
