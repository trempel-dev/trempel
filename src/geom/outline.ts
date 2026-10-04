// outline.ts — normalized path commands as polylines (renderer-agnostic), and what is built on them:
//
//   - flatten: every subpath → one polyline (curves and arcs subdivided, corners kept exact), with
//     its cumulative lengths — the same numbers for dashes and for hit tests;
//   - dashes (v0.9.1): stroke-dasharray / stroke-dashoffset / pathLength over a flattened outline →
//     the visible pieces, SVG 2 semantics (the pattern restarts at every subpath, a positive offset
//     shifts the pattern backwards, an odd list is repeated, an all-zero list is a solid stroke);
//   - insideOutline: point in the filled area, nonzero or evenodd.
//
// Used by the Pixi backend (dashed strokes), the core's hit test (geom/hit.ts) and the checker.

import type { PathCmd } from './pathdata.js';

/** One subpath as a polyline: points [x0, y0, x1, y1, …], cumulative length at each point. */
export interface Polyline {
  pts: number[];
  /** acc[i] — length from the start to point i (acc[0] = 0). */
  acc: number[];
  closed: boolean;
}

/** Segments for a curve of approximate length `len` (scene units): ~2 units each, 8..256. */
const steps = (len: number): number => Math.max(8, Math.min(256, Math.ceil(len / 2)));

/** SVG F.6.5: an endpoint arc → its centre parameterization, sampled into `out` (start point excluded). */
function arcPoints(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  large: number,
  sweep: number,
  x2: number,
  y2: number,
  out: number[],
): void {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if ((x1 === x2 && y1 === y2) || rx === 0 || ry === 0) {
    out.push(x2, y2);
    return;
  }
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy;
  const yp = -sin * dx + cos * dy;
  // Radii too small for the chord are scaled up (F.6.6).
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) {
    const k = Math.sqrt(lambda);
    rx *= k;
    ry *= k;
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  let coef = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * yp) / ry;
  const cyp = (-coef * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  // By length, and at least one segment per 1/128 turn — a small circle stays round (and measures right).
  const n = Math.min(256, Math.max(steps(Math.abs(dt) * Math.max(rx, ry)), Math.ceil(Math.abs(dt) / (Math.PI / 64))));
  for (let i = 1; i <= n; i++) {
    if (i === n) {
      out.push(x2, y2); // exact end point
      break;
    }
    const t = t1 + (dt * i) / n;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push(cos * ex - sin * ey + cx, sin * ex + cos * ey + cy);
  }
}

/** Every subpath of normalized commands as a polyline (a lone M — a one-point polyline, kept). */
export function flatten(cmds: PathCmd[]): Polyline[] {
  const out: Polyline[] = [];
  let pts: number[] | null = null;
  let closed = false;
  let sx = 0;
  let sy = 0;
  let cx = 0;
  let cy = 0;
  const finish = (): void => {
    if (pts && pts.length >= 2) {
      const acc = [0];
      for (let i = 2; i < pts.length; i += 2) acc.push(acc[acc.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
      out.push({ pts, acc, closed });
    }
    pts = null;
    closed = false;
  };
  const begin = (): number[] => {
    if (!pts) pts = [cx, cy];
    return pts;
  };
  for (const c of cmds) {
    switch (c[0]) {
      case 'M':
        finish();
        cx = sx = c[1];
        cy = sy = c[2];
        pts = [cx, cy];
        break;
      case 'L':
        begin().push(c[1], c[2]);
        cx = c[1];
        cy = c[2];
        break;
      case 'C': {
        const p = begin();
        const [, x1, y1, x2, y2, x, y] = c;
        const n = steps(Math.hypot(x1 - cx, y1 - cy) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x - x2, y - y2));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          p.push(
            u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
            u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
          );
        }
        cx = x;
        cy = y;
        break;
      }
      case 'Q': {
        const p = begin();
        const [, x1, y1, x, y] = c;
        const n = steps(Math.hypot(x1 - cx, y1 - cy) + Math.hypot(x - x1, y - y1));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          p.push(u * u * cx + 2 * u * t * x1 + t * t * x, u * u * cy + 2 * u * t * y1 + t * t * y);
        }
        cx = x;
        cy = y;
        break;
      }
      case 'A':
        arcPoints(cx, cy, c[1], c[2], c[3], c[4], c[5], c[6], c[7], begin());
        cx = c[6];
        cy = c[7];
        break;
      case 'Z': {
        const p = begin();
        if (p[p.length - 2] !== sx || p[p.length - 1] !== sy) p.push(sx, sy);
        closed = true;
        finish();
        cx = sx;
        cy = sy;
        break;
      }
    }
  }
  finish();
  return out;
}

