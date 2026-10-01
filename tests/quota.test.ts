import assert from "node:assert/strict";
import test from "node:test";
import { QuotaCache, fetchQuota, publishedQuota, QUOTA_MAX_BACKOFF_MS, QUOTA_TTL_MS, type Quota } from "../src/quota.ts";
import { collectStatuses } from "../src/status.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("quota publisher wins, stale and malformed payloads are hidden, no JSON leaks into generic statuses", () => {
  const now = Date.now();
  const statuses = new Map([["pi-jar.quota.openai-codex", JSON.stringify({ fiveHour: { used: 47 }, week: { used: 12 }, expiresAt: now + 1000 })]]);
  assert.deepEqual(publishedQuota(statuses, "openai-codex", now), { fiveHour: { used: 47 }, week: { used: 12 } });
  assert.deepEqual(collectStatuses(statuses, now).extras, []);
  assert.equal(publishedQuota(statuses, "openai-codex", now + 1001), undefined);
  statuses.set("pi-jar.quota.openai-codex", JSON.stringify({ fiveHour: { used: -12 }, expiresAt: now + 1000 }));
  assert.equal(publishedQuota(statuses, "openai-codex", now), undefined);
  statuses.set("pi-jar.quota.openai-codex", JSON.stringify({ fiveHour: { used: 1 }, expiresAt: now + QUOTA_TTL_MS + 1 }));
  assert.equal(publishedQuota(statuses, "openai-codex", now), undefined);
});

test("opt-in cache fetches once only when no valid public quota, and never from a render", async () => {
  const now = Date.now();
  const statuses = new Map([["pi-jar.quota.anthropic", JSON.stringify({ week: { used: 80 }, expiresAt: now + 20_000 })]]);
  let calls = 0;
  let changes = 0;
  const cache = new QuotaCache(async () => { calls++; return { fiveHour: { used: 4 } }; }, () => { changes++; });
  assert.equal(cache.refresh("anthropic", new Map(), now), false);
  assert.equal(cache.get("anthropic", new Map(), now), undefined);
  await tick();
  assert.equal(calls, 0); // disabled by default
  cache.enabled = true;
  assert.deepEqual(cache.get("anthropic", statuses, now), { week: { used: 80 } });
  assert.equal(cache.refresh("anthropic", statuses, now), false);
  await tick();
  assert.equal(calls, 0); // publisher prevents authenticated fallback
  for (let frame = 0; frame < 100; frame++) assert.equal(cache.get("anthropic", new Map(), now), undefined);
  await tick();
  assert.equal(calls, 0, "renders read the cache; they never start a lookup");
  assert.equal(cache.refresh("anthropic", new Map(), now), true);
  await tick();
  assert.equal(calls, 1);
  assert.equal(changes, 1);
  for (let frame = 0; frame < 100; frame++) assert.deepEqual(cache.get("anthropic", new Map(), now + frame), { fiveHour: { used: 4 } });
  assert.equal(cache.refresh("anthropic", new Map(), now + 1000), false, "a fresh value is not refetched");
  assert.equal(cache.get("anthropic", new Map(), now + QUOTA_TTL_MS), undefined, "an expired value is hidden");
  await tick();
  assert.equal(calls, 1, "and an expired value is not refetched by rendering it");
  cache.stop();
  cache.enabled = false;
  assert.equal(cache.get("anthropic", new Map(), now), undefined);
});

test("provider lookups deduplicate while one is pending; stats report pending and cache age", async () => {
  let release: (value: Quota | undefined) => void = () => {};
  let calls = 0;
  const cache = new QuotaCache(() => { calls++; return new Promise((resolve) => { release = resolve; }); }, () => {});
  cache.enabled = true;
  const now = 1_000_000;
  assert.equal(cache.refresh("openai-codex", new Map(), now), true);
  for (let attempt = 1; attempt < 50; attempt++) assert.equal(cache.refresh("openai-codex", new Map(), now + attempt), false);
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(cache.stats(now).providers, [{ provider: "openai-codex", pending: true, failures: 0 }]);
  release({ week: { used: 10 } });
  await tick();
  assert.deepEqual(cache.stats(now + 60_000), { enabled: true, requests: 1, failures: 0, providers: [
    { provider: "openai-codex", pending: false, failures: 0, ok: true, ageMs: 60_000, retryInMs: QUOTA_TTL_MS - 60_000 }
  ] });
  cache.stop();
});

