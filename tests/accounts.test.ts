import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync, lstatSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, createModels, InMemoryCredentialStore, normalizeContext, type Provider, type Model, type Api, type AssistantMessage, type SimpleStreamOptions, type ImageModel, type ImageApi, type ClassifierModel, type ClassifierApi } from "@earendil-works/pi-ai";
import { AccountStore, mergeHealth } from "../src/account-store.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { AccountRouter, remainingQuota, retryAfter } from "../src/account-router.ts";
import { parseAccountRouting, type AccountRoutingSettings } from "../src/account-settings.ts";
import { defaultVisualSettings, loadVisualSettings, saveVisualSettings } from "../src/settings.ts";
import { ProfileStore } from "../src/profiles.ts";
import { Accounts, inheritedAccountRouting } from "../src/accounts.ts";
import { ACCOUNT_ROUTING_ENV } from "../src/account-settings.ts";
import { askRole, SideUsage } from "../src/side-model.ts";

const model: Model<Api> = { id: "test-model", name: "Test", api: "openai-completions", provider: "openai",
  baseUrl: "https://example.invalid", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
function message(key: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text: key }], api: model.api, model: model.id, provider: model.provider,
    timestamp: 1, stopReason: "stop", usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 } } };
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "jar-accounts-"));
  t.after(() => { rmSync(directory, { recursive: true, force: true }); delete process.env.JAR_TEST_A; delete process.env.JAR_TEST_B; });
  const store = new AccountStore(directory);
  for (const [name, env, key] of [["a", "JAR_TEST_A", "key-a"], ["b", "JAR_TEST_B", "key-b"]]) {
    process.env[env!] = key;
    store.reserve(name!); store.save({ version: 1, name: name!, provider: "openai", auth: "env", env });
  }
  let settings: AccountRoutingSettings = { mode: "sticky", accounts: [] };
  const calls: string[] = [];
  const requests: SimpleStreamOptions[] = [];
  let responseStatus = 200;
  let partial = false;
  const provider: Provider = {
    id: "openai", name: "Test", auth: { apiKey: { name: "Default", resolve: async () => ({ auth: { apiKey: "primary" } }) } },
    getModels: () => [model],
    stream: (m, c, o) => provider.streamSimple(m, c, o as SimpleStreamOptions),
    streamSimple: (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const key = options?.apiKey ?? "missing";
        calls.push(key);
        requests.push(options ?? {});
        await options?.onPayload?.({ test: true }, _model);
        const status = responseStatus;
        responseStatus = 200;
        await options?.onResponse?.({ status, headers: { "retry-after": "120" } }, _model);
        const result = { ...message(key), provider: _model.provider, model: _model.id };
        if (status !== 200 && !partial) result.content = [];
        stream.push({ type: "start", partial: result });
        if (partial) stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: result });
        if (status !== 200) {
          result.stopReason = "error"; result.errorMessage = "limited";
          result.usage = message("").usage; result.usage.totalTokens = 0; result.usage.cost.total = 0;
          stream.push({ type: "error", reason: "error", error: result });
        } else stream.push({ type: "done", reason: "stop", message: result });
        stream.end();
      })();
      return stream;
    }
  };
  const router = new AccountRouter(store, () => settings);
  return { directory, store, calls, requests, provider, router, setMode(mode: AccountRoutingSettings["mode"]) { settings = { ...settings, mode }; },
    allow(accounts: string[]) { settings = { ...settings, accounts }; },
    fail(status: number, expose = false) { responseStatus = status; partial = expose; } };
}

test("canonical provider/model IDs, hooks and usage survive account routing", async t => {
  const f = fixture(t);
  const runtime = createModels(); runtime.setProvider(f.router.wrap(f.provider));
  let payloads = 0; let responses = 0;
  const result = await runtime.streamSimple(model, context, { onPayload: () => { payloads++; }, onResponse: () => { responses++; } }).result();
  assert.equal(result.content[0]?.type, "text");
  assert.equal((result.content[0] as { text: string }).text, "key-a");
  assert.deepEqual([result.provider, result.model, result.usage.totalTokens, result.usage.cost.total, payloads, responses], ["openai", "test-model", 3, 0.2, 1, 1]);
  assert.equal(lstatSync(join(f.store.root, "a")).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(f.store.root, "a", "account.json")).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(join(f.store.root, "a", "account.json"), "utf8"), /key-a/);
});

