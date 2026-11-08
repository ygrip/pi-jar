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
/** Shortest pose in any timeline; also the floor for reaction scheduling while Pi is idle. */
export const MASCOT_FRAME_MS = 120;
const BLINK_MS = 180;

/**
 * Pose timelines in milliseconds. Uneven holds read as natural motion: anticipation (squash),
 * a short airborne beat, a quick landing, then a longer rest, instead of a uniform metronome.
 * Poses: 0 rest, 1 squash/sway, 2 airborne (hop moods) or opposite glance, 3 settle.
 */
const TIMELINES: Record<MascotMood, readonly (readonly [pose: number, ms: number])[]> = {
  idle: [[0, 1000]], blink: [[0, 1000]], sleepy: [[0, 1400], [1, 1400]],
  happy: [[0, 640], [1, 140], [2, 240], [1, 120], [0, 360]],
  complete: [[0, 360], [1, 120], [2, 260], [1, 120]],
  poke: [[1, 120], [2, 220], [1, 120], [0, 240]],
  thinking: [[0, 900], [1, 260], [2, 900], [3, 260]],
  tool: [[0, 280], [1, 200], [0, 280], [3, 200]],
  waiting: [[0, 1200], [1, 420]],
  error: [[0, 420], [1, 120], [0, 160], [1, 120], [0, 600]]
};
const timelineLength = (mood: MascotMood) => TIMELINES[mood].reduce((total, [, ms]) => total + ms, 0);

/** Pose for `mood` at wall time `now`; deterministic so every render agrees without a timer. */
export function mascotPose(mood: MascotMood, now: number): number {
  return poseAt(mood, now).pose;
}
/** Milliseconds until `mood` changes pose at `now`. */
export function mascotPoseDelay(mood: MascotMood, now: number): number {
  return poseAt(mood, now).remaining;
}
function poseAt(mood: MascotMood, now: number): { pose: number; remaining: number } {
  const total = timelineLength(mood);
  let offset = ((Math.floor(now) % total) + total) % total;
  for (const [pose, ms] of TIMELINES[mood]) {
    if (offset < ms) return { pose, remaining: ms - offset };
    offset -= ms;
  }
  return { pose: 0, remaining: total };
}

export type Rgb = readonly [number, number, number];
/** Pixel key to color: outline, shadow, body, face, highlight, blush, eye, glint, mouth. */
export type MascotPalette = Readonly<Record<string, Rgb>>;

const mix = (from: Rgb, to: Rgb, amount: number): Rgb =>
  [0, 1, 2].map(index => Math.round(from[index]! + (to[index]! - from[index]!) * amount)) as unknown as Rgb;
const BLACK: Rgb = [12, 8, 10];
const WHITE: Rgb = [255, 252, 245];

/**
 * Ember in the selected accent: the accent becomes the body, darker steps shade and outline it,
 * lighter steps form the face and highlight. Blush and mouth stay warm so expressions stay legible.
 */
