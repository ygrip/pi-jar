import { FLAME_RAMP, rgb, supportsTruecolor } from "./flame.ts";
import type { WorkingPhase } from "./working.ts";

/**
 * Ember's activity state drives a shaded 11×10 pixel pet above the composer.
 * Short/narrow terminals retain a five-column icon and crown; both layouts have fixed dimensions.
 */
export type MascotMood = "idle" | "blink" | "happy" | "thinking" | "tool" | "waiting" | "sleepy" | "error" | "complete" | "poke";
export type MascotPaint = (color: "accent" | "warning" | "error" | "muted" | "dim", text: string) => string;

const FACES: Record<MascotMood, string> = {
  idle: "▪▄▪", blink: "─▄─", happy: "▀▄▀", thinking: "▪─▪", tool: ">▄<",
  waiting: "▪o▪", sleepy: "─_─", error: "×_×", complete: "✦▄✦", poke: "▀o▀"
};
/** Hand-authored pixel crowns; animation selects frames, never changes layout or allocates a canvas. */
const TIPS: Record<MascotMood, readonly string[]> = {
  idle: [" ▄█▄ ", " ▄▀█ ", " █▀▄ "],
  blink: [" ▄█▄ "],
  happy: [" ▄█▄ ", "▄ █ ▄"],
  thinking: [" ▄█· ", " ▄█ ·", "· █▄ ", " ·█▄ "],
  tool: [" ·█· ", " ▄█▄ ", "· █ ·"],
  waiting: [" ▄█▄?", " ▄█▄ "],
  sleepy: [" ▄zzz"],
  error: [" ▄▀▄ ", " ▄▄▄ "],
  complete: [" ·█· ", "· █ ·"],
  poke: ["▄ █ ▄", " ▄█▄ "]
};
export const MASCOT_FACE_WIDTH = 5;
export const MASCOT_TIP_WIDTH = 5;
export const SLEEPY_AFTER_MS = 120_000;
export const MASCOT_FRAME_MS = 600;
const BLINK_MS = 180;

export function mascotFace(mood: MascotMood): string { return "▐" + FACES[mood] + "▌"; }

/** A static crown for the selected mood; motion-off must not consult mutable activity/timers. */
export function mascotTip(mood: MascotMood, frame = 0): string {
  const tips = TIPS[mood];
  return tips[((frame % tips.length) + tips.length) % tips.length]!;
}

export const MASCOT_SPRITE_WIDTH = 11;
export const MASCOT_SPRITE_HEIGHT = 10;

/** A fixed-width mood marker above the pet; an empty row keeps its position stable. */
export function mascotSpark(mood: MascotMood, frame = 0): string {
  if (mood === "sleepy") return Math.abs(frame % 2) ? "      zzz  " : "       zzz ";
  if (mood === "complete") return Math.abs(frame % 2) ? "  ✦     ✦  " : "   ✦   ✦   ";
  if (mood === "waiting") return "        ?  ";
  return " ".repeat(MASCOT_SPRITE_WIDTH);
}
/** Original Ember artwork: a round, soft ember with a curled flame tuft. Dots are transparent. */
const BODY = [
  ".....o.....",
  "....oho....",
  "...ohhbo...",
  "..ohhffbo..",
  ".ohfffffbo.",
  "ohfffffffbo",
  "ohfffffffbo",
  "offfffffbso",
  ".osfffffso.",
  "..ooooooo.."
] as const;
/** Outline, shadow, orange body, golden face, highlight, blush, eye, glint and mouth. */
export const EMBER_PALETTE: Readonly<Record<string, readonly [number, number, number]>> = {
  o: [113, 42, 18], s: [198, 76, 24], b: [255, 139, 38], f: [255, 197, 79],
  h: [255, 231, 154], c: [255, 128, 112], k: [58, 28, 20], w: [255, 249, 230], m: [196, 62, 52]
};
const EMBER_256: Readonly<Record<string, number>> = { o: 94, s: 166, b: 208, f: 221, h: 229, c: 210, k: 52, w: 230, m: 160 };
/** Left-eye 3×2 patches; the right eye mirrors them. Idle eyes are small 1×2 beans. */
const EYES: Record<MascotMood, readonly string[]> = {
  idle: [".k.", ".k."], blink: ["...", ".k."],
  happy: [".k.", "k.k"], thinking: ["..k", "..k"],
  tool: ["kk.", ".k."], waiting: [".k.", ".k."],
  sleepy: ["...", "kkk"], error: ["k..", ".k."],
  complete: [".k.", "k.k"], poke: ["kkk", "..."]
};
const hopMood = (mood: MascotMood) => mood === "happy" || mood === "complete" || mood === "poke";
const poseFrame = (frame: number) => ((frame % 4) + 4) % 4;
const mirror = (rows: readonly string[]) => rows.map(row => [...row].reverse().join(""));

