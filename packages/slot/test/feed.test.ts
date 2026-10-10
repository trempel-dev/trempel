// The round feed: the plan's book, money and modes on synthetic feeds; the game's own transforms
// passing through; loud errors with codes.
import { describe, expect, it } from 'vitest';
import { planRound, bigWinLevel } from '../src/feed/plan.js';
import { applyDiff, boardOf, cascadeOps } from '../src/feed/board.js';
import { FREE, LINES, LOSE, LINE_GRID, LOSE_GRID, feed, step, t } from './helpers.js';

const types = (f: Parameters<typeof planRound>[0], o?: Parameters<typeof planRound>[1]) => planRound(f, o).book.map((e) => e.type);
const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return (e as Error).message.split(':')[0];
  }
  return 'no error';
};

describe('plan', () => {
  it('a losing spin: step, frame, round end; cost 1', () => {
    const p = planRound(LOSE);
    expect(p.book.map((e) => e.type)).toEqual(['step', 'frame', 'roundEnd']);
    expect(p).toMatchObject({ cost: 1, total: 0, capped: false, steps: 1, betCredits: 100 });
    expect(p.book[1]).toMatchObject({ type: 'frame', grid: LOSE_GRID, kind: 'spin' });
  });

  it('a line win: the paying cells and the symbol from the frame; credits summed', () => {
    const p = planRound(LINES);
    expect(types(LINES)).toEqual(['step', 'frame', 'lines', 'stepWin', 'roundEnd']);
    const lines = p.book.find((e) => e.type === 'lines');
    expect(lines).toMatchObject({ lines: [{ lineId: '0', symbol: 'A', value: 200, cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }] }] });
    expect(p.total).toBe(200);
    expect(p.spins).toEqual([{ n: 0, kind: 'spin', mode: undefined, base: 200, total: 200, multiplied: false }]);
  });

  it('free spins: trigger highlight, intro count, counter with a retrigger, outro total, big win level', () => {
    const p = planRound(FREE);
    expect(p.book.filter((e) => e.type === 'hits').map((e) => (e as { trigger: boolean }).trigger)).toEqual([true, true]);
    expect(p.book.find((e) => e.type === 'fsStart')).toEqual({ type: 'fsStart', mode: 'freeSpins', count: 2 });
    expect(p.book.filter((e) => e.type === 'spinsLeft')).toEqual([
      { type: 'spinsLeft', left: 2, index: 1, total: 2, added: 0 },
      { type: 'spinsLeft', left: 2, index: 2, total: 3, added: 1 },
      { type: 'spinsLeft', left: 1, index: 3, total: 3, added: 0 },
    ]);
    expect(p.episodes).toEqual([{ mode: 'freeSpins', total: 1800, spins: 3 }]);
    expect(p.book.slice(-3)).toEqual([{ type: 'fsEnd', mode: 'freeSpins', total: 1800 }, { type: 'bigWin', level: 'big', amount: 1800 }, { type: 'roundEnd', total: 1800 }]);
    expect(p.roundFinished).toBe(1800);
  });

  it('a multiplied spin total and the cap', () => {
    const mult = feed('mult', [step('spin', 0), t('frameInit', LINE_GRID), t('paylines', [{ lineId: '0', line: [0, 0, 0], value: 100 }]), t('win', 100), t('multipliersInit', [3]), t('win', 300)]);
    const p = planRound(mult);
    expect(p.total).toBe(300);
    expect(p.spins[0]).toMatchObject({ base: 100, total: 300, multiplied: true });
    const cap = feed('cap', [step('spin', 0), t('frameInit', LINE_GRID), t('paylines', [{ lineId: '0', line: [0, 0, 0], value: 100 }]), t('win', 100), t('maxWin', 500000)]);
    const c = planRound(cap);
    expect(c).toMatchObject({ total: 500000, capped: true });
    expect(c.book.slice(-2)).toEqual([{ type: 'bigWin', level: 'max', amount: 500000 }, { type: 'roundEnd', total: 500000 }]);
  });

  it('a buy round costs its price; the first step must be the buy step', () => {
    const buy = feed('buy', [step('buy', 0), t('frameInit', LOSE_GRID)], 'fs');
    expect(planRound(buy, { costs: { fs: 50 } }).cost).toBe(50);
    expect(code(() => planRound(buy))).toBe('E_FEED');
    expect(code(() => planRound({ ...buy, buy: null }, { costs: { fs: 50 } }))).toBe('E_FEED');
  });

  it('a cascade: atoms, gravity, the snapshot checked', () => {
    const after = [['D', 'B', 'C'], ['D', 'E', 'D'], ['E', 'C', 'D']];
    const casc = feed('cascade', [
      step('spin', 0),
      t('frameInit', LINE_GRID),
      t('paylines', [{ lineId: '0', line: [0, 0, 0], value: 100 }]),
      t('win', 100),
      step('cascade', 1),
      t('frameInitDiff', {
        diff: [
          { old: { position: { reel: 0, row: 0 }, symbol: 'A' } },
          { new: { position: { reel: 0, row: 0 }, symbol: 'D' } },
          { old: { position: { reel: 1, row: 0 }, symbol: 'A' } },
          { new: { position: { reel: 1, row: 0 }, symbol: 'D' } },
          { old: { position: { reel: 2, row: 0 }, symbol: 'A' } },
          { new: { position: { reel: 2, row: 0 }, symbol: 'E' } },
        ],
        snapshot: after,
      }),
    ]);
    const p = planRound(casc);
    const c = p.book.find((e) => e.type === 'cascade');
    expect(c).toMatchObject({ type: 'cascade', snapshot: after, ops: { grid: after, winners: [{ reel: 0, cell: 0 }, { reel: 1, cell: 0 }, { reel: 2, cell: 0 }], swaps: [] } });
    expect(p.snapshots).toEqual([after]);
    expect(p.spins).toHaveLength(1);
    const bad = structuredClone(casc);
    (bad.transforms[5].value as { snapshot: string[][] }).snapshot[0][0] = 'A';
    expect(code(() => planRound(bad))).toBe('E_FEED');
  });

  it("the game's own transforms and step flags pass through; a handler puts data on cells that rides the cascade", () => {
    const f = feed('extra', [
      step('spin', 0, undefined, { slow: true }),
      t('frameInit', LOSE_GRID),
      t('frameStickers', [{ position: { reel: 0, row: 2 }, sticker: 'gold' }]),
    ]);
    const seen: string[] = [];
    const p = planRound(f, {
      extend: {
        frameStickers: (tr, ctx) => {
          for (const s of tr.value as { position: { reel: number; row: number }; sticker: string }[]) {
            ctx.board![s.position.reel][s.position.row].data = { sticker: s.sticker };
            seen.push(`${s.position.reel}:${s.position.row}`);
          }
        },
      },
      viewId: (c) => (c.data ? `${c.sym}*` : c.sym),
    });
    expect(seen).toEqual(['0:2']);
    expect(p.stepInfos[0].flags).toEqual({ slow: true });
    expect(p.book.find((e) => e.type === 'extra')).toMatchObject({ type: 'extra', transform: { type: 'frameStickers' } });
    expect((p.book.find((e) => e.type === 'frame') as { grid: string[][] }).grid[0]).toEqual(['A', 'B', 'C*']);
    // without a handler: passed through as is
    expect(planRound(f).book.map((e) => e.type)).toEqual(['step', 'frame', 'extra', 'roundEnd']);
    // board data moves with its symbol
    const b = boardOf([['A', 'B', 'C']]);
    b[0][2].data = { sticker: 'gold' };
    const diff = [{ old: { position: { reel: 0, row: 0 }, symbol: 'A' } }, { old: { position: { reel: 0, row: 1 }, symbol: 'B' }, new: { position: { reel: 0, row: 1 }, symbol: 'B' } }, { new: { position: { reel: 0, row: 0 }, symbol: 'E' } }];
    const after = applyDiff(b, diff);
    expect(after[0][2].data).toEqual({ sticker: 'gold' });
    expect(cascadeOps(b, diff, after).winners).toEqual([{ reel: 0, cell: 0 }]);
  });

  it('fails loud on the core', () => {
    expect(code(() => planRound(feed('x', [t('frameInit', LOSE_GRID)])))).toBe('E_FEED');
    expect(code(() => planRound(feed('x', [step('spin', 1), t('frameInit', LOSE_GRID)])))).toBe('E_FEED');
    expect(code(() => planRound(feed('x', [step('wobble', 0), t('frameInit', LOSE_GRID)])))).toBe('E_FEED');
    expect(code(() => planRound(feed('x', [step('spin', 0)])))).toBe('E_FEED');
    expect(code(() => planRound(feed('x', [step('spin', 0), t('frameInit', LOSE_GRID), t('win', 0)])))).toBe('E_FEED');
    expect(code(() => planRound(feed('x', [step('spin', 0), t('frameInit', LOSE_GRID), t('paylines', [{ lineId: '1', line: [0, 0], value: 5 }])])))).toBe('E_FEED');
    expect(code(() => planRound(feed('x', [step('spin', 0), t('frameInit', LOSE_GRID)]), { grid: { reels: 5, rows: 3 } }))).toBe('E_FEED');
    expect(code(() => planRound(feed('x', [step('spin', 0), t('frameInit', LOSE_GRID), t('switchToMode', 'freeSpins')])))).toBe('E_FEED');
    expect(code(() => planRound(feed('x', [step('freeSpin', 0, 'freeSpins'), t('frameInit', LOSE_GRID, 'freeSpins')])))).toBe('E_FEED');
    expect(code(() => planRound({ ...FREE, transforms: FREE.transforms.slice(0, -1).concat(t('roundFinished', 1)) }))).toBe('E_FEED');
    expect(code(() => planRound(FREE, { modes: ['bonus'] }))).toBe('E_FEED');
    expect(code(() => planRound(feed('x', [step('spin', 0), t('frameInit', LOSE_GRID), t('frameStickers', [])]), { extend: { frameStickers: (_t, c) => c.fail('no stickers') } }))).toBe('E_FEED');
  });

  it('big win levels are data', () => {
    expect(bigWinLevel(14)).toBe(null);
    expect(bigWinLevel(15)).toBe('big');
    expect(bigWinLevel(100)).toBe('epic');
    expect(bigWinLevel(30, { nice: 10, great: 25 })).toBe('great');
    expect(planRound(LINES, { bigWin: { nice: 2 } }).book.find((e) => e.type === 'bigWin')).toEqual({ type: 'bigWin', level: 'nice', amount: 200 });
    expect(planRound(LINES, { betCredits: 10 }).book.find((e) => e.type === 'bigWin')).toEqual({ type: 'bigWin', level: 'big', amount: 200 });
  });
});
