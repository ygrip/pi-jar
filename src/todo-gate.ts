import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Todo, TodoStore } from "./tasks.ts";

export const TODO_GATE_TYPE = "pi-jar.todo-gate";
/** Automatic reminders per user message; keeps a stuck model from looping forever. */
export const TODO_GATE_MAX_NUDGES = 2;

export interface TodoGateOptions {
  todos: () => TodoStore | undefined;
  /** True while plan mode or goal mode owns turn continuation. */
  suspended: () => boolean;
  enabled?: () => boolean;
}

/** Leaf tasks that are still open (parents are derived from their subtasks). */
export function openLeaves(items: readonly Todo[]): Todo[] {
  const parents = new Set(items.map((item) => item.parentId).filter(Boolean));
  return items.filter((item) => !item.done && !parents.has(item.id));
}

export function todoGateMessage(open: readonly Todo[]): string {
  const lines = open.slice(0, 10).map((item) => `${item.status === "in_progress" ? "[~]" : "[ ]"} ${item.title} (${item.id})`);
  return [
    "[PI-JAR TODO CHECK] jar_todo still has unfinished tasks:",
    ...lines,
    open.length > lines.length ? `… and ${open.length - lines.length} more` : "",
    "Before ending the turn, sync jar_todo: mark verified work completed, or continue with the open task. If a task is obsolete or blocked, remove it or say why."
  ].filter(Boolean).join("\n");
}

/** Refuses to end a turn while jar_todo has pending or in-progress tasks (bounded reminders). */
export function registerTodoGate(pi: ExtensionAPI, options: TodoGateOptions): void {
  let nudges = 0;
  pi.on("input", (event) => { if (event.source === "interactive") nudges = 0; });
  pi.on("session_start", () => { nudges = 0; });
  pi.on("agent_before_settle", (event) => {
    if (event.outcome !== "completed" || event.continue || event.context?.canContinue === false) return;
    if (options.enabled && !options.enabled()) return;
    if (options.suspended() || nudges >= TODO_GATE_MAX_NUDGES) return;
    const open = openLeaves(options.todos()?.all() ?? []);
    if (!open.length) return;
    nudges++;
    return { entries: [{ type: "custom_message" as const, customType: TODO_GATE_TYPE, display: false, content: todoGateMessage(open) }], continue: true };
  });
}
