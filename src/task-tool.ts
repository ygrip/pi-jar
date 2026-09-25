import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Todo } from "./tasks.ts";
import { TODO_STATUSES, TodoStore, todoMark } from "./tasks.ts";

const ACTIONS = ["write", "list", "add", "start", "done", "open", "edit", "delete"] as const;
const Action = Type.Unsafe<(typeof ACTIONS)[number]>({ type: "string", enum: ACTIONS as any });
const Status = Type.Unsafe<(typeof TODO_STATUSES)[number]>({ type: "string", enum: TODO_STATUSES as any });

const Parameters = Type.Object({
  todos: Type.Optional(Type.Array(Type.Object({
    content: Type.String({ description: "Imperative task title, e.g. \"Run the tests\"." }),
    status: Status,
    activeForm: Type.Optional(Type.String({ description: "Present-continuous form shown while it runs, e.g. \"Running the tests\"." }))
  }), { description: "The complete, updated task list. Replaces the current list." })),
  action: Type.Optional(Action),
  id: Type.Optional(Type.String({ description: "Task id for start/done/open/edit/delete." })),
  title: Type.Optional(Type.String({ description: "Concise actionable task title for add/edit." })),
  details: Type.Optional(Type.String({ description: "Optional short task context for a new task." }))
});

interface TaskToolDetails {
  action: string;
  items: Todo[];
  changed?: string;
}

const summary = (items: readonly Todo[]) => {
  const done = items.filter((item) => item.done).length;
  const current = items.find((item) => item.status === "in_progress");
  return `${done}/${items.length} done` + (current ? ` · now: ${current.title}` : "");
};

const lines = (items: readonly Todo[]) => items.length
  ? items.map((item) => `${todoMark(item)} [${item.status}] ${item.title} (${item.id})`).join("\n")
  : "No tracked tasks.";

const REMINDER = "Keep using jar_todo to track progress: mark the next task in_progress before starting it and completed as soon as it is verified.";

export function registerTaskTool(
  pi: ExtensionAPI,
  store: () => TodoStore | undefined,
  changed: (ctx: ExtensionContext) => void
): void {
  if (typeof (pi as ExtensionAPI & { registerTool?: unknown }).registerTool !== "function") return;
  pi.registerTool({
    name: "jar_todo",
    label: "tasks",
    description: "Maintain pi-jar's session task list, shown live to the user. Send `todos` with the complete updated list (each with content, status pending|in_progress|completed, and activeForm). Single-task actions (start, done, open, add, edit, delete, list) are also available.",
    promptSnippet: "Track multi-step work with jar_todo: write the full list, keep exactly one task in_progress, complete tasks as they finish.",
    promptGuidelines: [
      "Use jar_todo proactively, without waiting for the user, for any task with three or more distinct steps, when the user gives several tasks, or right after receiving new instructions. Skip it for single trivial requests and pure questions.",
      "Prefer jar_todo with `todos` (the full updated list). Each item has `content` (imperative, e.g. \"Run tests\"), `status`, and `activeForm` (present continuous, e.g. \"Running tests\"), which the user sees while it runs.",
      "Keep exactly one task in_progress at a time. Mark a task in_progress before you start it and completed immediately after it is verified; do not batch completions.",
      "Only mark a task completed when it is fully done. If tests fail, work is partial or you are blocked, keep it in_progress and add a task for what must be resolved. Remove tasks that are no longer relevant."
    ],
    parameters: Parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = store();
      const action = params.todos ? "write" : params.action ?? "list";
      if (!current) {
        return { content: [{ type: "text", text: "Task tracking is unavailable before a Pi session starts." }], details: { action, items: [] } satisfies TaskToolDetails };
      }
      let changedId: string | undefined;
      let error: string | undefined;
      switch (action) {
        case "list":
          break;
        case "write":
          if (!params.todos) { error = "write needs `todos`: the complete updated list."; break; }
          error = current.write(params.todos.map((item) => ({ title: item.content, status: item.status, ...(item.activeForm ? { activeForm: item.activeForm } : {}) })));
          break;
        case "add": {
          const item = params.title?.trim() ? current.add(params.title, params.details) : undefined;
          if (!item) error = "add needs a short title.";
          changedId = item?.id;
          break;
        }
        case "start":
        case "done":
        case "open":
          if (!params.id || !current.setStatus(params.id, action === "start" ? "in_progress" : action === "done" ? "completed" : "pending")) error = `${action} needs a valid id from jar_todo list.`;
          else changedId = params.id;
          break;
        case "edit":
          if (!params.id || !params.title?.trim() || !current.edit(params.id, params.title)) error = "edit needs a valid id and a title.";
          else changedId = params.id;
          break;
        case "delete":
          if (!params.id || !current.delete(params.id)) error = "delete needs a valid id from jar_todo list.";
          else changedId = params.id;
          break;
      }
      if (action !== "list" && !error) changed(ctx);
      const items = current.all();
      const message = error
        ? `Could not ${action} tasks: ${error}\n${lines(items)}`
        : `${action === "list" ? "Tasks" : "Task list updated"} (${summary(items)}):\n${lines(items)}${action === "list" ? "" : "\n" + REMINDER}`;
      return {
        content: [{ type: "text", text: message }],
        details: { action, items, ...(changedId ? { changed: changedId } : {}) } satisfies TaskToolDetails
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("tasks"));
      if (args.todos) text += " " + theme.fg("accent", `update · ${args.todos.length} item${args.todos.length === 1 ? "" : "s"}`);
      else {
        text += " " + theme.fg("accent", args.action ?? "list");
        if (args.title) text += " " + theme.fg("muted", args.title);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Updating tasks…"), 0, 0);
      const details = result.details as TaskToolDetails | undefined;
      const items = details?.items ?? [];
      if (!items.length) return new Text(theme.fg("dim", "No tracked tasks."), 0, 0);
      // Like Claude: the checklist itself is the result. Collapsed shows up to 8 rows.
      const shown = expanded ? items : items.slice(0, 8);
      let text = theme.fg("dim", summary(items));
      for (const item of shown) text += "\n" + todoRow(item, (color, value) => theme.fg(color, value), (value) => theme.bold(value));
      if (shown.length < items.length) text += "\n" + theme.fg("dim", `  … +${items.length - shown.length} more (expand)`);
      return new Text(text, 0, 0);
    }
  });
}

type TodoColor = "accent" | "muted" | "dim" | "success";
/** One checklist row: completed rows are struck through, the running one is bold. */
export function todoRow(item: Todo, fg: (color: TodoColor, text: string) => string, bold: (text: string) => string = (text) => text): string {
  if (item.status === "completed") return fg("success", "  ✔ ") + fg("dim", "\x1b[9m" + item.title + "\x1b[29m");
  if (item.status === "in_progress") return fg("accent", "  ◼ ") + fg("accent", bold(item.title));
  return fg("muted", "  ☐ " + item.title);
}
