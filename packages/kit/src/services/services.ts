// services.ts — the registry of a game's contracts (a service locator, not a DI container).
//
//   services.get(C)        the contract's API — a LAZY reference: every call goes to the current
//                          implementation, so provide() before or after get() is the same;
//   services.provide(C, i) override the mock (an object, a factory (ctx) => impl, adapt(…));
//   services.state(C)      the reactive state slice; scenes bind it as services.<name>.<field>;
//   services.listen(e, h)  a contract event (sticky: the current value first) or a kit bus event;
//   services.mock(n, m)    mock modes: latency, fail, the contract's own;
//   services.mount(n, f)   construct an OWNER (component, screen controller): inject() / listen()
//                          in its field initialisers belong to it; injections resolve right after
//                          construction (awake) — an unregistered contract fails there with both
//                          names; unmount() drops its subscriptions.
//
// Module-level inject / listen / provide work on the owner being mounted, else on the CURRENT
// registry (`services` — the one of the running game; createGame adopts it).

import { reactive } from '@trempel/scene/core';
import { EventBus } from '../flow/bus.js';
import { isNamed, type AnyContract, type Api, type EventRef, type EventsOf, type Impl, type MockModes, type ServiceContext, type StateOf } from './contract.js';
type Handler<T> = (payload: T) => void;

/** One line of the dev log: a call, its result, an event. */
export interface ServiceLogEntry {
  t: number;
  contract: string;
  kind: 'call' | 'ok' | 'fail' | 'event' | 'provide';
  name: string;
  data?: unknown;
}

/** Where contracts persist (ctx.store): the game's save in createGame, memory otherwise. */
export interface ServiceStore {
  get(contract: string): unknown;
  set(contract: string, value: unknown): void;
}

/** What the dev panel shows about one contract. */
export interface ServiceInfo {
  name: string;
  /** 'mock' or the implementation's name. */
  impl: string;
  state: Record<string, unknown>;
  modes: MockModes;
  /** The contract's own modes. */
  custom: readonly string[];
  events: string[];
}

interface Entry {
  contract: AnyContract;
  /** Raw state object (its reactive proxy is ctx.state and services.<name>). */
  raw: Record<string, unknown>;
  provided: Impl<object> | null;
  label: string;
  impl: Record<string, unknown> | null;
  ctx: ServiceContext | null;
  api: object | null;
  called: boolean;
  modes: MockModes;
  /** sticky events: last emitted payload. */
  last: Map<string, unknown>;
}

const isMockImpl = (e: Entry) => e.provided === null;

function failNow(f: MockModes['fail'], random: () => number): boolean {
  if (f === 'always') return true;
  if (f === undefined || f === 'never') return false;
  return typeof f === 'number' && random() < f;
}

