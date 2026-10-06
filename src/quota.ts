export type QuotaProvider = "openai-codex" | "anthropic";
export interface QuotaWindow { used: number; resetsAt?: number }
export interface Quota { fiveHour?: QuotaWindow; week?: QuotaWindow }

export const QUOTA_TTL_MS = 5 * 60_000;
/** Consecutive failures double the retry delay from the TTL up to this, so a broken lookup cannot hot-loop. */
export const QUOTA_MAX_BACKOFF_MS = 30 * 60_000;
export const QUOTA_PREFIX = "pi-jar.quota.";

export interface QuotaProviderStats {
  provider: QuotaProvider;
  pending: boolean;
  /** Consecutive failed lookups. */
  failures: number;
  /** Last settled lookup, if any: whether it produced a value, how long ago it started, when the next may start. */
  ok?: boolean;
  ageMs?: number;
  retryInMs?: number;
}
export interface QuotaStats { enabled: boolean; requests: number; failures: number; providers: QuotaProviderStats[] }

function windowValue(value: unknown): QuotaWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.used !== "number" || !Number.isFinite(item.used) || item.used < 0 || item.used > 100) return undefined;
  return { used: item.used, ...(typeof item.resetsAt === "number" && Number.isFinite(item.resetsAt) ? { resetsAt: item.resetsAt } : {}) };
}

function parseQuota(value: unknown): Quota | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  const fiveHour = windowValue(object.fiveHour);
  const week = windowValue(object.week);
  return fiveHour || week ? { ...(fiveHour ? { fiveHour } : {}), ...(week ? { week } : {}) } : undefined;
}

const publishedCache = new Map<string, { raw: string; expiresAt?: number; value?: Quota }>();

/** Public statuses are authoritative only when valid and fresh. No arbitrary status prose is parsed. */
export function publishedQuota(statuses: ReadonlyMap<string, string>, provider: string, now: number): Quota | undefined {
  const raw = statuses.get(QUOTA_PREFIX + provider);
  if (typeof raw !== "string" || raw.length > 2048) return undefined;
  const cached = publishedCache.get(provider);
  if (cached?.raw === raw) {
    const { expiresAt, value } = cached;
    return value && expiresAt != null && expiresAt > now && expiresAt <= now + QUOTA_TTL_MS ? value : undefined;
  }
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object") { publishedCache.set(provider, { raw }); return undefined; }
    const obj = data as Record<string, unknown>;
    const expiresAt = obj.expiresAt;
    const value = parseQuota(obj);
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || !value) { publishedCache.set(provider, { raw }); return undefined; }
    publishedCache.set(provider, { raw, expiresAt, value });
    return expiresAt > now && expiresAt <= now + QUOTA_TTL_MS ? value : undefined;
  } catch { publishedCache.set(provider, { raw }); return undefined; }
}

function codexAccountId(token: string): string | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object") return undefined;
    const auth = (claims as Record<string, unknown>)["https://api.openai.com/auth"];
    const id = auth && typeof auth === "object" ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch { return undefined; }
}

/**
 * Never persist credentials; resolve through Pi's public model registry only on explicit opt-in.
 * Resolves undefined only when cancelled; every other miss throws a short, user-facing reason.
 */
export async function fetchQuota(provider: QuotaProvider, resolveAuth: (provider: string) => Promise<{ auth: { apiKey?: string }; source?: string } | undefined>, signal: AbortSignal): Promise<Quota | undefined> {
  const resolved = await resolveAuth(provider);
  if (signal.aborted) return undefined;
  if (!resolved?.source?.toLowerCase().includes("oauth") || !resolved.auth.apiKey) throw new Error("needs a subscription login (/login), not an API key");
  const token = resolved.auth.apiKey;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  let url: string;
  if (provider === "openai-codex") {
    const id = codexAccountId(token);
    if (!id) throw new Error("login token has no ChatGPT account id");
    headers["ChatGPT-Account-Id"] = id;
    url = "https://chatgpt.com/backend-api/wham/usage";
  } else {
    headers["anthropic-beta"] = "oauth-2025-04-20";
    url = "https://api.anthropic.com/api/oauth/usage";
  }
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", headers, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
  } catch (error) {
    if (signal.aborted) return undefined;
    throw new Error(error instanceof Error && error.name === "TimeoutError" ? "request timed out" : "request failed: " + String(error instanceof Error ? error.message : error));
  }
  // The Anthropic usage endpoint is shared with Claude Code and rate-limits aggressively.
  if (!response.ok) throw new Error(response.status === 429 ? "rate limited by the provider (HTTP 429)" : `HTTP ${response.status}`);
  const data: unknown = await response.json().catch(() => undefined);
  if (!data || typeof data !== "object") throw new Error("unreadable usage response");
  const body = data as Record<string, unknown>;
  let quota: Quota | undefined;
  if (provider === "openai-codex") {
    const rate = body.rate_limit && typeof body.rate_limit === "object" ? body.rate_limit as Record<string, unknown> : {};
    const parse = (window: unknown): QuotaWindow | undefined => {
      if (!window || typeof window !== "object") return undefined;
      const item = window as Record<string, unknown>;
      return windowValue({ used: item.used_percent, resetsAt: typeof item.reset_at === "number" ? item.reset_at * 1000 : undefined });
    };
    // Window slots are not fixed: Plus accounts get a single weekly `primary_window` and a null
    // secondary. Classify by `limit_window_seconds` (≤ 1 day is the short window), falling back
    // to position only when the duration is absent.
    const windows: Quota = {};
    for (const [window, fallback] of [[rate.primary_window, "fiveHour"], [rate.secondary_window, "week"]] as const) {
      const value = parse(window);
      if (!value) continue;
      const seconds = (window as Record<string, unknown>).limit_window_seconds;
      const slot = typeof seconds === "number" && seconds > 0 ? (seconds <= 24 * 60 * 60 ? "fiveHour" : "week") : fallback;
      if (!windows[slot]) windows[slot] = value;
    }
    quota = parseQuota(windows);
  } else {
    // `utilization` is already a percentage (7.0 means 7%), not a fraction.
    const parse = (window: unknown): QuotaWindow | undefined => {
      if (!window || typeof window !== "object") return undefined;
      const item = window as Record<string, unknown>;
      const resetsAt = typeof item.resets_at === "string" ? Date.parse(item.resets_at) : undefined;
      return windowValue({ used: item.utilization, resetsAt });
    };
    quota = parseQuota({ fiveHour: parse(body.five_hour), week: parse(body.seven_day) });
  }
  if (!quota) throw new Error("no plan limits in the usage response");
  return quota;
}

