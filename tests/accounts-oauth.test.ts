import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, createModels, InMemoryCredentialStore, normalizeContext,
  type Provider, type Model, type Api, type AssistantMessage, type OAuthCredential } from "@earendil-works/pi-ai";
import { AccountStore } from "../src/account-store.ts";
import { AccountRouter } from "../src/account-router.ts";
import { Accounts } from "../src/accounts.ts";
import type { AccountRoutingSettings } from "../src/account-settings.ts";

const model: Model<Api> = { id: "test", name: "Test", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "https://example.invalid", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
const context = normalizeContext({ messages: [] });
const credential = (access: string, expires = 0): OAuthCredential => ({ type: "oauth", access, refresh: `refresh-${access}`, expires });

test("native OAuth refresh is locked per account, quota probes coalesce, main login stays untouched", { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "jar-oauth-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new AccountStore(directory);
  const refreshed: string[] = []; const calls: string[] = [];
  const provider: Provider = {
    id: "anthropic", name: "OAuth Test", getModels: () => [model],
    auth: { oauth: { name: "OAuth", login: async interaction => credential(await interaction.prompt({ type: "text", message: "token" })),
      refresh: async current => {
        assert.notEqual(current.access, "main-expired");
        refreshed.push(current.access);
        return { ...current, access: current.access + "-fresh", expires: Date.now() + 3600_000 };
      },
      toAuth: async current => ({ apiKey: current.access }) } },
    stream: () => { throw new Error("unused"); },
    streamSimple: (_model, _context, options) => {
      calls.push(options?.apiKey ?? "missing");
      const output = createAssistantMessageEventStream();
      const result: AssistantMessage = { role: "assistant", api: model.api, model: model.id, provider: model.provider,
        content: [], stopReason: "stop", timestamp: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } } };
      output.push({ type: "done", reason: "stop", message: result }); output.end(); return output;
    }
  };
  for (const name of ["a", "b"]) {
    store.reserve(name);
    const account = { version: 1 as const, name, provider: "anthropic", auth: "oauth" as const };
    const runtime = await store.models(account, provider);
    await runtime.login("anthropic", "oauth", { prompt: async () => name, notify() {} });
    store.save(account);
  }
  const primary = new InMemoryCredentialStore();
  const main = credential("main-expired");
  await primary.modify("anthropic", async () => main);
  let lookups = 0;
  const settings: AccountRoutingSettings = { mode: "quota-first", accounts: [] };
  const router = new AccountRouter(store, () => settings, Date.now, async (_id, auth) => {
    lookups++;
    const token = (await auth("anthropic"))?.auth.apiKey;
    let used = 10;
    if (token === "a-fresh") used = 100;
    return { fiveHour: { used } };
  });
  const runtime = createModels({ credentials: primary }); runtime.setProvider(router.wrap(provider));
  const results = await Promise.all(Array.from({ length: 4 }, () => runtime.streamSimple(model, context).result()));
  assert.ok(results.every(result => result.stopReason === "stop"));
  assert.equal(calls.length, 4);
  assert.ok(calls.every(key => ["a-fresh", "b-fresh"].includes(key)),
    "only named account credentials are routed, even before async quota checks complete");
  assert.deepEqual(refreshed.sort(), ["a", "b"]);
  // The first request must not await quota IO. Once background probes finish,
  // the next request can rank the cached quota snapshot deterministically.
  for (let i = 0; i < 40 && !["a", "b"].every(name => store.health(name).checkedAt); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(["a", "b"].every(name => store.health(name).checkedAt), "quota probes eventually populate shared health");
  assert.equal(lookups, 2);
  await runtime.streamSimple(model, context).result();
  assert.equal(calls.at(-1), "b-fresh", "quota-first uses cached remaining capacity");
  assert.deepEqual(await primary.read("anthropic"), main);
  assert.match(readFileSync(join(store.root, "b", "auth.json"), "utf8"), /b-fresh/);
  assert.doesNotMatch(readFileSync(join(store.root, "b", "account.json"), "utf8"), /refresh|fresh/);
  assert.ok(router.status().every(account => account.inFlight === 0));
  await runtime.streamSimple(model, context).result();
  assert.equal(lookups, 2);
  // Another process/router reuses the private shared quota cache and refreshed credentials.
  const other = new AccountRouter(store, () => settings, Date.now, async () => { throw new Error("must use cached quota"); });
  assert.equal((await other.wrap(provider).streamSimple(model, context).result()).stopReason, "stop");
  assert.equal(refreshed.length, 2);

  // Cancelling the first caller must not cancel a quota lookup shared with another request.
  store.saveHealth("a", {}); store.saveHealth("b", {});
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  let pendingLookups = 0;
  const waitingRouter = new AccountRouter(store, () => settings, Date.now, async (_id, _auth, signal) => {
    pendingLookups++;
    if (pendingLookups === 2) started();
    await gate;
    assert.equal(signal.aborted, false);
    return { fiveHour: { used: 10 } };
  });
  const waiting = waitingRouter.wrap(provider);
  const abort = new AbortController();
  const cancelled = waiting.streamSimple(model, context, { signal: abort.signal }).result();
  const healthy = waiting.streamSimple(model, context).result();
  abort.abort();
  await ready;
  assert.equal((await cancelled).stopReason, "aborted");
  // The healthy request completes while quota fetch is still deliberately held.
  assert.equal((await healthy).stopReason, "stop");
  assert.equal(pendingLookups, 2);
  release();

  // Regression: two OAuth subscriptions from the SAME provider must keep their
  // native Pi credential stores isolated while rotating and enforcing allowlists.
  store.saveHealth("a", {}); store.saveHealth("b", {});
  let policy: AccountRoutingSettings = { mode: "round-robin", accounts: [] };
  const rotating = new AccountRouter(store, () => policy, Date.now, async () => ({ fiveHour: { used: 10 } }));
  const wrapped = rotating.wrap(provider);
  const beforeRotation = calls.length;
  const first = await wrapped.streamSimple(model, context).result();
  const second = await wrapped.streamSimple(model, context).result();
  assert.equal(first.stopReason, "stop");
  assert.equal(second.stopReason, "stop");
  assert.deepEqual(calls.slice(beforeRotation), ["a-fresh", "b-fresh"],
    "round-robin must use each named OAuth identity from the same provider");
  assert.deepEqual(await primary.read("anthropic"), main, "Pi's main OAuth login remains untouched");

  policy = { mode: "round-robin", accounts: ["b"] };
  const beforeAllowlist = calls.length;
  await wrapped.streamSimple(model, context).result();
  await wrapped.streamSimple(model, context).result();
  assert.deepEqual(calls.slice(beforeAllowlist), ["b-fresh", "b-fresh"],
    "a profile allowlist cannot silently borrow another same-provider OAuth token");
});

