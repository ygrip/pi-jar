export type QuotaProvider = "openai-codex" | "anthropic";
export interface QuotaWindow { used: number; resetsAt?: number }
export interface Quota { fiveHour?: QuotaWindow; week?: QuotaWindow }

export const QUOTA_TTL_MS = 5 * 60_000;
export const QUOTA_PREFIX = "pi-jar.quota.";

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

/** Public statuses are authoritative only when valid and fresh. No arbitrary status prose is parsed. */
export function publishedQuota(statuses: ReadonlyMap<string, string>, provider: string, now: number): Quota | undefined {
  const raw = statuses.get(QUOTA_PREFIX + provider);
  if (typeof raw !== "string" || raw.length > 2048) return undefined;
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object") return undefined;
    const obj = data as Record<string, unknown>;
    if (typeof obj.expiresAt !== "number" || obj.expiresAt <= now || obj.expiresAt > now + QUOTA_TTL_MS) return undefined;
    return parseQuota(obj);
  } catch { return undefined; }
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
      return parseQuota({ fiveHour: parse(rate.primary_window), week: parse(rate.secondary_window) });
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

/** One in-flight request per provider, negative-cache failures, never show expired values. */
export class QuotaCache {
  private entries = new Map<QuotaProvider, { value?: Quota; expiresAt: number }>();
  private pending = new Map<QuotaProvider, AbortController>();
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
    if (published) {
      this.pending.get(provider)?.abort();
      this.pending.delete(provider);
      return published;
    }
    if (!this.enabled) return undefined;
    const cached = this.entries.get(provider);
    if (cached && cached.expiresAt > now) return cached.value;
    if (!this.pending.has(provider)) {
      const controller = new AbortController();
      this.pending.set(provider, controller);
      // A microtask keeps IO outside the synchronous render cycle.
      queueMicrotask(() => {
        if (controller.signal.aborted) {
          if (this.pending.get(provider) === controller) this.pending.delete(provider);
          return;
        }
        void this.fetcher(provider, controller.signal).then((value) => {
          if (!controller.signal.aborted) {
            this.entries.set(provider, { value, expiresAt: Date.now() + QUOTA_TTL_MS });
            this.changed();
          }
        }).catch(() => {}).finally(() => {
          if (this.pending.get(provider) === controller) this.pending.delete(provider);
        });
      });
    }
    return undefined;
  }
  stop(): void { for (const controller of this.pending.values()) controller.abort(); this.pending.clear(); this.entries.clear(); }
}
