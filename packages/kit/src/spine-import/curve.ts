// curve.ts — Spine key interpolation (the reference math of the verification) and a key segment's
// Trempel ease. A Spine Bézier segment is the cubic from (t0, v0) to (t1, v1) through absolute
// control points; the clip ease is the same cubic normalized (clip-import/bezier.ts).

import { bezierAt, easeOfCubic, type EaseOut } from '../clip-import/bezier.js';
import type { Key } from './spine.js';

/** Value of a timeline at time t; undefined before the first key (Spine shows the setup pose there). */
export function valueAt(keys: Key[], t: number): number | undefined {
  if (!keys.length || t < keys[0].t) return undefined;
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  if (!b) return a.v;
  return segmentAt(a, b, t);
}

/** Value inside the segment a → b (a.curve shapes it). */
export function segmentAt(a: Key, b: Key, t: number): number {
  const c = a.curve;
  if (c.kind === 'stepped') return t >= b.t ? b.v : a.v;
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  if (c.kind === 'linear') return a.v + ((b.v - a.v) * (t - a.t)) / span;
  return bezierAt(t, a.t, a.v, b.t, b.v, c);
}

/** The Trempel ease of the segment a → b, or null when it has to be baked. */
export function easeOf(a: Key, b: Key): EaseOut | null {
  const c = a.curve;
  if (c.kind === 'linear') return 'linear';
  if (c.kind === 'stepped') return 'step';
  return easeOfCubic(a.t, a.v, b.t, b.v, c);
}
