# Multi-account routing (Pi 1.5+)

Route a selected model across accounts **of the same provider** without creating duplicate model IDs, changing role assignments, or using an LLM to choose credentials. Routing is opt-in and defaults to **off**.

## Set up accounts

For subscriptions, sign in independently for each account:

```text
/jar accounts login openai-codex work
/jar accounts login openai-codex personal
/jar accounts mode sticky
```

Open the sign-in URL shown by Pi and complete the provider's flow. Use the correct browser account/profile for each login. Anthropic and other providers with a native OAuth login also work. Repeating `login PROVIDER NAME` renews an existing OAuth account; it never imports/copies Pi's main login or its refresh token. An interrupted first login leaves an unactivated private directory; retry with a new name rather than silently overwriting credentials.

For API keys, first supply distinct environment variables through your normal secret manager or shell environment, then reference their **names**, not their values:

```text
/jar accounts add openai work WORK_OPENAI_API_KEY
/jar accounts add openai personal PERSONAL_OPENAI_API_KEY
```

The environment variables must be present in Pi's process. This form is for providers accepting an API key; it is not a replacement for AWS profiles, ADC, or provider-specific endpoint/environment setup. Commands never accept literal keys or execute credential scripts.

## Choose a routing policy

Enable or disable routing directly:

```text
/jar routing on
/jar routing off
/jar routing status
```

`on` keeps an already-active policy, or selects sticky when routing was off. `off` restores the original provider/authentication. These settings apply to the active profile. To select a particular policy, use `/jar routing quota-first` (also accepts `sticky` and `round-robin`).

Open **`/jar settings` → Pi → Account routing policy**, or use:

```text
/jar accounts mode quota-first
/jar accounts
```

- **off** — normal Pi authentication; no account quota lookups.
- **sticky** — keep the same eligible account, minimizing prompt-cache changes. Recommended default when enabling routing.
- **round-robin** — rotate eligible accounts in each process.
- **quota-first** — prefer the account with the most remaining quota in its most constrained active window; prefer fewer local in-flight requests when quota ties. Known quota ranks above unknown quota.

The account status lists remaining subscription quota, shared cooldowns, and quota-lookup warnings. The footer identifies the selected account and uses its fresh quota rather than the main login's limits. `/usage` retains Pi's original token/cost accounting, including provider-reported billing totals in Pi 1.5; switching accounts does not reset session cost. There is no separate account-cost ledger.

## Profiles, roles and subagents

The policy and optional account allowlist belong to the active profile:

```text
/jar accounts use work,personal
/jar accounts use all
```

An empty allowlist (`all`) permits all configured accounts. A named allowlist only permits those accounts; it never falls back to an excluded account or Pi's main login for a routed provider. Account names are global and unique; credentials are not embedded in profiles or project files.

Keep roles unchanged, for example `/roles set worker openai-codex/gpt-6.1-terra`. Routing happens below model selection, including advisor/commit side calls, compaction, and chat calls from subagents. At every spawn/relaunch, a child inherits the parent's policy and allowlist; pi-jar adds no tokens to its environment. Native OAuth refresh locks coordinate credential refresh, and quota/cooldown files are updated under a per-account lock so concurrent processes cannot erase each other's cooldowns. Rotation cursors and in-flight counts are process-local, not a distributed scheduler. A request keeps the policy and allowlist it was dispatched with; changes apply to the next request.

**Trust boundary for subagents.** Subagents run as your user and inherit Pi's process environment. OAuth tokens stay in private files the child reads only through its own routing. For environment-backed accounts, when routing is on with a named allowlist, the variables of excluded accounts are removed from the child's environment (unless an allowed account uses the same variable). All other environment variables, including allowed accounts' keys and Pi's own provider keys, still reach the child. With routing off or no allowlist nothing is removed, because the child may need those variables for Pi's normal login.

Only providers with configured accounts are wrapped. Providers without configured accounts continue using normal Pi auth. An explicitly configured **role fallback** can still change models/providers after account routing fails; the account router itself never does so. Image/classifier operations select an eligible account once and preserve their native results; they do not automatically replay failed requests.

## Quotas and retries

For **OpenAI Codex** and **Anthropic OAuth**, built-in usage endpoints provide five-hour/weekly subscription limits. Results are shared privately for five minutes; concurrent lookups within a process coalesce. Exhausted windows exclude an account until reset or refreshed quota shows availability. Other providers/API-key accounts have **unknown** proactive quota and rely on provider enforcement.

A failed quota lookup retains known limits, reports a warning, and backs off for five minutes. Unknown quota does **not** imply unlimited quota: the model endpoint remains authoritative. Cached limits and process-local selection cannot guarantee an atomic reservation of provider quota across simultaneous requests.

An explicit HTTP **429** can move a chat request to another account, at most once per eligible account. This is allowed only before response content is exposed and when the failed attempt reports no tokens or cost. The router honors `Retry-After` (or a 60-second cooldown), shares the cooldown across processes, and disables nested SDK retries for these attempts. It does not replay cancellation, partial output, authentication failures, server errors, or billed attempts. If every eligible account is unavailable/exhausted, the request fails with an account-routing diagnostic.

Quota probes only cover the provider's published common windows, not every model-specific/organization limit. Those limits remain enforced by the provider. This feature does not bypass account limits, subscription terms, or organization policy.

**Deferred/background responses require routing off** because their handles need persistent account affinity. Existing requests should be completed/cancelled before changing account configuration.

## Credential security

Files live under `~/.pi/agent/pi-jar-accounts/` (or Pi's configured agent directory). Each account has non-secret `account.json`, an OAuth `auth.json` when applicable, and private quota/cooldown metadata. Malformed/unsafe account configuration fails closed while routing is enabled, rather than silently using the main login. Unix directories must be owner-only (`700`) and files owner-only (`600`); symlinks and unsafe ownership/permissions are rejected. On Windows, protect the agent directory with your user ACL; Unix mode checks do not enforce Windows ACLs.

Pi 1.5's public `ModelRuntime` owns credential persistence, cross-process refresh locking, and rotated-token recovery. The router reuses native provider streams, catalogs, request hooks, cancellation, tools, and usage. It does not replace global `fetch`, copy provider implementations, execute custom routing scripts, persist API-key values, or log OAuth secrets. Pi's primary credential contents remain unchanged while routing.

Provider endpoints and non-auth request options still follow your trusted Pi provider configuration. Account routing replaces request credentials; do not put additional credential headers in model configuration. Account files remain sensitive even if their labels and quota values are not secrets. Back them up only to a protected location, and never commit them. Removing local credentials does not revoke a provider's session; revoke access through the provider when retiring an account.

The design is informed by [pi-multi-pass](https://github.com/hjanuschka/pi-multi-pass), but deliberately omits provider aliases, cross-provider chains, routing scripts and scheduled pools.