test("routing policies preserve sticky affinity, rotate, and respect profile allowlists", async t => {
  const f = fixture(t); const provider = f.router.wrap(f.provider);
  const ask = () => provider.streamSimple(model, context).result();
  await ask(); await ask();
  f.setMode("round-robin"); await ask(); await ask();
  f.allow(["b"]); await ask();
  assert.deepEqual(f.calls, ["key-a", "key-a", "key-a", "key-b", "key-b"]);
  f.allow(["not-configured"]);
  assert.match((await ask()).errorMessage!, /No eligible openai account/);
  assert.equal(f.calls.length, 5);
  f.setMode("off");
  await ask(); assert.equal(f.calls.at(-1), "missing"); // direct provider call, no runtime auth
});

test("per-provider account pin preserves independent provider pools and automatic retry", async t => {
  const f = fixture(t);
  const otherModel: Model<Api> = { ...model, provider: "other", id: "other-model" };
  process.env.JAR_OTHER_ACCOUNT = "other-key";
  t.after(() => { delete process.env.JAR_OTHER_ACCOUNT; });
  f.store.reserve("third");
  f.store.save({ version: 1, name: "third", provider: "other", auth: "env", env: "JAR_OTHER_ACCOUNT" });
  const otherCalls: string[] = [];
  const otherProvider: Provider = {
    ...f.provider, id: "other", getModels: () => [otherModel],
    streamSimple: (_model, _context, options) => {
      otherCalls.push(options?.apiKey ?? "missing");
      const output = createAssistantMessageEventStream();
      output.push({ type: "done", reason: "stop", message: { ...message(options?.apiKey ?? "missing"), provider: "other", model: "other-model" } });
      output.end();
      return output;
    }
  };
  let config: AccountRoutingSettings = { mode: "sticky", accounts: [], pinned: { openai: "b" } };
  const router = new AccountRouter(f.store, () => config);
  assert.equal((await router.wrap(f.provider).streamSimple(model, context).result()).stopReason, "stop");
  assert.equal(f.calls.at(-1), "key-b", "pin applies to matching provider only");
  assert.equal((await router.wrap(otherProvider).streamSimple(otherModel, context).result()).stopReason, "stop");
  assert.deepEqual(otherCalls, ["other-key"], "another provider retains its own credentials");
  f.fail(429);
  const pinnedResult = await router.wrap(f.provider).streamSimple(model, context).result();
  assert.equal(pinnedResult.stopReason, "error", "explicit pin does not route to another account");
  assert.deepEqual(f.calls, ["key-b", "key-b"]);
  config = { mode: "sticky", accounts: [] };
  const resumed = await router.wrap(f.provider).streamSimple(model, context).result();
  assert.equal(resumed.stopReason, "stop");
  assert.equal(f.calls.at(-1), "key-a", "automatic routing can fall back after pinned account cooldown");
});

test("pin commands validate provider ownership, persist profile policy, and clean up on exclusion", async t => {
  const f = fixture(t);
  let config: AccountRoutingSettings = { mode: "sticky", accounts: [] };
  const notices: string[] = [];
  const accounts = new Accounts({} as never, () => config, next => { config = next; }, f.directory);
  const ctx = { ui: { notify: (message: string) => notices.push(message) } };
  accounts.pin("openai", "b", ctx as never);
  assert.deepEqual(config.pinned, { openai: "b" });
  assert.deepEqual(parseAccountRouting(JSON.parse(accounts.environment()[ACCOUNT_ROUTING_ENV]!)), config);
  await accounts.command("use a", ctx as never);
  assert.equal(config.pinned, undefined, "excluding a pin clears it rather than stranding it");
  assert.throws(() => accounts.pin("openai", "b", ctx as never), /excluded/);
  await accounts.command("use all", ctx as never);
  assert.throws(() => accounts.pin("not-openai", "b", ctx as never), /not configured for provider/);
  accounts.pin("openai", "a", ctx as never);
  accounts.pin("openai", undefined, ctx as never);
  assert.equal(config.pinned, undefined);
  assert.ok(notices.some(text => text.includes("Automatic account selection restored")));
  assert.deepEqual(parseAccountRouting({ mode: "sticky", accounts: [], pinned: { openai: "../bad" } }),
    { mode: "off", accounts: [] }, "invalid pinned identities fail closed");
});

