// createSlot's data side: symbol looks from JSON, plan options from the config.
import { describe, expect, it } from 'vitest';
import { planOptions, symbolLooks } from '../src/create.js';
import { planRound } from '../src/feed/plan.js';
import { LINES } from './helpers.js';

describe('slot config as data', () => {
  it('symbol looks: colours as #rrggbb or numbers', () => {
    expect(symbolLooks({ A: { label: 'A', color: '#ffa300', labelColor: 0x101010 }, S: { texture: 'symbols/s.png' } })).toEqual({
      A: { label: 'A', color: 0xffa300, labelColor: 0x101010, texture: undefined },
      S: { texture: 'symbols/s.png', color: undefined, label: undefined, labelColor: undefined },
    });
  });

  it('plan options: grid, costs, big win levels, credits of a bet', () => {
    const o = planOptions({ grid: { reels: 3, rows: 3 }, bindings: { frame: 'land' }, betCredits: 10, bigWin: { nice: 5 }, costs: { fs: 50 } });
    expect(planRound(LINES, o).book.find((e) => e.type === 'bigWin')).toEqual({ type: 'bigWin', level: 'nice', amount: 200 });
    expect(() => planRound(LINES, planOptions({ grid: { reels: 5, rows: 3 }, bindings: {} }))).toThrow(/^E_FEED/);
  });
});
