import { cleanText } from "./status.ts";

export const GOAL_ENTRY = "pi-jar.goal";
export type GoalEvent =
  | { v: 1; op: "set"; text: string }
  | { v: 1; op: "clear" };

const validGoal = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 1024 && !!cleanText(value, 240);

/** Branch-aware, append-only active goal state. */
export class GoalStore {
  private value: string | undefined;
  private readonly append: (event: GoalEvent) => void;

  constructor(append: (event: GoalEvent) => void) {
    this.append = append;
  }

  current(): string | undefined {
    return this.value;
  }

  apply(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const event = raw as Record<string, unknown>;
    if (event.v !== 1) return false;
    if (event.op === "clear") {
      this.value = undefined;
      return true;
    }
    if (event.op === "set" && validGoal(event.text)) {
      this.value = cleanText(event.text, 240);
      return true;
    }
    return false;
  }

  restore(branch: readonly unknown[]): void {
    this.value = undefined;
    for (const raw of branch) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      if (entry.type === "custom" && entry.customType === GOAL_ENTRY) this.apply(entry.data);
    }
  }

  set(text: string): boolean {
    if (!validGoal(text)) return false;
    const event: GoalEvent = { v: 1, op: "set", text: cleanText(text, 240) };
    const previous = this.value;
    if (!this.apply(event)) return false;
    try {
      this.append(event);
      return true;
    } catch {
      this.value = previous;
      return false;
    }
  }

  clear(): boolean {
    const previous = this.value;
    const event: GoalEvent = { v: 1, op: "clear" };
    this.apply(event);
    try {
      this.append(event);
      return true;
    } catch {
      this.value = previous;
      return false;
    }
  }
}
