import { randomUUID } from "node:crypto";
import { cleanText } from "./status.ts";

export const TASK_ENTRY = "pi-jar.task";
export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
/**
 * `done` mirrors `status === "completed"` for callers that only need open/closed. `parentId` marks a
 * subtask of a top-level task (one level deep); a parent's status is derived from its subtasks.
 */
export interface Todo { id: string; title: string; done: boolean; status: TodoStatus; activeForm?: string; details?: string; parentId?: string }
/** A parent's own `status` is ignored when it has subtasks. */
export interface TodoInput { title: string; status: TodoStatus; activeForm?: string; subtasks?: readonly TodoInput[] }
/** Bounds the whole list: parents plus subtasks. */
export const MAX_TODOS = 50;

interface WrittenTodo { id: string; title: string; status: TodoStatus; activeForm?: string; parentId?: string }
export type TodoEvent =
  | { v: 1; op: "add"; id: string; title: string; details?: string; parentId?: string }
  | { v: 1; op: "edit"; id: string; title: string }
  | { v: 1; op: "toggle"; id: string; done: boolean }
  | { v: 1; op: "status"; id: string; status: TodoStatus }
  | { v: 1; op: "delete"; id: string }
  /** Full-list replacement, like a Claude todo write. Subtasks follow a parent listed earlier. */
  | { v: 1; op: "write"; items: WrittenTodo[] };

const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(id);
const validTitle = (title: unknown): title is string => typeof title === "string" && title.length <= 256 && !!cleanText(title, 120);
const validStatus = (status: unknown): status is TodoStatus => TODO_STATUSES.includes(status as TodoStatus);
const validWrite = (event: Record<string, unknown>): boolean => {
  if (event.v !== 1 || event.op !== "write" || !Array.isArray(event.items) || event.items.length > MAX_TODOS) return false;
  const ids = new Set<string>();
  const top = new Set<string>();
  const parents = new Set<string>();
  for (const raw of event.items as unknown[]) {
    const item = raw as Record<string, unknown> | null;
    if (!item || !validId(item.id) || !validTitle(item.title) || !validStatus(item.status) || ids.has(item.id)) return false;
    ids.add(item.id);
    if (item.parentId === undefined) top.add(item.id);
    else if (validId(item.parentId) && top.has(item.parentId)) parents.add(item.parentId);
    else return false;
  }
  // Only leaves run; a parent's in_progress is derived.
  let running = 0;
  for (const raw of event.items as Record<string, unknown>[]) if (raw.status === "in_progress" && !parents.has(raw.id as string) && ++running > 1) return false;
  return true;
};
const make = (id: string, title: string, status: TodoStatus, activeForm?: unknown, details?: unknown, parentId?: unknown): Todo => ({
  id, title: cleanText(title, 120), status, done: status === "completed",
  ...(typeof activeForm === "string" && cleanText(activeForm, 80) ? { activeForm: cleanText(activeForm, 80) } : {}),
  ...(typeof details === "string" && cleanText(details, 240) ? { details: cleanText(details, 240) } : {}),
  ...(typeof parentId === "string" ? { parentId } : {})
});
/** Parent rollup: all subtasks completed → completed; any running or partly completed → in_progress. */
const rolled = (done: number, running: number, total: number): TodoStatus => done === total ? "completed" : running || done ? "in_progress" : "pending";
/** Top-level tasks in order, each followed by its subtasks; orphans are dropped. */
const grouped = (items: ReadonlyMap<string, Todo>): Map<string, Todo> => {
  const kids = new Map<string, Todo[]>();
  for (const item of items.values()) {
    if (!item.parentId) continue;
    const list = kids.get(item.parentId);
    if (list) list.push(item); else kids.set(item.parentId, [item]);
  }
  const next = new Map<string, Todo>();
  for (const item of items.values()) {
    if (item.parentId) continue;
    next.set(item.id, item);
    for (const kid of kids.get(item.id) ?? []) next.set(kid.id, kid);
  }
  return next;
};

/** Subtask counts for a parent; `{ done: 0, total: 0 }` when it has none. */
export function todoProgress(items: readonly Todo[], id: string): { done: number; total: number } {
  let done = 0, total = 0;
  for (const item of items) if (item.parentId === id) { total++; if (item.done) done++; }
  return { done, total };
}
/** Completion counted over leaf tasks: subtasks plus top-level tasks without subtasks. */
export function todoTotals(items: readonly Todo[]): { done: number; total: number } {
  const parents = new Set<string>();
  for (const item of items) if (item.parentId) parents.add(item.parentId);
  let done = 0, total = 0;
  for (const item of items) if (!parents.has(item.id)) { total++; if (item.done) done++; }
  return { done, total };
}

