// plan.ts — a round feed → the book the client plays. Pure, no Pixi: steps are cut ONLY by the `step`
// marker, every core transform is read as docs/feed.md says, the field is simulated atom by atom
// (snapshots checked), and the money is summed the way the format defines it:
//   spin total  = the `win` after `multipliersInit` (the multiplied one) if the spin has it,
//                 otherwise the sum of its step `win`s;
//   round total = the sum of spin totals, or the cap when `maxWin` came (nothing may follow it).
// The free-spin episode total (the outro) is computed here too: the sum of spin totals of the mode.
// A core transform that contradicts the format throws — no silent skips. A transform of the game's
// own goes to its handler (`extend`, which may check it and put data on the board's cells) and into the
// book as an `extra` event for the player's hooks; without a handler it passes through as is.
// Expanding wilds (`frameExpandedWild`, a transform of the studio dictionary, docs/feed.md) are read
// here when the game declares its wilds (`wilds`: letter → multiplier): an `expand` event, and the
// multiplier rides the reel's cells — a line through them shows the product (`LineWin.mult`, display only).

import { applyDiff, boardOf, cascadeOps, frameDiff, letterId, lettersOf, sameFrame, viewOf, type Board, type CascadeOps, type ViewId } from './board.js';
import { coreOf, DEFAULT_BET_CREDITS, type ExtraTransform, type Hit, type Pos, type RoundFeed, type Transform } from './types.js';

/** Big win levels: name → threshold ×bet of the round total, ascending (client presentation, not math). */
export type BigWinLevels = Record<string, number>;

export const DEFAULT_BIG_WIN: BigWinLevels = { big: 15, mega: 40, epic: 100 };

/** The highest level the total (×bet) reaches, or null. */
export function bigWinLevel(totalBets: number, levels: BigWinLevels = DEFAULT_BIG_WIN): string | null {
  let out: string | null = null;
  let best = -Infinity;
  for (const [k, v] of Object.entries(levels)) if (totalBets >= v && v >= best) [out, best] = [k, v];
  return out;
}

/** Step kinds by role (the game's closed list of `kind`s). */
export interface StepKinds {
  /** A paid spin of the base game. */
  spin: string[];
  /** The spin of a bought feature (the feed's `buy` is set). */
  buy: string[];
  /** A spin of a mode entered by `switchToMode` (carries the mode as its context). */
  free: string[];
  /** A step that continues the spin before it: a cascade (`frameInitDiff`) or a respin (`frameInit`). */
  follow: string[];
}

export const DEFAULT_KINDS: StepKinds = { spin: ['spin'], buy: ['buy'], free: ['freeSpin'], follow: ['cascade', 'respin'] };

/** What the client records per step. */
export interface StepInfo {
  n: number;
  kind: string;
  /** Mode context of the step (undefined = base / buy spin). */
  mode?: string;
  /** The marker's other keys — flags of the game (passed through, not validated). */
  flags: Record<string, unknown>;
  /** Index of the spin this step belongs to (follow steps share it). */
  spin: number;
}

/** A line win as the client draws it: the paying cells, the symbol on the first of them. */
export interface LineWin {
  lineId: string;
  /** Rows per reel as the feed sent them (null — not paying on that reel). */
  line: (number | null)[];
  cells: Pos[];
  symbol: string;
  /** Credits. */
  value: number;
  /** The product of the multipliers its cells carry (expanded wilds, `data.mult`); 1 — none. Display only: `value` has it. */
  mult: number;
}

/** A reel taken by a wild (`frameExpandedWild`). */
export interface Expansion {
  reel: number;
  /** The wild's letter. */
  symbol: string;
  /** Its multiplier (the game's `wilds`). */
  mult: number;
  cells: Pos[];
}

/** The transform of expanding wilds (the studio dictionary): `{ positions, symbol }`, one per reel. */
export const EXPAND_TRANSFORM = 'frameExpandedWild';

