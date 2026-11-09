# Multi-account routing (Pi 1.5+)

Route a selected model across accounts **of the same provider** without creating duplicate model IDs, changing role assignments, or using an LLM to choose credentials. Routing is opt-in and defaults to **off**.

## Set up accounts

Open the **OMP-style provider/account hub** with **`/jar accounts`** (also **`/jar settings` → Accounts → Manage accounts**). Built on Pi's native TUI, it lists providers in one pane and accounts, connection status, quotas, cooldowns and pins in the other. Use **↑/↓** to select, **Tab/Shift+Tab** to change panes, **Enter** to open a row, **/** to search, or the **A/S/R/P/Q** shortcuts for add, switch, routing, profile access and quota. On narrow terminals the panes stack; Pi fullscreen supports mouse clicks. You can reconnect, sign out, or remove an account in its details. Accounts from unregistered/removed providers appear as **OFFLINE** groups and can still be removed, without running that provider’s authentication. Search filters account rows by label as well as provider groups. Profile access explicitly distinguishes **All accounts** from selecting **Restrict to** one identity. **`/jar accounts list`** is the noninteractive status view.

**Provider isolation:** `openai-codex` accounts form their own pool, independent of `anthropic`, `openai`, or any other provider. Switching a Codex account does not alter Anthropic's routing, models, or roles. Pi-Jar does not change a model/provider to chase another account.

For subscriptions, sign in independently for each account:

```text
/jar accounts login openai-codex work
/jar accounts login openai-codex personal
/jar accounts mode sticky
```

Pi-Jar delegates authentication to **Pi's native `ModelRuntime.login()` and the provider's own OAuth flow**, using the same built-in method selection, authorization URLs, credential persistence and refresh logic as Pi's `/login`. Each named account gets a separate private credential file, so the main Pi login is neither copied nor overwritten.

**Browser login troubleshooting:** For OpenAI Codex, choose **Device code** in Pi's provider login-method prompt, or run `/jar accounts login-device openai-codex work`. Open the verification URL on any browser and enter the displayed code. This avoids the `localhost:1455` callback, which may not reach Pi over SSH, containers or remote development. If using browser login, open the full authorization URL and, if the callback does not reach Pi, paste the **full redirected URL or authorization code** into the manual-code prompt. Pi-Jar now closes that prompt when the native callback succeeds instead of leaving a blocked modal behind. The provider must support device code for `login-device`.

Use the correct browser account/profile for each login. Anthropic and other providers with a native OAuth login also work. Repeating `login PROVIDER NAME` renews an existing OAuth account; it never imports/copies Pi's main login or its refresh token. If a first-time login fails before saving credentials, its empty private reservation is automatically released so the same label can be retried. A directory containing files is **never** deleted implicitly. Use `/jar accounts recover NAME` only for an abandoned **empty** reservation from an interrupted/older login; if files remain, inspect them securely instead of deleting unknown credentials.

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

To sign out without losing the account label, open `/jar accounts`, choose the provider/account and **Sign out**. Or use `/jar accounts logout NAME`. Reconnecting the same label invokes Pi's native OAuth flow again. To delete the account label and local credentials entirely, choose **Remove local account credentials** and confirm, or use **`/jar accounts remove NAME`** (also works when the provider is no longer registered). Removal rejects unexpected private files or locks and never touches Pi's primary login. Neither action revokes a provider-side session; revoke it at the provider when required.

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

**Switching versus routing:** Open **Switch active account** and select a provider. Choose **Automatic** to keep `sticky`, `round-robin`, or `quota-first` routing across all eligible accounts **of that provider**, including safe pre-output HTTP 429 failover. Choosing an individual account **pins only that provider** and intentionally disables automatic failover to another account until you unpin it. The same options are available as commands:

```text
/jar accounts pin openai-codex work
/jar accounts auto openai-codex
```

A pin must refer to a configured, authenticated account allowed by the active profile; incompatible pins are removed automatically when an account is excluded, signed out, or deleted. The default is automatic routing, with no pins. Pins are profile-scoped and inherited by subagents as non-secret routing policy.

