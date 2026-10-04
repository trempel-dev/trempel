// easing.ts — named easing curves + arbitrary cubic-bezier.
// All easing functions map progress p in [0,1] to an eased value with e(0)=0, e(1)=1.

import type { Ease, EaseName } from './types.js';

const c1 = 1.70158;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;

export type EaseFn = (p: number) => number;

const quadIn: EaseFn = (p) => p * p;
const quadOut: EaseFn = (p) => 1 - (1 - p) * (1 - p);
const quadInOut: EaseFn = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const backOut: EaseFn = (p) => 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);

const bounceOut: EaseFn = (p) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (p < 1 / d1) return n1 * p * p;
  if (p < 2 / d1) return n1 * (p -= 1.5 / d1) * p + 0.75;
  if (p < 2.5 / d1) return n1 * (p -= 2.25 / d1) * p + 0.9375;
  return n1 * (p -= 2.625 / d1) * p + 0.984375;
};

export const NAMED: Record<EaseName, EaseFn> = {
  linear: (p) => p,
  quadIn,
  quadOut,
  quadInOut,
  cubicInOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  backOut,
  elasticOut: (p) =>
    p === 0 ? 0 : p === 1 ? 1 : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * c4) + 1,
  // v0.7 — the names of the clip tables (md clips); in/out/inOut are the quad curves.
  in: quadIn,
  out: quadOut,
  inOut: quadInOut,
  outBack: backOut,
  inBack: (p) => c3 * p * p * p - c1 * p * p,
  outBounce: bounceOut,
  /** Hold the start value for the whole segment, jump at its end key. */
  step: (p) => (p < 1 ? 0 : 1),
};

/**
 * Cubic-bezier easing with control points P1=(x1,y1), P2=(x2,y2) and fixed endpoints
 * (0,0) and (1,1). Given progress p (an x value), solves for the curve parameter t via
 * bisection, then returns the corresponding y. This is the Cocos/CSS timing-function form.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseFn {
  // B(t) for a coordinate given control values a (P1) and b (P2), endpoints 0 and 1.
  const bez = (t: number, a: number, b: number): number => {
    const mt = 1 - t;
    // 3*mt^2*t*a + 3*mt*t^2*b + t^3
    return 3 * mt * mt * t * a + 3 * mt * t * t * b + t * t * t;
  };

  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    // Solve bez(t, x1, x2) == p for t via bisection (robust, no derivative needed).
    let lo = 0;
    let hi = 1;
    let t = p;
    for (let i = 0; i < 60; i++) {
      const x = bez(t, x1, x2);
      const err = x - p;
      if (Math.abs(err) < 1e-7) break;
      if (err > 0) hi = t;
      else lo = t;
      t = (lo + hi) / 2;
    }
    return bez(t, y1, y2);
  };
}

/** Resolve an Ease (name, bezier tuple, or undefined→linear) into an easing function. */
export function resolveEase(ease?: Ease): EaseFn {
  if (!ease) return NAMED.linear;
  if (Array.isArray(ease)) return cubicBezier(ease[0], ease[1], ease[2], ease[3]);
  const fn = Object.prototype.hasOwnProperty.call(NAMED, ease) ? NAMED[ease] : undefined;
  if (!fn) throw new Error(`Trempel easing error: unknown ease "${ease}"`);
  return fn;
}
