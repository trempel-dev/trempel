// contract.ts — a service contract: methods + events + a state slice, and a MOCK that is part of
// the declaration (a contract without a mock is a type error and a runtime error). The game works
// on the mock by default (offline, demos, evals, agent runs); integration overrides it with
// provide(C, impl) — services.ts. TS types are the only schema: no runtime schemas, no codegen.
//
//   export const Wallet = contract('wallet', {
//     state: { balance: 0 },
//     events: { changed: sticky<number>('balance'), spent: once<{ amount: number }>() },
//     mock: (ctx) => ({ async spend(n: number) { … ctx.state.balance -= n; ctx.emit('changed', ctx.state.balance); … } }),
//   })<{ spend(n: number): Promise<{ ok: boolean }> }>();
//
// Events: `sticky<T>(stateKey?)` — a state stands behind it: a new subscriber gets the current
// value at once (the last emitted one, else `state[stateKey]`), then the changes; `once<T>()` —
// one-off, never replayed. On the kit's bus they are `<contract>:<event>`.

/** Mock modes of a contract (services.mock(name, modes), ?svc.<name>=…, the dev panel). */
export interface MockModes {
  /** Delay of every mocked call, ms. */
  latency?: number;
  /** Failure rate of mocked calls: 0..1, 'always' or 'never' (default). A failed call rejects. */
  fail?: number | 'always' | 'never';
  /** The contract's own modes ('no-funds', 'offline'…): on / off. */
  [mode: string]: unknown;
}

export type EventKind = 'sticky' | 'once';

/** An event declaration inside a contract (sticky / once). */
export interface EventDecl<T> {
  readonly kind: EventKind;
  /** sticky: the state field that is its value before the first emit. */
  readonly stateKey?: string;
  /** Phantom payload type. */
  readonly __payload?: T;
}

/** A sticky event: new subscribers get the current value first. */
export function sticky<T>(stateKey?: string): EventDecl<T> {
  return { kind: 'sticky', stateKey };
}

/** A one-off event: never replayed to late subscribers. */
export function once(): EventDecl<void>;
export function once<T>(): EventDecl<T>;
export function once(): EventDecl<unknown> {
  return { kind: 'once' };
}

/** A contract's event, as games subscribe to it: listen(Wallet.events.changed, …). */
export interface EventRef<T> {
  readonly contract: string;
  readonly event: string;
  /** Name on the kit's bus: `<contract>:<event>`. */
  readonly type: string;
  readonly kind: EventKind;
  readonly stateKey?: string;
  readonly __payload?: T;
}

type Events = Record<string, EventDecl<unknown>>;
export type PayloadOf<D> = D extends EventDecl<infer T> ? T : D extends EventRef<infer T> ? T : never;
/** emit's payload argument: none for void events. */
export type PayloadArgs<T> = [T] extends [void | undefined] ? [] | [T] : [T];

/** What an implementation (mock or real) gets. */
export interface ServiceContext<S extends object = Record<string, unknown>, E extends Events = Events> {
  /** Contract name. */
  readonly name: string;
  /** The contract's state slice — reactive, the same object scenes bind as services.<name>.*. Change it only here. */
  readonly state: S;
  /** Publish an event of the contract (on the kit's bus as `<name>:<event>`). */
  emit<K extends keyof E & string>(event: K, ...payload: PayloadArgs<PayloadOf<E[K]>>): void;
  /** Mock modes in force (the mock reads its own: `ctx.mode['no-funds']`). */
  readonly mode: Readonly<MockModes>;
  /** Persistent per-contract storage (the game's save in createGame; memory elsewhere). */
  readonly store: { get<T>(): T | undefined; set<T>(value: T): void };
}

export type Factory<M, S extends object, E extends Events> = (ctx: ServiceContext<S, E>) => M;

/** An implementation for provide(): an object, or a factory that gets the context. */
export type Impl<M, S extends object = Record<string, unknown>, E extends Events = Events> = M | Factory<M, S, E> | Named<M, S, E>;

/** An implementation with a name for the dev panel (adapt(), named()). */
export interface Named<M, S extends object, E extends Events> {
  readonly __impl: true;
  readonly label: string;
  readonly make: Factory<M, S, E>;
}

export interface ContractSpec<S extends object, E extends Events, R> {
  /** Initial state slice (the shape too). */
  state?: S;
  events?: E;
  /** The contract's own mock modes, toggled in the dev panel ('no-funds', 'offline'). */
  modes?: readonly string[];
  /** Mandatory: the local implementation the game runs on by default. */
  mock: Factory<R, S, E>;
}

