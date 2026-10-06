import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Todo, TodoInput, TodoStatus } from "./tasks.ts";
import { TODO_STATUSES, TodoStore, todoMark, todoProgress, todoTotals } from "./tasks.ts";

const ACTIONS = ["write", "list", "append", "remove", "update", "add", "start", "done", "open", "edit", "delete"] as const;
const Action = Type.Unsafe<(typeof ACTIONS)[number]>({ type: "string", enum: [...ACTIONS] });
const Status = Type.Unsafe<(typeof TODO_STATUSES)[number]>({ type: "string", enum: [...TODO_STATUSES] });
const Content = Type.String({ description: "Imperative task title, e.g. \"Run the tests\"." });
const ActiveForm = Type.Optional(Type.String({ description: "Present-continuous form shown while it runs, e.g. \"Running the tests\"." }));

const Parameters = Type.Object({
  todos: Type.Optional(Type.Array(Type.Object({
    id: Type.Optional(Type.String({ description: "Existing stable task id for legacy write; omitted ids match by title." })),
    content: Content,
    status: Status,
    activeForm: ActiveForm,
    subtasks: Type.Optional(Type.Array(Type.Object({ id: Type.Optional(Type.String()), content: Content, status: Status, activeForm: ActiveForm }), {
      description: "Optional steps of this task (one level deep). The task's status then follows its subtasks."
    }))
  }), { description: "For append: new tasks only. For update: exactly one updated task. With write (or no action): the complete list, replacing it." })),
  action: Type.Optional(Action),
  id: Type.Optional(Type.String({ description: "Stable task id for update/remove/start/done/open/edit/delete. On a parent, start runs its first open subtask; done/open apply to all its subtasks." })),
  title: Type.Optional(Type.String({ description: "Task title for append/add/edit/update." })),
  status: Type.Optional(Status),
  activeForm: ActiveForm,
  parent: Type.Optional(Type.String({ description: "For append/add: id of a top-level task to add the new task under as a subtask." })),
  details: Type.Optional(Type.String({ description: "Optional short task context for a new task." }))
});

interface TaskToolDetails {
  action: string;
  /** Bounded preview (the full list in a subagent); the canonical list lives in TodoStore. */
  items: Todo[];
  /** Leaf tasks: subtasks plus top-level tasks without subtasks. */
  total: number;
  done: number;
  /** Every item, parents included. */
  count?: number;
  current?: string;
  changed?: string;
  /** Full stable id index, including items outside the bounded preview. */
  ids?: { id: string; title: string; parentId?: string }[];
  /** Optional deliberately small render surface for terse mutations such as start/done. */
  display?: Todo[];
  truncated?: boolean;
  /** Subtask counts of previewed parents when the preview cuts the list. */
  progress?: { id: string; done: number; total: number }[];
}

type TodoParam = { id?: string; content: string; status: TodoStatus; activeForm?: string; subtasks?: readonly TodoParam[] };
/** Deeper nesting is passed through so the store rejects it with a clear message. */
const toInput = (item: TodoParam): TodoInput => ({
  ...(item.id !== undefined ? { id: item.id } : {}),
  title: item.content, status: item.status,
  ...(item.activeForm !== undefined ? { activeForm: item.activeForm } : {}),
  ...(item.subtasks !== undefined ? { subtasks: item.subtasks.map(toInput) } : {})
});

const stats = (items: readonly Todo[]) => {
  const parents = new Set<string>();
  for (const item of items) if (item.parentId) parents.add(item.parentId);
  const current = items.find((item) => item.status === "in_progress" && !parents.has(item.id));
  const parent = current?.parentId ? items.find((item) => item.id === current.parentId) : undefined;
  return { ...todoTotals(items), current: current && (parent ? parent.title + " › " : "") + current.title };
};
const summary = (items: readonly Todo[]) => {
  const value = stats(items);
  return `${value.done}/${value.total} done` + (value.current ? ` · now: ${value.current}` : "");
};

