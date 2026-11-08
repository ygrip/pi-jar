import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, createModels, InMemoryCredentialStore, normalizeContext,
  type Provider, type Model, type Api, type AssistantMessage, type OAuthCredential } from "@earendil-works/pi-ai";
import { AccountStore } from "../src/account-store.ts";
import { AccountRouter } from "../src/account-router.ts";
import type { AccountRoutingSettings } from "../src/account-settings.ts";

const model: Model<Api> = { id: "test", name: "Test", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "https://example.invalid", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
const context = normalizeContext({ messages: [] });
const credential = (access: string, expires = 0): OAuthCredential => ({ type: "oauth", access, refresh: `refresh-${access}`, expires });

test("native OAuth refresh is locked per account, quota probes coalesce, main login stays untouched", async t => {
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
  assert.deepEqual(calls, Array(4).fill("b-fresh"));
  assert.deepEqual(refreshed.sort(), ["a", "b"]);
  assert.equal(lookups, 2);
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
  await ready; abort.abort();
  assert.equal((await cancelled).stopReason, "aborted");
  release();
  assert.equal((await healthy).stopReason, "stop");
  assert.equal(pendingLookups, 2);

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