/** The round book: what the player plays, in order. Money in credits. */
export type BookEvent =
  | { type: 'step'; step: StepInfo }
  | { type: 'spinsLeft'; left: number; index: number; total: number; added: number }
  | { type: 'frame'; grid: string[][]; kind: string; mode?: string }
  | { type: 'cascade'; ops: CascadeOps; snapshot: string[][] }
  | { type: 'hits'; hits: Hit[]; trigger: boolean }
  | { type: 'lines'; lines: LineWin[] }
  | ({ type: 'expand' } & Expansion)
  | { type: 'stepWin'; amount: number; spinSoFar: number }
  | { type: 'multTotal'; value: number; mode?: string }
  | { type: 'spinWin'; amount: number; base: number }
  | { type: 'maxWin'; amount: number }
  | { type: 'fsStart'; mode: string; count: number }
  | { type: 'fsEnd'; mode: string; total: number }
  | { type: 'bigWin'; level: string; amount: number }
  | { type: 'roundEnd'; total: number }
  | { type: 'extra'; transform: ExtraTransform; step: StepInfo };

export type BookEventType = BookEvent['type'];

export interface SpinSummary {
  /** Step index (`n`) of the spin's first step. */
  n: number;
  kind: string;
  mode?: string;
  /** Sum of step wins (no multiplier). */
  base: number;
  /** The spin's total (multiplied when the feed says so). */
  total: number;
  multiplied: boolean;
}

export interface RoundPlan {
  name: string;
  buy: string | null;
  /** Cost in bets. */
  cost: number;
  /** Round total, credits. */
  total: number;
  capped: boolean;
  /** Credits of one bet. */
  betCredits: number;
  /** Number of `step` markers. */
  steps: number;
  stepInfos: StepInfo[];
  spins: SpinSummary[];
  /** Snapshot (letters) after every cascade, in order. */
  snapshots: string[][][];
  /** Free-spin episodes: mode and total (credits). */
  episodes: { mode: string; total: number; spins: number }[];
  /** `roundFinished` of a debug feed (checked against `total`). */
  roundFinished?: number;
  book: BookEvent[];
}

/** What a game's transform handler gets. */
export interface ExtensionContext {
  /** The field so far (after the step's frame when it came before); cells' `data` is the game's. */
  board: Board | null;
  step: StepInfo;
  /** Throw the plan's error with the feed place. */
  fail(msg: string): never;
}

/** A handler of a transform of the game's own: check it, put data on the board. */
export type Extension = (t: ExtraTransform, ctx: ExtensionContext) => void;

export interface PlanOptions {
  /** Credits of one bet (default 100). */
  betCredits?: number;
  /** Cost of a round in bets: `spin` (default 1) and every buy the feed may name. */
  costs?: Record<string, number>;
  bigWin?: BigWinLevels;
  /** The field size every frame must have (default: any, but the same all round). */
  grid?: { reels: number; rows: number };
  kinds?: Partial<StepKinds>;
  /** Modes `switchToMode` may name (default: any). */
  modes?: readonly string[];
  /** Handlers of the game's own transforms by type. */
  extend?: Record<string, Extension>;
  /** Expanding wilds: letter → multiplier. Given — `frameExpandedWild` is read (an `expand` event, `data.mult` on the reel's cells). */
  wilds?: Record<string, number>;
  /** Reel symbol ids of cells (default: the letter). */
  viewId?: ViewId;
  /** Called after every step with the field (the game's own checks of its cell data). */
  checkStep?: (board: Board, step: StepInfo) => void;
}

const RESERVED = new Set(['kind', 'n']);

