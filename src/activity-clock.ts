/**
 * One timer for visible liveness while a turn runs: the elapsed-time label advances every second
 * and the mascot reaches its next pose even when the model is silent (long reasoning, slow tools).
 * Each tick is scheduled for the next visible change only, never a fixed-rate loop, and the caller
 * bounds the cadence by the session's render tier so long transcripts are not redrawn too often.
 */
export interface ActivityClockOptions {
  /** Update visible state; the callee requests a render only when something changed. */
  tick: (now: number) => void;
  /** Milliseconds until the next visible change, or undefined to pause until restarted. */
  nextDelay: (now: number) => number | undefined;
  now?: () => number;
}

export class ActivityClock {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private ticks = 0;
  private readonly options: ActivityClockOptions;
  private readonly now: () => number;

  constructor(options: ActivityClockOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get active(): boolean { return this.running; }
  get count(): number { return this.ticks; }

  start(): void {
    this.running = true;
    this.schedule();
  }

  /** Recompute the deadline after an external change (phase, animation setting, session size). */
  reschedule(): void {
    if (!this.running) return;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const delay = this.options.nextDelay(this.now());
    if (delay === undefined) return;
    this.timer = setTimeout(() => this.fire(), Math.max(16, Math.ceil(delay)));
    this.timer.unref?.();
  }

  private fire(): void {
    this.timer = undefined;
    if (!this.running) return;
    this.ticks++;
    try {
      this.options.tick(this.now());
    } catch (error) {
      // Decoration must never break a turn; keep the clock alive but surface the defect.
      console.error("pi-jar: activity tick failed", error);
    }
    this.schedule();
  }
}

/**
 * Next activity deadline: the next whole elapsed second, or sooner for a mascot pose, never
 * faster than the render tier allows. Very large sessions only advance the elapsed label, and
 * only every two seconds, because each frame redraws the entire transcript.
 */
export function activityDelay(now: number, startedAt: number, tierBackgroundMs: number | undefined, mascotDelay: number | undefined): number {
  const sinceStart = Math.max(0, now - startedAt);
  const toNextSecond = 1000 - (sinceStart % 1000);
  if (tierBackgroundMs === undefined) return Math.max(toNextSecond, 2000);
  let delay = toNextSecond;
  if (mascotDelay !== undefined) delay = Math.min(delay, mascotDelay);
  return Math.max(delay, tierBackgroundMs);
}
