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

/** Never persist credentials; resolve through Pi's public model registry only on explicit opt-in. */
export async function fetchQuota(provider: QuotaProvider, resolveAuth: (provider: string) => Promise<{ auth: { apiKey?: string }; source?: string } | undefined>, signal: AbortSignal): Promise<Quota | undefined> {
  try {
    const resolved = await resolveAuth(provider);
    if (signal.aborted || !resolved?.source?.toLowerCase().includes("oauth") || !resolved.auth.apiKey) return undefined;
    const token = resolved.auth.apiKey;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    let url: string;
    if (provider === "openai-codex") {
      const id = codexAccountId(token);
      if (!id) return undefined;
      headers["ChatGPT-Account-Id"] = id;
      url = "https://chatgpt.com/backend-api/wham/usage";
    } else {
      headers["anthropic-beta"] = "oauth-2025-04-20";
      url = "https://api.anthropic.com/api/oauth/usage";
    }
    const response = await fetch(url, { method: "GET", headers, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!response.ok) return undefined;
    const data: unknown = await response.json();
    if (!data || typeof data !== "object") return undefined;
    const body = data as Record<string, unknown>;
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
      const quota: Quota = {};
      for (const [window, fallback] of [[rate.primary_window, "fiveHour"], [rate.secondary_window, "week"]] as const) {
        const value = parse(window);
        if (!value) continue;
        const seconds = (window as Record<string, unknown>).limit_window_seconds;
        const slot = typeof seconds === "number" && seconds > 0 ? (seconds <= 24 * 60 * 60 ? "fiveHour" : "week") : fallback;
        if (!quota[slot]) quota[slot] = value;
      }
      return parseQuota(quota);
    }
    const parse = (window: unknown): QuotaWindow | undefined => {
      if (!window || typeof window !== "object") return undefined;
      const item = window as Record<string, unknown>;
      const utilization = item.utilization;
      const resetsAt = typeof item.resets_at === "string" ? Date.parse(item.resets_at) : undefined;
      return windowValue({ used: typeof utilization === "number" && utilization <= 1 ? utilization * 100 : utilization, resetsAt });
    };
    return parseQuota({ fiveHour: parse(body.five_hour), week: parse(body.seven_day) });
  } catch { return undefined; }
}

/**
 * One in-flight request per provider; failures are negative-cached with exponential backoff;
 * expired values are never shown. Reads never start IO: renders call `get` on every frame, and
 * lookups start only from `refresh` at session boundaries.
 */
export class QuotaCache {
  private entries = new Map<QuotaProvider, { value?: Quota; requestedAt: number; expiresAt: number; failures: number }>();
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
      // A rejected lookup is a failure like an empty one: both back off instead of retrying at once.
      void this.fetcher(provider, controller.signal).catch(() => undefined).then((value) => {
        if (controller.signal.aborted) return;
        const failures = value ? 0 : (this.entries.get(provider)?.failures ?? 0) + 1;
        if (!value) this.failures++;
        const ttl = value ? QUOTA_TTL_MS : Math.min(QUOTA_MAX_BACKOFF_MS, QUOTA_TTL_MS * 2 ** (failures - 1));
        this.entries.set(provider, { ...(value ? { value } : {}), requestedAt: now, expiresAt: now + ttl, failures });
        // An expired value was already hidden, so only a new value changes what renders show.
        if (value) this.changed();
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