/** Total length of flattened subpaths. */
export const outlineLength = (lines: Polyline[]): number => lines.reduce((s, l) => s + l.acc[l.acc.length - 1], 0);

/** A visible piece of a dashed outline; `closed` — the dash covers its whole closed subpath. */
export interface DashPiece {
  pts: number[];
  closed: boolean;
}

/** The part of a polyline between distances a ≤ b (both within [0, length]). */
function slice(l: Polyline, a: number, b: number): number[] {
  const { pts, acc } = l;
  const at = (s: number): [number, number, number] => {
    // index i of the segment [i, i+1] holding s, and the point
    let i = 0;
    while (i < acc.length - 2 && acc[i + 1] < s) i++;
    const seg = acc[i + 1] - acc[i];
    const f = seg > 0 ? (s - acc[i]) / seg : 0;
    return [i, pts[2 * i] + (pts[2 * i + 2] - pts[2 * i]) * f, pts[2 * i + 1] + (pts[2 * i + 3] - pts[2 * i + 1]) * f];
  };
  const [ia, xa, ya] = at(a);
  const [ib, xb, yb] = at(b);
  const out = [xa, ya];
  for (let i = ia + 1; i <= ib; i++) out.push(pts[2 * i], pts[2 * i + 1]);
  out.push(xb, yb);
  return out;
}

/**
 * Dashes over a flattened outline (SVG 2). `dash` — the dasharray in user units (already checked:
 * non-negative, not all zero), `offset` — stroke-dashoffset, `scale` — user units per author unit
 * (pathLength: real length / pathLength; 1 without it) applied to both.
 */
export function dashes(lines: Polyline[], dash: number[], offset: number, scale = 1): DashPiece[] {
  const pattern = (dash.length % 2 ? [...dash, ...dash] : dash).map((d) => d * scale);
  const period = pattern.reduce((s, d) => s + d, 0);
  const out: DashPiece[] = [];
  if (!(period > 0)) return out;
  for (const l of lines) {
    const len = l.acc[l.acc.length - 1];
    if (!(len > 0)) continue;
    // Where in the pattern the subpath starts: offset into the period (positive — pattern moves back).
    let phase = (offset * scale) % period;
    if (phase < 0) phase += period;
    let k = 0;
    while (phase >= pattern[k]) {
      phase -= pattern[k];
      k = (k + 1) % pattern.length;
    }
    let s = -phase;
    const pieces: [number, number][] = [];
    // Guard: a period of tiny dashes over a long path is bounded by the length / the smallest positive dash.
    for (let guard = 0; s < len && guard < 100_000; guard++) {
      const e = s + pattern[k];
      if (k % 2 === 0 && e > 0 && pattern[k] > 0) pieces.push([Math.max(0, s), Math.min(len, e)]);
      s = e;
      k = (k + 1) % pattern.length;
    }
    for (const [a, b] of pieces) {
      if (l.closed && a <= 1e-9 && b >= len - 1e-9) out.push({ pts: l.pts.slice(), closed: true });
      else if (b > a) out.push({ pts: slice(l, a, b), closed: false });
    }
  }
  return out;
}

/** Is (x, y) inside the area of the outlines (every subpath closed for filling, as SVG fills)? */
export function insideOutline(lines: Polyline[], x: number, y: number, rule: 'nonzero' | 'evenodd' = 'nonzero'): boolean {
  let winding = 0;
  let crossings = 0;
  for (const { pts } of lines) {
    const n = pts.length / 2;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const x0 = pts[2 * i];
      const y0 = pts[2 * i + 1];
      const j = (i + 1) % n;
      const x1 = pts[2 * j];
      const y1 = pts[2 * j + 1];
      if (y0 <= y ? y1 > y : y1 <= y) {
        const side = (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0);
        if (y1 > y0 ? side > 0 : side < 0) {
          crossings++;
          winding += y1 > y0 ? 1 : -1;
        }
      }
    }
  }
  return rule === 'evenodd' ? crossings % 2 === 1 : winding !== 0;
}

/** Distance from (x, y) to the polylines (their segments; a closed one includes its closing edge). */
export function distanceToOutline(lines: Polyline[], x: number, y: number): number {
  let best = Infinity;
  for (const { pts } of lines) {
    if (pts.length === 2) best = Math.min(best, Math.hypot(x - pts[0], y - pts[1]));
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i];
      const ay = pts[i + 1];
      const dx = pts[i + 2] - ax;
      const dy = pts[i + 3] - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
  }
  return best;
}
