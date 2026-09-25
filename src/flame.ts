/**
 * Pixel flame: a small heat-spreading fire automaton shaped into a torch, drawn with
 * half blocks (two simulated rows per terminal row) plus rising embers and sparks.
 * Every frame is a pure function of (seed, frame) so tests and motion-off stay stable.
 */

export const FLAME_WIDTH = 22;
/** Simulated rows; rendered as FLAME_ROWS terminal rows. */
const SIM_ROWS = 24;
export const FLAME_ROWS = SIM_ROWS / 2;
const MAX_HEAT = 9;
const WARMUP = 28;
const MAX_PARTICLES = 6;
/** Chance a rising cell loses one heat step; tuned so the tip reaches the top third. */
const COOLING = 0.4;

/** Heat ramp from deep ember red to a pale-gold core. Index 0 is transparent. */
export const FLAME_RAMP = [
  "", "#2B0A05", "#5C1407", "#8F2207", "#C7400C", "#E8601A", "#F58A24", "#FFB23A", "#FFD56A", "#FFF3C4"
] as const;

export type FlameColor = "accent" | "warning" | "error" | "muted" | "dim";
export type FlamePaint = (color: FlameColor, text: string) => string;

interface Particle { x: number; y: number; vy: number; drift: number; life: number; max: number; spark: boolean }

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hexRgb(hex: string): [number, number, number] | undefined {
  const value = hex.replace("#", "");
  if (value.length !== 6) return undefined;
  return [0, 2, 4].map((at) => Number.parseInt(value.slice(at, at + 2), 16)) as [number, number, number];
}

export function rgb(hex: string, text: string): string {
  const color = hexRgb(hex);
  return color ? `\x1b[38;2;${color[0]};${color[1]};${color[2]}m${text}\x1b[39m` : text;
}

function cell(top: number, bottom: number): string {
  const up = hexRgb(FLAME_RAMP[top] ?? "");
  const down = hexRgb(FLAME_RAMP[bottom] ?? "");
  if (up && down) return `\x1b[38;2;${up[0]};${up[1]};${up[2]}m\x1b[48;2;${down[0]};${down[1]};${down[2]}m▀\x1b[39m\x1b[49m`;
  if (up) return `\x1b[38;2;${up[0]};${up[1]};${up[2]}m▀\x1b[39m`;
  if (down) return `\x1b[38;2;${down[0]};${down[1]};${down[2]}m▄\x1b[39m`;
  return " ";
}

/** Terminals without 24-bit color get shaded blocks in theme colors instead. */
function shadedCell(top: number, bottom: number, paint: FlamePaint): string {
  const heat = Math.max(top, bottom);
  if (!heat) return " ";
  const glyph = heat >= 8 ? "█" : heat >= 6 ? "▓" : heat >= 4 ? "▒" : "░";
  return paint(heat >= 7 ? "warning" : heat >= 4 ? "error" : "dim", glyph);
}

export function supportsTruecolor(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.COLORTERM ?? "").toLowerCase();
  return value === "truecolor" || value === "24bit" || /-direct$/.test(env.TERM ?? "");
}

export class FlameSim {
  readonly width: number;
  readonly rows: number;
  frame = 0;
  private heat: number[];
  private particles: Particle[] = [];
  private readonly random: () => number;
  private readonly center: number;

  constructor(seed = 1, width = FLAME_WIDTH, rows = SIM_ROWS) {
    this.width = width;
    this.rows = rows;
    this.center = (width - 1) / 2;
    this.heat = new Array(width * rows).fill(0);
    this.random = prng(seed);
    for (let index = 0; index < WARMUP; index++) this.step();
    this.frame = 0;
  }

  /** Half width of the torch body at a simulated row; narrows toward the tip. */
  private halfWidth(y: number): number {
    const height = (this.rows - 1 - y) / (this.rows - 1);
    return Math.max(0.6, 5.6 * (1 - height * 0.8));
  }

  /** Teardrop envelope: the hottest a cell may be, so heat always reads as one torch. */
  private envelope(x: number, y: number): number {
    const distance = Math.abs(x - this.center) / this.halfWidth(y);
    return distance >= 1.15 ? 0 : Math.round(MAX_HEAT * Math.min(1, 1.35 - distance * 0.8));
  }

