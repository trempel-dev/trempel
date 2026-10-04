import { describe, it, expect } from 'vitest';
import { reactive, effect, evalExpression } from '../src/reactive';

describe('reactive', () => {
  it('re-runs an effect when a tracked property mutates', () => {
    const state = reactive({ balance: 1000 });
    const seen: number[] = [];
    effect(() => seen.push(state.balance));
    expect(seen).toEqual([1000]);
    state.balance = 950;
    expect(seen).toEqual([1000, 950]);
  });

  it('does not re-run when the value is unchanged', () => {
    const state = reactive({ x: 1 });
    let runs = 0;
    effect(() => {
      void state.x;
      runs++;
    });
    expect(runs).toBe(1);
    state.x = 1;
    expect(runs).toBe(1);
  });

  it('tracks nested (deep) objects', () => {
    const state = reactive({ pos: { x: 0 } });
    const seen: number[] = [];
    effect(() => seen.push(state.pos.x));
    state.pos.x = 5;
    expect(seen).toEqual([0, 5]);
  });

  it('evaluates bare expressions against a context', () => {
    expect(evalExpression('state.balance', { state: { balance: 42 } })).toBe(42);
    expect(evalExpression('state.win > 0', { state: { win: 3 } })).toBe(true);
    expect(evalExpression('a + b', { a: 2, b: 3 })).toBe(5);
  });

  it('returns undefined for a broken expression instead of throwing', () => {
    expect(evalExpression('state.', { state: {} })).toBeUndefined();
  });
});
