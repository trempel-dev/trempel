// board.ts — the field as the feed describes it: a letter per cell plus the game's own data riding on
// the cell (a multiplier value, a tag — set by the game's transform handlers, PlanOptions.extend).
// Cascades apply atom by atom (feed order, no overwrite); a moving symbol keeps its data, an in-place
// change to another symbol drops it; the result must equal the feed's snapshot — any mismatch throws.

import type { DiffAtom, Frame, Pos } from './types.js';

export interface BoardCell {
  sym: string;
  /** The game's data of the cell (moves with the symbol). */
  data?: Record<string, unknown>;
}

/** board[reel][row]. */
export type Board = BoardCell[][];

/** A cell of a reel (`cell` = row). */
export interface ReelCell {
  reel: number;
  cell: number;
}

/** Reel ops of one cascade (gravity convention: new on top, survivors keep order). */
export interface CascadeOps {
  /** In-place symbol changes (applied at rest, before the removal). View ids. */
  swaps: { reel: number; cell: number; id: string }[];
  /** Removed cells. */
  winners: ReelCell[];
  /** View grid after the refill, grid[reel][row]. */
  grid: string[][];
}

/** The reel symbol id of a cell (default: its letter); a game whose cells carry data names them itself. */
export type ViewId = (cell: BoardCell) => string;

export const letterId: ViewId = (c) => c.sym;

export const at = (p: Pos): string => `${p.reel}:${p.row}`;

export function boardOf(frame: Frame): Board {
  return frame.map((col) => col.map((sym) => ({ sym })));
}

export const lettersOf = (b: Board): Frame => b.map((col) => col.map((c) => c.sym));

export const viewOf = (b: Board, id: ViewId = letterId): string[][] => b.map((col) => col.map(id));

export function sameFrame(a: Frame, b: Frame): boolean {
  return a.length === b.length && a.every((col, r) => col.length === b[r].length && col.every((s, w) => s === b[r][w]));
}

export function frameDiff(got: Frame, want: Frame): string {
  const out: string[] = [];
  want.forEach((col, r) => col.forEach((s, w) => got[r]?.[w] !== s && out.push(`[${r}][${w}] ${got[r]?.[w] ?? '∅'} ≠ ${s}`)));
  if (got.length !== want.length) out.push(`reels ${got.length} ≠ ${want.length}`);
  return out.join(', ');
}

const sameData = (a: BoardCell, b: BoardCell): boolean => JSON.stringify(a.data ?? null) === JSON.stringify(b.data ?? null);

/**
 * Apply a cascade: atoms in feed order; returns the board after it. Throws when an atom does not
 * match the field, a cell would be overwritten, or a cell stays empty.
 */
export function applyDiff(before: Board, diff: DiffAtom[]): Board {
  const b: (BoardCell | null)[][] = before.map((col) => col.map((c) => ({ ...c })));
  const cell = (p: Pos): BoardCell | null => {
    if (!b[p.reel] || p.row < 0 || p.row >= b[p.reel].length) throw new Error(`E_FEED_BOARD: position ${at(p)} is off the field`);
    return b[p.reel][p.row];
  };
  const take = (p: Pos, sym: string): BoardCell => {
    const c = cell(p);
    if (!c) throw new Error(`E_FEED_BOARD: ${at(p)} is empty, the atom expects ${sym}`);
    if (c.sym !== sym) throw new Error(`E_FEED_BOARD: ${at(p)} holds ${c.sym}, the atom expects ${sym}`);
    b[p.reel][p.row] = null;
    return c;
  };
  const put = (p: Pos, c: BoardCell): void => {
    const cur = cell(p);
    if (cur) throw new Error(`E_FEED_BOARD: ${at(p)} would be overwritten (${cur.sym} by ${c.sym})`);
    b[p.reel][p.row] = c;
  };
  for (const a of diff) {
    if (a.old && a.new) {
      const c = take(a.old.position, a.old.symbol);
      put(a.new.position, a.new.symbol === c.sym ? c : { sym: a.new.symbol });
    } else if (a.old) take(a.old.position, a.old.symbol);
    else if (a.new) put(a.new.position, { sym: a.new.symbol });
    else throw new Error('E_FEED_BOARD: an atom without old and new');
  }
  return b.map((col, r) =>
    col.map((c, w) => {
      if (!c) throw new Error(`E_FEED_BOARD: ${r}:${w} is empty after the diff`);
      return c;
    }),
  );
}

/**
 * The cascade as reel ops (removal + gravity refill). In-place changes become swaps; the rest must
 * follow gravity — per reel, removed count = new-on-top count, survivors keep their order — otherwise
 * the reels cannot show it and we throw.
 */
export function cascadeOps(before: Board, diff: DiffAtom[], after: Board, id: ViewId = letterId): CascadeOps {
  const swaps: CascadeOps['swaps'] = [];
  const winners: ReelCell[] = [];
  const pre = before.map((col) => col.map((c) => ({ ...c })));
  for (const a of diff) {
    if (a.old && a.new && at(a.old.position) === at(a.new.position) && a.old.symbol !== a.new.symbol) {
      const { reel, row } = a.new.position;
      pre[reel][row] = { ...after[reel][row] };
      swaps.push({ reel, cell: row, id: id(after[reel][row]) });
    } else if (a.old && !a.new) winners.push({ reel: a.old.position.reel, cell: a.old.position.row });
  }
  pre.forEach((col, r) => {
    const removed = new Set(winners.filter((c) => c.reel === r).map((c) => c.cell));
    const survivors = col.filter((_, w) => !removed.has(w));
    const got = after[r].slice(removed.size);
    const ok = survivors.every((s, i) => s.sym === got[i].sym && sameData(s, got[i]));
    if (!ok) throw new Error(`E_FEED_BOARD: reel ${r} does not follow gravity (survivors ${survivors.map((s) => s.sym).join('')} → ${got.map((s) => s.sym).join('')})`);
  });
  return { swaps, winners, grid: viewOf(after, id) };
}
