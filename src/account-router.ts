import {
  createAssistantMessageEventStream, type Api, type ApiStreamOptions, type AssistantMessage,
  type AssistantMessageEventStream, type Model, type Provider, type ProviderResponse,
  type SimpleStreamOptions, type TranscriptContext, type AnyModel, type ProviderHeaders
} from "@earendil-works/pi-ai";
import type { AccountDefinition, AccountHealth, AccountStore } from "./account-store.ts";
import type { AccountRoutingSettings } from "./account-settings.ts";
import { fetchQuota, QUOTA_TTL_MS, type Quota, type QuotaProvider } from "./quota.ts";

type StreamOptions = SimpleStreamOptions | ApiStreamOptions<Api>;
interface AccountState {
  definition: AccountDefinition;
  models: ReturnType<AccountStore["models"]>;
  health: AccountHealth;
  pending?: Promise<void>;
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
  constructor(store: AccountStore, settings: () => AccountRoutingSettings,
    now: () => number = Date.now, quotaFetcher = fetchQuota) {
    this.store = store;
    this.settings = settings;
    this.now = now;
    this.quotaFetcher = quotaFetcher;
  }

  private state(account: AccountDefinition, provider: Provider): AccountState {
    let state = this.states.get(account.name);
    if (!state) {
      state = { definition: account, models: this.store.models(account, provider), health: this.store.health(account.name), nextCheck: 0, inFlight: 0 };
      this.states.set(account.name, state);
    }
    return state;
  }
  private async refreshQuota(state: AccountState, signal?: AbortSignal): Promise<void> {
    const provider = state.definition.provider;
    if (state.definition.auth !== "oauth" || !["anthropic", "openai-codex"].includes(provider)) return;
    const now = this.now();
    if (state.pending) return waitForQuota(state.pending, signal);
    if (state.nextCheck > now) return;
    const shared = this.store.health(state.definition.name);
    state.health = shared;
    if (typeof shared.checkedAt === "number" && shared.checkedAt <= now && shared.checkedAt + QUOTA_TTL_MS > now) return;
    state.pending = (async () => {
      let quota: Quota | undefined;
      try {
        quota = await this.quotaFetcher(provider as QuotaProvider, async (id) => (await state.models).getAuth(id), AbortSignal.timeout(5000));
        state.quotaError = undefined;
      } catch {
        // Preserve known limits during endpoint outages; do not mistake unknown quota for zero.
        state.quotaError = "Quota lookup unavailable; provider limits still apply";
      }
      if (quota) {
        const checkedAt = this.now();
        state.health = this.store.updateHealth(state.definition.name, current => ({ ...current, quota, checkedAt }));
      }
      state.nextCheck = this.now() + QUOTA_TTL_MS;
    })().finally(() => { state.pending = undefined; });
    return waitForQuota(state.pending, signal);
  }
  /** `settings` is the policy captured when the request was dispatched; retries reuse it. */
  private async select(provider: Provider, model: AnyModel, tried: Set<string>, settings: AccountRoutingSettings, signal?: AbortSignal): Promise<AccountState> {
    if (this.configurationError) throw new RoutingError(this.configurationError);
    // Provider IDs are the credential boundary. Model IDs are not globally unique,
    // so a same-named model from another provider must never select these credentials.
    if (model.provider !== provider.id) {
      throw new RoutingError(`Model ${model.provider}/${model.id} does not belong to routed provider ${provider.id}`);
    }
    const pinnedName = settings.pinned?.[provider.id];
    const accounts = this.store.list().filter(account => account.provider === provider.id
      && (!settings.accounts.length || settings.accounts.includes(account.name))
      && (!pinnedName || account.name === pinnedName)
      && !tried.has(account.name)
      // The ModelRuntime may hold a credential in memory after another Pi process
      // signs out or an API-key environment variable disappears. A fresh request
      // must never select an account whose configured credential source is gone.
      && this.store.hasCredentials(account));
    const states = accounts.map(account => this.state(account, provider));
    await Promise.all(states.map(state => this.refreshQuota(state, signal)));
    signal?.throwIfAborted();
    const eligible: AccountState[] = [];
    for (const state of states) {
      state.health = this.store.health(state.definition.name);
      if ((state.health.blockedUntil ?? 0) > this.now() || remainingQuota(state.health.quota, this.now()) === 0) continue;
      // Preserve credential-specific model eligibility, not merely the provider's catalog.
      if ((state.unavailableUntil ?? 0) > this.now()) continue;
      try {
        const models = await (await state.models).getAllAvailable(provider.id, { signal });
        if (models.some(candidate => candidate.provider === provider.id && candidate.id === model.id
          && (candidate.type ?? "chat") === (model.type ?? "chat") && candidate.api === model.api)) eligible.push(state);
      } catch {
        signal?.throwIfAborted();
        state.unavailableUntil = this.now() + 60_000;
      }
    }
    if (!eligible.length) throw new RoutingError(`No eligible ${provider.id} account for ${model.id}; check /jar accounts, profile allowlist, login and quota resets`);
    if (settings.mode === "quota-first") {
      eligible.sort((a, b) => (remainingQuota(b.health.quota, this.now()) ?? -1) - (remainingQuota(a.health.quota, this.now()) ?? -1)
        || a.inFlight - b.inFlight || a.definition.name.localeCompare(b.definition.name));
    } else if (settings.mode === "sticky") {
      const name = this.sticky.get(provider.id);
      const index = eligible.findIndex(state => state.definition.name === name);
      if (index > 0) eligible.unshift(eligible.splice(index, 1)[0]!);
    } else if (settings.mode === "round-robin") {
      const cursor = this.cursor.get(provider.id) ?? 0;
      const index = cursor % eligible.length;
      this.cursor.set(provider.id, cursor + 1);
      eligible.push(...eligible.splice(0, index));
    }
    const selected = eligible[0]!;
    this.sticky.set(provider.id, selected.definition.name);
    this.onRoute?.(selected.definition.name, provider.id, selected.health);
    selected.inFlight++;
    return selected;
  }
  invalidate(name: string): void {
    this.states.delete(name);
    // Re-login, sign-out, or deletion invalidates the account's last-used marker.
    for (const [provider, selected] of this.sticky) if (selected === name) this.sticky.delete(provider);
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
    return async (response: ProviderResponse, model: TModel): Promise<void> => {
      if (response.status === 429) {
        const blockedUntil = retryAfter(response, this.now());
        state.health = this.store.updateHealth(state.definition.name, current => ({ ...current, blockedUntil }));
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