test("429 retries once per account before output, with shared cooldown", async t => {
  const f = fixture(t); f.fail(429);
  const runtime = createModels(); runtime.setProvider(f.router.wrap(f.provider));
  const result = await runtime.streamSimple(model, context).result();
  assert.equal(result.stopReason, "stop"); assert.deepEqual(f.calls, ["key-a", "key-b"]);
  assert.ok(f.store.health("a").blockedUntil! > Date.now());
  const other = new AccountRouter(f.store, () => ({ mode: "sticky", accounts: [] }));
  await other.wrap(f.provider).streamSimple(model, context).result();
  assert.equal(f.calls.at(-1), "key-b");
});

for (const [status, partial] of [[429, true], [500, false], [401, false]] as const) {
  test(`does not replay exposed output or unrelated failures (${status}, partial=${partial})`, async t => {
    const f = fixture(t); f.fail(status, partial);
    const result = await f.router.wrap(f.provider).streamSimple(model, context).result();
    assert.equal(result.stopReason, "error"); assert.deepEqual(f.calls, ["key-a"]);
  });
}

test("exhausted windows are excluded, reset windows expire, quota-first picks most remaining", async t => {
  const f = fixture(t); f.setMode("quota-first");
  f.store.saveHealth("a", { quota: { fiveHour: { used: 95 }, week: { used: 20 } } });
  f.store.saveHealth("b", { quota: { fiveHour: { used: 20 }, week: { used: 30 } } });
  const provider = f.router.wrap(f.provider);
  await provider.streamSimple(model, context).result(); assert.equal(f.calls.at(-1), "key-b");
  f.store.saveHealth("b", { quota: { week: { used: 100 } } });
  await provider.streamSimple(model, context).result(); assert.equal(f.calls.at(-1), "key-a");
  f.store.saveHealth("a", { quota: { fiveHour: { used: 100, resetsAt: Date.now() - 1 } } });
  await provider.streamSimple(model, context).result(); assert.equal(f.calls.at(-1), "key-a");
});

test("abort does not invoke any account or fail over", async t => {
  const f = fixture(t); const abort = new AbortController(); abort.abort();
  const result = await f.router.wrap(f.provider).streamSimple(model, context, { signal: abort.signal }).result();
  assert.equal(result.stopReason, "aborted"); assert.deepEqual(f.calls, []);
});

test("broken account credentials do not prevent routing to healthy accounts", async t => {
  const f = fixture(t); delete process.env.JAR_TEST_A;
  const result = await f.router.wrap(f.provider).streamSimple(model, context).result();
  assert.equal(result.stopReason, "stop"); assert.deepEqual(f.calls, ["key-b"]);
});

test("account storage rejects traversal, symlinks and public permissions", t => {
  const f = fixture(t);
  assert.throws(() => f.store.reserve("../escape"));
  assert.throws(() => f.store.reserve("a"));
  symlinkSync(join(f.store.root, "a"), join(f.store.root, "linked"));
  assert.throws(() => f.store.list(), /not links/);
  rmSync(join(f.store.root, "linked"));
  if (process.platform !== "win32") {
    chmodSync(join(f.store.root, "a", "account.json"), 0o644);
    assert.throws(() => f.store.list(), /private/);
  }
});