export function planRound(feed: RoundFeed, opts: PlanOptions = {}): RoundPlan {
  const betCredits = opts.betCredits ?? DEFAULT_BET_CREDITS;
  const costs: Record<string, number> = { spin: 1, ...opts.costs };
  const kinds: StepKinds = { ...DEFAULT_KINDS, ...opts.kinds };
  const viewId = opts.viewId ?? letterId;
  const spinKinds = new Set([...kinds.spin, ...kinds.buy, ...kinds.free]);
  const known = new Set([...spinKinds, ...kinds.follow]);
  const name = feed.name;
  const err = (msg: string): never => {
    throw new Error(`E_FEED: ${name}: ${msg}`);
  };
  const fail = (i: number, t: Transform, msg: string): never => err(`#${i} ${t.type}: ${msg}`);

  if (feed.buy !== null && !(feed.buy in costs)) err(`unknown buy "${feed.buy}" (known: ${Object.keys(costs).filter((k) => k !== 'spin').join(', ') || '—'})`);

  // 1. Cut into steps by the marker (and nothing else).
  type StepT = Extract<Transform, { type: 'step' }>;
  const groups: { marker: StepT; items: { t: Transform; i: number }[] }[] = [];
  let roundFinished: number | undefined;
  feed.transforms.forEach((t, i) => {
    if (!t || typeof t !== 'object' || typeof (t as { type?: unknown }).type !== 'string') err(`#${i}: not a transform (${JSON.stringify(t)?.slice(0, 80)})`);
    if (t.type === 'roundFinished') {
      roundFinished = Number(t.value);
      return;
    }
    if (roundFinished !== undefined) fail(i, t, 'transform after roundFinished');
    if (t.type === 'step') groups.push({ marker: t as StepT, items: [] });
    else if (!groups.length) fail(i, t, 'transform before the first step marker');
    else groups[groups.length - 1].items.push({ t, i });
  });
  if (!groups.length) err('no step markers');

  const first = groups[0].marker.value.kind;
  if (kinds.buy.includes(first) !== (feed.buy !== null)) err(`the first step is "${first}", but the source says buy=${feed.buy}`);

  const book: BookEvent[] = [];
  const stepInfos: StepInfo[] = [];
  const spins: SpinSummary[] = [];
  const snapshots: string[][][] = [];
  const episodes: RoundPlan['episodes'] = [];
  let board: Board | null = null;
  let size: { reels: number; rows: number } | null = opts.grid ?? null;
  let total = 0;
  let capped = false;
  let mode: string | undefined; // current mode (undefined = base)
  let episode: { mode: string; total: number; spins: number; played: number; left: number } | null = null;
  let pendingSwitch: string | null = null;
  let spin: SpinSummary | null = null;

  const closeSpin = () => {
    if (!spin) return;
    total += spin.total;
    if (episode && spin.mode === episode.mode) episode.total += spin.total;
    spins.push(spin);
    spin = null;
  };
  const closeEpisode = () => {
    if (!episode) return;
    episodes.push({ mode: episode.mode, total: episode.total, spins: episode.spins });
    book.push({ type: 'fsEnd', mode: episode.mode, total: episode.total });
    episode = null;
    mode = undefined;
  };
  const checkSize = (i: number, t: Transform, f: string[][]) => {
    if (!Array.isArray(f) || f.some((c) => !Array.isArray(c))) fail(i, t, 'the frame is not a list of reels');
    if (!size) size = { reels: f.length, rows: f[0]?.length ?? 0 };
    if (f.length !== size.reels || f.some((c) => c.length !== size!.rows)) fail(i, t, `the frame is not ${size.reels}×${size.rows}`);
  };

  groups.forEach((g, gi) => {
    const m = g.marker;
    const k = m.value?.kind;
    const ctx = m.context;
    if (capped) err(`step ${m.value?.n} after maxWin`);
    if (m.value?.n !== gi) err(`step marker n=${m.value?.n}, expected ${gi}`);
    if (!known.has(k)) err(`step ${gi} has an unknown kind "${k}" (known: ${[...known].join(', ')})`);

    if (spinKinds.has(k)) {
      closeSpin();
      // Mode boundaries: a free spin needs the switch before it; any other spin ends an episode.
      if (kinds.free.includes(k)) {
        if (pendingSwitch) {
          if (ctx !== pendingSwitch) err(`step ${gi} context "${ctx}" after switchToMode "${pendingSwitch}"`);
          mode = pendingSwitch;
          pendingSwitch = null;
        }
        if (!mode || ctx !== mode) err(`free spin ${gi} in context "${ctx}" without switchToMode`);
      } else {
        if (ctx !== undefined) err(`${k} step ${gi} has a context "${ctx}"`);
        if (pendingSwitch) err(`switchToMode "${pendingSwitch}" not followed by free spins`);
        if (gi > 0 && kinds.buy.includes(k)) err(`buy step ${gi} is not the first step`);
        closeEpisode();
      }
      spin = { n: gi, kind: k, mode: ctx, base: 0, total: 0, multiplied: false };
    } else {
      if (!spin) err(`${k} step ${gi} before any spin`);
      if (ctx !== spin!.mode) err(`${k} step ${gi} context "${ctx}" ≠ its spin's "${spin!.mode}"`);
    }
    const cur: SpinSummary = spin!;
    const flags: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(m.value)) if (!RESERVED.has(key)) flags[key] = v;
    const info: StepInfo = { n: gi, kind: k, mode: ctx, flags, spin: spins.length };
    stepInfos.push(info);
    book.push({ type: 'step', step: info });

    // 2. Walk the step's transforms in order (each read by its meaning).
    const before = board;
    let frameIdx = -1; // index in book of the frame event (filled at the step's end)
    let diff: Extract<Transform, { type: 'frameInitDiff' }>['value'] | null = null;
    let multTotalSeen = false;
    let finalSeen = false;
    for (const { t, i } of g.items) {
      if (t.context !== ctx && t.type !== 'switchToMode') fail(i, t, `context "${t.context}" ≠ step context "${ctx}"`);
      if (finalSeen && t.type !== 'switchToMode') fail(i, t, 'transform after the spin total');
      const c = coreOf(t);
      if (!c && t.type === EXPAND_TRANSFORM && opts.wilds) {
        if (!board) fail(i, t, 'an expansion without a field');
        book.push({ type: 'expand', ...expansion(board!, t.value, opts.wilds, (msg) => fail(i, t, msg)) });
        continue;
      }
      if (!c) {
        opts.extend?.[t.type]?.(t, { board, step: info, fail: (msg) => fail(i, t, msg) });
        book.push({ type: 'extra', transform: t, step: info });
        continue;
      }
      switch (c.type) {
        case 'spinsLeft': {
          if (!kinds.free.includes(k) || !episode) fail(i, t, 'spinsLeft outside a free spin');
          const ep = episode!;
          if (ep.played > 0 && c.value < ep.left - 1) fail(i, t, `spinsLeft ${c.value} after ${ep.left}`);
          const added = ep.played > 0 ? c.value - (ep.left - 1) : 0;
          ep.played++;
          ep.spins++;
          ep.left = c.value;
          book.push({ type: 'spinsLeft', left: c.value, index: ep.played, total: ep.played - 1 + c.value, added });
          break;
        }
        case 'frameInit': {
          if (frameIdx >= 0) fail(i, t, 'a second frame on a step');
          checkSize(i, t, c.value);
          board = boardOf(c.value);
          frameIdx = book.length;
          book.push({ type: 'frame', grid: [], kind: k, mode: ctx });
          break;
        }
        case 'frameInitDiff': {
          if (spinKinds.has(k)) fail(i, t, `frameInitDiff on a ${k} step`);
          if (frameIdx >= 0) fail(i, t, 'a second frame on a step');
          if (!before) fail(i, t, 'a cascade without a field');
          board = applyDiff(before!, c.value.diff);
          const got = lettersOf(board);
          if (!sameFrame(got, c.value.snapshot)) fail(i, t, `the field after the cascade ≠ snapshot: ${frameDiff(got, c.value.snapshot)}`);
          diff = c.value;
          snapshots.push(c.value.snapshot);
          frameIdx = book.length;
          book.push({ type: 'cascade', ops: { swaps: [], winners: [], grid: [] }, snapshot: c.value.snapshot });
          break;
        }
        case 'frameHits': {
          if (!board) fail(i, t, 'hits without a field');
          const trigger = c.value.length > 0 && c.value.every((h) => h.value === 0);
          book.push({ type: 'hits', hits: c.value, trigger });
          break;
        }
        case 'paylines': {
          if (!board) fail(i, t, 'paylines without a field');
          const b = board!;
          const lines: LineWin[] = c.value.map((p, j) => {
            if (!Array.isArray(p.line) || p.line.length !== b.length) fail(i, t, `line ${j} ("${p.lineId}") has ${p.line?.length} reels, the field ${b.length}`);
            const cells: Pos[] = [];
            p.line.forEach((row, reel) => {
              if (row === null) return;
              if (!Number.isInteger(row) || row < 0 || row >= b[reel].length) fail(i, t, `line ${j} ("${p.lineId}"): row ${row} off reel ${reel}`);
              cells.push({ reel, row });
            });
            if (!cells.length) fail(i, t, `line ${j} ("${p.lineId}") has no cells`);
            if (!(p.value > 0)) fail(i, t, `line ${j} ("${p.lineId}") pays ${p.value}`);
            const mult = cells.reduce((m, q) => m * multOf(b[q.reel][q.row].data), 1);
            return { lineId: String(p.lineId), line: p.line, cells, symbol: b[cells[0].reel][cells[0].row].sym, value: p.value, mult };
          });
          book.push({ type: 'lines', lines });
          break;
        }
        case 'win': {
          if (multTotalSeen) {
            cur.total = c.value;
            cur.multiplied = true;
            finalSeen = true;
            book.push({ type: 'spinWin', amount: c.value, base: cur.base });
          } else {
            if (!(c.value > 0)) fail(i, t, 'a step win ≤ 0');
            cur.base += c.value;
            cur.total = cur.base;
            book.push({ type: 'stepWin', amount: c.value, spinSoFar: cur.base });
          }
          break;
        }
        case 'multipliersInit': {
          if (c.value.length !== 1) fail(i, t, `expected one value, got ${c.value.length}`);
          multTotalSeen = true;
          book.push({ type: 'multTotal', value: c.value[0], mode: ctx });
          break;
        }
        case 'maxWin': {
          cur.total = c.value - total; // the cap includes everything won before
          cur.multiplied = multTotalSeen;
          capped = true;
          finalSeen = true;
          book.push({ type: 'maxWin', amount: c.value });
          break;
        }
        case 'switchToMode': {
          if (episode || pendingSwitch) fail(i, t, 'switchToMode inside free spins');
          if (opts.modes && !opts.modes.includes(c.value)) fail(i, t, `unknown mode "${c.value}" (known: ${opts.modes.join(', ')})`);
          pendingSwitch = c.value;
          const next = groups[gi + 1]?.items.find((x) => x.t.type === 'spinsLeft')?.t;
          if (!next) fail(i, t, 'no spinsLeft after switchToMode');
          const count = Number(next!.value);
          episode = { mode: c.value, total: 0, spins: 0, played: 0, left: count + 1 };
          book.push({ type: 'fsStart', mode: c.value, count });
          break;
        }
        case 'step':
        case 'roundFinished':
          break; // handled above
      }
    }
    if (frameIdx < 0) err(`step ${gi} has no frame`);
    if (multTotalSeen && !finalSeen) err(`step ${gi}: multipliersInit without a following win / maxWin`);
    // 3. Fill the frame event now that the game's handlers have seen the whole step.
    opts.checkStep?.(board!, info);
    const ev = book[frameIdx];
    if (ev.type === 'frame') ev.grid = viewOf(board!, viewId);
    else if (ev.type === 'cascade') ev.ops = cascadeOps(before!, diff!.diff, board!, viewId);
  });
  closeSpin();
  if (pendingSwitch) err(`switchToMode "${pendingSwitch}" at the end of the feed`);
  if (capped) {
    // The episode is cut by the cap: no outro, the max-win overlay closes the round.
    if (episode) {
      const ep = episode as { mode: string; total: number; spins: number };
      episodes.push({ mode: ep.mode, total: ep.total, spins: ep.spins });
      episode = null;
    }
  } else closeEpisode();
  if (roundFinished !== undefined && roundFinished !== total) err(`roundFinished ${roundFinished} ≠ computed total ${total}`);

  const cost = costs[feed.buy ?? 'spin'];
  const level = capped ? 'max' : bigWinLevel(total / betCredits, opts.bigWin);
  if (level) book.push({ type: 'bigWin', level, amount: total });
  book.push({ type: 'roundEnd', total });
  return { name, buy: feed.buy, cost, total, capped, betCredits, steps: groups.length, stepInfos, spins, snapshots, episodes, roundFinished, book };
}

