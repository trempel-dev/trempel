// player.ts — the event player («книга раунда»): a stream or array of events → sequential playback.
//
// A handler map over a list of events, plus: events can arrive as a STREAM (a casual game's
// events come from input, push() appends while playing), playback can be cancelled and skipped,
// an event can time out instead of hanging the round, and it runs headless — handlers only see
// the event and a context, no Pixi. Waits run on the game loop (`loop.wait`), so a platform pause
// freezes the book and a test steps it deterministically.
//
// Handler contract:
//   async (event, ctx) => { ...; await ctx.wait(0.3); if (ctx.skipping) …end state now… }
//   ctx.wait resolves at once while skipping and rejects (AbortError) on cancel(); handlers that
//   start their own animations should honour ctx.signal / ctx.skipping.

import { abortError, type GameLoop } from '../time/loop.js';

export interface BookEvent {
  type: string;
}

export interface PlayContext<E extends BookEvent = BookEvent> {
  /** Aborted by cancel(). */
  readonly signal: AbortSignal;
  /** skip() was requested: jump to the end state, waits resolve at once. */
  readonly skipping: boolean;
  /** Game-loop wait; instant while skipping, AbortError on cancel. */
  wait(seconds: number): Promise<void>;
  /** Index of this event in the book. */
  readonly index: number;
  /** Events played so far in this book (this one included). */
  readonly book: readonly E[];
}

export type EventHandler<E extends BookEvent> = (event: E, ctx: PlayContext<E>) => void | Promise<void>;

export type HandlerMap<E extends BookEvent> = { [T in E['type']]?: EventHandler<Extract<E, { type: T }>> };

export interface EventPlayerOptions<E extends BookEvent> {
  handlers: HandlerMap<E>;
  /** Time source for waits and timeouts. */
  loop: Pick<GameLoop, 'wait'>;
  /** Max seconds (loop time) per event; exceeded → play() rejects. Default: none. */
  timeout?: number;
  /** What an event without a handler does: 'throw' (default, fail loud) or 'skip'. */
  unknown?: 'throw' | 'skip';
  /** Called before each event is played (logging, replay recording). */
  onEvent?: (event: E, index: number) => void;
}

export class EventPlayer<E extends BookEvent = BookEvent> {
  private queue: E[] = [];
  private book: E[] = [];
  private running: Promise<void> | null = null;
  private ctrl = new AbortController();
  private skipFlag = false;
  private skipWaiters = new Set<() => void>();
  private waiters: { count: number; resolve: () => void; reject: (e: unknown) => void }[] = [];

  constructor(private readonly opts: EventPlayerOptions<E>) {}

  /** Something is playing or queued. */
  get busy(): boolean {
    return this.running !== null;
  }

  get skipping(): boolean {
    return this.skipFlag;
  }

  /** Play a whole book; resolves when every event of it (and anything queued before) is played. */
  play(events: Iterable<E>): Promise<void> {
    const list = [...events];
    if (!list.length) return this.running ?? Promise.resolve();
    for (const e of list) this.queue.push(e);
    return this.until(this.book.length + this.queue.length);
  }

  /** Append one event to the stream; resolves when it has been played. */
  push(event: E): Promise<void> {
    this.queue.push(event);
    return this.until(this.book.length + this.queue.length);
  }

  /** Finish the current book fast: waits resolve now, handlers see ctx.skipping. */
  skip(): void {
    if (!this.running) return;
    this.skipFlag = true;
    for (const w of this.skipWaiters) w();
    this.skipWaiters.clear();
  }

  /** Abort the current event and drop the queue; pending play()/push() promises reject (AbortError). */
  cancel(): void {
    this.ctrl.abort();
    this.queue = [];
    const err = abortError();
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  /** Clear the played-book history (a new round). */
  reset(): void {
    if (this.running) throw new Error('EventPlayer.reset() while playing — cancel() first');
    this.book = [];
    this.skipFlag = false;
  }

  private until(count: number): Promise<void> {
    const p = new Promise<void>((resolve, reject) => this.waiters.push({ count, resolve, reject }));
    p.catch(() => {}); // the caller may not await a push(); awaiting still sees the rejection
    if (!this.running) this.running = this.drain();
    return p;
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length) {
        const event = this.queue.shift()!;
        this.book.push(event);
        const index = this.book.length - 1;
        this.opts.onEvent?.(event, index);
        await this.one(event, index);
        this.settle();
      }
    } catch (e) {
      this.queue = [];
      for (const w of this.waiters.splice(0)) w.reject(e);
    } finally {
      this.running = null;
      this.skipFlag = false;
      if (this.ctrl.signal.aborted) this.ctrl = new AbortController();
    }
  }

  private settle(): void {
    const n = this.book.length;
    this.waiters = this.waiters.filter((w) => {
      if (w.count > n) return true;
      w.resolve();
      return false;
    });
  }

  private async one(event: E, index: number): Promise<void> {
    const handler = (this.opts.handlers as Record<string, EventHandler<E> | undefined>)[event.type];
    if (!handler) {
      if (this.opts.unknown === 'skip') return;
      throw new Error(`EventPlayer: no handler for event "${event.type}" (known: ${Object.keys(this.opts.handlers).join(', ')})`);
    }
    const signal = this.ctrl.signal;
    if (signal.aborted) throw abortError();
    const player = this;
    const ctx: PlayContext<E> = {
      signal,
      index,
      book: this.book,
      get skipping() {
        return player.skipFlag;
      },
      wait: (s) => this.wait(s, signal),
    };
    const run = Promise.resolve().then(() => handler(event, ctx));
    if (this.opts.timeout === undefined) return run;
    const limit = this.opts.loop.wait(this.opts.timeout, { signal }).then(() => {
      throw new Error(`EventPlayer: event #${index} "${event.type}" did not finish in ${this.opts.timeout}s`);
    });
    limit.catch(() => {});
    return Promise.race([run, limit]);
  }

  private wait(seconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.skipFlag || seconds <= 0) return Promise.resolve();
    const local = new AbortController();
    const onAbort = () => local.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    return new Promise<void>((resolve, reject) => {
      const skip = () => {
        local.abort();
        resolve();
      };
      this.skipWaiters.add(skip);
      this.opts.loop.wait(seconds, { signal: local.signal }).then(resolve, (e) => (signal.aborted ? reject(e) : resolve()));
    }).finally(() => signal.removeEventListener('abort', onAbort));
  }
}
