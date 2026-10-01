# Subagent tool capabilities

Subagents use Pi's standard `--tools` allowlist. Each `jar_delegate` task can customize that allowlist independently:

```json
{
  "tasks": [
    { "task": "Research the API docs", "mode": "scout", "tools": ["read", "web_search", "fetch_content"] },
    { "task": "Implement the change", "mode": "worktree", "inheritTools": true }
  ]
}
```

- With neither option, existing mode defaults are unchanged: `scout` and `fork` are read-only; `worktree` gets the path-guarded file tools; legacy `direct` retains Pi's default allowlist.
- `tools` replaces the mode's default tool list. Names must be active in the parent session. Enable the relevant extension and tool in the parent first. Tool names vary by extension; use the exact active name (for example, a configured web/search extension's names).
- `inheritTools: true` snapshots the parent's currently active tool names, then filters them for mode safety. It does not grant tools registered later. Pi hosts must expose `getActiveTools()` (or the integration must supply an active-name getter); otherwise inheritance/configurable lists fail with an actionable error.
- `scout` and `fork` accept only known read-only/discovery tools and named web tools; edit/write, shell and arbitrary extension tools are rejected even if explicitly requested.
- `worktree` accepts known path-guarded file tools and named web tools. Shell and arbitrary extension tools are rejected. `multi_file_edit` is included in defaults only when active in the parent; each effective edit target, default path and recognized alternate path field is validated, including traversal and existing symlink escapes.
- Named web capabilities are `web_enable`, `web_search`, `fetch_content`, `get_search_content` and `source_check`. Newly enabled tools must still be in the child's original capability list.
- These are tool-call restrictions, not an OS sandbox. Extensions execute trusted code; named web tools can access external services, and legacy direct-write mode is not workspace-confined.
- `jar_delegate`, `jar_subagent`, and `jar_democracy` are always removed from inherited tools and rejected in explicit lists. A child cannot recursively spawn more subagents.
- Tool capabilities are per task; a batch can mix modes and allowlists. A fork still inherits the parent's conversation context, independently of its tool list.

Retained scout/fork/worktree children hibernate after 30 seconds idle: their Pi process exits, but the private child session and worktree remain for `jar_subagent resume` or `ask`. Hibernated records count against Max subagents. Unresolved worktree recovery records do not occupy a pool slot, but at most four active/recovery worktrees are admitted. `jar_subagent stop` retries reconciliation; `discard` explicitly removes an unresolved recovery workspace without applying it. On session shutdown pi-jar reports paths for worktrees it preserves on disk, including still-active worktrees that might contain edits.

If configurable tools are unavailable on a Pi host, use mode defaults or upgrade to a host exposing its active tool list. Avoid inheriting every tool for convenience; grant the narrowest capability needed for the assignment.