/**
 * One in-flight request per provider; failures are negative-cached with exponential backoff;
 * expired values are never shown. Reads never start IO: renders call `get` on every frame, and
 * lookups start only from `refresh` at session boundaries.
 */
export class QuotaCache {
  private entries = new Map<QuotaProvider, { value?: Quota; error?: string; requestedAt: number; expiresAt: number; failures: number }>();
  private pending = new Map<QuotaProvider, AbortController>();
  private requests = 0;
  private failures = 0;
  enabled = false;
  private readonly fetcher: (provider: QuotaProvider, signal: AbortSignal) => Promise<Quota | undefined>;
  private readonly changed: () => void;
  constructor(fetcher: (provider: QuotaProvider, signal: AbortSignal) => Promise<Quota | undefined>, changed: () => void) {
    this.fetcher = fetcher;
    this.changed = changed;
  }
  get(provider: string | undefined, statuses: ReadonlyMap<string, string>, now: number): Quota | undefined {
    if (provider !== "openai-codex" && provider !== "anthropic") return undefined;
    const published = publishedQuota(statuses, provider, now);
    if (published) return published;
    if (!this.enabled) return undefined;
    const cached = this.entries.get(provider);
    return cached && cached.expiresAt > now ? cached.value : undefined;
  }
  /** Why the last lookup failed and when the next may start; undefined while pending, fresh, or never tried. */
  failure(provider: string | undefined, now: number): { error: string; retryInMs: number } | undefined {
    if (provider !== "openai-codex" && provider !== "anthropic" || !this.enabled || this.pending.has(provider)) return undefined;
    const cached = this.entries.get(provider);
    return cached?.error !== undefined && cached.expiresAt > now ? { error: cached.error, retryInMs: cached.expiresAt - now } : undefined;
  }
  /** Start one background lookup when nothing fresh is cached and no retry delay is pending; true if it started. */
  refresh(provider: string | undefined, statuses: ReadonlyMap<string, string>, now: number): boolean {
    if (provider !== "openai-codex" && provider !== "anthropic" || !this.enabled) return false;
    if (publishedQuota(statuses, provider, now)) {
      // A publisher is authoritative; an authenticated fallback would only duplicate it.
      this.pending.get(provider)?.abort();
      this.pending.delete(provider);
      return false;
    }
    const cached = this.entries.get(provider);
    if (cached && cached.expiresAt > now || this.pending.has(provider)) return false;
    const controller = new AbortController();
    this.pending.set(provider, controller);
    this.requests++;
    // A microtask keeps IO outside the caller's synchronous event handler.
    queueMicrotask(() => {
      if (controller.signal.aborted) {
        if (this.pending.get(provider) === controller) this.pending.delete(provider);
        return;
      }
      // A rejected lookup backs off instead of retrying at once; its reason is kept for the usage panel.
      void this.fetcher(provider, controller.signal).then(
        (value) => ({ value, error: value ? undefined : "no usage returned" }),
        (error: unknown) => ({ value: undefined, error: error instanceof Error ? error.message : String(error) })
      ).then(({ value, error }) => {
        if (controller.signal.aborted) return;
        const failures = value ? 0 : (this.entries.get(provider)?.failures ?? 0) + 1;
        if (!value) this.failures++;
        const ttl = value ? QUOTA_TTL_MS : Math.min(QUOTA_MAX_BACKOFF_MS, QUOTA_TTL_MS * 2 ** (failures - 1));
        this.entries.set(provider, { ...(value ? { value } : { error: error ?? "no usage returned" }), requestedAt: now, expiresAt: now + ttl, failures });
        // Either outcome replaces the "loading" state renders show.
        this.changed();
      }).finally(() => {
        if (this.pending.get(provider) === controller) this.pending.delete(provider);
      });
    });
    return true;
  }
  /** Diagnostics: per-provider cache age and retry delay, computed on demand. */
  stats(now = Date.now()): QuotaStats {
    const providers = new Set<QuotaProvider>([...this.entries.keys(), ...this.pending.keys()]);
    return { enabled: this.enabled, requests: this.requests, failures: this.failures, providers: [...providers].map((provider) => {
      const entry = this.entries.get(provider);
      return { provider, pending: this.pending.has(provider), failures: entry?.failures ?? 0,
        ...(entry ? { ok: entry.value !== undefined, ageMs: now - entry.requestedAt, retryInMs: Math.max(0, entry.expiresAt - now) } : {}) };
    }) };
  }
  stop(): void { for (const controller of this.pending.values()) controller.abort(); this.pending.clear(); this.entries.clear(); }
}
