import {
  createAssistantMessageEventStream, type Api, type ApiStreamOptions, type AssistantMessage,
  type AssistantMessageEventStream, type Model, type Provider, type ProviderResponse,
  type SimpleStreamOptions, type TranscriptContext, type AnyModel, type ProviderHeaders
} from "@earendil-works/pi-ai";
import type { AccountDefinition, AccountHealth, AccountStore } from "./account-store.ts";
import { isUnsafeRouting, type AccountRoutingSettings } from "./account-settings.ts";
import { fetchQuota, QUOTA_TTL_MS, type Quota, type QuotaProvider } from "./quota.ts";

/** Longest a quota-first request waits for first-ever quota probes. */
const COLD_QUOTA_WAIT_MS = 500;
/** One account's catalog check may not hold up the others: a slow or hung account is skipped after this. */
const CATALOG_CHECK_TIMEOUT_MS = 5000;
/** Usage-endpoint lookups running at once per provider; a large pool queues instead of bursting. */
const QUOTA_PROBE_CONCURRENCY = 4;
type StreamOptions = SimpleStreamOptions | ApiStreamOptions<Api>;
interface AccountState {
  definition: AccountDefinition;
  /** Credential identity this runtime was built for; a change means the cached runtime is stale. */
  generation?: string;
  models: ReturnType<AccountStore["models"]>;
  health: AccountHealth;
  pending?: Promise<void>;
  invalidated?: boolean;
  nextCheck: number;
  unavailableUntil?: number;
  quotaError?: string;
  inFlight: number;
}
export interface AccountRouteStatus { name: string; provider: string; blockedUntil?: number; remaining?: number; inFlight: number; lastUsed: boolean; warning?: string }

