// player.ts — the round player: a feed from the RoundSource → the plan (feed/plan.ts) → every book event
// → the choreography sequence the game's BINDINGS name for it, played by the kit's Director on the
// loop's logical time (each sequence starts at the logical end of the previous one). The player decides
// WHAT plays and with which data (the event's vars); WHEN and HOW is the choreography — data of the game.
//
// Bindings: book event type → sequence id (`frame`, `cascade`, `expand`, `hits`, `lines`, `stepWin`,
// `multTotal`, `spinWin`, `maxWin`, `spinsLeft`, `fsStart`, `fsEnd`, `bigWin`, `roundEnd`), `step:<kind>`
// (or `step`) for step markers, `bigWin:<level>` (or `bigWin`) for the big win levels, the transform type
// for the game's own transforms (`extra` events). An event without a binding only changes the state;
// `frame` and `cascade` must be shown — bound, or handled by a hook.
// Outside the book: `idle` — played in passes while no round runs (after a round, and from idle());
// a spin skips the pass and starts at once, so its sequence is `$skip: on` with rows that end on a skip;
// `quickstop` / `skip` — played at the moment of a skip press (reels still spinning / the rest of the
// round), next to the skip rules of the running sequences.
// Hooks: the same keys → a function that plays the event itself (api.run(seq, vars)) — the game's
// own events and presentations without a fork of the player.
//
// The state (SlotState) changes around the sequences: the phase and the counters before, the values
// a sequence may animate (win, big win amount) — set to their final values after it.
// Money: the feed is in credits (one bet = betCredits); the state shows currency = credits × bet / betCredits.

import type { ChoreoValue, Director, GameLoop, Sequence, SpeedMode } from '@trempel/kit';
import { DEFAULT_KINDS, planRound, type BookEvent, type PlanOptions, type RoundPlan, type StepKinds } from './feed/plan.js';
import type { Pos } from './feed/types.js';
import type { RoundSource } from './feed/source.js';
import type { SlotPhase, SlotState } from './state.js';

/** Event key → sequence id. */
export type Bindings = Record<string, string>;

export interface HookApi {
  readonly state: SlotState;
  readonly plan: RoundPlan;
  /** The event's vars (what a bound sequence gets). */
  readonly vars: Record<string, ChoreoValue>;
  /** Play a sequence chained on the round's logical time; resolves at its logical end. */
  run(seq: string, vars?: Record<string, ChoreoValue>): Promise<number>;
  readonly director: Director;
  /** Credits → currency at the round's bet. */
  money(credits: number): number;
}

export type Hook = (e: BookEvent, api: HookApi) => void | Promise<void>;

export interface RoundPlayerOptions {
  state: SlotState;
  loop: GameLoop;
  source: RoundSource;
  director: Director;
  bindings: Bindings;
  hooks?: Record<string, Hook>;
  plan?: PlanOptions;
  /** Wins credited to the balance at the round's end (default) — false: a server keeps the balance. */
  creditWins?: boolean;
  /** Every book event, before it plays (analytics). */
  onEvent?: (e: BookEvent) => void;
  /** A round played and credited (save the balance here). */
  onRoundEnd?: (plan: RoundPlan) => void;
  /** Skip pressed during a round (after the sequences applied their rules): land the reels. */
  onSkip?: () => void;
  /** Letters whose cells a frame lists in `marks` (scatters, wilds — what lands with a show). */
  marks?: readonly string[];
  /** Anticipation: reels after the one where `count` of `symbols` have landed are teased (`tease` of a frame). */
  tease?: { symbols: readonly string[]; count: number };
}

/** The binding key of a book event. */
export function eventKey(e: BookEvent): string {
  if (e.type === 'step') return `step:${e.step.kind}`;
  if (e.type === 'bigWin') return `bigWin:${e.level}`;
  if (e.type === 'extra') return e.transform.type;
  return e.type;
}

