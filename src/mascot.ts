import { FLAME_RAMP, rgb, supportsTruecolor } from "./flame.ts";
import type { WorkingPhase } from "./working.ts";

/**
 * Ember, the composer's mascot: a tiny flame that perches on the input's top border.
 * Its face sits inside the border and its flickering tips sit on the row above.
 */
export type MascotMood = "idle" | "blink" | "happy" | "thinking" | "tool" | "waiting" | "sleepy" | "error" | "complete" | "poke";
export type MascotPaint = (color: "accent" | "warning" | "error" | "muted" | "dim", text: string) => string;

const FACES: Record<MascotMood, string> = {
  idle: "•ᴗ•", blink: "-ᴗ-", happy: "^ᴗ^", thinking: "°ᴗ°", tool: ">ᴗ<",
  waiting: "•o•", sleepy: "-ω-", error: "×_×", complete: "★ᴗ★", poke: "^o^"
};
/** Five-column flame tips drawn above the face; `*` is a spark, `z` a sleepy puff. */
const TIPS: Record<MascotMood, readonly string[]> = {
  idle: [" ▴▲▴ ", "  ▲▴ ", " ▴▲  "],
  blink: [" ▴▲▴ "],
  happy: [" ▴▲▴ ", "▴ ▲ ▴"],
  thinking: [" ▴▲∙ ", " ▴▲ ∙", "∙ ▲▴ ", " ∙▲▴ "],
  tool: [" *▲* ", " ·▲· ", "* ▲ *"],
  waiting: [" ▴▲▴?", " ▴▲▴ "],
  sleepy: ["  ▴ z", "  ▴  "],
  error: [" ˇ▲ˇ ", " ˇ▴ˇ "],
  complete: [" *★* ", "* ★ *"],
  poke: ["▴ ▲ ▴", " ▴▲▴ "]
};
export const MASCOT_FACE_WIDTH = 5;
export const MASCOT_TIP_WIDTH = 5;
export const SLEEPY_AFTER_MS = 120_000;
const BLINK_MS = 180;

export function mascotFace(mood: MascotMood): string { return "(" + FACES[mood] + ")"; }

export class Mascot {
  private phase: WorkingPhase = "idle";
  private lastActive: number;
  private nextBlink: number;
  private flashMood: { mood: MascotMood; until: number } | undefined;
  private readonly random: () => number;

  constructor(now = Date.now(), random: () => number = Math.random) {
    this.random = random;
    this.lastActive = now;
    this.nextBlink = now + this.blinkGap();
  }

  private blinkGap(): number { return 3000 + Math.floor(this.random() * 3000); }

  setPhase(phase: WorkingPhase, now = Date.now()): void {
    if (phase !== "idle" || this.phase !== "idle") this.lastActive = now;
    this.phase = phase;
  }

  /** Show a short-lived expression (error, goal complete, poke). */
  flash(mood: "error" | "complete" | "poke", ms: number, now = Date.now()): void {
    this.flashMood = { mood, until: now + ms };
    this.lastActive = now;
  }

  mood(now = Date.now()): MascotMood {
    if (this.flashMood && now < this.flashMood.until) return this.flashMood.mood;
    this.flashMood = undefined;
    if (this.phase === "generating") return Math.floor(now / 2400) % 3 === 2 ? "thinking" : "happy";
    if (this.phase === "tool") return "tool";
    if (this.phase === "waiting") return "waiting";
    if (now - this.lastActive >= SLEEPY_AFTER_MS) return "sleepy";
    if (now >= this.nextBlink) {
      if (now < this.nextBlink + BLINK_MS) return "blink";
      this.nextBlink = now + this.blinkGap();
    }
    return "idle";
  }

  face(now = Date.now()): string { return mascotFace(this.mood(now)); }

  tip(now = Date.now(), frame = 0): string {
    const tips = TIPS[this.mood(now)];
    return tips[((frame % tips.length) + tips.length) % tips.length]!;
  }

  /** Visual identity for change detection (avoids needless renders). */
  key(now = Date.now(), frame = 0): string { return this.mood(now) + ":" + this.tip(now, frame); }
}

/** Colorize the face; truecolor terminals get the flame palette, others theme colors. */
export function paintFace(face: string, mood: MascotMood, paint?: MascotPaint, truecolor = supportsTruecolor()): string {
  const shell = mood === "error" ? FLAME_RAMP[4] : FLAME_RAMP[6];
  const eyes = mood === "error" ? FLAME_RAMP[5] : mood === "sleepy" ? FLAME_RAMP[7] : FLAME_RAMP[9];
  if (!truecolor) return paint ? paint(mood === "error" ? "error" : "warning", face) : face;
  return rgb(shell!, face[0]!) + rgb(eyes!, face.slice(1, -1)) + rgb(shell!, face.at(-1)!);
}

export function paintTip(tip: string, mood: MascotMood, paint?: MascotPaint, truecolor = supportsTruecolor()): string {
  if (!truecolor) return paint ? paint(mood === "sleepy" ? "dim" : "warning", tip) : tip;
  return [...tip].map((char) => {
    if (char === " ") return char;
    if (char === "▲" || char === "★") return rgb(mood === "error" ? FLAME_RAMP[5]! : FLAME_RAMP[8]!, char);
    if (char === "*" || char === "∙" || char === "·") return rgb(FLAME_RAMP[9]!, char);
    if (char === "z" || char === "?") return rgb(FLAME_RAMP[7]!, char);
    return rgb(mood === "sleepy" ? FLAME_RAMP[4]! : FLAME_RAMP[6]!, char);
  }).join("");
}
