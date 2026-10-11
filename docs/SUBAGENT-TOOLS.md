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
- `tools` entries are `name`/`+name` (allow) or `-name` (subtract). Any allow entry makes an exact list that replaces the mode defaults and is the moderator's deliberate grant: any tool active in the parent is honored, including MCP/extension tools such as `mom_search` or `punakawan_project`. Include the basics you still need (`read`, `jar_todo`, ...). Only `-name` entries subtract from the mode defaults (or inherited tools), e.g. `["-jar_discuss"]`. A scout or fork granted a mutating tool is no longer strictly read-only — grant narrowly.
- `skills` (per task) uses the same syntax for Pi skills, by name or path: `["mom", "punakawan"]` (or `[]`) is exact, `["-lavish"]` removes from the defaults; omit it to keep the defaults. Children then run `--no-skills --skill <path>...`.
- `inheritTools: true` snapshots the parent's currently active tool names, then filters them for mode safety plus the trusted extras from `pi-jar-subagents.json`. It does not grant tools registered later. Pi hosts must expose `getActiveTools()` (or the integration must supply an active-name getter); otherwise inheritance/configurable lists fail with an actionable error.
- Inherited `scout`/`fork` tools are known read-only/discovery tools, named web tools and trusted extras.
- `worktree` rejects shell tools even when explicitly requested (a shell would escape the path guard). Inherited worktree tools are path-guarded file tools, named web tools and trusted extras. `multi_file_edit` is included in defaults only when active in the parent; each effective edit target, default path and recognized alternate path field is validated, including traversal and existing symlink escapes.
- Named web capabilities are `web_enable`, `web_search`, `fetch_content`, `get_search_content` and `source_check`. Newly enabled tools must still be in the child's original capability list.
- These are tool-call restrictions, not an OS sandbox. Extensions execute trusted code; named web tools can access external services, and legacy direct-write mode is not workspace-confined.
- `jar_delegate`, `jar_subagent`, and `jar_council` are always removed from inherited tools and rejected in explicit lists. A child cannot recursively spawn more subagents.
- Tool capabilities are per task; a batch can mix modes and allowlists. A fork still inherits the parent's conversation context, independently of its tool list.

Retained scout/fork/worktree children hibernate after 30 seconds idle: their Pi process exits, but the private child session and worktree remain for `jar_subagent resume` or `ask`. Hibernated records count against Max subagents. Unresolved worktree recovery records do not occupy a pool slot, but at most four active/recovery worktrees are admitted. `jar_subagent stop` retries reconciliation; `discard` explicitly removes an unresolved recovery workspace without applying it. On session shutdown pi-jar reports paths for worktrees it preserves on disk, including still-active worktrees that might contain edits.

## `~/.pi/agent/pi-jar-subagents.json`

User-owned and profile-independent; read on every launch. A missing file means no rules; malformed content fails the launch with an error. Each list takes `+entry` (or bare `entry`) to allow and `-entry` to disallow; a disallow wins over an allow, and user disallows always win over the moderator's task requests (which are then rejected with an error).

```json
{
  "tools": ["+mom_search", "+mom_get", "-punakawan_connector_call"],
  "extensions": ["+npm:@gotgenes/pi-anthropic-auth", "-pi-web-access"],
  "skills": ["+antislop", "-lavish"]
}
```

- `tools` — allow: trusted names added to `inheritTools` in every mode. Disallow: removed from defaults/inheritance and rejected in explicit task lists. Recursive delegation tools can never be allowed.
- `extensions` — entries are Pi package sources (`npm:@scope/name`, `git:host/owner/repo`, URLs), short names (npm package, git repo, a top-level extension file/dir name, or a builtin such as `mcp`), or paths (`~/`, absolute, `./`, or `dir/file` relative to the agent dir). Sources and names resolve to the installed paths from the parent's own Pi resolution (settings filters included); an allowed source that is not installed is passed to Pi as-is (Pi installs it temporarily, slower).
  - allow: loaded by every child. Default read-only scouts/forks run `--no-extensions` plus pi-jar for fast startup, so a provider extension such as Anthropic OAuth compatibility must be allowed here or those children fail authentication. Children with normal discovery get it added only when it is not already loaded.
  - disallow: children that would use normal discovery instead get `--no-extensions` plus the parent's enabled extensions (top-level, packages and enabled builtins) minus the disallowed ones. A parent started with `--no-extensions` never gains discovered extensions.
- `skills` — names or paths. allow: added to children's default skills, even when disabled in the parent. Disallow: never loaded by children; a task asking for one is rejected. When any skill rule (config or task) applies, children get an exact `--no-skills --skill ...` list; otherwise Pi's normal discovery is unchanged.
- The running pi-jar is always loaded explicitly; another installed pi-jar copy is never loaded twice.

If configurable tools are unavailable on a Pi host, use mode defaults or upgrade to a host exposing its active tool list. Avoid inheriting every tool for convenience; grant the narrowest capability needed for the assignment.
