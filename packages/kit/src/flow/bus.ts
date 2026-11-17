// bus.ts — typed event bus, no singleton. Narrow role: UI intents (`intent:play`) and host
// events; game STATE lives in the reactive state, not on the bus. A handler that throws does not
// stop the others, but emit() rethrows after dispatch (one error as is, several as AggregateError)
// — never logged and swallowed.

export type BusHandler<T> = (payload: T) => void;

export class EventBus<M extends object> {
  private handlers = new Map<keyof M, Set<BusHandler<never>>>();

  /** Subscribe; returns the unsubscribe function. */
  on<K extends keyof M>(event: K, handler: BusHandler<M[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as BusHandler<never>);
    return () => this.off(event, handler);
  }

  once<K extends keyof M>(event: K, handler: BusHandler<M[K]>): () => void {
    const wrap: BusHandler<M[K]> = (p) => {
      this.off(event, wrap);
      handler(p);
    };
    return this.on(event, wrap);
  }

  off<K extends keyof M>(event: K, handler: BusHandler<M[K]>): void {
    this.handlers.get(event)?.delete(handler as BusHandler<never>);
  }

  emit<K extends keyof M>(event: K, ...payload: M[K] extends void | undefined ? [] | [M[K]] : [M[K]]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    const errors: unknown[] = [];
    for (const h of [...set]) {
      try {
        (h as BusHandler<M[K]>)(payload[0] as M[K]);
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `EventBus: ${errors.length} handlers of "${String(event)}" failed`);
  }

  clear(): void {
    this.handlers.clear();
  }
}
