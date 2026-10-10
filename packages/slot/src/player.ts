// player.ts — the round player: a feed from the RoundSource → the plan (feed/plan.ts) → every book event
// → the choreography sequence the game's BINDINGS name for it, played by the kit's Director on the
// loop's logical time (each sequence starts at the logical end of the previous one). The player decides
// WHAT plays and with which data (the event's vars); WHEN and HOW is the choreography — data of the game.
//
// Bindings: book event type → sequence id (`frame`, `cascade`, `hits`, `lines`, `stepWin`, `multTotal`,
// `spinWin`, `maxWin`, `spinsLeft`, `fsStart`, `fsEnd`, `bigWin`, `roundEnd`), `step:<kind>` (or `step`)
// for step markers, the transform type for the game's own transforms (`extra` events). An event without
// a binding only changes the state; `frame` and `cascade` must be shown — bound, or handled by a hook.
// Hooks: the same keys → a function that plays the event itself (api.run(seq, vars)) — the game's
// own events and presentations without a fork of the player.
//
// The state (SlotState) changes around the sequences: the phase and the counters before, the values
// a sequence may animate (win, big win amount) — set to their final values after it.
// Money: the feed is in credits (one bet = betCredits); the state shows currency = credits × bet / betCredits.

import type { ChoreoValue, Director, GameLoop, SpeedMode } from '@trempel/kit';
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
}

/** The binding key of a book event. */
export function eventKey(e: BookEvent): string {
  if (e.type === 'step') return `step:${e.step.kind}`;
  if (e.type === 'extra') return e.transform.type;
  return e.type;
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

  constructor(private readonly o: RoundPlayerOptions) {
    this.kinds = { ...DEFAULT_KINDS, ...o.plan?.kinds };
    const seqs = o.director.choreo.sequences;
    for (const [key, seq] of Object.entries(o.bindings)) {
      if (!seqs[seq]) throw new Error(`E_SLOT_BINDING: "${key}" → unknown sequence "${seq}" (known: ${Object.keys(seqs).join(', ') || '—'})`);
    }
    if (!o.bindings.frame && !o.hooks?.frame) throw new Error('E_SLOT_BINDING: no sequence for "frame" (the reels must land: bind it or give a hook)');
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
    if (!this.o.state.busy) return;
    this.o.director.skip();
    this.o.onSkip?.();
  }

  /** Play one round (a spin, or a bought feature). Resolves back in idle. */
  async spin(buy: string | null = null): Promise<void> {
    const s = this.o.state;
    if (!this.canSpin(buy)) return;
    s.busy = true;
    try {
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
      if (this.canSpin()) await this.spin();
      else s.auto = 0;
    }
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
    let key = eventKey(e);
    if (e.type === 'step' && !this.o.hooks?.[key] && !this.o.bindings[key]) key = 'step';
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
        return { grid: e.grid, kind: e.kind, mode: e.mode ?? '', fs: !!e.mode };
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
        const lines = e.lines.map((l, i) => ({ cells: cells(l.cells), index: lineIndex(l.lineId, i), lineId: l.lineId, symbol: l.symbol, value: this.money(l.value) }));
        return { lines, cells: union(e.lines.flatMap((l) => l.cells)), count: lines.length };
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