/** Pixel-space frames shared by the terminal renderer and the visual comparison artifact. */
export function mascotPixels(mood: MascotMood, frame = 0): string[] {
  const grid = BODY.map(row => [...row]);
  const stamp = (x: number, y: number, rows: readonly string[]) => {
    rows.forEach((row, dy) => [...row].forEach((pixel, dx) => {
      if (pixel !== "." && grid[y + dy]?.[x + dx] !== undefined) grid[y + dy]![x + dx] = pixel;
    }));
  };
  const pose = poseFrame(frame);
  // The tuft sways while active; the face stays put.
  if (!["idle", "blink", "sleepy"].includes(mood) && pose % 2 === 1) {
    for (let y = 0; y < 3; y++) grid[y] = [".", ...grid[y]!.slice(0, -1)];
  }
  // Thinking glances right, then left; both eyes look the same way.
  const eyes = mood === "thinking" && pose >= 2 ? mirror(EYES.thinking) : EYES[mood];
  const eyeRow = mood === "waiting" ? 4 : 5;
  stamp(2, eyeRow, eyes);
  stamp(6, eyeRow, mood === "thinking" ? eyes : mirror(eyes));
  if (mood === "error") { stamp(1, 7, ["cc"]); stamp(8, 7, ["cc"]); }
  else { stamp(2, 7, ["c"]); stamp(8, 7, ["c"]); }
  stamp(5, 7, [hopMood(mood) ? "m" : "k"]);
  if (mood === "complete") stamp(5, 1, ["w"]);
  // Squash before a hop; pouting gives a small grounded huff. Never grow the canvas.
  if ((hopMood(mood) && pose === 1) || (mood === "error" && pose % 2 === 1)) {
    for (let y = 3; y > 0; y--) grid[y] = [...grid[y - 1]!];
    grid[0] = Array(MASCOT_SPRITE_WIDTH).fill(".");
  }
  return grid.map(row => row.join(""));
}

/** Two square pixels per terminal cell, like pixel-pet: colored half-blocks, not text-face glyphs. */
export function mascotSprite(mood: MascotMood, frame = 0, truecolor = supportsTruecolor()): string[] {
  const pixels = mascotPixels(mood, frame);
  const color = (pixel: string, background: boolean) => truecolor
    ? `\x1b[${background ? 48 : 38};2;${EMBER_PALETTE[pixel]!.join(";")}m`
    : `\x1b[${background ? 48 : 38};5;${EMBER_256[pixel]}m`;
  const rows: string[] = [];
  for (let y = 0; y < MASCOT_SPRITE_HEIGHT; y += 2) {
    let row = "";
    for (let x = 0; x < MASCOT_SPRITE_WIDTH; x++) {
      const top = pixels[y]![x]!, bottom = pixels[y + 1]![x]!;
      row += top === "." && bottom === "." ? " "
        : top === "." ? color(bottom, false) + "▄\x1b[0m"
        : bottom === "." ? color(top, false) + "▀\x1b[0m"
        : color(top, false) + color(bottom, true) + "▀\x1b[0m";
    }
    rows.push(row);
  }
  return rows;
}

/** A hop uses the existing spark row as headroom, never moving the editor below it. */
export function mascotPerch(mood: MascotMood, frame = 0, paint?: MascotPaint, truecolor = supportsTruecolor()): string[] {
  const sprite = mascotSprite(mood, frame, truecolor);
  if (hopMood(mood) && poseFrame(frame) === 2) return [...sprite, " ".repeat(MASCOT_SPRITE_WIDTH)];
  const spark = mascotSpark(mood, frame);
  return [paint ? paint(mood === "sleepy" ? "dim" : "accent", spark) : spark, ...sprite];
}

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
    return mascotTip(this.mood(now), frame);
  }

  /**
   * Milliseconds until an idle mascot can visibly change again. Active phases are driven by
   * the composer's low-frequency animation clock; idle uses this deadline instead of polling.
   */
  nextTransitionDelay(now = Date.now()): number | undefined {
    const current = this.mood(now);
    if (this.flashMood && now < this.flashMood.until) {
      // Only transient reactions need timed pose frames while Pi is idle; stop on expiry.
      return Math.max(16, Math.min(this.flashMood.until - now, MASCOT_FRAME_MS - now % MASCOT_FRAME_MS));
    }
    if (this.phase !== "idle") return undefined;
    const sleepyAt = this.lastActive + SLEEPY_AFTER_MS;
    if (now >= sleepyAt) return undefined;
    const next = current === "blink" ? Math.min(this.nextBlink + BLINK_MS, sleepyAt) : Math.min(this.nextBlink, sleepyAt);
    return Math.max(16, next - now);
  }

  /** Visual identity for change detection (avoids needless renders). */
  key(now = Date.now(), frame = Math.floor(now / MASCOT_FRAME_MS)): string {
    const mood = this.mood(now);
    return mood + ":" + mascotTip(mood, frame) + ":" + mascotPerch(mood, frame).join("");
  }
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
    if (char === "█" || char === "▀") return rgb(mood === "error" ? FLAME_RAMP[5]! : FLAME_RAMP[8]!, char);
    if (char === "·") return rgb(FLAME_RAMP[9]!, char);
    if (char === "z" || char === "?") return rgb(FLAME_RAMP[7]!, char);
    return rgb(mood === "sleepy" ? FLAME_RAMP[4]! : FLAME_RAMP[6]!, char);
  }).join("");
}