The account status lists remaining subscription quota, shared cooldowns, and quota-lookup warnings. The footer identifies the selected account and uses its fresh quota rather than the main login's limits. `/usage` retains Pi's original token/cost accounting, including provider-reported billing totals in Pi 1.5; switching accounts does not reset session cost. There is no separate account-cost ledger.


### Provider-scoped routing

Pi-Jar never creates shadow providers such as `openai-codex-2` and never rewrites the active provider/model ID. Every account is tied to its exact Pi provider ID. Automatic sticky, round-robin and quota-first selection run **only within that provider's pool**, with profile allowlist and individual account health applied before selection. A clean HTTP 429 can fail over to another eligible account of that same provider before any content or usage is exposed; a pinned account intentionally does not fail over. Cross-provider fallback is *only* possible through an explicitly configured model-role fallback, not the account router.

In the hub, selecting a named account pins that provider under the active Pi-Jar profile. It does **not** switch the model or affect other providers' account pools. Selecting `Automatic selection` clears the pin. If routing was off, explicitly selecting/pinning a named account enables `sticky` so the choice takes effect; selecting **Automatic** while routing is off leaves routing off and Pi’s native login untouched. Profile restrictions are enforced before pinning, and excluding a pinned account clears its pin. Policies are captured per request, so a UI change never reroutes an already-running response.

## Profiles, roles and subagents

The policy, per-provider pins, and optional account allowlist belong to the active profile:

```text
/jar accounts use work,personal
/jar accounts use all
```

An empty allowlist (`all`) permits all configured accounts. Removing the sole explicitly allowed account is refused even when it is the only configured account; you must explicitly choose **All accounts** or another allowlist first, so future accounts cannot accidentally gain access. A named allowlist applies **across** providers, so don't use it just to switch between two accounts for one provider: use per-provider **Switch / pin** instead. An allowlist never falls back to an excluded account or Pi's main login for a routed provider. Account names are global and unique; credentials are not embedded in profiles or project files.

Keep roles unchanged, for example `/roles set worker openai-codex/gpt-6.1-terra`. Routing happens below model selection, including advisor/commit side calls, compaction, and chat calls from subagents. At every spawn/relaunch, a child inherits the parent's policy and allowlist; pi-jar adds no tokens to its environment. Native OAuth refresh locks coordinate credential refresh, and quota/cooldown files are updated under a per-account lock so concurrent processes cannot erase each other's cooldowns. Rotation cursors and in-flight counts are process-local, not a distributed scheduler. A request keeps the policy and allowlist it was dispatched with; changes apply to the next request.

**Trust boundary for subagents.** Subagents run as your user and inherit Pi's process environment. OAuth tokens stay in private files the child reads only through its own routing. For environment-backed accounts, when routing is on with a named allowlist, the variables of excluded accounts are removed from the child's environment (unless an allowed account uses the same variable). All other environment variables, including allowed accounts' keys and Pi's own provider keys, still reach the child. With routing off or no allowlist nothing is removed, because the child may need those variables for Pi's normal login.

Only providers with configured accounts are wrapped. Providers without configured accounts continue using normal Pi auth. An explicitly configured **role fallback** can still change models/providers after account routing fails; the account router itself never does so. Image/classifier operations select an eligible account once and preserve their native results; they do not automatically replay failed requests.

## Quotas and retries

For **OpenAI Codex** and **Anthropic OAuth**, built-in usage endpoints provide five-hour/weekly subscription limits. Results are shared privately for five minutes; concurrent lookups within a process coalesce. Routing uses cached quota immediately and refreshes the provider usage endpoint asynchronously, so a delayed quota lookup cannot stall a model request. The one exception is `quota-first` with no cached quota at all: the first request waits at most 500 ms for the initial probes. Only the preferred account's model catalog is validated; the next account is checked only if it cannot serve the model. An account whose credential file is unreadable is skipped and named in the error if no other account qualifies. In-flight quota results are discarded after local invalidation or a persisted OAuth credential-generation change, including changes from other Pi sessions. Quota lookups run at most four at a time per provider (the rest queue), so a large pool cannot burst the usage endpoint. An OAuth account counts as signed in only if its private auth file holds a complete OAuth entry (access, refresh, numeric expiry) for its own provider; sign-out deletes that entry through Pi's credential store under the same file lock a native refresh holds, so a refresh in another Pi process cannot restore a signed-out identity; every new account gets its own credential generation (older accounts receive one on first use), so a label removed and re-created, even for the same provider, discards the previous identity's in-flight quota results and late 429s; a cached runtime is rebuilt when another Pi process re-creates the label with a different provider, auth type or credential generation. Account-specific model availability checks run one at a time in preference order, each limited to 5 seconds: a hung account is skipped (and cooled down for a minute) so healthy accounts behind it are still reached. A 429 cooldown is recorded only if the account's credential generation is unchanged since the request was dispatched. Exhausted windows exclude an account until reset or refreshed quota shows availability. Other providers/API-key accounts have **unknown** proactive quota and rely on provider enforcement.

