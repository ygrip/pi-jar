import { randomUUID } from "node:crypto";
import { cleanText } from "./status.ts";

export const TASK_ENTRY = "pi-jar.task";
export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
/** `done` mirrors `status === "completed"` for callers that only need open/closed. */
export interface Todo { id: string; title: string; done: boolean; status: TodoStatus; activeForm?: string; details?: string }
export interface TodoInput { title: string; status: TodoStatus; activeForm?: string }
export const MAX_TODOS = 50;

interface WrittenTodo { id: string; title: string; status: TodoStatus; activeForm?: string }
export type TodoEvent =
  | { v: 1; op: "add"; id: string; title: string; details?: string }
  | { v: 1; op: "edit"; id: string; title: string }
  | { v: 1; op: "toggle"; id: string; done: boolean }
  | { v: 1; op: "status"; id: string; status: TodoStatus }
  | { v: 1; op: "delete"; id: string }
  /** Full-list replacement, like a Claude todo write. */
  | { v: 1; op: "write"; items: WrittenTodo[] };

const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(id);
const validTitle = (title: unknown): title is string => typeof title === "string" && title.length <= 256 && !!cleanText(title, 120);
const validStatus = (status: unknown): status is TodoStatus => TODO_STATUSES.includes(status as TodoStatus);
const make = (id: string, title: string, status: TodoStatus, activeForm?: unknown, details?: unknown): Todo => ({
  id, title: cleanText(title, 120), status, done: status === "completed",
  ...(typeof activeForm === "string" && cleanText(activeForm, 80) ? { activeForm: cleanText(activeForm, 80) } : {}),
  ...(typeof details === "string" && cleanText(details, 240) ? { details: cleanText(details, 240) } : {})
});

/** Session-local, append-only changes: only the current Pi branch is replayed. */
export class TodoStore {
  private items = new Map<string, Todo>();
  private readonly append: (event: TodoEvent) => void;
  constructor(append: (event: TodoEvent) => void) { this.append = append; }
  all(): Todo[] { return [...this.items.values()].map((item) => ({ ...item })); }
  get(id: string): Todo | undefined { const item = this.items.get(id); return item && { ...item }; }
  /** The task being worked on right now, if any. */
  current(): Todo | undefined { const item = [...this.items.values()].find((todo) => todo.status === "in_progress"); return item && { ...item }; }

  private setItemStatus(item: Todo, status: TodoStatus): void {
    // Exactly one task is in progress: starting one parks the previous one.
    if (status === "in_progress") for (const other of this.items.values()) if (other !== item && other.status === "in_progress") { other.status = "pending"; other.done = false; }
    item.status = status;
    item.done = status === "completed";
  }

  apply(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const event = raw as Record<string, unknown>;
    if (event.v !== 1) return false;
    if (event.op === "write") {
      if (!Array.isArray(event.items) || event.items.length > MAX_TODOS) return false;
      const next = new Map<string, Todo>();
      for (const raw of event.items as unknown[]) {
        const item = raw as Record<string, unknown> | null;
        if (!item || !validId(item.id) || !validTitle(item.title) || !validStatus(item.status) || next.has(item.id)) return false;
        next.set(item.id, make(item.id, item.title, item.status, item.activeForm, this.items.get(item.id)?.details));
      }
      if ([...next.values()].filter((item) => item.status === "in_progress").length > 1) return false;
      this.items = next;
      return true;
    }
    if (!validId(event.id)) return false;
    const item = this.items.get(event.id);
    switch (event.op) {
      case "add":
        if (!validTitle(event.title) || item) return false;
        this.items.set(event.id, make(event.id, event.title, "pending", undefined, event.details));
        return true;
      case "edit":
        if (!validTitle(event.title) || !item) return false;
        item.title = cleanText(event.title, 120);
        return true;
      case "toggle":
        if (typeof event.done !== "boolean" || !item) return false;
        this.setItemStatus(item, event.done ? "completed" : "pending");
        return true;
      case "status":
        if (!validStatus(event.status) || !item) return false;
        this.setItemStatus(item, event.status);
        return true;
      case "delete": return this.items.delete(event.id);
      default: return false;
    }
  }
  restore(branch: readonly unknown[]): void {
    this.items.clear();
    for (const raw of branch) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      if (entry.type === "custom" && entry.customType === TASK_ENTRY) this.apply(entry.data);
    }
  }
  private commit(event: TodoEvent): boolean {
    const before = new Map([...this.items].map(([id, item]) => [id, { ...item }]));
    if (!this.apply(event)) return false;
    try { this.append(event); return true; }
    catch { this.items = before; return false; }
  }
  add(title: string, details?: string): Todo | undefined {
    if (!validTitle(title)) return undefined;
    const id = randomUUID();
    const cleanDetails = typeof details === "string" && details.trim() ? cleanText(details, 240) : undefined;
    return this.commit({ v: 1, op: "add", id, title, ...(cleanDetails ? { details: cleanDetails } : {}) }) ? this.get(id) : undefined;
  }
  /**
   * Replace the whole list. Items keep their id when an existing task has the same title,
   * so history and the goal loop see continuity. Returns an error message on invalid input.
   */
  write(inputs: readonly TodoInput[]): string | undefined {
    if (inputs.length > MAX_TODOS) return `At most ${MAX_TODOS} tasks.`;
    if (inputs.some((item) => !validTitle(item.title))) return "Every task needs a short, non-empty title.";
    if (inputs.some((item) => !validStatus(item.status))) return `status must be one of ${TODO_STATUSES.join(", ")}.`;
    if (inputs.filter((item) => item.status === "in_progress").length > 1) return "Only one task may be in_progress at a time.";
    const free = new Map<string, string[]>();
    for (const item of this.items.values()) {
      const key = cleanText(item.title, 120).toLowerCase();
      free.set(key, [...(free.get(key) ?? []), item.id]);
    }
    const items = inputs.map((item): WrittenTodo => {
      const id = free.get(cleanText(item.title, 120).toLowerCase())?.shift() ?? randomUUID();
      const activeForm = typeof item.activeForm === "string" && item.activeForm.trim() ? item.activeForm : undefined;
      return { id, title: item.title, status: item.status, ...(activeForm ? { activeForm } : {}) };
    });
    return this.commit({ v: 1, op: "write", items }) ? undefined : "Could not save the task list.";
  }
  edit(id: string, title: string): boolean { return this.commit({ v: 1, op: "edit", id, title }); }
  setStatus(id: string, status: TodoStatus): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    return item.status === status || this.commit({ v: 1, op: "status", id, status });
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
  delete(id: string): boolean { return this.commit({ v: 1, op: "delete", id }); }
}

/** Claude-style checkbox glyph for a task. */
export const todoMark = (item: Pick<Todo, "status">) => item.status === "completed" ? "✔" : item.status === "in_progress" ? "◼" : "☐";