/** Binding keys of an event, the specific first (`step:spin`, `step`; `bigWin:mega`, `bigWin`). */
function keysOf(e: BookEvent): string[] {
  const k = eventKey(e);
  return e.type === 'step' || e.type === 'bigWin' ? [k, e.type] : [k];
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const MUST_SHOW = ['frame', 'cascade'];

export class RoundPlayer {
  plan: RoundPlan | null = null;
  /** Keys of events that had neither a binding nor a hook, in order (the last round). */
  readonly unhandled: string[] = [];
  private at = 0;
  private bet = 0;
  /** Credits: closed spins of the round / the spin being played. */
  private committed = 0;
  private spinWin = 0;
  private readonly kinds: StepKinds;
  private idleRun: Promise<void> | null = null;
  private idleOn = false;
  /** Vars of the idle presentation: the last round's won lines. */
  private idleVars: Record<string, ChoreoValue> = { lines: [], cells: [], count: 0, total: 0 };

  constructor(private readonly o: RoundPlayerOptions) {
    this.kinds = { ...DEFAULT_KINDS, ...o.plan?.kinds };
    const seqs = o.director.choreo.sequences;
    for (const [key, seq] of Object.entries(o.bindings)) {
      if (!seqs[seq]) throw new Error(`E_SLOT_BINDING: "${key}" → unknown sequence "${seq}" (known: ${Object.keys(seqs).join(', ') || '—'})`);
    }
    if (!o.bindings.frame && !o.hooks?.frame) throw new Error('E_SLOT_BINDING: no sequence for "frame" (the reels must land: bind it or give a hook)');
    if (o.bindings.idle) skippable(o.bindings.idle, seqs, new Set());
  }

  get state(): SlotState {
    return this.o.state;
  }

  get director(): Director {
    return this.o.director;
  }

  /** The speed mode of the sequences and the reels. */
  get mode(): SpeedMode {
    return this.o.state.turbo ? 'turbo' : 'normal';
  }

  /** Credits → currency at the round's bet. */
  money(credits: number): number {
    return round2((credits * this.bet) / (this.plan?.betCredits ?? this.o.plan?.betCredits ?? 100));
  }

  canSpin(buy: string | null = null): boolean {
    const s = this.o.state;
    const cost = buy ? (this.o.plan?.costs?.[buy] ?? Infinity) : (this.o.plan?.costs?.spin ?? 1);
    return !s.busy && s.balance >= s.bet * cost;
  }

  /** Spin button: start a round when idle, skip the current one otherwise. */
  spinOrStop(): Promise<void> {
    if (this.o.state.busy) {
      this.skip();
      return Promise.resolve();
    }
    return this.spin();
  }

  /** Skip press during a round: every active skippable sequence applies its rules; the reels land. */
  skip(): void {
    const s = this.o.state;
    if (!s.busy) return;
    const reaction = this.o.bindings[s.phase === 'spin' || s.phase === 'stop' ? 'quickstop' : 'skip'];
    this.o.director.skip();
    this.o.onSkip?.();
    if (reaction) this.o.director.run(reaction, { phase: s.phase, fs: s.mode !== '' }, { mode: this.mode }).catch(() => {});
  }

  /** Start the idle presentation (the `idle` binding) unless it runs or a round does; a spin stops it. */
  idle(): void {
    const seq = this.o.bindings.idle;
    if (!seq || this.idleRun || this.o.state.busy) return;
    this.idleOn = true;
    const vars = this.idleVars;
    const run = (async () => {
      let at = this.o.director.now();
      while (this.idleOn) {
        const end = await this.o.director.run(seq, vars, { at, mode: this.mode });
        if (end <= at) break; // an empty pass: nothing to repeat
        at = end;
      }
    })()
      .catch(() => {})
      .finally(() => {
        if (this.idleRun === run) this.idleRun = null;
      });
    this.idleRun = run;
  }

  /** The idle presentation runs. */
  get idling(): boolean {
    return this.idleRun !== null;
  }

  private async stopIdle(): Promise<void> {
    const run = this.idleRun;
    if (!run) return;
    this.idleOn = false;
    this.o.director.skip(); // every idle row ends on a skip (checked in the constructor)
    await run;
  }

  /** Play one round (a spin, or a bought feature). Resolves back in idle. */
  async spin(buy: string | null = null): Promise<void> {
    const s = this.o.state;
    if (!this.canSpin(buy)) return;
    s.busy = true;
    let played = false;
    try {
      await this.stopIdle();
      this.idleVars = { lines: [], cells: [], count: 0, total: 0 };
      const feed = await this.o.source.next({ bet: s.bet, buy });
      const plan = planRound(feed, this.o.plan); // throws on any feed error — before money moves
      this.plan = plan;
      this.bet = s.bet;
      this.unhandled.length = 0;
      this.committed = 0;
      this.spinWin = 0;
      s.round = feed.name;
      s.win = 0;
      s.bigWin = 0;
      s.bigWinTier = '';
      s.balance = round2(s.balance - s.bet * plan.cost);
      this.at = this.o.director.now();
      for (const e of plan.book) {
        this.o.onEvent?.(e);
        await this.play(e, plan);
      }
      s.win = this.money(plan.total);
      if (this.o.creditWins !== false) s.balance = round2(s.balance + s.win);
      this.idleVars = { ...this.idleVars, total: s.win };
      played = true;
      this.o.onRoundEnd?.(plan);
    } finally {
      s.busy = false;
      s.fsTotal = 0;
      s.fsIndex = 0;
      s.mode = '';
      s.bigWinTier = '';
      s.phase = 'idle';
    }
    if (s.auto > 0) {
      s.auto--;
      if (this.canSpin()) return this.spin();
      s.auto = 0;
    }
    if (played) this.idle();
  }

  /** Autoplay: n rounds (0 stops). Starts now when idle. */
  autoplay(n: number): void {
    const s = this.o.state;
    s.auto = Math.max(0, n);
    if (s.auto > 0 && !s.busy) {
      s.auto--;
      void this.spin();
    }
  }

  setBet(i: number): void {
    const s = this.o.state;
    if (s.busy) return;
    s.bet = s.bets[Math.max(0, Math.min(s.bets.length - 1, i))];
  }

  betUp(): void {
    this.setBet(this.o.state.bets.indexOf(this.o.state.bet) + 1);
  }

  betDown(): void {
    this.setBet(this.o.state.bets.indexOf(this.o.state.bet) - 1);
  }

  toggleTurbo(): void {
    this.o.state.turbo = !this.o.state.turbo;
  }

  // ── one event ──────────────────────────────────────────────────────────────

  private run(seq: string, vars: Record<string, ChoreoValue>): Promise<number> {
    return this.o.director.run(seq, vars, { at: this.at, mode: this.mode }).then((end) => (this.at = end));
  }

  private phase(p: SlotPhase): void {
    this.o.state.phase = p;
  }

  private shown(): number {
    return this.money(this.committed + this.spinWin);
  }

  private async play(e: BookEvent, plan: RoundPlan): Promise<void> {
    const s = this.o.state;
    const vars = this.before(e);
    const keys = keysOf(e);
    const key = keys.find((k) => this.o.hooks?.[k] || this.o.bindings[k]) ?? keys[keys.length - 1];
    const hook = this.o.hooks?.[key];
    const seq = this.o.bindings[key];
    if (hook) {
      await hook(e, { state: s, plan, vars, run: (q, v = vars) => this.run(q, v), director: this.o.director, money: (c) => this.money(c) });
    } else if (seq) await this.run(seq, vars);
    else if (MUST_SHOW.includes(key)) throw new Error(`E_SLOT_BINDING: no sequence for "${key}" (round ${plan.name}): bind it or give a hook`);
    else this.unhandled.push(key);
    this.after(e);
  }

  /** State before the event's sequence; returns its vars. */
  private before(e: BookEvent): Record<string, ChoreoValue> {
    const s = this.o.state;
    switch (e.type) {
      case 'step': {
        const k = e.step.kind;
        if (this.kinds.follow.includes(k)) this.phase('cascade');
        else {
          this.committed += this.spinWin;
          this.spinWin = 0;
          this.phase('spin');
        }
        s.mode = e.step.mode ?? '';
        return { kind: k, n: e.step.n, spin: e.step.spin, mode: s.mode, fs: s.mode !== '', ...(e.step.flags as Record<string, ChoreoValue>) };
      }
      case 'spinsLeft':
        s.fsIndex = e.index;
        s.fsTotal = e.total;
        return { left: e.left, index: e.index, total: e.total, added: e.added };
      case 'frame':
        this.phase('stop');
        return { grid: e.grid, kind: e.kind, mode: e.mode ?? '', fs: !!e.mode, reels: e.grid.length, marks: marksOf(e.grid, this.o.marks), tease: teaseOf(e.grid, this.o.tease) };
      case 'expand':
        return { reel: e.reel, symbol: e.symbol, mult: e.mult, cells: cells(e.cells) };
      case 'cascade':
        this.phase('cascade');
        return { grid: e.ops.grid, removed: e.ops.winners.map((w) => ({ reel: w.reel, row: w.cell })), swaps: e.ops.swaps.map((w) => ({ reel: w.reel, row: w.cell, id: w.id })), snapshot: e.snapshot };
      case 'hits': {
        this.phase('win');
        const hits = e.hits.map((h) => ({ cells: cells(h.positions), symbol: h.symbol, value: this.money(h.value) }));
        return { hits, cells: union(e.hits.flatMap((h) => h.positions)), count: hits.length, trigger: e.trigger };
      }
      case 'lines': {
        this.phase('win');
        const lines = e.lines.map((l, i) => ({ cells: cells(l.cells), index: lineIndex(l.lineId, i), lineId: l.lineId, symbol: l.symbol, value: this.money(l.value), mult: l.mult }));
        const vars = { lines, cells: union(e.lines.flatMap((l) => l.cells)), count: lines.length };
        this.idleVars = { ...this.idleVars, ...vars };
        return vars;
      }
      case 'stepWin': {
        const from = s.win;
        this.spinWin = e.spinSoFar;
        return { amount: this.money(e.amount), spinSoFar: this.money(e.spinSoFar), from, to: this.shown() };
      }
      case 'multTotal':
        return { value: e.value, mode: e.mode ?? '' };
      case 'spinWin': {
        const from = s.win;
        this.spinWin = e.amount;
        return { amount: this.money(e.amount), base: this.money(e.base), from, to: this.shown() };
      }
      case 'maxWin': {
        const from = s.win;
        this.spinWin = e.amount - this.committed;
        return { amount: this.money(e.amount), from, to: this.shown() };
      }
      case 'fsStart':
        this.phase('fsIntro');
        s.fsTotal = e.count;
        s.fsIndex = 0;
        s.fsWin = 0;
        return { count: e.count, mode: e.mode };
      case 'fsEnd':
        this.phase('fsOutro');
        s.fsWin = this.money(e.total);
        return { total: this.money(e.total), mode: e.mode };
      case 'bigWin':
        this.phase('bigwin');
        s.bigWinTier = e.level;
        s.bigWin = 0;
        return { level: e.level, amount: this.money(e.amount), from: 0, to: this.money(e.amount) };
      case 'roundEnd':
        this.committed += this.spinWin;
        this.spinWin = 0;
        return { total: this.money(e.total) };
      case 'extra':
        return { type: e.transform.type, value: e.transform.value as ChoreoValue, mode: e.step.mode ?? '' };
    }
  }

  /** State after the event's sequence: the values it may have animated land on their final values. */
  private after(e: BookEvent): void {
    const s = this.o.state;
    switch (e.type) {
      case 'stepWin':
      case 'spinWin':
      case 'maxWin':
        s.win = this.shown();
        break;
      case 'fsEnd':
        s.fsTotal = 0;
        s.fsIndex = 0;
        s.mode = '';
        break;
      case 'bigWin':
        s.bigWin = this.money(e.amount);
        s.bigWinTier = '';
        break;
      case 'roundEnd':
        this.phase('idle');
        break;
    }
  }
}

const cells = (ps: Pos[]): ChoreoValue => ps.map((p) => ({ reel: p.reel, row: p.row }));

function union(ps: Pos[]): ChoreoValue {
  const seen = new Map<string, Pos>();
  for (const p of ps) seen.set(`${p.reel}:${p.row}`, p);
  return cells([...seen.values()]);
}

/** A numeric line id is its index (colour); otherwise the order in the event. */
function lineIndex(id: string, i: number): number {
  const n = Number(id);
  return Number.isInteger(n) && n >= 0 ? n : i;
}

/** The idle pass must end on a skip: `$skip: on`, a skip rule on every row, nested sequences alike. */
function skippable(id: string, seqs: Record<string, Sequence>, seen: Set<string>): void {
  if (seen.has(id)) return;
  seen.add(id);
  const seq = seqs[id];
  if (!seq) throw new Error(`E_SLOT_BINDING: "idle" runs an unknown sequence "${id}"`);
  if (seq.skip !== 'on') throw new Error(`E_SLOT_BINDING: idle sequence "${id}" must be $skip: on (a spin skips the idle pass)`);
  for (const r of seq.rows) {
    const m = /^run:(.+)$/.exec(r.action);
    if (m) skippable(m[1], seqs, seen);
    else if (r.skip.kind === 'none') throw new Error(`E_SLOT_BINDING: idle row ${r.at} has no skip rule (a spin must end it: now / cut)`);
  }
}

/** Cells of the given letters on a grid, reel by reel. */
function marksOf(grid: string[][], letters: readonly string[] | undefined): ChoreoValue {
  if (!letters?.length) return [];
  const out: ChoreoValue[] = [];
  grid.forEach((col, reel) => col.forEach((symbol, row) => letters.includes(symbol) && out.push({ reel, row, symbol })));
  return out;
}

/** Reels to tease: every reel after the one where `count` of the symbols have shown (left to right). */
function teaseOf(grid: string[][], t: RoundPlayerOptions['tease']): ChoreoValue {
  if (!t || !(t.count > 0)) return [];
  let seen = 0;
  for (let reel = 0; reel < grid.length; reel++) {
    seen += grid[reel].filter((s) => t.symbols.includes(s)).length;
    if (seen >= t.count) return grid.slice(reel + 1).map((_, i) => reel + 1 + i);
  }
  return [];
}
