// director.ts — plays choreography sequences on the kit's game loop and writes the choreography log.
//
// Logical time. Every row has a time in ms from its sequence start (a formula of vars, mode
// constants and other rows: `@id`, `@id.end`). The director keeps those times exactly — they are the
// reference numbers — and fires each row in the first loop frame at or after it (`at` in the log is
// that frame, ≤ one frame late). A sequence started at the logical end of the previous one keeps the
// chain exact: no frame drift accumulates over a round. All time comes from the kit loop (a pause of
// the platform stops it; tests step it).
//
// Rows fire into actions by the prefix of their `action` (`clip:`, `tween:`, `fx:`, `sound:`,
// `call:` — actions.ts; a game registers its own), then into the sink (an observer of every row:
// sounds by the `sound` column, analytics, a view that draws everything itself). A prefix with no
// action and no sink is an error. Sequence end: the `resolve` rows (their end), else the end of
// every `await` row. `run:<seq>` rows nest sequences. Skip: every active sequence with `$skip: on`
// applies its rows' rules (cut / now / +N) at the skip moment.

import type { GameLoop } from '../time/loop.js';
import { evalNum, evaluate, type Scope, type Value } from './expr.js';
import type { Choreo, Row, Sequence, SpeedMode } from './model.js';

/** The prefix of an action (`tween:x` → 'tween'); 'timer' — no prefix (`wait`); 'seq' — a sequence's start / end. */
export type EventKind = string;

export interface EventProp {
  name: string;
  from?: number;
  to?: number;
  by?: number;
  set?: Value;
}

export interface ChoreoEvent {
  /** Logical time, ms (absolute, loop clock). */
  t: number;
  /** Loop time when it fired, ms (t ≤ at < t + frame). */
  at: number;
  seq: string;
  /** Sequence run id (nested runs have their own). */
  run: number;
  /** Logical start of the run, ms. */
  seqStart: number;
  row: string;
  ref: string;
  /** `each` bindings of this instance. */
  vars: Record<string, Value>;
  target: string;
  action: string;
  /** ms; 0 = instant; Infinity = loop. */
  dur: number;
  ease: string;
  sound: string;
  props: EventProp[];
  kind: EventKind;
  mode: SpeedMode;
  /** Enclosing runs, outermost first, this run last (timeline times are relative to one of them). */
  chain: { seq: string; run: number; start: number }[];
}

export interface RowCtl {
  /** Aborted when skip cuts the row short (the view jumps to the row's end state). */
  readonly signal: AbortSignal;
}

export type Sink = (e: ChoreoEvent, ctl: RowCtl) => void;

/** What a row's action does: `arg` — the action after its prefix (`tween:x` → 'x'). */
export type Action = (e: ChoreoEvent, ctl: RowCtl, arg: string) => void;

export interface RunOptions {
  /** Logical start, ms (default: now). Chain sequences by passing the previous end. */
  at?: number;
  mode?: SpeedMode;
}

class Pending extends Error {
  constructor(readonly ref: string) {
    super(`pending ${ref}`);
  }
}

type InstState = 'new' | 'planned' | 'started' | 'done' | 'off';

interface Inst {
  row: Row;
  bind: Record<string, Value>;
  state: InstState;
  /** Relative to the run start, ms. */
  start?: number;
  end?: number;
  child?: Run;
  abort?: AbortController;
  /** Skip rule applied before start: forced start. */
  forced?: number;
  /** `poll:` rows: frame time of the last check (once per frame). */
  polledAt?: number;
}

interface Run {
  id: number;
  seq: Sequence;
  /** `each` bindings of the enclosing run rows (k of a row that ran this sequence …). */
  outer: Record<string, Value>;
  start: number;
  mode: SpeedMode;
  vars: Record<string, Value>;
  parent?: { run: Run; scope: Scope };
  insts: Inst[];
  skipped: boolean;
  resolved: boolean;
  end?: number;
  done: (end: number) => void;
  fail: (e: Error) => void;
  constCache: Map<string, Value>;
}

const kindOf = (action: string): EventKind => {
  const i = action.indexOf(':');
  return i > 0 ? action.slice(0, i) : 'timer';
};

export interface DirectorOptions {
  choreo: Choreo;
  loop: GameLoop;
  /** Actions by prefix (kitActions() + the game's own). */
  actions?: Record<string, Action>;
  /** Every fired row, after its action (a game that draws everything itself needs no actions). */
  sink?: Sink;
  /** Names every formula can read (landscape, …). */
  globals?: Record<string, Value>;
  /** `rand` of `poll:` rows (kit seededRandom in the game; deterministic in tests). */
  random?: () => number;
}

export class Director {
  readonly log: ChoreoEvent[] = [];
  private runs: Run[] = [];
  private nextId = 1;
  private readonly globals: Record<string, Value>;
  private processing = false;
  private readonly removeTick: () => void;