const line = (items: readonly Todo[], item: Todo) => {
  const progress = todoProgress(items, item.id);
  return `${item.parentId ? "  " : ""}${todoMark(item)} [${item.status}] ${item.title}${progress.total ? ` (${progress.done}/${progress.total} done)` : ""} (${item.id})`;
};
const lines = (items: readonly Todo[]) => items.length ? items.map((item) => line(items, item)).join("\n") : "No tracked tasks.";

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
    description: "Maintain session tasks. write sets the complete current plan (omitted tasks are removed; each item has content, status, optional activeForm and one level of `subtasks`, whose completion completes the parent; progress counts leaves). update changes one task by stable id, append adds genuinely new work mid-run (not a new plan), remove deletes one task tree; start/done/open/edit are concise status operations. Stable IDs are returned for every task.",
    promptSnippet: "Track work with 3+ steps or several requests in jar_todo (skip trivial requests and questions): write the complete plan for a new request, start fresh once the old list is completed.",
    promptGuidelines: [
      "Keep exactly one leaf in_progress; mark it completed right after verifying it. Never batch completions or complete partial, failing or blocked work: keep it open and add a task for the blocker."
    ],
    parameters: Parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = store();
      const action = params.action ?? (params.todos !== undefined ? "write" : "list");
      if (!current) {
        return { content: [{ type: "text", text: "Task tracking is unavailable before a Pi session starts." }], details: { action, items: [], total: 0, done: 0 } satisfies TaskToolDetails };
      }
      let changedId: string | undefined;
      let error: string | undefined;
      let inputs: TodoInput[] | undefined;
      if (params.todos !== undefined) {
        try {
          if (!Array.isArray(params.todos)) throw new Error();
          inputs = params.todos.map(toInput);
        } catch { error = "todos must be an array of task objects with array subtasks."; }
        if (!["write", "append", "update"].includes(action)) error = "todos may only be used with write, append, or update; no tasks were changed.";
      }
      if (!error) switch (action) {
        case "list":
          break;
        case "write":
          if (!inputs) { error = "write needs `todos`: the complete updated list."; break; }
          error = current.write(inputs);
          break;
        case "append": {
          const before = new Set(current.all().map((item) => item.id));
          if (inputs && params.title !== undefined) { error = "append accepts either todos or title, not both."; break; }
          error = current.appendTodos(inputs ?? [{ title: params.title ?? "", status: params.status ?? "pending", activeForm: params.activeForm, details: params.details }], params.parent);
          if (!error) changedId = current.all().find((item) => !before.has(item.id))?.id;
          break;
        }
        case "update": {
          if (!params.id) { error = "update needs a valid existing task id."; break; }
          if (inputs && (inputs.length !== 1 || params.title !== undefined || params.status !== undefined || params.activeForm !== undefined)) { error = "update accepts exactly one todos item OR title/status/activeForm fields."; break; }
          const replacement = inputs?.[0] ?? {
            ...(params.title !== undefined ? { title: params.title } : {}),
            ...(params.status !== undefined ? { status: params.status } : {}),
            ...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {})
          };
          error = current.update(params.id, replacement);
          if (!error) changedId = params.id;
          break;
        }
        case "add": {
          const parent = params.parent?.trim() || undefined;
          const title = params.title ?? "";
          error = current.addError(title, parent);
          const item = error ? undefined : current.add(title, params.details, parent);
          if (!error && !item) error = "Could not save the task.";
          changedId = item?.id;
          break;
        }
        case "start":
        case "done":
        case "open": {
          const item = params.id ? current.get(params.id) : undefined;
          const progress = item ? todoProgress(current.all(), item.id) : { done: 0, total: 0 };
          if (!item) error = `${action} needs a valid id from jar_todo list.`;
          else if (action === "start" && progress.total && progress.done === progress.total) error = `every subtask of ${item.id} is completed; open it or add a subtask first.`;
          else if (!current.setStatus(item.id, action === "start" ? "in_progress" : action === "done" ? "completed" : "pending")) error = "Could not save the task.";
          else changedId = action === "start" ? (current.current()?.id ?? item.id) : item.id;
          break;
        }
        case "edit":
          if (!params.id || !params.title?.trim() || !current.edit(params.id, params.title)) error = "edit needs a valid id and a title.";
          else changedId = params.id;
          break;
        case "remove":
        case "delete":
          if (!params.id || !current.delete(params.id)) error = `${action} needs a valid id from jar_todo list.`;
          else changedId = params.id;
          break;
        default: error = "Unknown task action; no tasks were changed.";
      }
      if (action !== "list" && !error) changed(ctx);
      const items = current.all();
      const state = stats(items);
      // The changed task in context: its whole parent group, subtasks indented.
      const changedItem = changedId ? items.find((item) => item.id === changedId) : undefined;
      const root = changedItem?.parentId ?? changedItem?.id;
      const group = root ? items.filter((item) => item.id === root || item.parentId === root) : [];
      const mutationItems = action === "write" || action === "append" ? items : group;
      const mutationPreview = mutationItems.slice(0, 8);
      const terseMutation = action === "start" || action === "done";
      const terseItem = terseMutation && changedId ? items.find((item) => item.id === changedId) : undefined;
      // Keep task prose bounded while still returning every addressable id in canonical order.
      const idIndex = mutationItems.length > 8
        ? "\nTask IDs (list order): " + items.map((item, index) => `${index + 1}=${item.id}`).join(", ") + "\nUse list for all task titles."
        : "";
      const message = error
        ? `Could not ${action} tasks: ${error} (${summary(items)}).`
        : action === "list"
          ? `Tasks (${summary(items)}):\n${lines(items)}`
          : action === "start" && terseItem
            ? `Started task:\n${line(items, terseItem)}`
            : action === "done" && terseItem
              ? `Completed task:\n${line(items, terseItem)}`
              : `Task list updated (${summary(items)}).${mutationPreview.length ? "\n" + mutationPreview.map((item) => line(items, item)).join("\n") : ""}${idIndex}\n${REMINDER}`;
      // A subagent's parent mirrors the checklist from these details, so children send it whole.
      const preview = process.env.PI_JAR_CHILD ? items : items.slice(0, 8);
      const truncated = preview.length < items.length;
      const progress = truncated ? preview.flatMap((item) => {
        const value = todoProgress(items, item.id);
        return value.total ? [{ id: item.id, ...value }] : [];
      }) : [];
      return {
        content: [{ type: "text", text: message }],
        details: {
          action, items: preview, total: state.total, done: state.done, count: items.length,
          ids: items.map(({ id, title, parentId }) => ({ id, title, ...(parentId ? { parentId } : {}) })),
          ...(terseItem ? { display: [{ ...terseItem }] } : {}),
          ...(state.current ? { current: state.current } : {}),
          ...(truncated ? { truncated: true } : {}),
          ...(progress.length ? { progress } : {}),
          ...(changedId ? { changed: changedId } : {})
        } satisfies TaskToolDetails
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("tasks"));
      if (args.todos) text += " " + theme.fg("accent", `${args.action ?? "write"} · ${args.todos.length} item${args.todos.length === 1 ? "" : "s"}`);
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
      const displayItems = details?.display ?? items;
      // Older results predate `count`, when `total` counted every item.
      const count = details?.count ?? details?.total ?? items.length;
      const totals = details?.total === undefined ? todoTotals(items) : { done: details.done, total: details.total };
      if (!count) return new Text(theme.fg("dim", "No tracked tasks."), 0, 0);
      const known = new Map((details?.progress ?? []).map((value) => [value.id, value]));
      const shown = details?.display ? displayItems : expanded ? items : items.slice(0, 8);
      let text = details?.display ? "" : theme.fg("dim", `${totals.done}/${totals.total} done${details?.current ? " · now: " + details.current : ""}`);
      for (const item of shown) {
        const row = todoRow(item, (color, value) => theme.fg(color, value), (value) => theme.bold(value), known.get(item.id) ?? todoProgress(items, item.id));
        text += (text ? "\n" : "") + row;
      }
      if (!details?.display && (details?.truncated || shown.length < count)) text += "\n" + theme.fg("dim", `  … +${Math.max(0, count - shown.length)} more · /jar tasks`);
      return new Text(text, 0, 0);
    }
  });
}

type TodoColor = "accent" | "muted" | "dim" | "success";
/**
 * One checklist row: completed rows are struck through, the running one is bold. Subtasks are
 * indented; pass a parent's subtask `progress` to show its `(done/total)`.
 */
export function todoRow(item: Todo, fg: (color: TodoColor, text: string) => string, bold: (text: string) => string = (text) => text, progress?: { done: number; total: number }): string {
  const indent = item.parentId ? "    " : "  ";
  const suffix = progress?.total ? fg("dim", ` (${progress.done}/${progress.total})`) : "";
  if (item.status === "completed") return fg("success", indent + "✔ ") + fg("dim", "\x1b[9m" + item.title + "\x1b[29m") + suffix;
  if (item.status === "in_progress") return fg("accent", indent + "◼ ") + fg("accent", bold(item.title)) + suffix;
  return fg("muted", indent + "☐ " + item.title) + suffix;
}
