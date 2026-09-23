# Integrations

pi-jar is a presentation layer. External extensions remain authoritative for their own state.

## Integration policy

Preference order:

1. documented Pi lifecycle/event APIs;
2. `ctx.ui.setStatus()` / footer extension status data;
3. documented extension APIs or exported integration hooks;
4. explicit user configuration;
5. private storage inspection only as a last resort, and never silently.

The goal is to avoid fragile coupling to another package's internal JSON or runtime directory.

## Team Mode

Target information:

- teammate name/role;
- lifecycle state;
- current task summary;
- worktree/branch in verbose mode;
- completion/failure.

pi-jar maps external state into:

```ts
interface RoleStatus {
  id: string;
  label: string;
  name: string;
  state: "idle" | "thinking" | "working" | "waiting" | "reviewing" | "done" | "failed";
  task?: string;
}
```

Gareng, Petruk, and Bagong are defaults, not a hard limit. Arbitrary Team Mode teammates should render using the same model.

## Advisor Flow

Target states:

- idle;
- consulting;
- completed;
- failed.

The footer should not show permanent motion merely because Advisor Flow is enabled.

## SoL-Pi

Target states:

- installed/enabled;
- active reduction;
- active compaction.

pi-jar should not duplicate SoL-Pi's logic or inspect sensitive reduced content. Only lifecycle/status information belongs in the UI.

## Generic extension statuses

Pi custom footers can read statuses published by other extensions. pi-jar will use this where it provides enough semantic information, with adapters for richer integrations where necessary.