A failed quota lookup retains known limits, reports a warning, and backs off for five minutes. Unknown quota does **not** imply unlimited quota: the model endpoint remains authoritative. Cached limits and process-local selection cannot guarantee an atomic reservation of provider quota across simultaneous requests.

An explicit HTTP **429** can move a chat request to another account, at most once per eligible account. This is allowed only before response content is exposed and when the failed attempt reports no tokens or cost. The router honors `Retry-After` (or a 60-second cooldown), shares the cooldown across processes, and disables nested SDK retries for these attempts. It does not replay cancellation, partial output, authentication failures, server errors, or billed attempts. If every eligible account is unavailable/exhausted, the request fails with an account-routing diagnostic.

Quota probes only cover the provider's published common windows, not every model-specific/organization limit. Those limits remain enforced by the provider. This feature does not bypass account limits, subscription terms, or organization policy.

**Deferred/background responses require routing off** because their handles need persistent account affinity. Existing requests should be completed/cancelled before changing account configuration.

## Credential security

Files live under `~/.pi/agent/pi-jar-accounts/` (or Pi's configured agent directory). Each account has non-secret `account.json`, an OAuth `auth.json` when applicable, and private quota/cooldown metadata. Malformed/unsafe account configuration fails closed while routing is enabled, rather than silently using the main login. Unix directories must be owner-only (`700`) and files owner-only (`600`); symlinks and unsafe ownership/permissions are rejected. On Windows, protect the agent directory with your user ACL; Unix mode checks do not enforce Windows ACLs.

Pi 1.5's public `ModelRuntime` owns credential persistence, cross-process refresh locking, and rotated-token recovery. The router reuses native provider streams, catalogs, request hooks, cancellation, tools, and usage. It does not replace global `fetch`, copy provider implementations, execute custom routing scripts, persist API-key values, or log OAuth secrets. Pi's primary credential contents remain unchanged while routing.

Provider endpoints and non-auth request options still follow your trusted Pi provider configuration. Account routing replaces request credentials; do not put additional credential headers in model configuration. Account files remain sensitive even if their labels and quota values are not secrets. Back them up only to a protected location, and never commit them. Removing local credentials does not revoke a provider's session; revoke access through the provider when retiring an account.

The design is informed by [pi-multi-pass](https://github.com/hjanuschka/pi-multi-pass), but deliberately omits provider aliases, cross-provider chains, routing scripts and scheduled pools.

## Unsafe or unreadable routing policy

`off` means "use Pi's own login", so it is only the result of a genuinely **absent** policy (a profile or settings file from before account routing, or a fresh install). A policy that is present but cannot be trusted **locks routing** instead: every request is refused with an `unsafe` error and never reaches a provider with Pi's primary credential. This covers a malformed mode, allowlist or pin, a profiles file that cannot be loaded, a legacy settings file that is unreadable, malformed JSON or an unknown version, and an inherited subagent policy that cannot be parsed. The lock is saved with the profile, shown as `BLOCKED` in the hub, settings and `/jar accounts list`, and passed to subagents.

If no accounts are configured there is nothing a policy could restrict, so Pi is left on its own login rather than locked out. `pin` and `use` refuse while the policy is locked. Choosing a mode (`/jar accounts mode off|sticky|round-robin|quota-first`, or the settings row) resets the policy to a clean one, dropping the bad fields.
