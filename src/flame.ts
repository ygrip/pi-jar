/**
 * Pixel flame: one continuous flame with a rounded base that tapers into a softly wavering
 * tip, animated by smooth value noise and a gentle sway, drawn with half blocks (two simulated
 * rows per terminal row) plus wisps, embers and sparks.
 * Every frame is a pure function of (seed, frame) so tests and motion-off stay stable.
 */

/** Odd, so the flame is centered on a whole column (and on the π beneath it). */
export const FLAME_WIDTH = 21;
/** Simulated rows; rendered as FLAME_ROWS terminal rows. */
const SIM_ROWS = 24;
export const FLAME_ROWS = SIM_ROWS / 2;
const MAX_HEAT = 9;
const WARMUP = 28;
export const MAX_PARTICLES = 8;
/** Where the rounded base is widest (fraction of the flame's height) and its half width. */
const BELLY = 0.3;
const BELLY_HALF_WIDTH = 5.6;
const MAX_WISPS = 2;

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

/** Smooth 2D value noise in [0, 1) from a seeded integer lattice. */
function valueNoise(seed: number): (x: number, y: number) => number {
  const lattice = (ix: number, iy: number) => {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 982451653);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = smooth(x - ix), fy = smooth(y - iy);
    const top = lattice(ix, iy) + (lattice(ix + 1, iy) - lattice(ix, iy)) * fx;
    const bottom = lattice(ix, iy + 1) + (lattice(ix + 1, iy + 1) - lattice(ix, iy + 1)) * fx;
    return top + (bottom - top) * fy;
  };
}

interface Wisp { x: number; y: number; vy: number; life: number; max: number }

export class FlameSim {
  readonly width: number;
  readonly rows: number;
  frame = 0;
  private heat: number[];
  private particles: Particle[] = [];
  private wisps: Wisp[] = [];
  private readonly random: () => number;
  private readonly noise: (x: number, y: number) => number;
  private readonly center: number;
  /** Current flame height (fraction of the grid) and horizontal lean of the tip. */
  private height = 0.9;
  private sway = 0;

  constructor(seed = 1, width = FLAME_WIDTH, rows = SIM_ROWS) {
    this.width = width;
    this.rows = rows;
    this.center = (width - 1) / 2;
    this.heat = new Array(width * rows).fill(0);
    this.random = prng(seed);
    this.noise = valueNoise(seed);
    for (let index = 0; index < WARMUP; index++) this.step();
    this.frame = 0;
  }

  /**
   * Half width at height fraction `h` of the flame: a circular bulb below the belly, then a
   * smooth taper to the tip. The base is rounded, not flat, and narrower than the belly.
   */
  private profile(h: number): number {
    if (h < BELLY) {
      const k = (BELLY - h) / (BELLY + 0.03);
      return BELLY_HALF_WIDTH * Math.sqrt(Math.max(0, 1 - k * k));
    }
    return BELLY_HALF_WIDTH * Math.pow(Math.max(0, 1 - (h - BELLY) / (1 - BELLY)), 1.25);
  }

  /** Center column at height fraction `h`: the tip sways and wanders more than the base. */
  private axis(h: number): number {
    const t = this.frame;
    return this.center + this.sway * h * h + (this.noise(h * 1.6, t * 0.06 + 11) - 0.5) * 1.6 * h;
  }

  step(): void {
    const { width, rows, random } = this;
    const t = this.frame;
    // Slow, layered motion: breathing height and a sway that eases side to side.
    this.height = 0.84 + 0.1 * this.noise(t * 0.05, 3.1) + 0.05 * Math.sin(t * 0.21);
    this.sway = 1.4 * Math.sin(t * 0.07) + 0.6 * (this.noise(t * 0.09, 7.3) - 0.5) * 2;
    const heat = this.heat;
    for (let y = 0; y < rows; y++) {
      const v = (rows - 1 - y) / (rows - 1);
      const h = v / this.height;
      const axis = this.axis(Math.min(1, h));
      // Edges ripple upward; the ripple grows toward the tip so the top licks while the base stays calm.
      const ripple = 1 + (this.noise(h * 3.2 - t * 0.22, 5.5) - 0.5) * (0.08 + 0.85 * h);
      const half = h > 1 ? 0 : this.profile(h) * ripple;
      for (let x = 0; x < width; x++) {
        let value = 0;
        if (half > 0.2 && x > 0 && x < width - 1) {
          const d = Math.abs(x - axis) / half;
          if (d < 1) {
            // Hot, pale core low in the flame, cooling to red at the rim and the tip.
            const core = Math.min(1, 1.3 - 0.95 * h);
            const texture = 0.88 + 0.24 * this.noise(x * 0.8, y * 0.55 - t * 0.35);
            value = MAX_HEAT * (1 - Math.pow(d, 1.8)) * core * texture;
          }
        }
        heat[y * width + x] = Math.max(0, Math.min(MAX_HEAT, Math.round(value)));
      }
    }
    this.moveWisps();
    this.moveParticles();
    this.frame++;
  }

  /** Small pieces of flame that break off the tip, rise and fade. */
  private moveWisps(): void {
    const { width, rows, random, heat } = this;
    this.wisps = this.wisps.map((wisp) => ({ ...wisp, y: wisp.y + wisp.vy, x: wisp.x + this.sway * 0.05, life: wisp.life - 1 }))
      .filter((wisp) => wisp.life > 0 && wisp.y >= 0);
    if (this.wisps.length < MAX_WISPS && random() < 0.09) {
      const tip = Math.round((rows - 1) * (1 - this.height));
      const max = 4 + Math.floor(random() * 4);
      this.wisps.push({ x: this.axis(1), y: Math.max(0, tip - 1), vy: -0.6 - random() * 0.4, life: max, max });
    }
    for (const wisp of this.wisps) {
      const x = Math.round(wisp.x), y = Math.round(wisp.y);
      if (x < 1 || x >= width - 1 || y < 0 || y >= rows) continue;
      const value = Math.round(2 + 3 * (wisp.life / wisp.max));
      heat[y * width + x] = Math.max(heat[y * width + x]!, value);
    }
  }

  private topOf(x: number): number | undefined {
    for (let y = 0; y < this.rows; y++) if (this.heat[y * this.width + x]! >= 3) return y;
    return undefined;
  }

  private moveParticles(): void {
    const random = this.random;
    this.particles = this.particles
      .map((particle) => ({ ...particle, y: particle.y + particle.vy, x: particle.x + particle.drift + (random() - 0.5) * 0.3, life: particle.life - 1 }))
      .filter((particle) => particle.life > 0 && particle.y >= 0 && particle.x >= 1 && particle.x < this.width - 1.5);
    const spawn = (spark: boolean) => {
      if (this.particles.length >= MAX_PARTICLES) return;
      // Embers lift off the upper flame, near its swaying axis.
      const x = Math.round(this.axis(0.8) + (random() - 0.5) * 5);
      const top = this.topOf(Math.max(0, Math.min(this.width - 1, x)));
      if (top == null) return;
      const max = spark ? 2 + Math.floor(random() * 3) : 8 + Math.floor(random() * 13);
      this.particles.push({ x, y: Math.max(0, top - 1), vy: spark ? -1.1 - random() * 0.4 : -0.3 - random() * 0.5,
        drift: (random() - 0.5) * 0.5, life: max, max, spark });
    };
    if (random() < 0.3) spawn(false);
    if (random() < 0.12) spawn(false);
    if (random() < 0.08) spawn(true);
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
      if (row < 0 || row >= rows.length || x < 1 || x >= this.width - 1) continue;
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