test("routing settings migrate safely and persist with profiles without secrets", t => {
  const f = fixture(t);
  const settings = { ...defaultVisualSettings(), accountRouting: { mode: "quota-first" as const, accounts: ["b"] } };
  saveVisualSettings(f.directory, settings);
  assert.deepEqual(loadVisualSettings(f.directory).accountRouting, settings.accountRouting);
  const profiles = new ProfileStore(f.directory);
  const profile = profiles.add("Accounts", "pi-jar-dark", settings, { version: 2, roles: { worker: "openai/test-model" } });
  const reloaded = new ProfileStore(f.directory).list().find(item => item.id === profile.id)!;
  assert.deepEqual(reloaded.settings.accountRouting, settings.accountRouting);
  assert.equal(reloaded.roles.roles.worker, "openai/test-model");
  assert.deepEqual(parseAccountRouting({ mode: "unknown", accounts: [] }), { mode: "off", accounts: [] });
  assert.deepEqual(parseAccountRouting({ mode: "sticky", accounts: ["../escape"] }), { mode: "off", accounts: [] });
});

for (const [header, expected] of [["120", 121000], ["Thu, 01 Jan 1970 00:02:00 GMT", 120000], ["invalid", 61000]] as const) {
  test(`Retry-After supports ${header}`, () => {
    assert.equal(retryAfter({ status: 429, headers: { "Retry-After": header } }, 1000), expected);
  });
}
test("request instrumentation and non-auth options survive; primary request secrets do not", async t => {
  const f = fixture(t);
  const hook = async () => {};
  await f.router.wrap(f.provider).streamSimple(model, context, {
    apiKey: "unrelated-primary", env: { KEY: "unrelated-primary" }, headers: { Authorization: "Bearer primary", "X-Trace-Id": "trace" },
    reasoning: "high", temperature: 0.3, onProviderStreamEvent: hook
  }).result();
  const options = f.requests[0]!;
  assert.equal(options.apiKey, "key-a");
  assert.equal(options.headers?.Authorization, undefined);
  assert.equal(options.headers?.["X-Trace-Id"], "trace");
  assert.equal(options.env?.KEY, undefined);
  assert.deepEqual([options.reasoning, options.temperature, options.onProviderStreamEvent, options.maxRetries], ["high", 0.3, hook, 0]);
});

test("native request-setup failures terminate with an error without replaying", async t => {
  const f = fixture(t);
  let attempts = 0;
  const provider = { ...f.provider, streamSimple: () => { attempts++; throw new Error("setup failed"); } };
  const result = await f.router.wrap(provider).streamSimple(model, context).result();
  assert.equal(result.stopReason, "error");
  assert.equal(attempts, 1);
});

test("side-call roles route without model aliases and keep actual usage", async t => {
  const f = fixture(t); f.setMode("round-robin");
  const runtime = createModels(); runtime.setProvider(f.router.wrap(f.provider));
  const ctx = { model, modelRegistry: { find: () => model, streamSimple: runtime.streamSimple.bind(runtime) } };
  const roles = { resolve: () => ({ provider: model.provider, model: model.id }) };
  const usage = new SideUsage();
  await askRole(ctx as never, roles as never, usage, "advisor", "system", "prompt");
  await askRole(ctx as never, roles as never, usage, "worker", "system", "prompt");
  assert.deepEqual(f.calls, ["key-a", "key-b"]);
  assert.deepEqual(usage.all().map(call => [call.role, call.model, call.input, call.output, call.cost]),
    [["advisor", "openai/test-model", 2, 1, 0.2], ["worker", "openai/test-model", 2, 1, 0.2]]);
});

