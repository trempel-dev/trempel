// curve.ts — Unity animation curves: keys as Unity serializes them (time, value, in / out slope,
// weightedMode, in / out weight), Unity's own evaluation (the importer's sampler, written from the
// semantics, independent of the conversion), and the conversion of a curve into md clip keys.
//
// Unity's evaluation of a segment k0 → k1 (dt = t1 − t0):
//   - an infinite out slope of k0 or in slope of k1 — the segment is constant: v0 until t1 (a step);
//   - neither weight in use (k0 not 'out'-weighted, k1 not 'in'-weighted) — cubic Hermite with the
//     tangents m·dt;
//   - weighted — a 2D cubic Bézier (t0, v0) (t0 + w0·dt, v0 + m0·w0·dt) (t1 − w1·dt, v1 − m1·w1·dt)
//     (t1, v1), solved for the time (the unused weight is 1/3).
// The Hermite form IS that Bézier with both weights 1/3: the conversion writes every segment as the
// cubic [x1, y1, x2, y2] of clip-import's easeOfCubic — exact for Hermite, exact for weights in 0..1
// (the control points stay inside the segment in time). A constant segment is `step`; a segment with
// no Trempel ease is baked (bakeTimes). Before the first key / after the last Unity holds the ends
// (the Animator ignores the curves' wrap modes), and so does Trempel's player.

import { bakeTimes, easeOfCubic, type ColKey, type Cubic, type EaseOut } from '../clip-import/index.js';
import { list, map, num, type YamlValue } from '../fx-import/yaml.js';

export interface UKey {
  t: number;
  v: number;
  inSlope: number;
  outSlope: number;
  /** 0 none, 1 in, 2 out, 3 both. */
  weightedMode: number;
  inWeight: number;
  outWeight: number;
}

export interface UCurve {
  keys: UKey[];
  /** m_PreInfinity / m_PostInfinity as written (the Animator ignores them for clips). */
  pre: number;
  post: number;
}

/** A slope: Unity writes `Infinity` / `-Infinity` for constant tangents. */
export function slope(v: YamlValue | undefined): number {
  if (v === 'Infinity' || v === '+Infinity' || v === 'inf') return Infinity;
  if (v === '-Infinity' || v === '-inf') return -Infinity;
  return num(v);
}

const component = (v: YamlValue | undefined, c: string | null): YamlValue | undefined => (c === null ? v : map(v)[c]);

/**
 * The keys of `m_Curve` — of a float curve (`c` null) or of one component (x, y, z, w) of a vector /
 * quaternion curve (value {x, y, z}, slopes and weights per component, modes shared).
 */
export function readCurve(curve: YamlValue | undefined, c: string | null = null): UCurve {
  const body = map(curve);
  const keys: UKey[] = [];
  for (const raw of list(body.m_Curve)) {
    const k = map(raw);
    const weights = k.inWeight !== undefined;
    keys.push({
      t: num(k.time),
      v: num(component(k.value, c)),
      inSlope: slope(component(k.inSlope, c)),
      outSlope: slope(component(k.outSlope, c)),
      weightedMode: weights ? num(k.weightedMode) : 0,
      inWeight: weights ? num(component(k.inWeight, c), 1 / 3) : 1 / 3,
      outWeight: weights ? num(component(k.outWeight, c), 1 / 3) : 1 / 3,
    });
  }
  keys.sort((a, b) => a.t - b.t);
  return { keys, pre: num(body.m_PreInfinity, 2), post: num(body.m_PostInfinity, 2) };
}

/** The segment k0 → k1 holds k0's value (an infinite tangent). */
export const constantSeg = (a: UKey, b: UKey): boolean => !Number.isFinite(a.outSlope) || !Number.isFinite(b.inSlope);

/** The segment uses a weight (k0 out-weighted or k1 in-weighted). */
export const weightedSeg = (a: UKey, b: UKey): boolean => (a.weightedMode & 2) !== 0 || (b.weightedMode & 1) !== 0;

const outW = (a: UKey): number => ((a.weightedMode & 2) !== 0 ? a.outWeight : 1 / 3);
const inW = (b: UKey): number => ((b.weightedMode & 1) !== 0 ? b.inWeight : 1 / 3);

/** The segment as an absolute cubic (control points), as Unity draws it. */
export function segmentCubic(a: UKey, b: UKey): Cubic {
  const dt = b.t - a.t;
  const w0 = outW(a);
  const w1 = inW(b);
  return { cx1: a.t + w0 * dt, cy1: a.v + a.outSlope * w0 * dt, cx2: b.t - w1 * dt, cy2: b.v - b.inSlope * w1 * dt };
}