/** Session-local, append-only changes: only the current Pi branch is replayed. */
export class TodoStore {
  private items = new Map<string, Todo>();
  private readonly append: (event: TodoEvent) => void;
  constructor(append: (event: TodoEvent) => void) { this.append = append; }
  /** Display order: each top-level task is followed by its subtasks. */
  all(): Todo[] { return [...this.items.values()].map((item) => ({ ...item })); }
  get(id: string): Todo | undefined { const item = this.items.get(id); return item && { ...item }; }
  /** The leaf task being worked on right now, if any. */
  current(): Todo | undefined {
    const parents = new Set<string>();
    for (const item of this.items.values()) if (item.parentId) parents.add(item.parentId);
    const item = [...this.items.values()].find((todo) => todo.status === "in_progress" && !parents.has(todo.id));
    return item && { ...item };
  }

  private children(id: string): Todo[] { return [...this.items.values()].filter((item) => item.parentId === id); }
  private setItemStatus(item: Todo, status: TodoStatus): void {
    // Exactly one leaf is in progress: starting one parks the previous one (parents re-derive in rollup).
    if (status === "in_progress") for (const other of this.items.values()) if (other !== item && other.status === "in_progress") { other.status = "pending"; other.done = false; }
    item.status = status;
    item.done = status === "completed";
  }
  /** Parent actions cascade: start runs the first open subtask, done/open apply to every subtask. */
  private setTree(item: Todo, status: TodoStatus): boolean {
    const kids = this.children(item.id);
    if (!kids.length) this.setItemStatus(item, status);
    else if (status === "in_progress") {
      const next = kids.find((kid) => kid.status === "in_progress") ?? kids.find((kid) => kid.status !== "completed");
      if (!next) return false;
      this.setItemStatus(next, status);
    } else for (const kid of kids) this.setItemStatus(kid, status);
    this.rollup();
    return true;
  }
  private rollup(): void {
    const counts = new Map<string, { done: number; running: number; total: number }>();
    for (const item of this.items.values()) {
      if (!item.parentId) continue;
      const count = counts.get(item.parentId) ?? { done: 0, running: 0, total: 0 };
      count.total++;
      if (item.status === "completed") count.done++;
      else if (item.status === "in_progress") count.running++;
      counts.set(item.parentId, count);
    }
    for (const [id, count] of counts) {
      const parent = this.items.get(id);
      if (!parent) continue;
      parent.status = rolled(count.done, count.running, count.total);
      parent.done = parent.status === "completed";
    }
  }

