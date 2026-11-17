// bezier.ts — a key segment as a cubic Bézier in absolute (time, value) and its Trempel ease. The
// clip ease [x1, y1, x2, y2] is the same cubic normalized to the segment's unit square:
// x = (cx − t0) / (t1 − t0), y = (cy − v0) / (v1 − v0). It does not exist when the segment does not
// change value but the curve does (an overshoot and back), or when a control point leaves the
// segment in time — such a segment is baked into linear keys (tables.ts bakeTimes).

export interface Cubic {
  cx1: number;
  cy1: number;
  cx2: number;
  cy2: number;
}

export type EaseOut = 'linear' | 'step' | [number, number, number, number];

export const cubic = (s: number, a: number, b: number, c: number, d: number): number => {
  const m = 1 - s;
  return m * m * m * a + 3 * m * m * s * b + 3 * m * s * s * c + s * s * s * d;
};

/** Value of a Bézier segment at time t (t0 ≤ t ≤ t1): solve x(s) = t, return y(s). */
export function bezierAt(t: number, t0: number, v0: number, t1: number, v1: number, c: Cubic): number {
  if (t <= t0) return v0;
  if (t >= t1) return v1;
  // x(s) is monotonic when the control points stay inside the segment; when they do not, the value
  // at t is taken at the FIRST s where the curve reaches t (scan, then bisect the bracket).
  const N = 256;
  let lo = 0;
  let hi = 1;
  for (let i = 1; i <= N; i++) {
    if (cubic(i / N, t0, c.cx1, c.cx2, t1) >= t) {
      lo = (i - 1) / N;
      hi = i / N;
      break;
    }
  }
  let s = (lo + hi) / 2;
  for (let i = 0; i < 60; i++) {
    const x = cubic(s, t0, c.cx1, c.cx2, t1);
    if (Math.abs(x - t) < 1e-10) break;
    if (x > t) hi = s;
    else lo = s;
    s = (lo + hi) / 2;
  }
  return cubic(s, v0, c.cy1, c.cy2, v1);
}

const EPS = 1e-9;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * The Trempel ease of the segment (t0, v0) → (t1, v1) shaped by `c`, or null when it has to be
 * baked (see the header). A flat segment with a flat curve, and a straight line in disguise, are
 * 'linear'. `maxY` — a normalized y beyond it (a tiny value change) is baked too.
 */
export function easeOfCubic(t0: number, v0: number, t1: number, v1: number, c: Cubic, maxY = 10): EaseOut | null {
  const span = t1 - t0;
  const dv = v1 - v0;
  if (span <= 0) return 'linear';
  const x1 = (c.cx1 - t0) / span;
  const x2 = (c.cx2 - t0) / span;
  if (x1 < -EPS || x1 > 1 + EPS || x2 < -EPS || x2 > 1 + EPS) return null;
  if (Math.abs(dv) < EPS) {
    const flat = Math.abs(c.cy1 - v0) < 1e-6 && Math.abs(c.cy2 - v0) < 1e-6;
    return flat ? 'linear' : null;
  }
  const y1 = (c.cy1 - v0) / dv;
  const y2 = (c.cy2 - v0) / dv;
  if (Math.abs(x1 - y1) < 1e-6 && Math.abs(x2 - y2) < 1e-6) return 'linear';
  if (Math.abs(y1) > maxY || Math.abs(y2) > maxY) return null;
  return [clamp01(x1), y1 + 0, clamp01(x2), y2 + 0]; // + 0: no -0 in tables
}
