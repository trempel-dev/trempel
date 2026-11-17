// loop.ts — the one game loop: a single update(dt) for everything, injectable time, pause.
//
// Time comes from above: the host (Pixi ticker in the browser, a
// test's manual step() headless) calls step(dt); nothing in the kit reads wall time. Hence:
//   - platform pause (Playables onPause) stops ALL time at once — tweens, clips, particles, the
//     event player, external libs on the ticker adapter (tween or animation libraries);
//   - game pause (pause menu) stops only the GAME channel; the UI channel (tweens, clips,
//     particles, popups) keeps running so the pause menu itself animates;
//   - tests are deterministic: step(1/60) as many times as needed.
// Ticker adapter: a duck-type Pixi `Ticker` (add/remove/deltaMS/lastTime…) advanced by this
// loop, for libraries that want a Ticker.

/** Monotonic milliseconds (Trempel Animator's Clock). */
export interface Clock {
  now(): number;
}

export type UpdateFn = (dt: number) => void;

type TickerCb = (ticker: TickerAdapter) => void;

/** Duck-type of Pixi's `Ticker`, driven by the game loop (paused with it). */
export class TickerAdapter {
  deltaMS = 1000 / 60;
  deltaTime = 1;
  elapsedMS = 1000 / 60;
  lastTime = 0;
  speed = 1;
  started = true;
  FPS = 60;
  minFPS = 10;
  maxFPS = 0;
  private cbs: { fn: TickerCb; ctx: unknown }[] = [];

  add(fn: TickerCb, context?: unknown): this {
    this.cbs.push({ fn, ctx: context });
    return this;
  }

  addOnce(fn: TickerCb, context?: unknown): this {
    const once: TickerCb = (t) => {
      this.remove(once);
      fn.call(context, t);
    };
    return this.add(once);
  }

  remove(fn: TickerCb, context?: unknown): this {
    this.cbs = this.cbs.filter((c) => !(c.fn === fn && (context === undefined || c.ctx === context)));
    return this;
  }

  start(): void {}
  stop(): void {}
  destroy(): void {
    this.cbs = [];
  }

  get count(): number {
    return this.cbs.length;
  }

  /** @internal Called by GameLoop.step. */
  tick(dtMs: number, nowMs: number): void {
    this.deltaMS = dtMs;
    this.elapsedMS = dtMs;
    this.deltaTime = dtMs / (1000 / 60);
    this.lastTime = nowMs;
    for (const c of [...this.cbs]) c.fn.call(c.ctx, this);
  }
}

export interface LoopOptions {
  /** Largest step, seconds (a long frame — tab switch, GC — must not teleport the game). */
  maxDt?: number;
}

export class GameLoop {
  /** Game-loop time, seconds (advances only while not platform-paused). */
  time = 0;
  readonly maxDt: number;
  /** Duck-type Pixi Ticker on this loop's time — give it to libraries that drive themselves by a Ticker. */
  readonly ticker = new TickerAdapter();
  /** Milliseconds clock on this loop's time (Trempel Animator, zvuk-free timers). */
  readonly clock: Clock = { now: () => this.time * 1000 };
  private ui: UpdateFn[] = [];
  private game: UpdateFn[] = [];
  private timers: { at: number; done: () => void; game: boolean }[] = [];
  private platformPaused = false;
  private gamePaused = false;

  constructor(opts: LoopOptions = {}) {
    this.maxDt = opts.maxDt ?? 0.1;
  }

  /** Paused by the platform (all time stopped). */
  get suspended(): boolean {
    return this.platformPaused;
  }

  /** Game channel paused (pause menu). */
  get paused(): boolean {
    return this.gamePaused;
  }

  /**
   * Register a per-frame update. `channel: 'game'` (default) stops on pause(); 'ui' runs always
   * except during a platform pause. Returns the remover.
   */
  add(fn: UpdateFn, channel: 'game' | 'ui' = 'game'): () => void {
    const list = channel === 'ui' ? this.ui : this.game;
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** Advance by dt seconds (clamped to maxDt). */
  step(dt: number): void {
    if (this.platformPaused || !(dt > 0)) return;
    dt = Math.min(dt, this.maxDt);
    this.time += dt;
    this.ticker.tick(dt * 1000, this.time * 1000);
    for (const fn of [...this.ui]) fn(dt);
    if (!this.gamePaused) for (const fn of [...this.game]) fn(dt);
    this.fireTimers();
  }

  /** Run `seconds` of time in steps of `frame` (tests, headless runs). */
  advance(seconds: number, frame = 1 / 60): void {
    let left = seconds;
    while (left > 1e-9) {
      const d = Math.min(frame, left);
      this.step(d);
      left -= d;
    }
  }

  /** Resolves after `seconds` of loop time. Game timers (default) also wait out a game pause. */
  wait(seconds: number, opts: { signal?: AbortSignal; channel?: 'game' | 'ui' } = {}): Promise<void> {
    const { signal } = opts;
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const game = opts.channel !== 'ui';
      const timer = { at: (game ? this.gameTime : this.time) + Math.max(0, seconds), done: resolve, game };
      if (seconds <= 0) {
        resolve();
        return;
      }
      this.timers.push(timer);
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.timers.indexOf(timer);
          if (i >= 0) this.timers.splice(i, 1);
          reject(abortError());
        },
        { once: true },
      );
    });
  }

  /** Game-channel time: loop time minus the time spent in game pause. */
  get gameTime(): number {
    return (this.gamePaused ? this.pausedAt : this.time) - this.pausedFor;
  }

  private pausedFor = 0;
  private pausedAt = 0;

  /** Pause the game channel (pause menu). */
  pause(): void {
    if (this.gamePaused) return;
    this.gamePaused = true;
    this.pausedAt = this.time;
  }

  resume(): void {
    if (!this.gamePaused) return;
    this.gamePaused = false;
    this.pausedFor += this.time - this.pausedAt;
  }

  /** Platform pause: everything stops (driven by Platform.onPause/onResume). */
  suspend(): void {
    this.platformPaused = true;
  }

  unsuspend(): void {
    this.platformPaused = false;
  }

  /** Drive this loop from a Pixi Application ticker (browser); returns the detach (2.0). */
  attach(pixiTicker: { add(fn: (t: { deltaMS: number }) => void): unknown; remove?(fn: (t: { deltaMS: number }) => void): unknown }): () => void {
    const fn = (t: { deltaMS: number }) => this.step(t.deltaMS / 1000);
    pixiTicker.add(fn);
    return () => void pixiTicker.remove?.(fn);
  }

  private fireTimers(): void {
    if (!this.timers.length) return;
    const now = this.time;
    const game = this.gameTime;
    const due = this.timers.filter((t) => (t.game ? game : now) >= t.at - 1e-9);
    if (!due.length) return;
    this.timers = this.timers.filter((t) => !due.includes(t));
    due.sort((a, b) => a.at - b.at);
    for (const t of due) t.done();
  }
}

export function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

export function isAbort(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError';
}