const bez = (s: number, p0: number, p1: number, p2: number, p3: number): number => {
  const m = 1 - s;
  return m * m * m * p0 + 3 * m * m * s * p1 + 3 * m * s * s * p2 + s * s * s * p3;
};

/** Unity's value of the segment a → b at t (a.t ≤ t ≤ b.t). */
export function evalSegment(a: UKey, b: UKey, t: number): number {
  if (constantSeg(a, b)) return t >= b.t ? b.v : a.v;
  const dt = b.t - a.t;
  if (dt <= 0) return b.v;
  if (!weightedSeg(a, b)) {
    // Cubic Hermite.
    const s = (t - a.t) / dt;
    const s2 = s * s;
    const s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * a.v + (s3 - 2 * s2 + s) * dt * a.outSlope + (-2 * s3 + 3 * s2) * b.v + (s3 - s2) * dt * b.inSlope;
  }
  // Weighted: solve x(s) = t by bisection over the first crossing, then y(s).
  const w0 = outW(a);
  const w1 = inW(b);
  const x1 = a.t + w0 * dt;
  const x2 = b.t - w1 * dt;
  let lo = 0;
  let hi = 1;
  const N = 128;
  for (let i = 1; i <= N; i++) {
    if (bez(i / N, a.t, x1, x2, b.t) >= t) {
      lo = (i - 1) / N;
      hi = i / N;
      break;
    }
  }
  for (let i = 0; i < 50; i++) {
    const m = (lo + hi) / 2;
    if (bez(m, a.t, x1, x2, b.t) < t) lo = m;
    else hi = m;
  }
  const s = (lo + hi) / 2;
  return bez(s, a.v, a.v + a.outSlope * w0 * dt, b.v - b.inSlope * w1 * dt, b.v);
}

/** Unity's value of a curve at t (ends held). */
export function evalCurve(c: UCurve, t: number): number {
  const k = c.keys;
  if (!k.length) return 0;
  if (t <= k[0].t) return k[0].v;
  const last = k[k.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0;
  let hi = k.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (k[m].t <= t) lo = m;
    else hi = m;
  }
  return evalSegment(k[lo], k[hi], t);
}

/** The curve does not move between t0 and t1 (outside its keys, a constant segment, or flat). */
export function constantIn(c: UCurve, t0: number, t1: number): boolean {
  const k = c.keys;
  if (k.length < 2) return true;
  const mid = (t0 + t1) / 2;
  if (mid <= k[0].t || mid >= k[k.length - 1].t) return true;
  for (let i = 0; i + 1 < k.length; i++) {
    const a = k[i];
    const b = k[i + 1];
    if (mid < a.t || mid >= b.t) continue;
    if (constantSeg(a, b)) return true;
    return a.v === b.v && a.outSlope === 0 && b.inSlope === 0;
  }
  return true;
}

/** Every key has the same value and the tangents are flat (or infinite). */
export function flatCurve(c: UCurve): boolean {
  const k = c.keys;
  return k.every((x) => x.v === k[0].v) && k.every((x, i) => i + 1 >= k.length || constantSeg(x, k[i + 1]) || (x.outSlope === 0 && k[i + 1].inSlope === 0));
}

export const sameCurve = (a: UCurve, b: UCurve): boolean =>
  a.keys.length === b.keys.length &&
  a.keys.every((k, i) => {
    const o = b.keys[i];
    return k.t === o.t && k.v === o.v && k.inSlope === o.inSlope && k.outSlope === o.outSlope && k.weightedMode === o.weightedMode && k.inWeight === o.inWeight && k.outWeight === o.outWeight;
  });

export interface CurveKeysInfo {
  keys: ColKey[];
  /** Segments baked into linear keys (no Trempel ease). */
  baked: number;
  /** Segments with a weighted tangent (converted as their cubic). */
  weighted: number;
  /** Constant segments (step). */
  steps: number;
}

export interface BakeOpts {
  /** Clip length: keys outside 0..duration are cut. */
  duration: number;
  fps: number;
  /** Bake tolerance in the column's units. */
  tol: number;
}

/**
 * The md keys of one Unity curve under an affine map of its values (v ↦ a·v + b: units, sign, the
 * rest pose): the ease of a Bézier segment does not change under such a map, so it is taken from
 * the Unity values and the key values are mapped.
 */
