// fsm.ts — state machine with cancellation of an async `enter`, engine-free. transition() aborts
// the previous state's unfinished async enter through its AbortSignal, then exit → enter.
//
// An unknown state and an error thrown by enter/exit reject transition() (fail loud); each enter
// owns its own AbortController (a transition started from inside enter does not clear the new
// state's controller); waits use the game loop, not setTimeout; listeners via onChange; a
// transition superseded during an async exit does not enter.

import { abortError, isAbort } from '../time/loop.js';

export interface StateHandler<C> {
  enter?: (ctx: C, signal: AbortSignal) => void | Promise<void>;
  exit?: (ctx: C) => void | Promise<void>;
  update?: (ctx: C, dt: number) => void;
}

export class StateMachine<C, S extends string> {
  private readonly states = new Map<S, StateHandler<C>>();
  private current: S | null = null;
  private ctrl: AbortController | null = null;
  private transitioning = 0;
  private gen = 0;
  private listeners: ((to: S, from: S | null) => void)[] = [];

  constructor(readonly context: C) {}

  add(name: S, handler: StateHandler<C>): this {
    this.states.set(name, handler);
    return this;
  }

  get state(): S | null {
    return this.current;
  }

  is(state: S): boolean {
    return this.current === state;
  }

  get isTransitioning(): boolean {
    return this.transitioning > 0;
  }

  /** Called on every state change (before the new state's enter runs). */
  onChange(fn: (to: S, from: S | null) => void): () => void {
    this.listeners.push(fn);
    return () => (this.listeners = this.listeners.filter((l) => l !== fn));
  }

  /**
   * Go to `to`: abort the previous async enter, exit the current state, enter the new one.
   * Resolves when the new state's enter has finished (or was aborted by a later transition).
   */
  async transition(to: S): Promise<void> {
    const handler = this.states.get(to);
    if (!handler) throw new Error(`StateMachine: unknown state "${to}" (known: ${[...this.states.keys()].join(', ')})`);
    const gen = ++this.gen;
    this.ctrl?.abort();
    this.ctrl = null;
    const from = this.current;
    const fromHandler = from ? this.states.get(from) : undefined;
    this.transitioning++;
    try {
      // No await without an exit: enter starts synchronously, so a transition right after
      // this one finds it running and aborts it.
      if (fromHandler?.exit) await fromHandler.exit(this.context);
      if (gen !== this.gen) return; // superseded by a later transition during exit
      this.current = to;
      for (const l of [...this.listeners]) l(to, from);
      if (!handler.enter) return;
      const ctrl = new AbortController();
      this.ctrl = ctrl;
      try {
        await handler.enter(this.context, ctrl.signal);
      } catch (e) {
        if (isAbort(e) && ctrl.signal.aborted) return;
        throw e;
      } finally {
        if (this.ctrl === ctrl) this.ctrl = null;
      }
    } finally {
      this.transitioning--;
    }
  }

  /** Per-frame update of the current state (register on the loop). */
  update(dt: number): void {
    if (this.current && !this.transitioning) this.states.get(this.current)?.update?.(this.context, dt);
  }
}

/** Reject with AbortError as soon as `signal` aborts. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Throw AbortError when `signal` is aborted. */
export function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}