test("image and classifier calls share account selection while preserving native usage", async t => {
  const f = fixture(t); f.setMode("round-robin");
  const image: ImageModel<ImageApi> = { ...model, type: "image", output: ["image"] };
  const classifier: ClassifierModel<ClassifierApi> = { ...model, compat: undefined, type: "classifier" };
  const calls: string[] = [];
  const provider: Provider = { ...f.provider,
    getAllModels: () => [model, image, classifier],
    generateImages: async (selected, _context, options) => {
      calls.push(options?.apiKey ?? "missing");
      return { api: selected.api, provider: selected.provider, model: selected.id, output: [], stopReason: "stop", timestamp: 1, usage: message("").usage };
    },
    classify: async (selected, _context, options) => {
      calls.push(options?.apiKey ?? "missing");
      return { api: selected.api, provider: selected.provider, model: selected.id, answers: {}, stopReason: "stop", timestamp: 1, usage: message("").usage };
    }
  };
  const runtime = createModels(); runtime.setProvider(f.router.wrap(provider));
  const images = await runtime.generateImages(image, { prompt: "hello" } as never);
  const answers = await runtime.classify(classifier, { state: {}, questions: {} });
  assert.deepEqual(calls, ["key-a", "key-b"]);
  assert.deepEqual([images.stopReason, answers.stopReason, images.usage?.totalTokens, answers.usage?.totalTokens], ["stop", "stop", 3, 3]);
});

test("deferred requests fail explicitly without selecting an account", async t => {
  const f = fixture(t);
  const result = await f.router.wrap(f.provider).streamSimple(model, context, { deferred: true }).result();
  assert.match(result.errorMessage!, /Deferred requests require account routing off/);
  assert.deepEqual(f.calls, []);
});

test("routing on/off installs and restores native providers, and on preserves an active policy", async t => {
  const f = fixture(t);
  let settings: AccountRoutingSettings = { mode: "off", accounts: [] };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(f.provider);
  const notices: string[] = [];
  const ctx = { hasUI: false, isIdle: () => true, modelRegistry: new ModelRegistry(runtime), ui: { notify: (text: string) => notices.push(text) } };
  const accounts = new Accounts({ registerProvider: (provider: Provider) => runtime.registerNativeProvider(provider) } as never,
    () => settings, next => { settings = next; }, f.directory);
  await accounts.routing("on", ctx as never);
  assert.equal(settings.mode, "sticky");
  await runtime.streamSimple(model, context).result();
  assert.equal(f.calls.at(-1), "key-a");
  await accounts.routing("quota-first", ctx as never);
  await accounts.routing("on", ctx as never);
  assert.equal(settings.mode, "quota-first");
  await accounts.routing("off", ctx as never);
  assert.equal(settings.mode, "off");
  await runtime.streamSimple(model, context).result();
  assert.equal(f.calls.at(-1), "primary");
  await accounts.routing("status", ctx as never);
  assert.ok(notices.some(text => text.includes("Account routing: off")));
  await assert.rejects(accounts.routing("invalid", ctx as never), /Usage: \/jar routing/);
});

test("subagents inherit routing policy/allowlist without credentials", t => {
  const f = fixture(t);
  const settings: AccountRoutingSettings = { mode: "quota-first", accounts: ["b"] };
  const accounts = new Accounts({} as never, () => settings, () => {}, f.directory);
  const env = accounts.environment();
  assert.deepEqual(Object.keys(env), [ACCOUNT_ROUTING_ENV]);
  assert.doesNotMatch(JSON.stringify(env), /key-a|key-b|refresh|access/);
  const previous = process.env[ACCOUNT_ROUTING_ENV];
  process.env[ACCOUNT_ROUTING_ENV] = env[ACCOUNT_ROUTING_ENV];
  try { assert.deepEqual(inheritedAccountRouting(), settings); }
  finally {
    if (previous === undefined) delete process.env[ACCOUNT_ROUTING_ENV];
    else process.env[ACCOUNT_ROUTING_ENV] = previous;
  }
});

test("quota score uses the most constrained unexpired window", () => {
  assert.equal(remainingQuota({ fiveHour: { used: 50 }, week: { used: 90 } }, 1), 10);
  assert.equal(remainingQuota({ week: { used: 100, resetsAt: 1 } }, 2), undefined);
});

