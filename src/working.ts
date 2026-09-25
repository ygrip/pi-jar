import { cleanText } from "./status.ts";

export type WorkingPhase = "idle" | "generating" | "tool" | "waiting";
export type WorkingColor = "accent" | "warning" | "success" | "muted";
export interface WorkingView { message?: string; frames: string[]; color: WorkingColor }

const PROGRESSION = [
  "A spark remains…", "Kindling a thought…", "Following the faint light…",
  "Gathering scattered sparks…", "The path is beginning to glow…",
  "There is a way through…", "A clearer path is forming…", "The horizon is clearer now…"
] as const;
const STAGES = [0, 8, 20, 35, 50, 70, 90, 120] as const;
function duration(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function tokenCount(tokens: number): string {
  return tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(1)}k`;
}

/** A label describes only observed Pi lifecycle activity, never hidden reasoning. */
export class WorkingState {
  private generating = false;
  private waiting = false;
  private tools = new Map<string, string>();
  private startedAt?: number;
  private outputTokens = 0;
  get phase(): WorkingPhase {
    if (this.waiting) return "waiting";
    if (this.tools.size) return "tool";
    return this.generating ? "generating" : "idle";
  }
  start(now = Date.now()): void {
    if (this.startedAt === undefined) { this.startedAt = now; this.outputTokens = 0; }
    this.generating = true; this.waiting = false;
  }
  end(): void { this.generating = false; this.waiting = false; this.tools.clear(); this.startedAt = undefined; this.outputTokens = 0; }
  reportOutputTokens(tokens: number): void {
    if (this.startedAt !== undefined && Number.isSafeInteger(tokens) && tokens >= 0) this.outputTokens += tokens;
  }
  prompt(open: boolean): void { this.waiting = open; }
  toolStart(id: string, name: string): void { this.tools.set(id, cleanText(name, 24) || "tool"); }
  toolEnd(id: string): void { this.tools.delete(id); }
  /** `task` is the running jar_todo's active form; like Claude, it replaces the generic wording. */
  view(animations: boolean, fg: (color: WorkingColor, text: string) => string, now = Date.now(), effort?: string, task?: string): WorkingView {
    const phase = this.phase;
    const activity = task ? cleanText(task, 60).replace(/[.…]+$/, "") : "";
    const elapsed = this.startedAt === undefined ? 0 : Math.max(0, Math.floor((now - this.startedAt) / 1000));
    const stage = STAGES.reduce<number>((index, threshold, next) => elapsed >= threshold ? next : index, 0);
    const word = activity && (phase === "tool" || phase === "generating") ? activity + "…"
      : phase === "tool" ? `Tracing light through ${[...this.tools.values()][0] ?? "tool"}…`
      : phase === "generating" ? PROGRESSION[Math.max(0, stage)]
      : phase === "waiting" ? "Holding the lantern for your answer…" : undefined;
    const color: WorkingColor = phase === "tool" ? "warning" : phase === "waiting" ? "muted" : "accent";
    const symbols = phase === "tool" ? ["◐", "◓", "◑", "◒"] : phase === "generating" ? ["✢", "✣", "✤", "✣"] : ["✢"];
    const frames = animations ? symbols.map((symbol) => fg(color, symbol)) : [fg(color, symbols[0] ?? "✢")];
    const details = phase === "idle" || this.startedAt === undefined ? "" :
      ` (${duration(elapsed)}${this.outputTokens ? ` · ↓ ${tokenCount(this.outputTokens)} tokens` : ""}${effort && effort !== "off" ? ` · ${effort} effort` : ""})`;
    return { message: word ? fg(color, word) + fg("muted", details) : undefined, frames, color };
  }
}