export function curveKeys(c: UCurve, a: number, b: number, o: BakeOpts): CurveKeysInfo {
  const m = (v: number): number => a * v + b + 0; // + 0: no -0
  const at = (t: number): number => m(evalCurve(c, t));
  const out: ColKey[] = [];
  const info: CurveKeysInfo = { keys: out, baked: 0, weighted: 0, steps: 0 };
  const k = c.keys;
  const D = o.duration;
  if (!k.length) return info;
  if (k.length === 1) {
    out.push({ t: clampT(k[0].t, D), v: m(k[0].v) });
    return info;
  }
  const push = (t: number, v: number, ease?: EaseOut): void => {
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - t) < 1e-9) {
      last.v = v;
      last.ease = ease;
      return;
    }
    out.push({ t, v, ease });
  };
  const bake = (t0: number, t1: number): void => {
    push(t0, at(t0), 'linear');
    for (const t of bakeTimes(t0, t1, at, o.fps, o.tol)) push(t, at(t), 'linear');
  };
  for (let i = 0; i + 1 < k.length; i++) {
    const s = k[i];
    const e = k[i + 1];
    if (e.t <= 0 || s.t >= D) continue;
    if (constantSeg(s, e)) {
      info.steps++;
      push(Math.max(s.t, 0), m(s.v), 'step');
      continue;
    }
    if (weightedSeg(s, e)) info.weighted++;
    if (s.t < 0 || e.t > D) {
      info.baked++;
      bake(Math.max(s.t, 0), Math.min(e.t, D));
      continue;
    }
    const ease = easeOfCubic(s.t, s.v, e.t, e.v, segmentCubic(s, e));
    if (ease === null) {
      info.baked++;
      bake(s.t, e.t);
      continue;
    }
    push(s.t, m(s.v), ease);
  }
  const last = k[k.length - 1];
  if (last.t <= D) push(Math.max(last.t, 0), m(last.v));
  else if (k[0].t < D) push(D, at(D));
  else push(clampT(k[0].t, D), m(k[0].v));
  if (out.length) out[out.length - 1].ease = undefined;
  return info;
}

const clampT = (t: number, D: number): number => Math.min(Math.max(t, 0), D);

/** Sorted distinct key times of curves inside 0..D (plus 0). */
export function breakpoints(curves: UCurve[], D: number): number[] {
  const ts = [0];
  for (const c of curves) for (const k of c.keys) if (k.t > 0 && k.t <= D) ts.push(k.t);
  if (D > 0) ts.push(D);
  ts.sort((a, b) => a - b);
  return ts.filter((t, i) => i === 0 || t - ts[i - 1] > 1e-6);
}

/**
 * Keys of a value made of several curves (`f`): between two key times of the sources the value
 * holds when every source holds (a step key), else it is baked into linear keys. Repeated held
 * values are dropped.
 */
export function bakedKeys(sources: UCurve[], f: (t: number) => number, o: BakeOpts): ColKey[] {
  const ts = breakpoints(sources, o.duration);
  const out: ColKey[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t0 = ts[i];
    const t1 = ts[i + 1];
    if (t1 === undefined) {
      out.push({ t: t0, v: f(t0) });
      break;
    }
    if (sources.every((c) => constantIn(c, t0, t1))) {
      out.push({ t: t0, v: f(t0), ease: 'step' });
      continue;
    }
    out.push({ t: t0, v: f(t0), ease: 'linear' });
    for (const t of bakeTimes(t0, t1, f, o.fps, o.tol)) out.push({ t, v: f(t), ease: 'linear' });
  }
  return dropHeld(out);
}

/** A key after a step to the same value is redundant. */
export function dropHeld(keys: ColKey[]): ColKey[] {
  const out: ColKey[] = [];
  for (const k of keys) {
    const prev = out[out.length - 1];
    if (prev && prev.ease === 'step' && prev.v === k.v) continue;
    out.push(k);
  }
  if (out.length) out[out.length - 1].ease = undefined;
  return out;
}

/**
 * An angle function (degrees, wrapped) made continuous over 0..D: unwrapped on a dense grid, any t
 * then takes the turn nearest to the grid's line through it. Stateless (bakeTimes calls out of order).
 */
export function unwrapped(angle: (t: number) => number, D: number, step = 1 / 600): (t: number) => number {
  const n = Math.max(1, Math.ceil(D / step));
  const grid: number[] = [];
  let prev = angle(0);
  grid.push(prev);
  for (let i = 1; i <= n; i++) {
    const a = near(angle((D * i) / n), prev);
    grid.push(a);
    prev = a;
  }
  return (t) => {
    if (D <= 0) return grid[0];
    const x = Math.min(Math.max(t / D, 0), 1) * n;
    const i = Math.min(n - 1, Math.floor(x));
    const ref = grid[i] + (grid[Math.min(n, i + 1)] - grid[i]) * (x - i);
    return near(angle(t), ref);
  };
}

/** `a` ± k·360 nearest to `ref`. */
export const near = (a: number, ref: number): number => a + 360 * Math.round((ref - a) / 360);
