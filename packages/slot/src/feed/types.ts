// types.ts — the round feed (docs/feed.md): a flat list of typed facts `{ type, value, context? }` the
// client plays. Steps are opened by the `step` marker; frames are `frame[reel][row]`, rows top-down.
// Money in the feed is CREDITS: one bet = `betCredits` credits (a parameter of the game, 100 by default).
//
// The core below is what the kit reads and validates. A game's own transforms (cell multipliers, tags,
// collectors…) and the flags of its step markers are not core: the plan passes them through to the
// game (`extra` book events, `StepInfo.flags`) — see PlanOptions.extend.

export interface Pos {
  reel: number;
  row: number;
}

/** frame[reel][row], rows top-down; a symbol is one letter of the game's table. */
export type Frame = string[][];

/** The step marker's value: `kind` (a closed list of the game), `n` — the step number from 0; flags of the game. */
export interface StepMarker {
  kind: string;
  n: number;
  [flag: string]: unknown;
}

export interface DiffCell {
  position: Pos;
  symbol: string;
}

/** Cascade atom: removal (old), fall (old + new), drop-in (new), in-place change (old + new, same position). */
export interface DiffAtom {
  old?: DiffCell;
  new?: DiffCell;
}

/** A pay-anywhere / cluster / scatter win. `value` in credits; 0 — a highlight (trigger, retrigger). */
export interface Hit {
  positions: Pos[];
  symbol: string;
  multiplier: number;
  value: number;
}

/** A line win: `line[reel]` — the row of the winning cell on that reel, null where the line does not pay. */
export interface Payline {
  lineId: string;
  line: (number | null)[];
  value: number;
}

export type CoreTransform =
  | { type: 'step'; value: StepMarker; context?: string }
  | { type: 'spinsLeft'; value: number; context?: string }
  | { type: 'frameInit'; value: Frame; context?: string }
  | { type: 'frameInitDiff'; value: { diff: DiffAtom[]; snapshot: Frame }; context?: string }
  | { type: 'frameHits'; value: Hit[]; context?: string }
  | { type: 'paylines'; value: Payline[]; context?: string }
  | { type: 'win'; value: number; context?: string }
  | { type: 'multipliersInit'; value: number[]; context?: string }
  | { type: 'maxWin'; value: number; context?: string }
  | { type: 'switchToMode'; value: string; context?: string }
  | { type: 'roundFinished'; value: number; context?: string };

export type CoreType = CoreTransform['type'];

/** A transform of the game's own: the kit does not read it, the plan hands it to the game. */
export interface ExtraTransform {
  type: string;
  value?: unknown;
  context?: string;
}

/** A transform on the wire: a core one or the game's own. */
export type Transform = CoreTransform | ExtraTransform;

export const CORE_TYPES: readonly CoreType[] = ['step', 'spinsLeft', 'frameInit', 'frameInitDiff', 'frameHits', 'paylines', 'win', 'multipliersInit', 'maxWin', 'switchToMode', 'roundFinished'];

const CORE = new Set<string>(CORE_TYPES);

/** A core transform (narrowed), or null for the game's own. */
export function coreOf(t: Transform): CoreTransform | null {
  return CORE.has(t.type) ? (t as CoreTransform) : null;
}

/** Credits of one bet unless the game says otherwise. */
export const DEFAULT_BET_CREDITS = 100;

/** One round's feed as a RoundSource hands it over. */
export interface RoundFeed {
  /** Source label (fixture name, round id). */
  name: string;
  /** Bought feature of the round (a key of PlanOptions.costs), null — a normal spin. */
  buy: string | null;
  transforms: Transform[];
}
