import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Todo } from "./tasks.ts";
import { TodoStore } from "./tasks.ts";

const ACTIONS = ["list", "add", "done", "open", "edit", "delete"] as const;
const Action = Type.Unsafe<(typeof ACTIONS)[number]>({ type: "string", enum: ACTIONS as any });

const Parameters = Type.Object({
  action: Action,
  id: Type.Optional(Type.String({ description: "Task id returned by jar_todo list/add." })),
  title: Type.Optional(Type.String({ description: "Concise actionable task title." })),
  details: Type.Optional(Type.String({ description: "Optional short task context for a new task." }))
});

interface TaskToolDetails {
  action: string;
  items: Todo[];
  changed?: string;
}

const snapshot = (store: TodoStore) => store.all();

const summary = (items: readonly Todo[]) => {
  const open = items.filter((item) => !item.done).length;
  return `${open} open · ${items.length - open} done`;
};

const lines = (items: readonly Todo[]) => items.length
  ? items.map((item) => `${item.done ? "☑" : "☐"} ${item.title} [${item.id}]`).join("\n")
  : "No tracked tasks.";

export function registerTaskTool(
  pi: ExtensionAPI,
  store: () => TodoStore | undefined,
  changed: (ctx: ExtensionContext) => void
): void {
  if (typeof (pi as ExtensionAPI & { registerTool?: unknown }).registerTool !== "function") return;
  pi.registerTool({
    name: "jar_todo",
    label: "tasks",
    description: "Maintain pi-jar's branch-aware session task list. Use it proactively for multi-step work so progress remains visible without user prompting.",
    promptSnippet: "Track multi-step work with jar_todo; keep the checklist synchronized as you work.",
    promptGuidelines: [
      "For any request requiring two or more substantive actions, use jar_todo proactively without waiting for the user: list current tasks, add any missing actionable steps, and mark each step done as it completes.",
      "When using jar_todo, keep titles concise and outcome-oriented, reuse matching open tasks instead of creating duplicates, and do not create tasks for trivial single-step questions."
    ],
    parameters: Parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = store();
      if (!current) {
        return { content: [{ type: "text", text: "Task tracking is unavailable before a Pi session starts." }], details: { action: params.action, items: [] } satisfies TaskToolDetails };
      }
      let changedId: string | undefined;
      let ok = true;
      switch (params.action) {
        case "list":
          break;
        case "add": {
          const item = params.title?.trim() ? current.add(params.title, params.details) : undefined;
          ok = !!item;
          changedId = item?.id;
          break;
        }
        case "done":
        case "open":
          ok = !!params.id && current.setDone(params.id, params.action === "done");
          changedId = ok ? params.id : undefined;
          break;
        case "edit":
          ok = !!params.id && !!params.title?.trim() && current.edit(params.id, params.title);
          changedId = ok ? params.id : undefined;
          break;
        case "delete":
          ok = !!params.id && current.delete(params.id);
          changedId = ok ? params.id : undefined;
          break;
      }
      if (params.action !== "list" && ok) changed(ctx);
      const items = snapshot(current);
      const message = ok
        ? `${params.action === "list" ? "Tasks" : "Task list updated"}: ${summary(items)}\n${lines(items)}`
        : `Could not ${params.action} task. Provide the required title/id from jar_todo list.`;
      return {
        content: [{ type: "text", text: message }],
        details: { action: params.action, items, ...(changedId ? { changed: changedId } : {}) } satisfies TaskToolDetails
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("tasks"));
      text += " " + theme.fg("accent", args.action);
      if (args.title) text += " " + theme.fg("muted", args.title);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Updating tasks…"), 0, 0);
      const details = result.details as TaskToolDetails | undefined;
      const items = details?.items ?? [];
      let text = theme.fg("success", summary(items));
      if (!expanded) {
        const next = items.find((item) => !item.done);
        if (next) text += theme.fg("dim", ` · next: ${next.title}`);
        text += theme.fg("dim", " · expand for checklist");
        return new Text(text, 0, 0);
      }
      for (const item of items) {
        text += "\n  " + theme.fg(item.done ? "dim" : "accent", `${item.done ? "☑" : "☐"} ${item.title}`);
      }
      return new Text(text, 0, 0);
    }
  });
}