  constructor(private readonly o: DirectorOptions) {
    this.globals = o.globals ?? {};
    this.removeTick = o.loop.add(() => this.process(), 'game');
  }

  /** Loop clock, ms (game channel). */
  now(): number {
    return this.o.loop.gameTime * 1000;
  }

  get choreo(): Choreo {
    return this.o.choreo;
  }

  get active(): boolean {
    return this.runs.length > 0;
  }

  /** Play a sequence; resolves with its logical end (ms) — pass it as `at` of the next one. */
  run(seqId: string, vars: Record<string, Value> = {}, opts: RunOptions = {}): Promise<number> {
    const seq = this.o.choreo.sequences[seqId];
    if (!seq) throw new Error(`E_CHOREO_RUN: unknown sequence "${seqId}" (known: ${Object.keys(this.o.choreo.sequences).join(', ')})`);
    return new Promise<number>((done, fail) => {
      this.start(seq, vars, opts.at ?? this.now(), opts.mode ?? 'normal', undefined, done, fail);
      this.process();
    });
  }

  /** Skip press at the current moment: every active `$skip: on` sequence applies its row rules. */
  skip(): void {
    const now = this.now();
    for (const r of [...this.runs]) {
      if (r.seq.skip !== 'on' || r.resolved) continue;
      r.skipped = true;
      const rel = now - r.start;
      for (const i of r.insts) {
        const rule = i.row.skip;
        if (rule.kind === 'none') continue;
        if (i.state === 'new' || i.state === 'planned') {
          if (rule.kind === 'cut') i.state = 'off';
          else {
            i.forced = rule.kind === 'now' ? rel : rel + rule.ms;
            if (i.state === 'planned') i.start = Math.max(i.forced, 0);
          }
        } else if (i.state === 'started' && (i.end === undefined || i.end > rel)) {
          if (i.child) continue; // nested runs decide by their own $skip
          i.end = rule.kind === 'plus' ? rel + rule.ms : rel;
          i.abort?.abort();
        }
      }
    }
    this.process();
  }

  /** Drop everything (round failed / reset). Pending run promises are rejected. */
  cancel(reason = 'cancelled'): void {
    const runs = this.runs;
    this.runs = [];
    for (const r of runs) {
      for (const i of r.insts) i.abort?.abort();
      r.fail(new Error(`E_CHOREO_RUN: ${r.seq.id} ${reason}`));
    }
  }