test("failed lookups are hidden and back off exponentially instead of hot-looping", async () => {
  let calls = 0;
  let failing = true;
  let changes = 0;
  const cache = new QuotaCache(async () => {
    calls++;
    if (failing) throw new Error("network down");
    return { week: { used: 5 } };
  }, () => { changes++; });
  cache.enabled = true;
  let now = 0;
  const attempt = async () => { const started = cache.refresh("anthropic", new Map(), now); await tick(); return started; };
  assert.equal(await attempt(), true);
  for (let retry = 0; retry < 20; retry++) {
    assert.equal(cache.get("anthropic", new Map(), now), undefined);
    assert.equal(await attempt(), false);
  }
  assert.equal(calls, 1, "a rejected lookup is negative-cached like an empty one");
  // Consecutive failures double the retry delay from the TTL up to the cap.
  for (const delay of [QUOTA_TTL_MS, 2 * QUOTA_TTL_MS, 4 * QUOTA_TTL_MS, QUOTA_MAX_BACKOFF_MS, QUOTA_MAX_BACKOFF_MS]) {
    now += delay - 1;
    assert.equal(await attempt(), false, "still backing off");
    now += 1;
    assert.equal(await attempt(), true);
  }
  assert.equal(calls, 6);
  assert.equal(changes, 0, "a failure changes nothing a render shows");
  assert.equal(cache.stats(now).failures, 6);
  assert.equal(cache.stats(now).providers[0]?.failures, 6);
  failing = false;
  now += QUOTA_MAX_BACKOFF_MS;
  assert.equal(await attempt(), true);
  assert.deepEqual(cache.get("anthropic", new Map(), now), { week: { used: 5 } });
  assert.deepEqual(cache.stats(now).providers[0], { provider: "anthropic", pending: false, failures: 0, ok: true, ageMs: 0, retryInMs: QUOTA_TTL_MS },
    "success resets the backoff");
  cache.stop();
});

test("unsupported provider is hidden and cancelled fallback does not resolve a token", async () => {
  let resolves = 0;
  assert.equal(await fetchQuota("anthropic", async () => { resolves++; return { auth: { apiKey: "secret" }, source: "OAuth" }; }, AbortSignal.abort()), undefined);
  assert.equal(resolves, 1); // auth resolution starts only inside an explicitly invoked fetch
  let calls = 0;
  const cache = new QuotaCache(async () => { calls++; return undefined; }, () => {});
  cache.enabled = true;
  assert.equal(cache.get("unsupported", new Map(), Date.now()), undefined);
  assert.equal(cache.refresh("unsupported", new Map(), Date.now()), false);
  await tick();
  assert.equal(calls, 0);
  cache.stop();
});

test("read-only provider fetch accepts only resolved OAuth and valid percentages", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url");
  const token = `abc.${payload}.signature`;
  globalThis.fetch = (async (url: unknown, options: RequestInit) => {
    calls++;
    assert.equal(options.method, "GET");
    assert.equal(options.headers && (options.headers as Record<string, string>).Authorization, `Bearer ${token}`);
    assert.equal(options.headers && (options.headers as Record<string, string>)["ChatGPT-Account-Id"], "account");
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
    // Plus accounts report one weekly window in the primary slot (real wham/usage shape).
    const rate_limit = calls === 1
      ? { primary_window: { used_percent: 16 }, secondary_window: { used_percent: 23 } }
      : { primary_window: { used_percent: 85, limit_window_seconds: 604800 }, secondary_window: null };
    return { ok: true, json: async () => ({ rate_limit }) } as Response;
  }) as typeof fetch;
  try {
    const signal = new AbortController().signal;
    assert.equal(await fetchQuota("openai-codex", async () => ({ auth: { apiKey: token }, source: "API key" }), signal), undefined);
    assert.equal(calls, 0);
    assert.deepEqual(await fetchQuota("openai-codex", async () => ({ auth: { apiKey: token }, source: "OAuth" }), signal), { fiveHour: { used: 16 }, week: { used: 23 } });
    assert.equal(calls, 1);
    assert.deepEqual(await fetchQuota("openai-codex", async () => ({ auth: { apiKey: token }, source: "OAuth" }), signal), { week: { used: 85 } },
      "a weekly primary window must not be labelled as the 5h session window");
  } finally { globalThis.fetch = originalFetch; }
});
