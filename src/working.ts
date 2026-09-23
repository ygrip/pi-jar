import { cleanText } from "./status.ts";

export type WorkingPhase = "idle" | "generating" | "tool" | "waiting";
export type WorkingColor = "accent" | "warning" | "success" | "muted";
export interface WorkingView { message?: string; frames: string[]; color: WorkingColor }

/** A label describes only observed Pi lifecycle activity, never hidden reasoning. */
export class WorkingState {
  private generating = false;
  private waiting = false;
  private tools = new Map<string, string>();
  private sequence = 0;
  get phase(): WorkingPhase {
    if (this.waiting) return "waiting";
    if (this.tools.size) return "tool";
    return this.generating ? "generating" : "idle";
  }
  start(): void { this.generating = true; this.waiting = false; }
  end(): void { this.generating = false; this.waiting = false; this.tools.clear(); }
  prompt(open: boolean): void { this.waiting = open; }
  toolStart(id: string, name: string): void { this.tools.set(id, cleanText(name, 24) || "tool"); }
  toolEnd(id: string): void { this.tools.delete(id); }
  view(animations: boolean, fg: (color: WorkingColor, text: string) => string): WorkingView {
    const phase = this.phase;
    const labels = phase === "tool"
      ? [`Using ${[...this.tools.values()][0] ?? "tool"}`, `Running ${[...this.tools.values()][0] ?? "tool"}`]
      : phase === "generating" ? ["Considering the next step", "Putting an answer together"]
      : phase === "waiting" ? ["Waiting for your answer"] : [];
    const color: WorkingColor = phase === "tool" ? "warning" : phase === "waiting" ? "muted" : "accent";
    const word = labels.length ? labels[animations ? this.sequence++ % labels.length : 0] : undefined;
    const symbols = phase === "tool" ? ["◐", "◓", "◑", "◒"] : phase === "generating" ? ["◇", "◈", "◆", "◈"] : ["◇"];
    const frames = animations ? symbols.map((symbol) => fg(color, symbol)) : [fg(color, symbols[0] ?? "◇")];
    return { message: word ? fg(color, word) : undefined, frames, color };
  }
}
