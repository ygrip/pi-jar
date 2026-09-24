import { randomUUID } from "node:crypto";
import { cleanText } from "./status.ts";

export const TASK_ENTRY = "pi-jar.task";
export interface Todo { id: string; title: string; done: boolean; details?: string }
export type TodoEvent =
  | { v: 1; op: "add"; id: string; title: string; details?: string }
  | { v: 1; op: "edit"; id: string; title: string }
  | { v: 1; op: "toggle"; id: string; done: boolean }
  | { v: 1; op: "delete"; id: string };

const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(id);
const validTitle = (title: unknown): title is string => typeof title === "string" && title.length <= 256 && !!cleanText(title, 120);

/** Session-local, append-only changes: only the current Pi branch is replayed. */
export class TodoStore {
  private items = new Map<string, Todo>();
  private readonly append: (event: TodoEvent) => void;
  constructor(append: (event: TodoEvent) => void) { this.append = append; }
  all(): Todo[] { return [...this.items.values()].map((item) => ({ ...item })); }
  get(id: string): Todo | undefined { const item = this.items.get(id); return item && { ...item }; }
  apply(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const event = raw as Record<string, unknown>;
    if (event.v !== 1 || !validId(event.id)) return false;
    switch (event.op) {
      case "add":
        if (!validTitle(event.title) || this.items.has(event.id)) return false;
        this.items.set(event.id, { id: event.id, title: cleanText(event.title, 120), done: false,
          ...(typeof event.details === "string" ? { details: cleanText(event.details, 240) } : {}) });
        return true;
      case "edit":
        if (!validTitle(event.title) || !this.items.has(event.id)) return false;
        this.items.get(event.id)!.title = cleanText(event.title, 120);
        return true;
      case "toggle":
        if (typeof event.done !== "boolean" || !this.items.has(event.id)) return false;
        this.items.get(event.id)!.done = event.done;
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
  edit(id: string, title: string): boolean { return this.commit({ v: 1, op: "edit", id, title }); }
  setDone(id: string, done: boolean): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    return item.done === done || this.commit({ v: 1, op: "toggle", id, done });
  }
  toggle(id: string): boolean {
    const item = this.items.get(id);
    return !!item && this.setDone(id, !item.done);
  }
  delete(id: string): boolean { return this.commit({ v: 1, op: "delete", id }); }
}
