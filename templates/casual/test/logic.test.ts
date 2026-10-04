import { describe, expect, it } from 'vitest';
import { GOAL, TIME, hit, newRound, stars, tick } from '../src/logic';

describe('rules', () => {
  it('GOAL taps win', () => {
    let r = newRound();
    for (let i = 0; i < GOAL; i++) r = hit(r);
    expect(r).toMatchObject({ score: GOAL, over: true, won: true });
  });
  it('time out loses; no taps after the end', () => {
    let r = tick(newRound(), 100);
    expect(r).toMatchObject({ over: true, won: false, time: 0 });
    r = hit(r);
    expect(r.score).toBe(0);
  });
  it('stars: 0 on a loss, 3 for a fast win, 1 for a last-second one', () => {
    expect(stars(tick(newRound(), 100))).toBe(0);
    const win = (time: number) => ({ ...newRound(), score: GOAL, over: true, won: true, time });
    expect(stars(win(TIME))).toBe(3);
    expect(stars(win(1))).toBe(1);
  });
});
