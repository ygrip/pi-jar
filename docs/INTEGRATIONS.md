# Integrations

pi-jar presents external public statuses and owns an independent session-local to-do list; it is not an agent orchestrator. The currently supported Pi API is `@earendil-works/*` 0.85.1; older `@mariozechner/*` packages are out of scope.

## Public data

The footer reads Pi's model, context usage and git branch. It also preserves texts that other extensions publish through `ctx.ui.setStatus(key, text)` and that Pi exposes to custom footers via `footerData.getExtensionStatuses()`. A generic status remains generic text: pi-jar never guesses roles, workflow ordering, or failure from free-form prose. For example, an Advisor status `consulting` displays as `advisor: consulting`, not as an inferred consultation lifecycle.

## Optional opt-in role contract

An extension that has authoritative teammate state may publish it through Pi's public status API:

```ts
ctx.ui.setStatus("pi-jar.role.worker-17", JSON.stringify({
  name: "API Builder", label: "API", state: "working", task: "implement",
  expiresAt: Date.now() + 30_000
}));
// Refresh the status before expiry while it remains live.
ctx.ui.setStatus("pi-jar.role.worker-17", undefined); // Clear when finished/removed.
```

- Key suffix: lowercase alphanumeric/hyphens, 1–32 characters.
- `name`: required human-readable string. `label` and `task`: optional human-readable strings.
- `state`: `idle | thinking | working | waiting | reviewing | done | failed`.
- `expiresAt`: required epoch milliseconds in the future, no more than 30 seconds ahead. Refresh it while state is current; pi-jar displays an expired, malformed or unsupported role as `<id>: unavailable` until the publisher clears/updates it. No private storage is read.
- String fields are sanitized and bounded. The published JSON must be at most 4096 characters.

IDs, names and labels are supplied by the publisher: no fixed Punakawan IDs are required. This protocol is opt-in and does **not** mean Team Mode, Advisor Flow, or SoL-Pi currently publish it. Their statuses display as generic public text until a verified, documented integration exists. On a narrow terminal, absent optional integrations stay hidden so model/context and an active or failed role remain readable.

## Optional quota publisher (preferred over network fallback)

A quota integration can publish a JSON status under `pi-jar.quota.openai-codex` or `pi-jar.quota.anthropic`:

```ts
ctx.ui.setStatus("pi-jar.quota.openai-codex", JSON.stringify({
  fiveHour: { used: 42 }, week: { used: 15 },
  expiresAt: Date.now() + 60_000
}));
```

`used` is a percentage from 0 to 100; either window can be omitted; optional `resetsAt` is an epoch millisecond timestamp. `expiresAt` is required, no more than five minutes ahead. Missing, expired or malformed quotas stay hidden. A valid publisher wins over the opt-in network fallback. The installed `pi-mono-status-line` currently fetches its own quota but does **not** publish a shareable status; pi-jar never reads its private cache.

If the user runs `/jar quota on`, pi-jar can resolve the current Anthropic or OpenAI Codex OAuth token through Pi's public model registry and make a read-only request to the provider quota endpoint when no valid published status exists. Consent is session-local and off by default. Only those two provider OAuth types are supported; failures, unsupported models, and absent windows are hidden. Responses are cached for five minutes (including failures); requests have a five-second timeout. `/jar quota off` cancels pending requests and clears the cache. The provider endpoints may change without notice.

## Separate task ownership and public working signals

`/jar tasks` creates **pi-jar-only** to-dos stored as versioned `pi.appendEntry("pi-jar.task", ...)` session entries. The current branch is replayed on reload/tree navigation. These items do not execute agents, and checking one never marks a Team Mode task complete. No Team Mode or subagent files are read.

Creative working wording and icon colors use only Pi's public agent, turn, UI-prompt and tool-execution events. “Considering the next step” denotes active generation, not access to the model's hidden reasoning. Motion stops when `/jar animations off`, the turn settles, the UI is disabled, or the session shuts down.

`/jar hub` still lists installed extension commands `/tasks` (Team Mode) and `/subagents-fleet` (pi-subagents), opening the selected manager. It does not infer their tasks, read private manager data, or replace assign/steer/stop controls.

Pi-jar question dialogs are only invoked by pi-jar commands, not by intercepting other extensions. `/jar composer on` uses Pi's editor-component API if a prior custom editor factory exists; otherwise it adds a non-invasive label next to Pi's native editor. `/jar composer off` restores only a factory pi-jar still owns and preserves the current draft.

`/jar demo` overlays a visibly marked `DEMO` preview using generic Explorer, Builder and Reviewer examples, not live roles. `/jar reset` stops the preview and reveals real statuses again. `/jar ui off` restores Pi's built-in footer if another extension needs to own the footer or custom rendering fails.