  step(): void {
    const { width, rows, random } = this;
    const heat = this.heat;
    const base = (rows - 1) * width;
    // A flickering, torch-shaped source: hot core, cooler shoulders, nothing at the edges.
    for (let x = 0; x < width; x++) {
      const distance = Math.abs(x - this.center);
      heat[base + x] = distance <= 3 ? MAX_HEAT - (random() < 0.18 ? 1 : 0)
        : distance <= 5 ? MAX_HEAT - 2 - Math.floor(random() * 2) : 0;
    }
    const t = this.frame;
    const wind = Math.sin(t * 0.13) * 0.6 + Math.sin(t * 0.041 + 1.3) * 0.4;
    for (let y = 1; y < rows; y++) {
      for (let x = 0; x < width; x++) {
        const source = heat[y * width + x]!;
        const roll = random();
        const spread = roll < 0.25 ? 0 : roll < 0.75 ? 1 : 2;
        let target = x - spread + 1;
        if (random() < Math.abs(wind) * 0.3) target += Math.sign(wind);
        if (target < 0 || target >= width) continue;
        const cooled = source - (random() < COOLING ? 1 : 0);
        heat[(y - 1) * width + target] = Math.max(0, Math.min(this.envelope(target, y - 1), cooled));
      }
    }
    this.moveParticles();
    this.frame++;
  }

  private topOf(x: number): number | undefined {
    for (let y = 0; y < this.rows; y++) if (this.heat[y * this.width + x]! >= 3) return y;
    return undefined;
  }

  private moveParticles(): void {
    const random = this.random;
    this.particles = this.particles
      .map((particle) => ({ ...particle, y: particle.y + particle.vy, x: particle.x + particle.drift + (random() - 0.5) * 0.3, life: particle.life - 1 }))
      .filter((particle) => particle.life > 0 && particle.y >= 0 && particle.x >= 0 && particle.x < this.width);
    const spawn = (spark: boolean) => {
      if (this.particles.length >= MAX_PARTICLES) return;
      const x = Math.round(this.center + (random() - 0.5) * (spark ? 3 : 7));
      const top = this.topOf(Math.max(0, Math.min(this.width - 1, x)));
      if (top == null) return;
      const max = spark ? 2 + Math.floor(random() * 3) : 8 + Math.floor(random() * 13);
      this.particles.push({ x, y: Math.max(0, top - 1), vy: spark ? -1.1 - random() * 0.4 : -0.3 - random() * 0.5,
        drift: (random() - 0.5) * 0.5, life: max, max, spark });
    };
    if (random() < 0.3) spawn(false);
    if (random() < 0.12) spawn(false);
    if (random() < 0.07) spawn(true);
  }

  particleCount(): number { return this.particles.length; }

  render(paint: FlamePaint = (_color, text) => text, truecolor = true): string[] {
    const rows: string[][] = Array.from({ length: this.rows / 2 }, (_, row) => Array.from({ length: this.width }, (_, x) => {
      const top = this.heat[row * 2 * this.width + x]!;
      const bottom = this.heat[(row * 2 + 1) * this.width + x]!;
      return truecolor ? cell(top, bottom) : shadedCell(top, bottom, paint);
    }));
    for (const particle of this.particles) {
      const x = Math.round(particle.x);
      const simY = Math.round(particle.y);
      const row = Math.floor(simY / 2);
      if (row < 0 || row >= rows.length || x < 0 || x >= this.width) continue;
      if (this.heat[simY * this.width + x]! > 0 || rows[row]![x] !== " ") continue;
      const fade = particle.life / particle.max;
      const glyph = particle.spark ? (fade > 0.5 ? "✦" : "*") : fade > 0.66 ? "•" : fade > 0.33 ? "∙" : "·";
      const heat = particle.spark ? MAX_HEAT : Math.max(3, Math.round(4 + fade * 4));
      rows[row]![x] = truecolor ? rgb(FLAME_RAMP[heat]!, glyph) : paint(particle.spark ? "warning" : "error", glyph);
    }
    return rows.map((row) => row.join(""));
  }
}

let cached: { seed: number; sim: FlameSim } | undefined;

/** Rendered flame rows for an absolute frame; replays deterministically for a seed. */
export function flameFrame(frame: number, seed = 1, paint?: FlamePaint, truecolor = supportsTruecolor()): string[] {
  const target = Math.max(0, Math.floor(Number.isFinite(frame) ? frame : 0));
  if (!cached || cached.seed !== seed || cached.sim.frame > target) cached = { seed, sim: new FlameSim(seed) };
  while (cached.sim.frame < target) cached.sim.step();
  return cached.sim.render(paint, truecolor);
}
