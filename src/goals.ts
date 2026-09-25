import { randomUUID } from "node:crypto";
import { cleanText } from "./status.ts";

export const GOAL_ENTRY = "pi-jar.goal";
export type GoalStatus = "active" | "paused" | "complete" | "dropped";
export type GoalPhase = "implement" | "audit";
export interface Goal { id: string; text: string; status: GoalStatus; phase: GoalPhase; rounds: number; evidence?: string; reason?: string }
export type GoalEvent =
  | { v: 1; op: "set"; text: string }
  | { v: 1; op: "clear" }
  | { v: 2; op: "set"; id: string; text: string }
  | { v: 2; op: "status"; id: string; status: GoalStatus; evidence?: string; reason?: string }
  | { v: 2; op: "round"; id: string; rounds: number; phase: GoalPhase };

const STATUSES: GoalStatus[] = ["active", "paused", "complete", "dropped"];
const validGoal = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 1024 && !!cleanText(value, 240);
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(id);

/** Branch-aware, append-only goal lifecycle: set → active ⇄ paused → complete | dropped. */
export class GoalStore {
  private value: Goal | undefined;
  private readonly append: (event: GoalEvent) => void;

  constructor(append: (event: GoalEvent) => void) {
    this.append = append;
  }

  /** The goal on this branch, including a completed one until it is cleared; dropped goals are gone. */
  current(): Goal | undefined {
    return this.value && { ...this.value };
  }

  /** Text of a goal that is still being worked on (active or paused). */
  text(): string | undefined {
    return this.value && (this.value.status === "active" || this.value.status === "paused") ? this.value.text : undefined;
  }

  isActive(): boolean { return this.value?.status === "active"; }

  apply(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const event = raw as Record<string, unknown>;
    if (event.v === 1) {
      if (event.op === "clear") { this.value = undefined; return true; }
      if (event.op === "set" && validGoal(event.text)) {
        this.value = { id: "legacy", text: cleanText(event.text, 240), status: "active", phase: "implement", rounds: 0 };
        return true;
      }
      return false;
    }
    if (event.v !== 2 || !validId(event.id)) return false;
    if (event.op === "set" && validGoal(event.text)) {
      this.value = { id: event.id, text: cleanText(event.text, 240), status: "active", phase: "implement", rounds: 0 };
      return true;
    }
    if (!this.value || this.value.id !== event.id) return false;
    if (event.op === "status" && STATUSES.includes(event.status as GoalStatus)) {
      if (event.status === "dropped") { this.value = undefined; return true; }
      const { evidence: _evidence, reason: _reason, ...rest } = this.value;
      this.value = { ...rest, status: event.status as GoalStatus,
        ...(typeof event.evidence === "string" && event.evidence.trim() ? { evidence: cleanText(event.evidence, 600) } : {}),
        ...(typeof event.reason === "string" && event.reason.trim() ? { reason: cleanText(event.reason, 240) } : {}) };
      return true;
    }
    if (event.op === "round" && Number.isInteger(event.rounds) && (event.rounds as number) >= 0 && (event.phase === "implement" || event.phase === "audit")) {
      this.value = { ...this.value, rounds: Math.min(event.rounds as number, 1000), phase: event.phase };
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

  private commit(event: GoalEvent): boolean {
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

  set(text: string): boolean {
    if (!validGoal(text)) return false;
    return this.commit({ v: 2, op: "set", id: randomUUID(), text: cleanText(text, 240) });
  }

  setStatus(status: GoalStatus, detail: { evidence?: string; reason?: string } = {}): boolean {
    if (!this.value) return false;
    return this.commit({ v: 2, op: "status", id: this.value.id, status, ...detail });
  }

  setRound(rounds: number, phase: GoalPhase): boolean {
    if (!this.value) return false;
    if (this.value.rounds === rounds && this.value.phase === phase) return true;
    return this.commit({ v: 2, op: "round", id: this.value.id, rounds, phase });
  }

  clear(): boolean {
    if (!this.value) return true;
    return this.commit({ v: 2, op: "status", id: this.value.id, status: "dropped" });
  }
}
