// tweens.ts — frame-driven tweens and waits (in the spirit of DOTween).
// Driven by one update(dt) from the game loop, so pausing the loop pauses every animation and
// timer with it. Eases are DOTween's (default OutQuad), the overshoot of Back is 1.70158.
// Kit additions: more eases (sine, cubic, elastic, bounce), `from`, a `speed` multiplier.

export type Ease = (t: number) => number;

const BACK = 1.70158;

const bounceOut = (t: number): number => {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};

export const ease = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  inSine: (t: number) => 1 - Math.cos((t * Math.PI) / 2),
  outSine: (t: number) => Math.sin((t * Math.PI) / 2),
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  inBack: (t: number) => (BACK + 1) * t * t * t - BACK * t * t,
  outBack: (t: number) => 1 + (BACK + 1) * (t - 1) ** 3 + BACK * (t - 1) ** 2,
  outElastic: (t: number) => (t === 0 || t === 1 ? t : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  outBounce: bounceOut,
} satisfies Record<string, Ease>;

export type EaseName = keyof typeof ease;

interface Job {
  t: number;
  delay: number;
  dur: number;
  step: (k: number) => void;
  done: () => void;
  alive: () => boolean;
  target: object | null;
  started: boolean;
}

export interface TweenOptions {
  ease?: Ease | EaseName;
  delay?: number;
  /** Abort silently when this returns false (target destroyed). */
  alive?: () => boolean;
  /** Owner object for kill(target). */
  target?: object;
}

export class Tweens {
  private jobs: Job[] = [];
  /** Time multiplier (turbo / slow-motion), read every frame. */
  speed = 1;

  /** Advance everything by dt seconds. */
  update(dt: number): void {
    dt *= this.speed;
    const jobs = this.jobs;
    this.jobs = [];
    const keep: Job[] = [];
    for (const j of jobs) {
      if (!j.alive()) {
        j.done();
        continue;
      }
      let step = dt;
      if (j.delay > 0) {
        j.delay -= dt;
        if (j.delay > 0) {
          keep.push(j);
          continue;
        }
        step = -j.delay; // carry the remainder into the tween
        j.delay = 0;
      }
      if (!j.started) {
        j.started = true;
        j.step(0);
      }
      j.t = Math.min(j.dur, j.t + step);
      j.step(j.dur > 0 ? j.t / j.dur : 1);
      if (j.t >= j.dur) j.done();
      else keep.push(j);
    }
    // Jobs added during this update land in this.jobs; keep both.
    this.jobs = keep.concat(this.jobs);
  }

  /** Run `step(k)` for k 0→1 over `dur` seconds. Resolves when finished, killed, or the target dies. */
  run(dur: number, step: (k: number) => void, opts: TweenOptions = {}): Promise<void> {
    return new Promise((done) => {
      const job: Job = {
        t: 0,
        delay: opts.delay ?? 0,
        dur,
        step,
        done,
        alive: opts.alive ?? (() => true),
        target: opts.target ?? null,
        started: false,
      };
      if (job.delay <= 0) {
        job.started = true;
        step(0);
      }
      this.jobs.push(job);
    });
  }

  /** Tween numeric fields of `target` to `props` (from their values when the tween starts). */
  to<T extends object>(target: T, props: Partial<Record<keyof T, number>> | Record<string, number>, dur: number, opts: TweenOptions | EaseName = {}): Promise<void> {
    const o: TweenOptions = typeof opts === 'string' ? { ease: opts } : opts;
    const fn = easeOf(o.ease);
    const rec = target as unknown as Record<string, number>;
    const keys = Object.keys(props);
    const goal = props as Record<string, number>;
    let from: Record<string, number> | null = null;
    return this.run(
      dur,
      (k) => {
        if (!from) {
          from = {};
          for (const key of keys) from[key] = rec[key];
        }
        const e = fn(k);
        for (const key of keys) rec[key] = from[key] + (goal[key] - from[key]) * e;
      },
      { ...o, target: o.target ?? target },
    );
  }

  /** Set `props` now, then tween back to the current values. */
  from<T extends object>(target: T, props: Record<string, number>, dur: number, opts: TweenOptions | EaseName = {}): Promise<void> {
    const rec = target as unknown as Record<string, number>;
    const to: Record<string, number> = {};
    for (const key of Object.keys(props)) {
      to[key] = rec[key];
      rec[key] = props[key];
    }
    return this.to(target, to, dur, opts);
  }

  /** Resolves after `seconds` of loop time (UI channel: runs during a game pause). */
  wait(seconds: number): Promise<void> {
    return this.run(seconds, () => {});
  }

  /** Stop every tween owned by `target` — their promises resolve. */
  kill(target: object): void {
    for (const j of this.jobs) if (j.target === target) j.alive = () => false;
  }

  /** Is a tween owned by `target` running. */
  busy(target: object): boolean {
    return this.jobs.some((j) => j.target === target);
  }

  clear(): void {
    const jobs = this.jobs;
    this.jobs = [];
    for (const j of jobs) j.done();
  }

  get size(): number {
    return this.jobs.length;
  }
}

export function easeOf(e: Ease | EaseName | undefined): Ease {
  if (typeof e === 'function') return e;
  const f = ease[e ?? 'outQuad'];
  if (!f) throw new Error(`kit tweens: unknown ease "${String(e)}" (known: ${Object.keys(ease).join(', ')})`);
  return f;
}