test("account email is read locally from a Codex token without exposing credentials", t => {
  const directory = mkdtempSync(join(tmpdir(), "jar-oauth-email-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new AccountStore(directory);
  const account = { version: 1 as const, name: "work", provider: "openai-codex", auth: "oauth" as const };
  store.reserve(account.name);
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/profile": { email: "person@example.com" } })).toString("base64url");
  const path = join(store.root, account.name, "auth.json");
  writeFileSync(path, JSON.stringify({ "openai-codex": { type: "oauth", access: `header.${payload}.signature` } }), { mode: 0o600 });
  assert.equal(store.email(account), "person@example.com");
  const unsafe = Buffer.from(JSON.stringify({ email: "person\u001b[31m@example.com" })).toString("base64url");
  writeFileSync(path, JSON.stringify({ "openai-codex": { type: "oauth", access: `header.${unsafe}.signature` } }));
  assert.equal(store.email(account), undefined);
  writeFileSync(path, JSON.stringify({ "openai-codex": { type: "oauth", access: "opaque" } }));
  assert.equal(store.email(account), undefined);
  assert.equal(store.email({ ...account, provider: "anthropic" }), undefined);
});

test("explicit configured-account quota refresh works with routing off", { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "jar-oauth-explicit-quota-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new AccountStore(directory);
  const account = { version: 1 as const, name: "work", provider: "anthropic", auth: "oauth" as const };
  store.reserve(account.name);
  const provider: Provider = {
    id: "anthropic", name: "OAuth Test", getModels: () => [model],
    auth: { oauth: { name: "OAuth", login: async () => credential("work-token", Date.now() + 3600_000),
      refresh: async current => current, toAuth: async current => ({ apiKey: current.access }) } },
    stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); }
  };
  const runtime = await store.models(account, provider);
  await runtime.login("anthropic", "oauth", { prompt: async () => "unused", notify() {} });
  store.save(account);
  store.reserve("pi-anthropic");
  store.save({ version: 1, name: "pi-anthropic", provider: "anthropic", auth: "oauth", source: "native" });
  const settings: AccountRoutingSettings = { mode: "off", accounts: [] };
  let lookups = 0;
  let changed = 0;
  const router = new AccountRouter(store, () => settings, Date.now, async (_id, auth) => {
    lookups++;
    assert.equal((await auth("anthropic"))?.auth.apiKey, "work-token");
    return { fiveHour: { used: 0 } };
  });
  router.onQuotaChange = () => changed++;
  await router.refreshConfiguredQuota("anthropic", provider, true);
  assert.equal(lookups, 1, "native quota is fetched only by the shared native cache");
  assert.equal(store.health("work").quota?.fiveHour?.used, 0, "zero usage is retained");
  assert.equal(changed, 1, "settled probe notifies an open usage panel");
});