  dispose(): void {
    this.cancel('disposed');
    this.removeTick();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private start(seq: Sequence, vars: Record<string, Value>, at: number, mode: SpeedMode, parent: Run['parent'], done: (n: number) => void, fail: (e: Error) => void): Run {
    const run: Run = { id: this.nextId++, seq, outer: {}, start: at, mode, vars, parent, insts: [], skipped: false, resolved: false, done, fail, constCache: new Map() };
    this.runs.push(run);
    this.emitSeq(run, '^', at);
    for (const row of seq.rows) {
      for (const bind of this.expand(row, run)) run.insts.push({ row, bind, state: 'new' });
    }
    return run;
  }

  private expand(row: Row, run: Run): Record<string, Value>[] {
    let out: Record<string, Value>[] = [{}];
    for (const e of row.each) {
      const next: Record<string, Value>[] = [];
      for (const b of out) {
        const s = this.scope(run, b);
        let items: Value[];
        if (e.list) {
          const v = this.safe(() => evaluate(e.list!, s), row, 'each');
          if (!Array.isArray(v)) throw new Error(`E_CHOREO_RUN: ${row.at}: each ${e.name} in ${e.list} — not a list (${JSON.stringify(v)})`);
          items = v;
        } else {
          const a = this.safe(() => evalNum(e.from!, s), row, 'each');
          const z = this.safe(() => evalNum(e.to!, s), row, 'each');
          items = [];
          for (let i = a; i <= z; i++) items.push(i);
        }
        items.forEach((it, idx) => next.push({ ...b, [e.name]: it, [`${e.name}_index`]: idx }));
      }
      out = next;
    }
    return out;
  }

  private safe<T>(f: () => T, row: Row, what: string): T {
    try {
      return f();
    } catch (e) {
      if (e instanceof Pending) throw e;
      throw new Error(`E_CHOREO_RUN: ${row.at}: ${what}: ${(e as Error).message}`);
    }
  }

  private constant(run: Run, name: string, scope: Scope): Value | typeof NOPE {
    const c = this.o.choreo.consts[name];
    if (!c) return NOPE;
    if (run.constCache.has(name)) return run.constCache.get(name);
    const v = evaluate(c[run.mode], scope);
    run.constCache.set(name, v);
    return v;
  }

  /** Scope of an instance: bindings → run vars → parent scope → mode constants → globals. */
  private scope(run: Run, bind: Record<string, Value>): Scope {
    const self: Scope = (name) => {
      if (name in bind) return bind[name];
      if (name.startsWith('@')) {
        const rid = name.slice(1).split('.')[0];
        if (run.insts.some((i) => i.row.id === rid) || !run.parent) return this.refTime(run, bind, name);
        return run.parent.scope(name);
      }
      if (name === 'skipped') return run.skipped;
      if (name === 'mode') return run.mode;
      if (name in run.vars) return run.vars[name];
      if (run.parent) {
        try {
          return run.parent.scope(name);
        } catch (e) {
          if (e instanceof Pending) throw e;
          // fall through to constants/globals of this run's mode
        }
      }
      const c = this.constant(run, name, self);
      if (c !== NOPE) return c as Value;
      if (name in this.globals) return this.globals[name];
      const known = [...Object.keys(bind), ...Object.keys(run.vars), ...Object.keys(this.o.choreo.consts), ...Object.keys(this.globals)];
      throw new Error(`unknown name "${name}" in ${run.seq.id} (vars: ${[...new Set(known)].filter((k) => !k.endsWith('_index')).sort().join(', ')})`);
    };
    return self;
  }

  private refTime(run: Run, bind: Record<string, Value>, name: string): number {
    const [rid, prop = 'start'] = name.slice(1).split('.');
    const insts = run.insts.filter((i) => i.row.id === rid);
    if (!insts.length) {
      // a row whose `each` is empty has no instances: like rows all switched off by `when` — 0
      if (run.seq.rows.some((r) => r.id === rid)) return 0;
      throw new Error(`no row "${rid}" in ${run.seq.id}`);
    }
    const shared = insts.filter((i) => Object.keys(i.bind).every((k) => !(k in bind) || bind[k] === i.bind[k]));
    let best = -Infinity;
    let any = false;
    for (const i of shared) {
      if (i.state === 'off') continue;
      any = true;
      const v = prop === 'end' ? (i.state === 'done' ? i.end : undefined) : i.state === 'new' ? undefined : i.start;
      if (v === undefined) throw new Pending(name);
      best = Math.max(best, v);
    }
    return any ? best : 0;
  }

  /** Plan new instances whose times are computable; returns true if anything changed. */
  private plan(run: Run): boolean {
    let changed = false;
    for (const i of run.insts) {
      if (i.state !== 'new') continue;
      const s = this.scope(run, i.bind);
      try {
        if (i.row.when && !evaluate(i.row.when, s)) {
          i.state = 'off';
          changed = true;
          continue;
        }
        let t: number;
        if (i.forced !== undefined) t = i.forced;
        else if (i.row.t.startsWith('poll:')) {
          // checked once per frame with a fresh `rand` (a per-frame re-roll: a button that lights up at random)
          const now = this.now();
          if (i.polledAt === now) continue;
          i.polledAt = now;
          const rel = now - run.start;
          const rnd = (this.o.random ?? Math.random)();
          const ps: Scope = (n) => (n === 'now' ? rel : n === 'rand' ? rnd : s(n));
          if (!evaluate(i.row.t.slice(5), ps)) continue;
          t = rel;
        } else t = evalNum(i.row.t, s);
        i.start = Math.max(0, t);
        i.state = 'planned';
        changed = true;
      } catch (e) {
        if (e instanceof Pending) continue;
        throw new Error(`E_CHOREO_RUN: ${i.row.at}: ${(e as Error).message}`);
      }
    }
    return changed;
  }

  process(): void {
    if (this.processing) return;
    this.processing = true;
    try {
      const now = this.now();
      for (let guard = 0; guard < 100000; guard++) {
        for (const r of [...this.runs]) while (this.plan(r));
        // earliest due happening: an instance start, an instance end, a run resolve
        let best: { t: number; act: () => void } | null = null;
        const consider = (t: number, act: () => void) => {
          if (t <= now + 1e-6 && (!best || t < best.t - 1e-9)) best = { t, act };
        };
        for (const r of this.runs) {
          for (const i of r.insts) {
            if (i.state === 'planned') consider(r.start + i.start!, () => this.fire(r, i));
            else if (i.state === 'started' && !i.child && i.end !== undefined && Number.isFinite(i.end)) consider(r.start + i.end, () => (i.state = 'done'));
          }
          const end = this.resolveTime(r);
          if (end !== undefined) consider(r.start + end, () => this.resolve(r, r.start + end));
        }
        if (!best) break;
        (best as { act: () => void }).act();
        this.runs = this.runs.filter((r) => this.alive(r));
      }
    } catch (e) {
      const err = e as Error;
      const runs = this.runs;
      this.runs = [];
      for (const r of runs) r.fail(err);
    } finally {
      this.processing = false;
    }
  }

  /** Relative resolve time when known, else undefined. */
  private resolveTime(r: Run): number | undefined {
    if (r.resolved) return undefined;
    const res = r.insts.filter((i) => i.row.sync === 'resolve' && i.state !== 'off');
    if (res.length) {
      // the sequence resolves when its resolve rows have ended (an instant row marks a moment)
      if (res.some((i) => i.state !== 'done')) return undefined;
      return Math.max(...res.map((i) => i.end!));
    }
    if (r.insts.some((i) => i.state === 'new')) return undefined;
    const aw = r.insts.filter((i) => i.row.sync === 'await' && i.state !== 'off');
    if (aw.some((i) => i.state !== 'done')) return undefined;
    return aw.length ? Math.max(...aw.map((i) => i.end!)) : 0;
  }

  private resolve(r: Run, end: number): void {
    r.resolved = true;
    r.end = end;
    this.emitSeq(r, '$', end);
    r.done(end);
  }

  /** A resolved run lives on while its rows still play (overlaps); loops do not keep it alive. */
  private alive(r: Run): boolean {
    if (!r.resolved) return true;
    return r.insts.some((i) => i.state === 'planned' || (i.state === 'started' && (i.child ? !i.child.resolved : Number.isFinite(i.end ?? Infinity))));
  }

  private fire(run: Run, i: Inst): void {
    const row = i.row;
    const s = this.scope(run, i.bind);
    const t = run.start + i.start!;
    let dur = 0;
    if (row.dur === 'loop') dur = Infinity;
    else if (row.dur) dur = this.safe(() => evalNum(row.dur, s), row, 'dur');
    i.state = 'started';
    i.end = i.start! + dur;
    i.abort = new AbortController();
    const render = (str: string) => str.replace(/\{([^}]+)\}/g, (_, f: string) => String(this.safe(() => evaluate(f, s), row, 'interpolation')));
    const props: EventProp[] = row.value.map((v) => {
      const n = (f: string | undefined) => (f === undefined ? undefined : this.safe(() => evaluate(f, s), row, `value ${v.name}`));
      const p: EventProp = { name: render(v.name) };
      if (v.set !== undefined) p.set = n(v.set);
      if (v.by !== undefined) p.by = n(v.by) as number;
      if (v.from !== undefined) p.from = n(v.from) as number;
      if (v.to !== undefined) p.to = n(v.to) as number;
      return p;
    });
    const action = render(row.action);
    const ev: ChoreoEvent = {
      t,
      at: this.now(),
      seq: run.seq.id,
      run: run.id,
      seqStart: run.start,
      row: row.id,
      ref: row.ref,
      vars: { ...run.outer, ...i.bind },
      target: render(row.target),
      action,
      dur,
      ease: row.ease,
      sound: render(row.sound),
      props,
      kind: kindOf(action),
      mode: run.mode,
      chain: chainOf(run),
    };
    this.log.push(ev);
    const m = /^run:(.+)$/.exec(action);
    if (m) {
      const child = this.o.choreo.sequences[m[1]];
      const childVars: Record<string, Value> = {};
      for (const p of props) childVars[p.name] = p.set as Value;
      i.end = undefined;
      i.child = this.start(child, childVars, t, run.mode, { run, scope: s }, (end) => {
        i.end = end - run.start;
        i.state = 'done';
      }, run.fail);
      i.child.outer = { ...run.outer, ...i.bind };
      return;
    }
    const ctl = { signal: i.abort.signal };
    const act = this.o.actions?.[ev.kind];
    if (act) act(ev, ctl, action.slice(ev.kind.length + 1));
    else if (!this.o.sink && ev.kind !== 'timer') throw new Error(`E_CHOREO_ACTION: ${row.at}: no action "${ev.kind}" (known: ${Object.keys(this.o.actions ?? {}).join(', ') || '—'})`);
    this.o.sink?.(ev, ctl);
    if (dur === 0) i.state = 'done';
  }

  private emitSeq(run: Run, row: '^' | '$', t: number): void {
    this.log.push({ t, at: this.now(), seq: run.seq.id, run: run.id, seqStart: run.start, row, ref: '', vars: {}, target: '', action: row === '^' ? 'seq:start' : 'seq:end', dur: 0, ease: '', sound: '', props: [], kind: 'seq', mode: run.mode, chain: chainOf(run) });
  }
}

const NOPE = Symbol('nope');

function chainOf(run: Run): ChoreoEvent['chain'] {
  const out: ChoreoEvent['chain'] = [];
  for (let r: Run | undefined = run; r; r = r.parent?.run) out.unshift({ seq: r.seq.id, run: r.id, start: r.start });
  return out;
}

