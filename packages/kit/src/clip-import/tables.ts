// tables.ts — writing md clips (scene format §9) from imported key lists: numbers for tables, one
// column per property, columns of a target grouped into tables when their key times and eases agree
// (an ease belongs to a row), equal times nudged apart, held values (tex, visibility) as step keys,
// segments without a Trempel ease baked into linear keys.

import type { EaseOut } from './bezier.js';

export interface ColKey {
  t: number;
  v: number | string;
  ease?: EaseOut;
}

export interface Column {
  col: string;
  keys: ColKey[];
}

/** Number for SVG / tables: `digits` decimals, no trailing zeros, no -0. */
export function fmt(n: number, digits = 4): string {
  const r = Number(n.toFixed(digits));
  return Object.is(r, -0) || r === 0 ? '0' : String(r);
}

export const easeCell = (e: EaseOut | undefined): string =>
  e === undefined || e === 'linear' ? '' : e === 'step' ? 'step' : `[${e.map((v) => fmt(v, 5)).join(', ')}]`;

/** A valid clip / node id from a foreign name. */
export function idify(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_.-]+/g, '_');
  if (!/^[A-Za-z_]/.test(s)) s = `_${s}`;
  return s;
}

/** Unique ids from foreign names (`name`, `name_2`, …). */
export class Ids {
  private used = new Set<string>();
  take(want: string): string {
    let id = idify(want);
    if (this.used.has(id)) {
      let n = 2;
      while (this.used.has(`${id}_${n}`)) n++;
      id = `${id}_${n}`;
    }
    this.used.add(id);
    return id;
  }
  has(id: string): boolean {
    return this.used.has(id);
  }
}

/**
 * Inner times of a baked segment t0 → t1 of `at(t)`: every 1/fps s, then halved where the straight
 * line between two samples misses the curve by more than `tol` (steep spots), down to 2 ms.
 */
export function bakeTimes(t0: number, t1: number, at: (t: number) => number, fps: number, tol: number): number[] {
  const grid = [t0];
  for (let t = t0 + 1 / fps; t < t1 - 1e-6; t += 1 / fps) grid.push(t);
  grid.push(t1);
  const out: number[] = [];
  const refine = (a: number, b: number, depth: number): void => {
    const va = at(a);
    const vb = at(b);
    let worst = 0;
    for (const f of [0.25, 0.5, 0.75]) {
      const t = a + (b - a) * f;
      worst = Math.max(worst, Math.abs(at(t) - (va + (vb - va) * f)));
    }
    if (worst > tol && b - a > 0.002 && depth < 12) {
      const m = (a + b) / 2;
      refine(a, m, depth + 1);
      out.push(m);
      refine(m, b, depth + 1);
    }
  };
  for (let i = 0; i + 1 < grid.length; i++) {
    refine(grid[i], grid[i + 1], 0);
    if (i + 2 < grid.length) out.push(grid[i + 1]);
  }
  return out;
}

/** Equal key times would break "ascending t": a repeat is nudged by 0.1 ms and the jump made a step. Returns the number nudged. */
export function strictTimes(keys: ColKey[]): number {
  let nudged = 0;
  for (let i = 1; i < keys.length; i++) {
    if (keys[i].t <= keys[i - 1].t + 1e-6) {
      keys[i - 1].ease = 'step';
      keys[i].t = keys[i - 1].t + 0.0001;
      nudged++;
    }
  }
  return nudged;
}

/** Hold-value keys (visibility, tex): a key per change, the first kept; numbers step. */
export function heldKeys<T extends number | string>(points: { t: number; v: T }[]): ColKey[] {
  const out: ColKey[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.v === p.v) continue;
    if (last && Math.abs(last.t - p.t) < 1e-9) {
      last.v = p.v;
      continue;
    }
    out.push({ t: p.t, v: p.v, ease: typeof p.v === 'number' ? 'step' : undefined });
  }
  return out;
}

const sameTimes = (a: ColKey[], b: ColKey[]): boolean => a.length === b.length && a.every((k, i) => Math.abs(k.t - b[i].t) < 1e-9);
const sameEases = (a: ColKey[], b: ColKey[]): boolean => a.every((k, i) => easeCell(k.ease) === easeCell(b[i].ease));

/** Columns whose ease the table row does not carry (always step / held). */
const EASELESS = new Set(['tex', 'view', 'z']);

/** Digits of a column's numbers in a table. */
const digitsOf = (col: string): number => (col.startsWith('scale') ? 6 : col === 'alpha' ? 5 : 4);

/** Columns of one target → `## $track` tables (a column joins a table when times and eases agree). */
export function trackTables(target: string, cols: Column[]): string[] {
  const groups: Column[][] = [];
  for (const c of cols) {
    if (!c.keys.length) continue;
    const g = groups.find((g) => {
      if (!sameTimes(g[0].keys, c.keys) || g.some((x) => x.col === c.col)) return false;
      const eased = g.filter((x) => !EASELESS.has(x.col));
      if (EASELESS.has(c.col) || !eased.length) return true;
      return eased.every((x) => sameEases(x.keys, c.keys));
    });
    if (g) g.push(c);
    else groups.push([c]);
  }
  return groups.map((g) => {
    const eased = g.find((c) => !EASELESS.has(c.col));
    const head = ['t', ...g.map((c) => c.col), ...(eased ? ['ease'] : [])];
    const rows = g[0].keys.map((k, i) => [
      fmt(k.t, 5),
      ...g.map((c) => {
        const v = c.keys[i].v;
        return typeof v === 'number' ? fmt(v, digitsOf(c.col)) : String(v);
      }),
      ...(eased ? [easeCell(eased.keys[i].ease)] : []),
    ]);
    const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
    return [`## $track ${target}`, line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
  });
}

/** `## $events` table (sorted by time). */
export function eventsTable(events: { t: number; name: string }[]): string {
  const rows = [...events].sort((a, b) => a.t - b.t).map((e) => `| ${fmt(e.t, 5)} | ${e.name} |`);
  return ['## $events', '| t | event |', '| --- | --- |', ...rows].join('\n');
}

/** `#rrggbb` of 0..1 channels. */
export function hexColor(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