test("configured quota refresh uses the original OAuth provider while routing is enabled", async t => {
  const directory = mkdtempSync(join(tmpdir(), "jar-oauth-original-provider-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const provider: Provider = {
    id: "anthropic", name: "OAuth Test", getModels: () => [model],
    auth: { oauth: { name: "OAuth", login: async () => credential("token"),
      refresh: async current => current, toAuth: async current => ({ apiKey: current.access }) } },
    stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); }
  };
  let registered = provider;
  const settings: AccountRoutingSettings = { mode: "sticky", accounts: [] };
  const accounts = new Accounts({ registerProvider: (next: Provider) => { registered = next; } } as never,
    () => settings, () => {}, directory);
  accounts.store.reserve("work");
  accounts.store.save({ version: 1, name: "work", provider: "anthropic", auth: "oauth" });
  const ctx = { hasUI: false, modelRegistry: { getProvider: () => registered, getAll: () => [model] } };
  accounts.sync(ctx as never);
  assert.notEqual(registered, provider);
  let captured: Provider | undefined;
  accounts.router.refreshConfiguredQuota = async (_id, selected) => { captured = selected; };
  await accounts.refreshConfiguredQuota("anthropic", ctx as never);
  assert.equal(captured, provider);
});

test("sign-out waits for an in-flight native refresh in another process and the account stays disconnected", { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "jar-oauth-logout-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storeA = new AccountStore(directory);
  let releaseRefresh!: () => void, refreshStarted!: () => void;
  const gate = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const started = new Promise<void>(resolve => { refreshStarted = resolve; });
  const provider: Provider = {
    id: "anthropic", name: "OAuth Test", getModels: () => [model],
    auth: { oauth: { name: "OAuth", login: async interaction => credential(await interaction.prompt({ type: "text", message: "token" })),
      refresh: async current => {
        refreshStarted();
        await gate; // the provider call is slow; Pi holds the auth-file lock meanwhile
        return { ...current, access: "resurrected", expires: Date.now() + 3600_000 };
      },
      toAuth: async current => ({ apiKey: current.access }) } },
    stream: () => { throw new Error("unused"); },
    streamSimple: () => { throw new Error("unused"); }
  };
  storeA.reserve("work");
  const account = { version: 1 as const, name: "work", provider: "anthropic", auth: "oauth" as const };
  const runtimeA = await storeA.models(account, provider);
  await runtimeA.login("anthropic", "oauth", { prompt: async () => "old", notify() {} }); // expires: 0, so the next use refreshes
  storeA.save(account);

  const refreshing = runtimeA.getAuth("anthropic").catch(() => undefined); // process A: refresh in flight, lock held
  await started;
  const storeB = new AccountStore(directory); // process B signs out meanwhile
  let loggedOut = false;
  const signingOut = storeB.logout("work").then(() => { loggedOut = true; });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(loggedOut, false, "sign-out waits for the refresh's lock instead of deleting under it");
  releaseRefresh();
  await Promise.all([refreshing, signingOut]);

  assert.equal(storeB.hasCredentials(storeB.list()[0]!), false, "the refresh could not resurrect the signed-out identity");
  assert.equal(storeA.hasCredentials(storeA.list()[0]!), false);
  const router = new AccountRouter(storeB, () => ({ mode: "sticky", accounts: [] }));
  const result = await router.wrap(provider).streamSimple(model, context).result();
  assert.equal(result.stopReason, "error", "routing fails closed");
});