export class ServiceError extends Error {
  constructor(
    readonly contract: string,
    readonly method: string,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/** The owner being mounted (component / screen controller): inject and listen register on it. */
class Owner {
  readonly injects: AnyContract[] = [];
  readonly disposers: (() => void)[] = [];
  readonly pending: (() => void)[] = [];
  constructor(
    readonly name: string,
    readonly services: Services,
  ) {}
}

let owner: Owner | null = null;

export interface Mounted<T> {
  readonly value: T;
  /** Drop every subscription the owner made (listen). */
  unmount(): void;
}

export class Services {
  /** Events go here as `<contract>:<event>` — the kit's bus in a game. */
  bus: EventBus<Record<string, unknown>>;
  store: ServiceStore;
  /** Call log for the dev panel (newest last, capped). */
  readonly log: ServiceLogEntry[] = [];
  logLimit = 200;
  random: () => number = Math.random;
  private readonly entries = new Map<string, Entry>();
  private readonly raw: Record<string, Record<string, unknown>> = {};
  /** Reactive state of every contract by name — the scenes' `services`. */
  readonly scene: Record<string, Record<string, unknown>> = reactive(this.raw);
  private readonly watchers = new Set<(e: ServiceLogEntry) => void>();
  private readonly pendingModes = new Map<string, MockModes>();

  constructor(opts: { contracts?: readonly AnyContract[]; bus?: EventBus<never>; store?: ServiceStore } = {}) {
    this.bus = (opts.bus as EventBus<Record<string, unknown>> | undefined) ?? new EventBus();
    const mem = new Map<string, unknown>();
    this.store = opts.store ?? { get: (c) => mem.get(c), set: (c, v) => void mem.set(c, structuredClone(v)) };
    for (const c of opts.contracts ?? []) this.register(c);
  }

  /** Make contracts known to this registry (the game's: createGame({ services })). Idempotent. */
  register(...contracts: AnyContract[]): this {
    for (const c of contracts) {
      const had = this.entries.get(c.name);
      if (had) {
        if (had.contract === c || isBaseOf(c, had.contract)) continue;
        if (!isBaseOf(had.contract, c)) throw new Error(`services: two different contracts named "${c.name}"`);
        // An extension replaces its base: same state object, the mock rebuilt on first use.
        had.contract = c;
        for (const [k, v] of Object.entries(structuredClone(c.state) as Record<string, unknown>)) if (!(k in had.raw)) this.scene[c.name][k] = v;
        if (isMockImpl(had)) this.drop(had);
        continue;
      }
      this.raw[c.name] = structuredClone(c.state) as Record<string, unknown>;
      const raw = this.raw[c.name];
      // Through the reactive root, so a scene bound to services.<name> before it existed updates.
      this.scene[c.name] = raw;
      this.entries.set(c.name, { contract: c, raw, provided: null, label: 'mock', impl: null, ctx: null, api: null, called: false, modes: this.pendingModes.get(c.name) ?? {}, last: new Map() });
      this.pendingModes.delete(c.name);
    }
    return this;
  }

  has(c: AnyContract | string): boolean {
    return this.entries.has(typeof c === 'string' ? c : c.name);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  private entry(c: AnyContract | string, why = 'get'): Entry {
    const name = typeof c === 'string' ? c : c.name;
    const e = this.entries.get(name);
    if (!e) throw new Error(`services.${why}: contract "${name}" is not registered in this game (known: ${this.names().join(', ') || 'none'}) — createGame({ services: [${name}] })`);
    return e;
  }

  /**
   * The contract's API: a lazy reference (stable per contract) — every call goes to the current
   * implementation (the mock until provide()).
   */
  get<C extends AnyContract>(c: C): Api<C> {
    const e = this.entry(c as AnyContract);
    if (!e.api) e.api = this.proxy(() => this.entry(c as AnyContract));
    return e.api as Api<C>;
  }

  /** The reactive state slice (services.<name> of the scenes). */
  state<C extends AnyContract>(c: C): StateOf<C> {
    // The state is the implementation's: reading it builds the implementation (awake).
    this.instance(this.entry(c, 'state'));
    return this.scene[c.name] as StateOf<C>;
  }

  /** Override a contract's implementation (registers the contract when new). `label` — its name in the dev panel. */
  provide<C extends AnyContract>(c: C, impl: Impl<Api<C>, StateOf<C>, EventsOf<C>>, label?: string): this {
    const cc = c as AnyContract;
    if (!this.has(cc)) this.register(cc);
    const e = this.entry(cc);
    if (e.called) console.warn(`services: "${cc.name}" is provided after its first call — earlier calls went to the ${e.label} implementation`);
    this.drop(e);
    e.provided = impl as Impl<object>;
    const fnName = typeof impl === 'function' ? (impl as { name?: string }).name : '';
    e.label = label ?? (isNamed(impl) ? impl.label : fnName || 'custom');
    this.write({ contract: cc.name, kind: 'provide', name: e.label });
    return this;
  }

  /** Back to the mock. */
  unprovide(c: AnyContract): this {
    const e = this.entry(c as AnyContract);
    this.drop(e);
    e.provided = null;
    e.label = 'mock';
    return this;
  }

  /** Name of the implementation in force: 'mock' or the provided one's. */
  implName(c: AnyContract | string): string {
    return this.entry(c as AnyContract).label;
  }

  /** Set mock modes of a contract (merged; `null` clears all). Before registration they wait for it. */
  mock(c: AnyContract | string, modes: MockModes | null): this {
    const name = typeof c === 'string' ? c : c.name;
    const e = this.entries.get(name);
    if (!e) {
      this.pendingModes.set(name, { ...(this.pendingModes.get(name) ?? {}), ...(modes ?? {}) });
      return this;
    }
    for (const k of Object.keys(modes ?? {})) {
      if (k !== 'latency' && k !== 'fail' && !e.contract.modes.includes(k)) throw new Error(`services.mock: "${name}" has no mode "${k}" (latency, fail${e.contract.modes.map((m) => ', ' + m).join('')})`);
    }
    if (modes === null) for (const k of Object.keys(e.modes)) delete e.modes[k];
    else Object.assign(e.modes, modes);
    this.write({ contract: name, kind: 'provide', name: 'modes', data: { ...e.modes } });
    return this;
  }

  modes(c: AnyContract | string): Readonly<MockModes> {
    return this.entry(c as AnyContract).modes;
  }

  /** Build every implementation now (createGame: after the save is loaded, before the scenes). */
  start(): void {
    for (const e of this.entries.values()) this.instance(e);
  }

  /** The raw implementation in force (built on first use). */
  impl<C extends AnyContract>(c: C): Api<C> {
    return this.instance(this.entry(c as AnyContract)) as Api<C>;
  }

  /**
   * Subscribe to a contract event (sticky: the current value is delivered first, unless
   * init: false) or to a kit bus event by name. Returns the unsubscribe function.
   */
  listen<T>(ev: EventRef<T> | string, handler: Handler<T>, opts: { init?: boolean } = {}): () => void {
    if (typeof ev === 'string') return this.bus.on(ev, handler as Handler<unknown>);
    const e = this.entry(ev.contract, 'listen');
    this.instance(e);
    const off = this.bus.on(ev.type, handler as Handler<unknown>);
    if (ev.kind === 'sticky' && opts.init !== false) {
      const has = e.last.has(ev.event);
      const v = has ? e.last.get(ev.event) : ev.stateKey ? (this.scene[e.contract.name] as Record<string, unknown>)[ev.stateKey] : undefined;
      if (has || ev.stateKey) handler(v as T);
    }
    return off;
  }

  /** Number of handlers on a bus event (tests: no leaks). */
  listeners(ev: EventRef<unknown> | string): number {
    const type = typeof ev === 'string' ? ev : ev.type;
    return ((this.bus as unknown as { handlers: Map<string, Set<unknown>> }).handlers.get(type)?.size ?? 0);
  }

  /**
   * Construct an owner (a component, a screen controller): inject() / listen() in its field
   * initialisers belong to it. Right after construction (awake) every injected contract must be
   * registered — else an error naming the contract and the owner; sticky inits are delivered then.
   */
  mount<T>(name: string, make: () => T): Mounted<T> {
    const prev = owner;
    const o = (owner = new Owner(name, this));
    let value: T;
    try {
      value = make();
    } catch (err) {
      o.disposers.forEach((d) => d());
      throw err;
    } finally {
      owner = prev;
    }
    const missing = o.injects.filter((c) => !this.has(c));
    if (missing.length) {
      o.disposers.forEach((d) => d());
      const list = [...new Set(missing.map((c) => c.name))];
      throw new Error(`services: "${name}" injects ${list.map((n) => `"${n}"`).join(', ')}, not registered in this game — createGame({ services: [${list.join(', ')}] })`);
    }
    for (const c of o.injects) this.impl(c);
    for (const p of o.pending) p();
    let alive = true;
    return {
      value,
      unmount: () => {
        if (!alive) return;
        alive = false;
        o.disposers.forEach((d) => d());
        o.disposers.length = 0;
      },
    };
  }

  /** Watch the log (dev panel); returns the unsubscribe function. */
  watch(fn: (e: ServiceLogEntry) => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  /** Everything the dev panel shows. */
  info(): ServiceInfo[] {
    return [...this.entries.values()].map((e) => ({
      name: e.contract.name,
      impl: e.label,
      state: JSON.parse(JSON.stringify(e.raw)) as Record<string, unknown>,
      modes: { ...e.modes },
      custom: e.contract.modes,
      events: Object.keys(e.contract.events),
    }));
  }

  private write(entry: Omit<ServiceLogEntry, 't'>): void {
    const full = { t: Date.now(), ...entry };
    this.log.push(full);
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
    for (const w of this.watchers) w(full);
  }

  private drop(e: Entry): void {
    const d = e.impl?.dispose;
    if (typeof d === 'function') (d as () => void).call(e.impl);
    e.impl = null;
    e.ctx = null;
  }

  private instance(e: Entry): Record<string, unknown> {
    if (e.impl) return e.impl;
    const name = e.contract.name;
    const ctx: ServiceContext = {
      name,
      state: this.scene[name],
      emit: (event: string, ...p: unknown[]) => this.emit(e, event, p[0]),
      mode: e.modes,
      store: { get: <T>() => this.store.get(name) as T | undefined, set: (v) => this.store.set(name, v) },
    } as ServiceContext;
    e.ctx = ctx;
    const src = e.provided;
    const made = (src === null ? e.contract.mock(ctx as never) : isNamed(src) ? src.make(ctx as never) : typeof src === 'function' ? (src as (c: ServiceContext) => object)(ctx) : src) as Record<string, unknown>;
    if (!made || typeof made !== 'object') throw new Error(`services: the ${e.label} implementation of "${name}" returned ${String(made)}`);
    if (src !== null) {
      // The mock declares the method set: a real implementation lacking one is caught here, not at the call.
      // `host*` methods of a mock are the host's controls (dev panel, tests), not the contract's.
      const shape = this.mockShape(e) as Record<string, unknown>;
      const missing = Object.keys(shape).filter((k) => typeof shape[k] === 'function' && !/^host[A-Z]/.test(k) && typeof made[k] !== 'function');
      if (missing.length) throw new Error(`services: the ${e.label} implementation of "${name}" lacks ${missing.join(', ')}`);
    }
    e.impl = made;
    return made;
  }

  private shapes = new WeakMap<object, object>();
  /** The mock's method set, built once on a throwaway context (no events, no store). */
  private mockShape(e: Entry): object {
    let s = this.shapes.get(e.contract);
    if (!s) {
      const dry: ServiceContext = { name: e.contract.name, state: structuredClone(e.contract.state) as Record<string, unknown>, emit: () => {}, mode: {}, store: { get: () => undefined, set: () => {} } } as ServiceContext;
      s = e.contract.mock(dry as never) as object;
      this.shapes.set(e.contract, s);
    }
    return s;
  }

  private emit(e: Entry, event: string, payload: unknown): void {
    const ref = (e.contract.events as Record<string, EventRef<unknown>>)[event];
    if (!ref) throw new Error(`services: "${e.contract.name}" has no event "${event}" (${Object.keys(e.contract.events).join(', ') || 'none'})`);
    if (ref.kind === 'sticky') e.last.set(event, payload);
    this.write({ contract: e.contract.name, kind: 'event', name: event, data: payload });
    this.bus.emit(ref.type, payload);
  }

  private proxy(entry: () => Entry): object {
    const fns = new Map<string, (...a: unknown[]) => unknown>();
    return new Proxy(
      {},
      {
        get: (_t, key) => {
          if (typeof key !== 'string' || key === 'then') return undefined;
          const e = entry();
          const v = this.instance(e)[key];
          if (typeof v !== 'function') return v;
          let f = fns.get(key);
          if (!f) fns.set(key, (f = (...args: unknown[]) => this.call(entry(), key, args)));
          return f;
        },
        has: (_t, key) => typeof key === 'string' && key in this.instance(entry()),
        ownKeys: () => Reflect.ownKeys(this.instance(entry())),
        getOwnPropertyDescriptor: (_t, key) => {
          const d = Reflect.getOwnPropertyDescriptor(this.instance(entry()), key);
          return d ? { ...d, configurable: true } : undefined;
        },
      },
    );
  }

  private call(e: Entry, method: string, args: unknown[]): unknown {
    const impl = this.instance(e);
    const fn = impl[method];
    if (typeof fn !== 'function') throw new Error(`services: "${e.contract.name}" has no method "${method}"`);
    e.called = true;
    const name = e.contract.name;
    this.write({ contract: name, kind: 'call', name: method, data: args });
    const mocked = isMockImpl(e);
    const latency = mocked ? Math.max(0, Number(e.modes.latency) || 0) : 0;
    const fail = mocked && failNow(e.modes.fail, this.random);
    const done = (r: unknown) => {
      this.write({ contract: name, kind: 'ok', name: method, data: r });
      return r;
    };
    const failed = (err: unknown) => {
      this.write({ contract: name, kind: 'fail', name: method, data: String(err instanceof Error ? err.message : err) });
      throw err;
    };
    if (!latency && !fail) {
      let r: unknown;
      try {
        r = (fn as (...a: unknown[]) => unknown).apply(impl, args);
      } catch (err) {
        failed(err);
      }
      return r && typeof (r as Promise<unknown>).then === 'function' ? (r as Promise<unknown>).then(done, failed) : done(r);
    }
    // A mode in force: the call becomes async — wait, then fail or run.
    const wait = latency ? new Promise((res) => setTimeout(res, latency)) : Promise.resolve();
    return wait.then(() => {
      if (fail) return failed(new ServiceError(name, method, `${name}.${method}: mock failure (fail mode)`));
      return Promise.resolve((fn as (...a: unknown[]) => unknown).apply(impl, args)).then(done, failed);
    });
  }
}

function isBaseOf(base: AnyContract, c: AnyContract): boolean {
  for (let b = c.base; b; b = b.base) if (b === (base as unknown)) return true;
  return false;
}

// ---- the current registry and the module-level API --------------------------------------------

let current = new Services();
let adopted = false;

/** The registry of the running game (createGame adopts it); outside a game — a standalone one. */
export function currentServices(): Services {
  return current;
}

/** Make `s` the current registry (tests; createGame). */
export function setCurrentServices(s: Services): Services {
  current = s;
  return s;
}

/**
 * createGame's registry: the current one if no game took it yet (so provide() before createGame
 * lands in the game), else a fresh one. It becomes current.
 */
export function adoptServices(): Services {
  if (adopted) current = new Services();
  adopted = true;
  return current;
}

/**
 * The current registry as an object (`services.get(Wallet)`, `services.mock('wallet', …)`): every
 * member goes to the registry of the running game at the time of the call.
 */
export const services: Services = new Proxy({} as Services, {
  get: (_t, key) => {
    const v = (current as unknown as Record<string | symbol, unknown>)[key];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(current) : v;
  },
  set: (_t, key, v) => Reflect.set(current, key, v),
});

/**
 * One line, no decorators: `private wallet = inject(Wallet)`. Inside an owner being mounted
 * (services.mount — kit components, screen controllers) the contract is checked at mount (awake);
 * elsewhere (modules, tests) it is a lazy reference: the implementation is taken at each call,
 * a later provide() is picked up.
 */
export function inject<C extends AnyContract>(c: C): Api<C> {
  const o = owner;
  if (o) {
    o.injects.push(c as AnyContract);
    let api: Api<C> | null = null;
    // Resolved after awake; the reference itself stays lazy (provide later still applies).
    return new Proxy({} as Api<C> & object, {
      get: (_t, key) => (key === 'then' ? undefined : ((api ??= o.services.get(c)) as Record<string | symbol, unknown>)[key]),
      has: (_t, key) => key in ((api ??= o.services.get(c)) as object),
    });
  }
  return new Proxy({} as Api<C> & object, {
    get: (_t, key) => (key === 'then' ? undefined : (current.get(c) as Record<string | symbol, unknown>)[key]),
    has: (_t, key) => key in (current.get(c) as object),
  });
}

/**
 * Subscribe to a contract event (or a kit bus event by name). Inside an owner being mounted the
 * subscription is the owner's — dropped at unmount — and a sticky init arrives after awake;
 * elsewhere it subscribes on the current registry. Returns the unsubscribe function.
 */
export function listen<T>(ev: EventRef<T> | string, handler: Handler<T>): () => void {
  const o = owner;
  if (!o) return current.listen(ev, handler);
  let off: (() => void) | null = null;
  let dead = false;
  const dispose = () => {
    dead = true;
    off?.();
    off = null;
  };
  o.disposers.push(dispose);
  if (typeof ev !== 'string') o.injects.push({ name: ev.contract } as AnyContract);
  // After awake: the contract is checked, the sticky init goes out.
  o.pending.push(() => {
    if (!dead) off = o.services.listen(ev, handler);
  });
  return dispose;
}

/** Override a contract's implementation in the current registry (see Services.provide). */
export function provide<C extends AnyContract>(c: C, impl: Impl<Api<C>, StateOf<C>, EventsOf<C>>, label?: string): Services {
  return current.provide(c, impl, label);
}

/** Mock modes from a query string: ?svc.wallet=fail&svc.iap=latency:300,cancel → { wallet: { fail: 'always' }, … }. */
export function parseModeQuery(search: string): Record<string, MockModes> {
  const out: Record<string, MockModes> = {};
  for (const [k, v] of new URLSearchParams(search)) {
    if (!k.startsWith('svc.')) continue;
    const modes: MockModes = {};
    for (const part of v.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [key, val] = part.split(':');
      if (key === 'fail') modes.fail = val === undefined || val === 'always' ? 'always' : val === 'never' ? 'never' : Number(val);
      else if (key === 'latency') modes.latency = Number(val ?? 0);
      else modes[key] = val === undefined ? true : val === 'false' || val === 'off' ? false : val;
    }
    out[k.slice(4)] = modes;
  }
  return out;
}