export interface Contract<M extends object = object, S extends object = Record<string, unknown>, E extends Events = Events> {
  readonly name: string;
  readonly events: { readonly [K in keyof E]: EventRef<PayloadOf<E[K]>> };
  readonly state: Readonly<S>;
  readonly modes: readonly string[];
  readonly mock: Factory<M, S, E>;
  /** The contract this one extends (extend()). */
  readonly base?: AnyContract;
  /** Phantom method type. */
  readonly __methods?: M;
}

/** Any contract (generic constraints). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyContract = Contract<any, any, any>;
/** Methods of a contract (what services.get / inject return). */
export type Api<C> = C extends Contract<infer M, infer _S, infer _E> ? M : never;
export type StateOf<C> = C extends Contract<infer _M, infer S, infer _E> ? S : never;
export type EventsOf<C> = C extends Contract<infer _M, infer _S, infer E> ? E : never;

const NAME = /^[a-z][a-z0-9-]*$/;
const names = new Set<string>();

function eventRefs(name: string, events: Events): Record<string, EventRef<unknown>> {
  const out: Record<string, EventRef<unknown>> = {};
  for (const [event, d] of Object.entries(events)) {
    if (!d || (d.kind !== 'sticky' && d.kind !== 'once')) throw new Error(`contract "${name}": event "${event}" is not sticky<T>() / once<T>()`);
    out[event] = Object.freeze({ contract: name, event, type: `${name}:${event}`, kind: d.kind, stateKey: d.stateKey });
  }
  return out;
}

function checkMock(name: string, mock: unknown): void {
  if (typeof mock !== 'function') throw new Error(`contract "${name}": a mock is mandatory — contract('${name}', { mock: (ctx) => ({ …methods }) })`);
}

/**
 * Declare a contract. `name` — [a-z][a-z0-9-]*, unique; `mock` is mandatory. The second call
 * gives the method type: contract('x', {...})<{ m(): Promise<void> }>(); the mock must satisfy it.
 */
export function contract<S extends object = Record<string, never>, E extends Events = Record<string, never>, R extends object = object>(
  name: string,
  spec: ContractSpec<S, E, R>,
): <M extends object = R>(...check: R extends M ? [] : [never]) => Contract<M, S, E> {
  if (!NAME.test(name)) throw new Error(`contract "${name}": the name must match [a-z][a-z0-9-]*`);
  checkMock(name, spec?.mock);
  if (names.has(name)) throw new Error(`contract "${name}" is declared twice (contract names are unique)`);
  names.add(name);
  const c = Object.freeze({
    name,
    events: Object.freeze(eventRefs(name, spec.events ?? {})),
    state: Object.freeze(structuredClone(spec.state ?? {})),
    modes: Object.freeze([...(spec.modes ?? [])]),
    mock: spec.mock,
  });
  return (() => c) as never;
}

/**
 * Extend a contract (more methods / events / state / modes) — the same service name, so it
 * replaces the base in a registry. The extension's mock is mandatory; it gets the base mock built
 * on the same context and returns the added methods (spread `base` to keep the old ones changed).
 */
export function extend<M0 extends object, S0 extends object, E0 extends Events, S extends object = Record<string, never>, E extends Events = Record<string, never>, R extends object = object>(
  base: Contract<M0, S0, E0>,
  spec: { state?: S; events?: E; modes?: readonly string[]; mock: (ctx: ServiceContext<S0 & S, E0 & E>, base: M0) => R },
): <M extends object = R>(...check: R extends M ? [] : [never]) => Contract<M0 & M, S0 & S, E0 & E> {
  checkMock(base.name, spec?.mock);
  const mock = (ctx: ServiceContext<S0 & S, E0 & E>) => {
    const b = base.mock(ctx as never);
    return { ...b, ...spec.mock(ctx, b) };
  };
  const c = Object.freeze({
    name: base.name,
    events: Object.freeze({ ...base.events, ...eventRefs(base.name, spec.events ?? {}) }),
    state: Object.freeze({ ...structuredClone(base.state), ...structuredClone(spec.state ?? {}) }),
    modes: Object.freeze([...base.modes, ...(spec.modes ?? [])]),
    mock,
    base,
  });
  return (() => c) as never;
}

/**
 * A named implementation of contract `c` built on the context — typically an adapter of another
 * model (a host SDK, a backend) to this contract: provide(Iap, adapt(Iap, (ctx) => ({…}), 'youtube')).
 * Missing methods are an error when it is instantiated.
 */
export function adapt<M extends object, S extends object, E extends Events>(c: Contract<M, S, E>, make: Factory<M, S, E>, label = 'adapter'): Named<M, S, E> {
  if (typeof make !== 'function') throw new Error(`adapt(${c.name}): needs a factory (ctx) => implementation`);
  return { __impl: true, label, make };
}

export function isNamed(x: unknown): x is Named<object, object, Events> {
  return !!x && typeof x === 'object' && (x as { __impl?: unknown }).__impl === true;
}