export function remainingQuota(quota: Quota | undefined, now: number): number | undefined {
  let remaining: number | undefined;
  for (const window of [quota?.fiveHour, quota?.week]) {
    if (!window || !Number.isFinite(window.used) || window.used < 0 || window.used > 100) continue;
    if (window.resetsAt !== undefined && window.resetsAt <= now) continue;
    const value = 100 - window.used;
    remaining = Math.min(remaining ?? 100, value);
  }
  return remaining;
}
export function retryAfter(response: ProviderResponse, now: number): number {
  const headers = new Headers(response.headers);
  const value = headers.get("retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return now + Math.max(1000, seconds * 1000);
    const date = Date.parse(value);
    if (Number.isFinite(date) && date > now) return date;
  }
  return now + 60_000;
}
function failureMessage(model: Model<Api>, error: unknown, signal?: AbortSignal): AssistantMessage {
  let stopReason: "aborted" | "error" = "error";
  let errorMessage = "Account routing failed; check /jar accounts and account credentials";
  if (signal?.aborted) { stopReason = "aborted"; errorMessage = "Request aborted"; }
  else if (error instanceof RoutingError) errorMessage = error.message;
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), stopReason, errorMessage,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
class RoutingError extends Error {}
function waitForQuota(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Keeps canonical provider/model IDs. Account authentication never mutates Pi's main auth.json. */
export class AccountRouter {
  onRoute?: (account: string, provider: string, health: AccountHealth) => void;
  configurationError?: string;
  private states = new Map<string, AccountState>();
  private sticky = new Map<string, string>();
  private cursor = new Map<string, number>();
  private store: AccountStore;
  private settings: () => AccountRoutingSettings;
  private now: () => number;
  private quotaFetcher: typeof fetchQuota;
  private catalogTimeoutMs: number;
  private probeSlots = new Map<string, { active: number; waiting: Array<() => void> }>();
  constructor(store: AccountStore, settings: () => AccountRoutingSettings,
    now: () => number = Date.now, quotaFetcher = fetchQuota, catalogTimeoutMs = CATALOG_CHECK_TIMEOUT_MS) {
    this.catalogTimeoutMs = catalogTimeoutMs;
    this.store = store;
    this.settings = settings;
    this.now = now;
    this.quotaFetcher = quotaFetcher;
  }

  /**
   * One state per account label. Another Pi process can remove and re-create a label under a
   * different provider, auth type, variable or identity, so a cached runtime is reused only while
   * all of those still match; otherwise it is retired and rebuilt.
   */
  private state(account: AccountDefinition, provider: Provider): AccountState {
    let health = this.store.health(account.name);
    if (!health.credentialGeneration) {
      this.store.ensureCredentialGeneration(account.name);
      health = this.store.health(account.name);
    }
    let state = this.states.get(account.name);
    if (state && !this.sameIdentity(state, account, health)) {
      state.invalidated = true;
      this.states.delete(account.name);
      this.dropLastUsed(account.name);
      state = undefined;
    }
    if (!state) {
      state = { definition: account, generation: health.credentialGeneration, models: this.store.models(account, provider), health, nextCheck: 0, inFlight: 0 };
      this.states.set(account.name, state);
    }
    state.health = health;
    return state;
  }
  private sameIdentity(state: AccountState, account: AccountDefinition, health: AccountHealth): boolean {
    const known = state.definition;
    return known.provider === account.provider && known.auth === account.auth && known.env === account.env && known.source === account.source
      && state.generation === health.credentialGeneration;
  }
  private dropLastUsed(name: string): void {
    for (const [provider, selected] of this.sticky) if (selected === name) this.sticky.delete(provider);
  }
  /** Runs `work` once a probe slot for this provider is free, so a large pool never bursts the usage endpoint. */
  private async withProbeSlot<T>(provider: string, work: () => Promise<T>): Promise<T> {
    let slot = this.probeSlots.get(provider);
    if (!slot) { slot = { active: 0, waiting: [] }; this.probeSlots.set(provider, slot); }
    if (slot.active < QUOTA_PROBE_CONCURRENCY) slot.active++;
    else await new Promise<void>(resolve => slot.waiting.push(resolve)); // the finishing probe hands its slot over
    try { return await work(); }
    finally {
      const next = slot.waiting.shift();
      if (next) next(); else slot.active--;
    }
  }
  private async refreshQuota(state: AccountState, signal?: AbortSignal): Promise<void> {
    const provider = state.definition.provider;
    if (state.definition.auth !== "oauth" || !["anthropic", "openai-codex"].includes(provider)) return;
    const now = this.now();
    if (state.pending) return waitForQuota(state.pending, signal);
    if (state.invalidated || this.states.get(state.definition.name) !== state) return;
    const shared = this.store.health(state.definition.name);
    if (shared.credentialGeneration !== state.generation) {
      this.invalidate(state.definition.name);
      return;
    }
    state.health = shared;
    if (typeof shared.checkedAt === "number" && shared.checkedAt <= now && shared.checkedAt + QUOTA_TTL_MS > now) {
      if (this.isCurrentRoute(state)) this.onRoute?.(state.definition.name, provider, shared);
      return;
    }
    if (state.nextCheck > now) return;
    const generation = shared.credentialGeneration;
    state.pending = (async () => {
      let quota: Quota | undefined;
      try {
        quota = await this.withProbeSlot(provider, async () => {
          // Queued behind other probes: the account may have been signed out or replaced meanwhile.
          if (state.invalidated || this.states.get(state.definition.name) !== state) return undefined;
          return this.quotaFetcher(provider as QuotaProvider, async (id) => (await state.models).getAuth(id), AbortSignal.timeout(5000));
        });
        state.quotaError = undefined;
      } catch {
        // Preserve known limits during endpoint outages; do not mistake unknown quota for zero.
        state.quotaError = "Quota lookup unavailable; provider limits still apply";
      }
      // An idle session can sign out/reconnect while an unbilled quota probe is
      // still running. Guard both this process's runtime and the persisted
      // identity epoch, so another Pi process cannot resurrect old credentials' quota.
      if (state.invalidated || this.states.get(state.definition.name) !== state) return;
      let nextCheck = this.now() + QUOTA_TTL_MS;
      if (quota) {
        const checkedAt = this.now();
        nextCheck = checkedAt + QUOTA_TTL_MS;
        state.health = this.store.updateHealth(state.definition.name, current =>
          state.invalidated || this.states.get(state.definition.name) !== state
            || current.credentialGeneration !== generation
            ? current : { ...current, quota, checkedAt });
        if (!state.invalidated && this.states.get(state.definition.name) === state
          && state.health.credentialGeneration === generation && this.isCurrentRoute(state)) {
          this.onRoute?.(state.definition.name, provider, state.health);
        }
      }
      if (!state.invalidated) state.nextCheck = nextCheck;
    })().finally(() => { state.pending = undefined; });
    return waitForQuota(state.pending, signal);
  }
  /** `settings` is the policy captured when the request was dispatched; retries reuse it. */
  private async select(provider: Provider, model: AnyModel, tried: Set<string>, settings: AccountRoutingSettings, signal?: AbortSignal): Promise<AccountState> {
    if (this.configurationError) throw new RoutingError(this.configurationError);
    if (isUnsafeRouting(settings)) throw new RoutingError(`Account routing policy is unsafe (${settings.invalid}); reset it with /jar accounts mode`);
    // Provider IDs are the credential boundary. Model IDs are not globally unique,
    // so a same-named model from another provider must never select these credentials.
    if (model.provider !== provider.id) {
      throw new RoutingError(`Model ${model.provider}/${model.id} does not belong to routed provider ${provider.id}`);
    }
    const pinnedName = settings.pinned?.[provider.id];
    const unreadable: string[] = [];
    const accounts = this.store.list().filter(account => account.provider === provider.id
      && (!settings.accounts.length || settings.accounts.includes(account.name))
      && (!pinnedName || account.name === pinnedName)
      && !tried.has(account.name)
      && this.hasUsableCredentials(account, unreadable));
    const states = accounts.map(account => this.state(account, provider));
    // Remote quota endpoints can stall for seconds. Routing uses the latest shared
    // quota snapshot and starts coalesced refreshes asynchronously, never gating
    // a healthy request on a usage endpoint. Provider 429 remains authoritative.
    const coldProbes: Promise<void>[] = [];
    for (const state of states) {
      // state() just read the health file; refreshQuota re-reads it only when a probe is due.
      const probe = this.refreshQuota(state).catch(() => {
        state.quotaError = "Quota lookup unavailable; provider limits still apply";
      });
      if (state.health.quota === undefined) coldProbes.push(probe);
    }
    // quota-first ranks by remaining quota, so with no snapshot at all the order would be
    // arbitrary. Give the first probes a short, bounded head start; other modes never wait.
    if (settings.mode === "quota-first" && coldProbes.length) {
      await this.waitBriefly(Promise.all(coldProbes), COLD_QUOTA_WAIT_MS);
      for (const state of states) state.health = this.store.health(state.definition.name);
    }
    signal?.throwIfAborted();
    const candidates = states.filter(state =>
      (state.health.blockedUntil ?? 0) <= this.now()
      && remainingQuota(state.health.quota, this.now()) !== 0
      && (state.unavailableUntil ?? 0) <= this.now());
    const selected = await this.firstEligible(this.preferenceOrder(candidates, provider.id, settings), provider, model, signal);
    if (!selected) {
      const skipped = unreadable.length ? ` (skipped accounts with unreadable credentials: ${unreadable.join(", ")})` : "";
      throw new RoutingError(`No eligible ${provider.id} account for ${model.id}; check /jar accounts, profile allowlist, login and quota resets${skipped}`);
    }
    this.sticky.set(provider.id, selected.definition.name);
    selected.health = this.store.health(selected.definition.name);
    if (this.isCurrentRoute(selected)) this.onRoute?.(selected.definition.name, provider.id, selected.health);
    selected.inFlight++;
    return selected;
  }
  /**
   * The ModelRuntime may hold a credential in memory after another Pi process signs out or an
   * API-key variable disappears, so a fresh request re-checks the configured credential source.
   * One account with a broken file must not fail the whole provider: skip it and report it.
   */
  private hasUsableCredentials(account: AccountDefinition, unreadable: string[]): boolean {
    try { return this.store.hasCredentials(account); }
    catch { unreadable.push(account.name); return false; }
  }
  private async waitBriefly(work: Promise<unknown>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, ms); });
    try { await Promise.race([work, timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }
  /** Most preferred first. Failover walks this list, so only the winner is ever validated. */
  private preferenceOrder(candidates: AccountState[], providerId: string, settings: AccountRoutingSettings): AccountState[] {
    const ordered = [...candidates];
    if (!ordered.length) return ordered;
    if (settings.mode === "quota-first") {
      ordered.sort((a, b) => (remainingQuota(b.health.quota, this.now()) ?? -1) - (remainingQuota(a.health.quota, this.now()) ?? -1)
        || a.inFlight - b.inFlight || a.definition.name.localeCompare(b.definition.name));
    } else if (settings.mode === "sticky") {
      const name = this.sticky.get(providerId);
      const index = ordered.findIndex(state => state.definition.name === name);
      if (index > 0) ordered.unshift(ordered.splice(index, 1)[0]!);
    } else if (settings.mode === "round-robin") {
      const cursor = this.cursor.get(providerId) ?? 0;
      this.cursor.set(providerId, cursor + 1);
      ordered.push(...ordered.splice(0, cursor % ordered.length));
    }
    return ordered;
  }
  /**
   * Credential-scoped catalog validation: the first account that serves this exact model wins.
   * Each check is time-limited, so a hung account is skipped (and cooled down) instead of
   * blocking healthy accounts behind it.
   */
  private async firstEligible(ordered: AccountState[], provider: Provider, model: AnyModel, signal?: AbortSignal): Promise<AccountState | undefined> {
    for (const state of ordered) {
      signal?.throwIfAborted();
      try {
        if (await this.servesModel(state, provider, model, signal)) return state;
      } catch {
        signal?.throwIfAborted();
        state.unavailableUntil = this.now() + 60_000;
      }
    }
    return undefined;
  }
  private async servesModel(state: AccountState, provider: Provider, model: AnyModel, signal?: AbortSignal): Promise<boolean> {
    const limit = AbortSignal.timeout(this.catalogTimeoutMs);
    const checkSignal = signal ? AbortSignal.any([signal, limit]) : limit;
    // A catalog check that ignores its abort signal must still lose the race.
    const timedOut = new Promise<never>((_, reject) => {
      limit.addEventListener("abort", () => reject(new Error("model catalog check timed out")), { once: true });
    });
    const check = (async () => {
      const models = await (await state.models).getAllAvailable(provider.id, { signal: checkSignal });
      return models.some(candidate => candidate.provider === provider.id && candidate.id === model.id
        && (candidate.type ?? "chat") === (model.type ?? "chat") && candidate.api === model.api);
    })();
    return Promise.race([check, timedOut]);
  }
  private isCurrentRoute(state: AccountState): boolean {
    const policy = this.settings();
    const provider = state.definition.provider;
    return !isUnsafeRouting(policy) && policy.mode !== "off"
      && this.sticky.get(provider) === state.definition.name
      && (!policy.accounts.length || policy.accounts.includes(state.definition.name))
      && (!policy.pinned?.[provider] || policy.pinned[provider] === state.definition.name);
  }
  async refreshActiveQuota(provider?: string): Promise<void> {
    const active = [...this.sticky.entries()].filter(([id]) => provider === undefined || id === provider);
    await Promise.all(active.map(([id, name]) => {
      const state = this.states.get(name);
      if (state && !state.invalidated && state.definition.provider === id && this.isCurrentRoute(state)) return this.refreshQuota(state);
    }));
  }
  invalidate(name: string): void {
    const state = this.states.get(name);
    if (state) {
      state.invalidated = true;
      if (this.sticky.get(state.definition.provider) === name) {
        this.onRoute?.(name, state.definition.provider, {});
      }
    }
    this.states.delete(name);
    // Re-login, sign-out, or deletion invalidates the account's last-used marker.
    this.dropLastUsed(name);
  }
  status(): AccountRouteStatus[] {
    return this.store.list().map(account => {
      const health = this.store.health(account.name);
      return { name: account.name, provider: account.provider, blockedUntil: health.blockedUntil,
        remaining: remainingQuota(health.quota, this.now()), inFlight: this.states.get(account.name)?.inFlight ?? 0,
        lastUsed: this.settings().mode !== "off" && this.sticky.get(account.provider) === account.name,
        warning: this.states.get(account.name)?.quotaError };
    });
  }
  private cleanOptions<T extends { apiKey?: string; headers?: ProviderHeaders; env?: Record<string, string> }>(options: T = {} as T): T {
    const headers: ProviderHeaders = {};
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (["authorization", "proxy-authorization", "x-api-key", "api-key", "chatgpt-account-id", "openai-organization", "openai-project", "x-organization-id", "x-account-id", "x-goog-api-key", "cookie"].includes(key.toLowerCase())) continue;
      headers[key] = value;
    }
    return { ...options, apiKey: undefined, env: undefined, headers };
  }
  private observeResponse<TModel>(state: AccountState,
    callback?: (response: ProviderResponse, model: TModel) => void | Promise<void>) {
    // The identity this request was dispatched with. A late 429 must not cool down a different
    // credential that was reconnected under the same label (possibly by another Pi process).
    const generation = state.health.credentialGeneration;
    return async (response: ProviderResponse, model: TModel): Promise<void> => {
      if (response.status === 429) {
        const blockedUntil = retryAfter(response, this.now());
        state.health = this.store.updateHealth(state.definition.name, current =>
          current.credentialGeneration !== generation ? current : { ...current, blockedUntil });
      }
      await callback?.(response, model);
    };
  }
  private routingOAuth(provider: Provider, active: () => boolean): Provider["auth"]["oauth"] {
    const oauth = provider.auth.oauth;
    if (!oauth) return undefined;
    return { ...oauth,
      // The main credential is not used while routing. Returning it unchanged avoids both
      // refreshing an unrelated login and ever persisting fake token/expiry data to auth.json.
      refresh: async (credential, signal) => {
        if (active()) return credential;
        return oauth.refresh(credential, signal);
      },
      toAuth: async credential => {
        if (active()) return {};
        return oauth.toAuth(credential);
      }
    };
  }
  wrap(provider: Provider): Provider {
    const active = () => this.settings().mode !== "off";
    const originalKey = provider.auth.apiKey;
    return { ...provider,
      auth: { oauth: this.routingOAuth(provider, active), apiKey: {
        name: originalKey?.name ?? "Pi-jar accounts",
        login: originalKey?.login,
        check: async input => {
          if (active()) return { type: "api_key", source: "Pi-jar accounts" };
          if (originalKey?.check) return originalKey.check(input);
          const auth = await originalKey?.resolve(input);
          if (auth) return { type: "api_key", source: auth.source };
          return undefined;
        },
        resolve: async input => {
          if (active()) return { auth: {}, source: "Pi-jar accounts" };
          return originalKey?.resolve(input);
        }
      } },
      getModels: () => provider.getModels(),
      getAllModels: provider.getAllModels?.bind(provider),
      refreshModels: provider.refreshModels?.bind(provider),
      filterModels: provider.filterModels && ((models, credential) => {
        if (active()) return models;
        return provider.filterModels!(models, credential);
      }),
      filterAllModels: provider.filterAllModels && ((models, credential) => {
        if (active()) return models;
        return provider.filterAllModels!(models, credential);
      }),
      generateImages: provider.generateImages && (async (model, context, options) => {
        if (!active()) return provider.generateImages!(model, context, options);
        try {
          const state = await this.select(provider, model, new Set(), this.settings(), options?.signal);
          try { return await (await state.models).generateImages(model, context, {
            ...this.cleanOptions(options), onResponse: this.observeResponse(state, options?.onResponse)
          }); }
          finally { state.inFlight--; }
        } catch {
          let stopReason: "error" | "aborted" = "error";
          if (options?.signal?.aborted) stopReason = "aborted";
          return { api: model.api, output: [], model: model.id, provider: model.provider,
            stopReason, errorMessage: "Image account routing failed; check /jar accounts", timestamp: this.now() };
        }
      }),
      classify: provider.classify && (async (model, context, options) => {
        if (!active()) return provider.classify!(model, context, options);
        try {
          const state = await this.select(provider, model, new Set(), this.settings(), options?.signal);
          try { return await (await state.models).classify(model, context, {
            ...this.cleanOptions(options), onResponse: this.observeResponse(state, options?.onResponse)
          }); }
          finally { state.inFlight--; }
        } catch {
          let stopReason: "error" | "aborted" = "error";
          if (options?.signal?.aborted) stopReason = "aborted";
          return { api: model.api, answers: {}, model: model.id, provider: model.provider,
            stopReason, errorMessage: "Classifier account routing failed; check /jar accounts", timestamp: this.now() };
        }
      }),
      fetchDeferred: provider.fetchDeferred && ((model, handle, options) => {
        if (active()) throw new RoutingError("Deferred requests require account routing off");
        return provider.fetchDeferred!(model, handle, options);
      }),
      cancelDeferred: provider.cancelDeferred && ((model, handle, options) => {
        if (active()) throw new RoutingError("Deferred requests require account routing off");
        return provider.cancelDeferred!(model, handle, options);
      }),
      stream: (model, context, options) => {
        if (!active()) return provider.stream(model, context, options);
        return this.route(provider, model, context, options, false);
      },
      streamSimple: (model, context, options) => {
        if (!active()) return provider.streamSimple(model, context, options);
        return this.route(provider, model, context, options, true);
      }
    };
  }
  private route(provider: Provider, model: Model<Api>, context: TranscriptContext, options: StreamOptions = {}, simple: boolean): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();
    // One policy per request: a mode or allowlist change applies to the next request, never a retry.
    const settings = this.settings();
    void (async () => {
      let started = false;
      const tried = new Set<string>();
      try {
        while (true) {
          options.signal?.throwIfAborted();
          if ("deferred" in options && options.deferred) throw new RoutingError("Deferred requests require account routing off");
          const state = await this.select(provider, model, tried, settings, options.signal);
          tried.add(state.definition.name);
          let response: ProviderResponse | undefined;
          let exposed = false;
          let retry = false;
          let terminal = false;
          const attemptOptions = { ...this.cleanOptions(options),
            maxRetries: 0, maxRetryDelayMs: 0,
            onResponse: this.observeResponse(state, async (value: ProviderResponse, selected: Model<Api>) => {
              response = value;
              await options.onResponse?.(value, selected);
            }) };
          try {
            const models = await state.models;
            let attempt: AssistantMessageEventStream;
            if (simple) attempt = models.streamSimple(model, context, attemptOptions as SimpleStreamOptions);
            else attempt = models.stream(model, context, attemptOptions as ApiStreamOptions<Api>);
            for await (const event of attempt) {
              if (event.type === "start") {
                if (event.partial.content.length) exposed = true;
                if (!started) { output.push(event); started = true; }
                continue;
              }
              if (event.type === "error" && !exposed && !options.signal?.aborted
                && event.reason !== "aborted" && event.error.usage.totalTokens === 0 && event.error.usage.cost.total === 0 && response?.status === 429) {
                retry = true;
                break;
              }
              exposed = true;
              terminal = event.type === "done" || event.type === "error";
              output.push(event);
              if (terminal) break;
            }
          } finally { state.inFlight--; }
          if (retry) continue;
          if (!terminal) throw new RoutingError("Provider stream ended without a final response; request was not replayed");
          output.end();
          return;
        }
      } catch (error) {
        const message = failureMessage(model, error, options.signal);
        output.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
        output.end();
      }
    })();
    return output;
  }
}