const multOf = (data: Record<string, unknown> | undefined): number => (typeof data?.mult === 'number' && data.mult > 0 ? data.mult : 1);

/** Read a `frameExpandedWild`: one reel of the field, a declared wild; its cells get the multiplier. */
function expansion(board: Board, value: unknown, wilds: Record<string, number>, fail: (msg: string) => never): Expansion {
  const v = value as { positions?: unknown; symbol?: unknown } | null;
  if (!v || typeof v !== 'object' || !Array.isArray(v.positions) || !v.positions.length) fail('not { positions: [...], symbol }');
  const symbol = String(v!.symbol);
  const mult = wilds[symbol];
  if (!(typeof mult === 'number' && mult > 0)) fail(`"${symbol}" is not a wild of the game (wilds: ${Object.keys(wilds).join(', ') || '—'})`);
  const cells = (v!.positions as unknown[]).map((p) => {
    const q = p as Partial<Pos> | null;
    if (!q || !Number.isInteger(q.reel) || !Number.isInteger(q.row) || !board[q.reel!]?.[q.row!]) fail(`position ${JSON.stringify(p)} is off the field`);
    return { reel: q!.reel!, row: q!.row! };
  });
  const reel = cells[0].reel;
  if (cells.some((q) => q.reel !== reel)) fail('positions on more than one reel');
  for (const q of cells) {
    const cell = board[q.reel][q.row];
    cell.data = { ...cell.data, mult };
  }
  return { reel, symbol, mult, cells };
}