  apply(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const event = raw as Record<string, unknown>;
    if (event.v !== 1) return false;
    if (event.op === "write") {
      if (!validWrite(event)) return false;
      const next = new Map<string, Todo>();
      for (const raw of event.items as unknown[]) {
        const item = raw as Record<string, unknown>;
        next.set(item.id as string, make(item.id as string, item.title as string, item.status as TodoStatus, item.activeForm, this.items.get(item.id as string)?.details, item.parentId));
      }
      this.items = grouped(next);
      this.rollup();
      return true;
    }
    if (!validId(event.id)) return false;
    const item = this.items.get(event.id);
    switch (event.op) {
      case "add": {
        const parent = validId(event.parentId) ? this.items.get(event.parentId) : undefined;
        if (!validTitle(event.title) || item || (event.parentId !== undefined && (!parent || parent.parentId))) return false;
        this.items.set(event.id, make(event.id, event.title, "pending", undefined, event.details, event.parentId));
        if (parent) { this.items = grouped(this.items); this.rollup(); }
        return true;
      }
      case "edit":
        if (!validTitle(event.title) || !item) return false;
        item.title = cleanText(event.title, 120);
        return true;
      case "toggle":
        if (typeof event.done !== "boolean" || !item) return false;
        return this.setTree(item, event.done ? "completed" : "pending");
      case "status":
        if (!validStatus(event.status) || !item) return false;
        return this.setTree(item, event.status);
      case "delete":
        if (!item) return false;
        this.items.delete(event.id);
        for (const kid of this.children(event.id)) this.items.delete(kid.id);
        this.rollup();
        return true;
      default: return false;
    }
  }
  restore(branch: readonly unknown[]): void {
    this.items.clear();
    // Walk the transcript once from newest to oldest, collecting only task events. A valid full
    // write is a checkpoint, so everything before it is irrelevant.
    const replay: unknown[] = [];
    for (let index = branch.length - 1; index >= 0; index--) {
      const raw = branch[index];
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      if (entry.type !== "custom" || entry.customType !== TASK_ENTRY) continue;
      replay.push(entry.data);
      if (entry.data && typeof entry.data === "object" && validWrite(entry.data as Record<string, unknown>)) break;
    }
    for (let index = replay.length - 1; index >= 0; index--) this.apply(replay[index]);
  }
  private commit(event: TodoEvent): boolean {
    const before = new Map([...this.items].map(([id, item]) => [id, { ...item }]));
    if (!this.apply(event)) return false;
    try { this.append(event); return true; }
    catch { this.items = before; return false; }
  }
  /** Why `add` would be rejected, as a message for the model; undefined when it is valid. */
  addError(title: string, parentId?: string): string | undefined {
    if (!validTitle(title)) return "add needs a short, non-empty title.";
    if (this.items.size >= MAX_TODOS) return `At most ${MAX_TODOS} tasks including subtasks.`;
    if (parentId === undefined) return undefined;
    const parent = this.items.get(parentId);
    if (!parent) return `parent ${parentId} is not a task id from jar_todo list.`;
    if (parent.parentId) return `parent ${parentId} is a subtask; subtasks nest only one level under a top-level task.`;
    return undefined;
  }
  add(title: string, details?: string, parentId?: string): Todo | undefined {
    if (this.addError(title, parentId)) return undefined;
    const id = randomUUID();
    const cleanDetails = typeof details === "string" && details.trim() ? cleanText(details, 240) : undefined;
    return this.commit({ v: 1, op: "add", id, title, ...(cleanDetails ? { details: cleanDetails } : {}), ...(parentId ? { parentId } : {}) }) ? this.get(id) : undefined;
  }
  /**
   * Replace the whole list. Items keep their id when an existing task has the same title (subtasks:
   * within the same parent), so history and the goal loop see continuity. Returns an error message
   * on invalid input.
   */
  write(inputs: readonly TodoInput[]): string | undefined {
    const flat = inputs.flatMap((item) => [item, ...(item.subtasks ?? [])]);
    if (flat.length > MAX_TODOS) return `At most ${MAX_TODOS} tasks including subtasks.`;
    if (inputs.some((item) => item.subtasks?.some((sub) => sub.subtasks?.length))) return "Subtasks cannot have their own subtasks; nest only one level.";
    if (flat.some((item) => !validTitle(item.title))) return "Every task and subtask needs a short, non-empty title.";
    if (flat.some((item) => !validStatus(item.status))) return `status must be one of ${TODO_STATUSES.join(", ")}.`;
    const leaves = inputs.flatMap((item) => item.subtasks?.length ? item.subtasks : [item]);
    if (leaves.filter((item) => item.status === "in_progress").length > 1) return "Only one task may be in_progress at a time (a parent's status follows its subtasks).";
    const key = (parentId: string, title: string) => parentId + "\n" + cleanText(title, 120).toLowerCase();
    const free = new Map<string, string[]>();
    for (const item of this.items.values()) {
      const slot = key(item.parentId ?? "", item.title);
      free.set(slot, [...(free.get(slot) ?? []), item.id]);
    }
    const entry = (item: TodoInput, id: string, status: TodoStatus, parentId?: string): WrittenTodo => {
      const activeForm = typeof item.activeForm === "string" && item.activeForm.trim() ? item.activeForm : undefined;
      return { id, title: item.title, status, ...(activeForm ? { activeForm } : {}), ...(parentId ? { parentId } : {}) };
    };
    const items: WrittenTodo[] = [];
    for (const item of inputs) {
      const id = free.get(key("", item.title))?.shift() ?? randomUUID();
      const subtasks = item.subtasks ?? [];
      const done = subtasks.filter((sub) => sub.status === "completed").length;
      const running = subtasks.filter((sub) => sub.status === "in_progress").length;
      items.push(entry(item, id, subtasks.length ? rolled(done, running, subtasks.length) : item.status));
      for (const sub of subtasks) items.push(entry(sub, free.get(key(id, sub.title))?.shift() ?? randomUUID(), sub.status, id));
    }
    return this.commit({ v: 1, op: "write", items }) ? undefined : "Could not save the task list.";
  }
  edit(id: string, title: string): boolean { return this.commit({ v: 1, op: "edit", id, title }); }
  /** On a parent, start runs its first open subtask; done/open complete or reopen all subtasks. */
  setStatus(id: string, status: TodoStatus): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    const kids = status === "in_progress" ? this.children(id) : [];
    const unchanged = kids.length ? kids.some((kid) => kid.status === "in_progress") : item.status === status;
    return unchanged || this.commit({ v: 1, op: "status", id, status });
  }
  setDone(id: string, done: boolean): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    return item.done === done || this.setStatus(id, done ? "completed" : "pending");
  }
  toggle(id: string): boolean {
    const item = this.items.get(id);
    return !!item && this.setDone(id, !item.done);
  }
  /** Deleting a parent deletes its subtasks. */
  delete(id: string): boolean { return this.commit({ v: 1, op: "delete", id }); }
}

/** Claude-style checkbox glyph for a task. */
export const todoMark = (item: Pick<Todo, "status">) => item.status === "completed" ? "✔" : item.status === "in_progress" ? "◼" : "☐";