export function accentPalette(accent: Rgb): MascotPalette {
  const warm: Rgb = [255, 128, 112];
  return {
    o: mix(accent, BLACK, 0.62), s: mix(accent, BLACK, 0.3), b: accent, f: mix(accent, WHITE, 0.38),
    h: mix(accent, WHITE, 0.68), c: mix(warm, accent, 0.25), k: mix(accent, BLACK, 0.84), w: WHITE,
    m: mix([196, 62, 52], accent, 0.2)
  };
}
const hex = (color: Rgb) => "#" + color.map(channel => channel.toString(16).padStart(2, "0")).join("");
/** Nearest xterm-256 cube color, for terminals without truecolor. */
export function rgbTo256(color: Rgb): number {
  const level = (channel: number) => {
    if (channel < 48) return 0;
    if (channel < 115) return 1;
    return Math.min(5, Math.floor((channel - 35) / 40));
  };
  return 16 + 36 * level(color[0]) + 6 * level(color[1]) + level(color[2]);
}

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
export const EMBER_PALETTE: MascotPalette = {
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
export function mascotSprite(mood: MascotMood, frame = 0, truecolor = supportsTruecolor(), palette: MascotPalette = EMBER_PALETTE): string[] {
  const pixels = mascotPixels(mood, frame);
  const indexed = (pixel: string) => {
    if (palette === EMBER_PALETTE) return EMBER_256[pixel];
    return rgbTo256(palette[pixel]!);
  };
  const color = (pixel: string, background: boolean) => truecolor
    ? `\x1b[${background ? 48 : 38};2;${palette[pixel]!.join(";")}m`
    : `\x1b[${background ? 48 : 38};5;${indexed(pixel)}m`;
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
export function mascotPerch(mood: MascotMood, frame = 0, paint?: MascotPaint, truecolor = supportsTruecolor(), palette: MascotPalette = EMBER_PALETTE): string[] {
  const sprite = mascotSprite(mood, frame, truecolor, palette);
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
      return Math.max(16, Math.min(this.flashMood.until - now, mascotPoseDelay(current, now)));
    }
    if (this.phase !== "idle") return undefined;
    const sleepyAt = this.lastActive + SLEEPY_AFTER_MS;
    if (now >= sleepyAt) return undefined;
    const next = current === "blink" ? Math.min(this.nextBlink + BLINK_MS, sleepyAt) : Math.min(this.nextBlink, sleepyAt);
    return Math.max(16, next - now);
  }

  /** Visual identity for change detection (avoids needless renders). */
  key(now = Date.now()): string {
    const mood = this.mood(now);
    return mood + ":" + mascotPose(mood, now);
  }

  /** Milliseconds until the visible pose or mood can change while active. */
  activeDelay(now = Date.now()): number {
    return Math.max(16, mascotPoseDelay(this.mood(now), now));
  }
}

/** Colorize the face; truecolor terminals get the flame palette, others theme colors. */
export function paintFace(face: string, mood: MascotMood, paint?: MascotPaint, truecolor = supportsTruecolor(), palette?: MascotPalette): string {
  let shell: string = mood === "error" ? FLAME_RAMP[4] : FLAME_RAMP[6];
  let eyes: string = mood === "error" ? FLAME_RAMP[5] : mood === "sleepy" ? FLAME_RAMP[7] : FLAME_RAMP[9];
  if (palette) {
    shell = hex(mood === "error" ? palette.s! : palette.b!);
    eyes = hex(mood === "error" ? palette.c! : mood === "sleepy" ? palette.f! : palette.h!);
  }
  if (!truecolor) {
    if (!paint) return face;
    if (mood === "error") return paint("error", face);
    if (palette) return paint("accent", face);
    return paint("warning", face);
  }
  return rgb(shell!, face[0]!) + rgb(eyes!, face.slice(1, -1)) + rgb(shell!, face.at(-1)!);
}

export function paintTip(tip: string, mood: MascotMood, paint?: MascotPaint, truecolor = supportsTruecolor(), palette?: MascotPalette): string {
  if (!truecolor) {
    if (!paint) return tip;
    if (mood === "sleepy") return paint("dim", tip);
    if (palette) return paint("accent", tip);
    return paint("warning", tip);
  }
  let core: string = mood === "error" ? FLAME_RAMP[5] : FLAME_RAMP[8];
  let spark: string = FLAME_RAMP[9];
  let mark: string = FLAME_RAMP[7];
  let edge: string = mood === "sleepy" ? FLAME_RAMP[4] : FLAME_RAMP[6];
  if (palette) {
    core = hex(mood === "error" ? palette.c! : palette.f!);
    spark = hex(palette.h!);
    mark = hex(palette.f!);
    edge = hex(mood === "sleepy" ? palette.s! : palette.b!);
  }
  return [...tip].map((char) => {
    if (char === " ") return char;
    if (char === "█" || char === "▀") return rgb(core, char);
    if (char === "·") return rgb(spark, char);
    if (char === "z" || char === "?") return rgb(mark, char);
    return rgb(edge, char);
  }).join("");
}
