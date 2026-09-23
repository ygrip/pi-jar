import assert from "node:assert/strict";
import test from "node:test";
import { QuotaCache, fetchQuota, publishedQuota, QUOTA_TTL_MS } from "../src/quota.ts";
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

test("opt-in cache fetches once only when no valid public quota and hides unsuccessful values", async () => {
  const now = Date.now();
  const statuses = new Map([["pi-jar.quota.anthropic", JSON.stringify({ week: { used: 80 }, expiresAt: now + 20_000 })]]);
  let calls = 0;
  let changes = 0;
  const cache = new QuotaCache(async () => { calls++; return { fiveHour: { used: 4 } }; }, () => { changes++; });
  assert.equal(cache.get("anthropic", new Map(), now), undefined);
  assert.equal(calls, 0); // disabled by default
  cache.enabled = true;
  assert.deepEqual(cache.get("anthropic", statuses, now), { week: { used: 80 } });
  await tick();
  assert.equal(calls, 0); // publisher prevents authenticated fallback
  assert.equal(cache.get("anthropic", new Map(), Date.now()), undefined);
  assert.equal(cache.get("anthropic", new Map(), Date.now()), undefined);
  await tick();
  assert.equal(calls, 1);
  assert.equal(changes, 1);
  assert.deepEqual(cache.get("anthropic", new Map(), Date.now()), { fiveHour: { used: 4 } });
  assert.equal(calls, 1);
  cache.stop();
  cache.enabled = false;
  assert.equal(cache.get("anthropic", new Map(), Date.now()), undefined);
});

test("failed quota fetch is hidden and negative-cached", async () => {
  let calls = 0;
  const cache = new QuotaCache(async () => { calls++; return undefined; }, () => {});
  cache.enabled = true;
  cache.get("anthropic", new Map(), Date.now());
  await tick();
  assert.equal(cache.get("anthropic", new Map(), Date.now()), undefined);
  assert.equal(calls, 1);
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
    return { ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 16 }, secondary_window: { used_percent: 23 } } }) } as Response;
  }) as typeof fetch;
  try {
    const signal = new AbortController().signal;
    assert.equal(await fetchQuota("openai-codex", async () => ({ auth: { apiKey: token }, source: "API key" }), signal), undefined);
    assert.equal(calls, 0);
    assert.deepEqual(await fetchQuota("openai-codex", async () => ({ auth: { apiKey: token }, source: "OAuth" }), signal), { fiveHour: { used: 16 }, week: { used: 23 } });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});
