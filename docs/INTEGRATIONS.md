# Integrations

pi-jar presents public statuses from other extensions and owns its own session-local workflows (tasks, plans, goals, suggestions). It never reads another extension's private state. It targets the current `@earendil-works/*` Pi API; the legacy `@mariozechner/*` packages are not supported.

## Public data

The footer reads Pi's model, thinking level, context usage and git branch. It also shows the texts that other extensions publish with `ctx.ui.setStatus(key, text)`, which Pi exposes to custom footers through `footerData.getExtensionStatuses()`. Free-form status text stays free-form: pi-jar never infers roles, ordering or failure from prose.

## Opt-in role contract

An extension with authoritative teammate state can publish it:

```ts
ctx.ui.setStatus("pi-jar.role.worker-17", JSON.stringify({
  name: "API Builder", label: "API", state: "working", task: "implement",
  expiresAt: Date.now() + 30_000
}));
// Refresh before expiry while it is live; clear it when finished.
ctx.ui.setStatus("pi-jar.role.worker-17", undefined);
```

- Key suffix: lowercase alphanumerics and hyphens, 1–32 characters.
- `name` is required. `label` and `task` are optional human-readable strings.
- `state`: `idle | thinking | working | waiting | reviewing | done | failed`.
- `expiresAt`: epoch milliseconds, in the future and at most 30 s ahead. An expired, malformed or unsupported entry displays as `<id>: unavailable` until the publisher updates or clears it.
- Fields are sanitized and bounded. The JSON may be at most 4096 characters.

The welcome card's **TEAM** row and the footer roles use this data. Without a publisher, no teammate is shown.

## Quota publisher (preferred over the network fallback)

```ts
ctx.ui.setStatus("pi-jar.quota.openai-codex", JSON.stringify({
  fiveHour: { used: 42 }, week: { used: 15 },
  expiresAt: Date.now() + 60_000
}));
```

- `used` is a percentage from 0 to 100. Either window may be omitted, and each can carry an optional `resetsAt` (epoch milliseconds).
- `expiresAt` is required and may be at most five minutes ahead. A valid published status always wins.
- `/jar quota on` (the default each session) lets pi-jar resolve the current Anthropic or OpenAI Codex OAuth credentials through Pi's model registry and make a **read-only** request to the provider's quota endpoint when nothing is published.
- Requests have a 5 s timeout and results (including failures) are cached for 5 minutes. `/jar quota off` cancels pending requests and clears the cache.
- These provider endpoints are not stable public APIs.

## Session entries owned by pi-jar

| Custom type | Contents | Replay |
| --- | --- | --- |
| `pi-jar.task` | versioned to-do events (`write`, `add`, `edit`, `status`, `delete`; legacy `toggle` accepted) | active branch on start, tree navigation and compaction |
| `pi-jar.goal` | goal events (`set`, `status`, `round`; v1 `set`/`clear` accepted) | active branch |
| `pi-jar.plan` | plan state (`enabled`, `steps`, `text`, `path`, `title`) | active branch |

Hidden context messages (`pi-jar.plan-context`, `pi-jar.plan-reminder`, `pi-jar.goal-context`, `pi-jar.goal-continuation`, `pi-jar.suggest-reminder`) are filtered or deduplicated in the `context` hook, so they never accumulate.

## Tools pi-jar registers

| Tool | Purpose |
| --- | --- |
| `jar_todo` | branch-aware checklist: `todos` full-list writes (`content`, `status` pending/in_progress/completed, `activeForm`), plus `list`, `add`, `start`, `done`, `open`, `edit`, `delete` |
| `jar_ask` | structured questions answered in the TUI |
| `jar_plan_submit` | submit a plan file for review (plan mode only) |
| `jar_goal` | `get`, `complete` (with evidence, audit phase only), `block` |
| `jar_suggest` | one next-prompt suggestion shown as composer ghost text |

## Working signals and other managers

Working wording, icon colors and Ember's moods use only Pi's public agent, turn, UI-prompt and tool-execution events. "Thinking" means active generation, not access to hidden reasoning. Motion stops when animations are off, the run settles, the UI is disabled or the session shuts down.

`/jar hub` lists installed extension commands `/tasks` and `/subagents-fleet` when present and opens the one you pick. It never reads their data or replaces their controls.

## Editor and footer ownership

`/jar composer on` wraps an existing custom editor factory if another extension installed one, or otherwise replaces Pi's editor with a `CustomEditor` subclass that keeps Pi's application keybindings. `/jar composer off` restores only a factory pi-jar still owns and keeps the draft. `/jar ui off` gives the footer back to Pi.