test("a stale quota refresh never clears a cooldown another writer recorded", () => {
  const cooled = { blockedUntil: 5000, quota: { week: { used: 10 } }, checkedAt: 100 };
  assert.deepEqual(mergeHealth(cooled, { quota: { week: { used: 20 } }, checkedAt: 200 }),
    { blockedUntil: 5000, quota: { week: { used: 20 } }, checkedAt: 200 });
  assert.deepEqual(mergeHealth(cooled, { ...cooled, blockedUntil: 9000 }).blockedUntil, 9000);
  assert.deepEqual(mergeHealth({ ...cooled, checkedAt: 300 }, { quota: { week: { used: 99 } }, checkedAt: 200 }).quota, { week: { used: 10 } },
    "an older quota snapshot does not replace a newer one");
});

test("health updates from separate processes are serialized: no lost cooldowns or increments", async t => {
  const f = fixture(t);
  const store = fileURLToPath(new URL("../src/account-store.ts", import.meta.url));
  const worker = (role: "quota" | "cooldown") => `
    import { AccountStore } from ${JSON.stringify(store)};
    const store = new AccountStore(${JSON.stringify(f.directory)});
    for (let index = 0; index < 60; index++) {
      store.updateHealth("a", (current) => {
        const quota = { week: { used: ((current.quota?.week?.used ?? 0) + 1) } };
        if (${JSON.stringify(role)} === "cooldown" && index === 30) return { ...current, quota, blockedUntil: 4102444800000 };
        return { ...current, quota, checkedAt: (current.checkedAt ?? 0) + 1 };
      });
    }`;
  const run = (role: "quota" | "cooldown") => promisify(execFile)(process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", worker(role)]);
  await Promise.all([run("quota"), run("cooldown"), run("quota")]);
  const health = f.store.health("a");
  assert.equal(health.quota?.week?.used, 180, "every read/modify/write saw the previous one");
  assert.equal(health.blockedUntil, 4102444800000, "a concurrent quota refresh did not erase the 429 cooldown");
  assert.equal(lstatSync(join(f.store.root, "a", "health.json")).mode & 0o777, 0o600);
  assert.throws(() => lstatSync(join(f.store.root, "a", "health.lock")), /ENOENT/, "the lock is released");
});

test("a routing policy change during a request does not alter its 429 retry", async t => {
  const f = fixture(t); f.fail(429);
  const provider = f.router.wrap(f.provider);
  const pending = provider.streamSimple(model, context).result();
  f.allow(["a"]);
  f.setMode("off");
  const result = await pending;
  assert.equal(result.stopReason, "stop", "the retry used the policy captured at dispatch");
  assert.deepEqual(f.calls, ["key-a", "key-b"]);
  await provider.streamSimple(model, context).result();
  assert.equal(f.calls.at(-1), "missing", "the next request uses the new policy");
});

test("private account removal is explicit, scoped and fails closed on unknown files", t => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-jar-remove-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const store = new AccountStore(fixture);
  store.reserve("work");
  store.save({ version: 1, name: "work", provider: "openai", auth: "env", env: "WORK_KEY" });
  store.saveHealth("work", { blockedUntil: Date.now() + 1000 });
  const path = join(store.root, "work");
  writeFileSync(join(path, "unexpected.txt"), "do not delete");
  assert.throws(() => store.remove("work"), /unexpected files or active locks/);
  assert.ok(existsSync(join(path, "account.json")));
  rmSync(join(path, "unexpected.txt"));
  store.remove("work");
  assert.equal(existsSync(path), false);
  assert.deepEqual(store.list(), []);
  assert.throws(() => store.remove("work"), /Unknown account/);
});

test("native provider login identity follows Pi settings and stays stable otherwise", t => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-jar-device-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const store = new AccountStore(fixture);
  const created = store.deviceId();
  assert.match(created, /^[0-9a-f-]{36}$/i);
  assert.equal(store.deviceId(), created);
  assert.deepEqual(store.list(), [], "identity marker must never look like an account directory");
  const piDeviceId = "12345678-1234-4234-8234-123456789abc";
  writeFileSync(join(fixture, "settings.json"), JSON.stringify({ deviceId: piDeviceId }));
  assert.equal(store.deviceId(), piDeviceId, "reuse Pi's native installation ID when present");
});
