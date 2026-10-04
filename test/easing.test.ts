import { describe, it, expect } from 'vitest';
import { NAMED, cubicBezier, resolveEase } from '../src/anim/easing';
import type { EaseName } from '../src/anim/types';

const NAMES: EaseName[] = [
  'linear',
  'quadIn',
  'quadOut',
  'quadInOut',
  'cubicInOut',
  'backOut',
  'elasticOut',
];

describe('easing — named', () => {
  it('all named curves satisfy e(0)=0 and e(1)=1', () => {
    for (const name of NAMES) {
      expect(NAMED[name](0)).toBeCloseTo(0, 6);
      expect(NAMED[name](1)).toBeCloseTo(1, 6);
    }
  });

  it('linear is the identity', () => {
    expect(NAMED.linear(0.37)).toBeCloseTo(0.37, 6);
  });

  it('quadIn(0.5) = 0.25', () => {
    expect(NAMED.quadIn(0.5)).toBeCloseTo(0.25, 6);
  });

  it('resolveEase falls back to linear for undefined', () => {
    expect(resolveEase(undefined)(0.5)).toBeCloseTo(0.5, 6);
  });

  it('resolveEase handles a bezier tuple', () => {
    const f = resolveEase([0.42, 0, 0.58, 1]);
    expect(f(0)).toBeCloseTo(0, 6);
    expect(f(1)).toBeCloseTo(1, 6);
  });
});

describe('easing — cubic-bezier', () => {
  it('is monotonic for monotonic control points and hits endpoints', () => {
    const f = cubicBezier(0.42, 0, 0.58, 1); // ease-in-out
    expect(f(0)).toBeCloseTo(0, 6);
    expect(f(1)).toBeCloseTo(1, 6);

    let prev = -Infinity;
    for (let p = 0; p <= 1.0001; p += 0.02) {
      const y = f(Math.min(p, 1));
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
  });

  it('maps value from→to with v(0)=from and v(1)=to', () => {
    const f = cubicBezier(0.25, 0.1, 0.25, 1);
    const from = 10;
    const to = 30;
    const value = (p: number) => from + (to - from) * f(p);
    expect(value(0)).toBeCloseTo(from, 6);
    expect(value(1)).toBeCloseTo(to, 6);
    expect(value(0.5)).toBeGreaterThan(from);
    expect(value(0.5)).toBeLessThan(to);
  });

  it('a linear bezier matches the identity', () => {
    const f = cubicBezier(0, 0, 1, 1);
    expect(f(0.3)).toBeCloseTo(0.3, 3);
    expect(f(0.7)).toBeCloseTo(0.7, 3);
  });
});
