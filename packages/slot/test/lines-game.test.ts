// A slot with lines on a 5×3 field: expanding wilds with multipliers (the plan's `expand` event, the
// line's product), the frame's marks and teased reels, reels landing one by one (`landedReels`), the
// big win level's own sequence, the idle passes a spin skips, the quickstop / skip reactions.
import { describe, expect, it } from 'vitest';
import { Director, loadChoreo, kitActions, type Tweens } from '@trempel/kit';
import { GameLoop } from '@trempel/kit/testing';
import { Tweens as KitTweens } from '@trempel/kit/internal/anim/tweens';
import { RoundPlayer, type Bindings } from '../src/player.js';
import { slotActions } from '../src/actions.js';
import { headlessReels } from '../src/view/reels.js';
import { initialSlotState } from '../src/state.js';
import { fixtureSource, type FixtureFile } from '../src/feed/source.js';
import { planRound } from '../src/feed/plan.js';
import { feed, run, step, t } from './helpers.js';

const GRID = [['A', 'B', 'C'], ['W', 'A', 'D'], ['A', 'V', 'C'], ['B', 'C', 'S'], ['S', 'D', 'B']];
const LOSE = [['A', 'B', 'C'], ['D', 'A', 'B'], ['C', 'D', 'A'], ['B', 'C', 'D'], ['D', 'A', 'B']];
const WILDS = { W: 1, V: 2 };
const reel = (r: number) => [0, 1, 2].map((row) => ({ reel: r, row }));

/** Wild ×1 on reel 2 and ×2 on reel 3 expand; the middle line of A goes through both (×2), the top one through one (×2 too). */
const EXPAND = feed('expand', [
  step('spin', 0),
  t('frameInit', GRID),
  t('frameExpandedWild', { positions: reel(1), symbol: 'W' }),
  t('frameExpandedWild', { positions: reel(2), symbol: 'V' }),
  t('paylines', [
    { lineId: '0', line: [0, 0, 0, null, null], value: 400 },
    { lineId: '3', line: [0, 1, 2, null, null], value: 400 },
  ]),
  t('win', 800),
]);

const BIG = feed('big', [step('spin', 0), t('frameInit', LOSE), t('paylines', [{ lineId: '1', line: [1, 1, null, null, null], value: 5000 }]), t('win', 5000)]);
const NONE = feed('none', [step('spin', 0), t('frameInit', LOSE)]);

const CHOREO = `# $seq spin
$skip: on
| id   | t | dur     | target | action     | sync     | skip |
|------|---|---------|--------|------------|----------|------|
| go   | 0 |         | reels  | reels:spin | parallel |      |
| hold | 0 | 300     |        | wait       | await    | now  |

# $seq land
$skip: on
| id    | each           | t                    | target | action     | value                                 | sync     | skip |
|-------|----------------|----------------------|--------|------------|---------------------------------------|----------|------|
| stop  |                | 0                    | reels  | reels:stop | grid = grid; anticipation = tease     | parallel | now  |
| tease | r in tease     | 0                    | reels  | reels:tease| reel = r                              | parallel |      |
| one   | k=0..reels-1   | poll: landedReels > k |       | run:landed | reel = k                              | parallel |      |
| done  |                | poll: landed         |        | wait       |                                       | await    |      |

# $seq landed
| id  | t | action | sync  |
|-----|---|--------|-------|
| bump| 0 | wait   | await |

# $seq expand
$skip: on
| id   | t | dur | target | action       | value                                    | sync  | skip |
|------|---|-----|--------|--------------|------------------------------------------|-------|------|
| grow | 0 | 400 | reels  | reels:expand | reel = reel; symbol = symbol; mult = mult | await | now  |

# $seq lines
$skip: on
| id   | each         | t       | target | action     | value           | sync     | skip |
|------|--------------|---------|--------|------------|-----------------|----------|------|
| one  | k=0..count-1 | 200 * k | lines  | lines:show | line = lines[k] | parallel |      |
| hold |              | 200 * count |    | wait       |                 | await    | now  |

# $seq big.mega
$skip: on
| id   | t | dur  | action | sync  | skip |
|------|---|------|--------|-------|------|
| hold | 0 | 1500 | wait   | await | now  |

# $seq big
$skip: on
| id   | t | dur | action | sync  | skip |
|------|---|-----|--------|-------|------|
| hold | 0 | 500 | wait   | await | now  |

# $seq idle
$skip: on
| id    | t   | dur  | target | action      | sync  | skip |
|-------|-----|------|--------|-------------|-------|------|
| clear | 0   |      | lines  | lines:clear | parallel | cut |
| beat  | 0   | 1000 |        | wait        | await | now  |

# $seq quickstop
| id  | t | action      | sync  |
|-----|---|-------------|-------|
| tap | 0 | sound:stop  | await |

# $seq skip
| id  | t | action      | sync  |
|-----|---|-------------|-------|
| tap | 0 | sound:click | await |
`;

const BINDINGS: Bindings = { 'step:spin': 'spin', frame: 'land', expand: 'expand', lines: 'lines', 'bigWin:mega': 'big.mega', bigWin: 'big', idle: 'idle', quickstop: 'quickstop', skip: 'skip' };

function rig(files: FixtureFile[], bindings: Bindings = BINDINGS) {
  const loop = new GameLoop();
  const tweens: Tweens = new KitTweens();
  loop.add((dt) => tweens.update(dt));
  const state = initialSlotState({ balance: 100, bets: [1], bet: 1 });
  const reels = headlessReels(loop, LOSE);
  const sounds: string[] = [];
  const director = new Director({
    choreo: loadChoreo({ 'slot.md': CHOREO }),
    loop,
    actions: { ...kitActions({ tweens, sound: { play: (c: string) => sounds.push(c) }, target: (n) => (n === 'state' ? state : undefined) }), ...slotActions(() => reels) },
    globals: {
      get landed() {
        return reels.landed;
      },
      get landedReels() {
        return reels.landedReels;
      },
    },
  });
  const player = new RoundPlayer({
    state,
    loop,
    source: fixtureSource(files, { walk: 'all' }),
    director,
    bindings,
    plan: { wilds: WILDS, bigWin: { big: 15, mega: 40 } },
    marks: ['S', 'W', 'V'],
    tease: { symbols: ['S'], count: 1 },
    onSkip: () => reels.slam(),
  });
  return { loop, state, reels, player, director, sounds };
}

const runs = (d: Director, seq: string) => d.log.filter((e) => e.seq === seq && e.row === '^').length;

describe('a slot with lines (headless)', () => {
  it('the plan: frameExpandedWild → expand events; the cells carry the multiplier, a line shows the product', () => {
    const plan = planRound(EXPAND, { wilds: WILDS });
    const ex = plan.book.filter((e) => e.type === 'expand');
    expect(ex).toEqual([
      { type: 'expand', reel: 1, symbol: 'W', mult: 1, cells: reel(1) },
      { type: 'expand', reel: 2, symbol: 'V', mult: 2, cells: reel(2) },
    ]);
    const lines = plan.book.find((e) => e.type === 'lines');
    expect(lines?.type === 'lines' && lines.lines.map((l) => [l.lineId, l.symbol, l.mult])).toEqual([
      ['0', 'A', 2],
      ['3', 'A', 2],
    ]);
    // the frame lands as the feed sent it (the wild takes the reel later, in its own event)
    expect(plan.book.find((e) => e.type === 'frame')).toMatchObject({ grid: GRID });
    // without declared wilds it is the game's own transform, as before
    expect(planRound(EXPAND).book.filter((e) => e.type === 'extra')).toHaveLength(2);
  });

  it('two ×2 wilds on a line multiply: ×4', () => {
    const g = [['A', 'B', 'C'], ['V', 'A', 'D'], ['V', 'B', 'C'], ['B', 'C', 'D'], ['D', 'A', 'B']];
    const f = feed('x4', [step('spin', 0), t('frameInit', g), t('frameExpandedWild', { positions: reel(1), symbol: 'V' }), t('frameExpandedWild', { positions: reel(2), symbol: 'V' }), t('paylines', [{ lineId: '1', line: [1, 1, 1, null, null], value: 800 }]), t('win', 800)]);
    const lines = planRound(f, { wilds: WILDS }).book.find((e) => e.type === 'lines');
    expect(lines?.type === 'lines' && lines.lines[0].mult).toBe(4);
  });

  it('a bad expansion fails loud', () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as Error).message;
      }
      return 'no error';
    };
    const bad = (value: unknown) => feed('bad', [step('spin', 0), t('frameInit', GRID), t('frameExpandedWild', value)]);
    expect(code(() => planRound(bad({ positions: reel(1), symbol: 'Q' }), { wilds: WILDS }))).toMatch(/^E_FEED: .*not a wild/);
    expect(code(() => planRound(bad({ positions: [{ reel: 1, row: 0 }, { reel: 2, row: 0 }], symbol: 'W' }), { wilds: WILDS }))).toMatch(/^E_FEED: .*more than one reel/);
    expect(code(() => planRound(bad({ positions: [{ reel: 7, row: 0 }], symbol: 'W' }), { wilds: WILDS }))).toMatch(/^E_FEED: .*off the field/);
  });

  it('the round: reels land one by one, teased reels framed, the wilds expand, the lines show their ×; marks and tease vars', async () => {
    const r = rig([EXPAND]);
    await run(r.loop, r.player.spin());
    expect(r.reels.log).toEqual(['spin normal', 'stop tease 4', 'tease 4', 'expand 1 W x1', 'expand 2 V x2', 'lines 0x2', 'lines 3x2', 'clear']); // the idle pass after the round clears the lines
    const landed = r.director.log.filter((e) => e.seq === 'landed' && e.row === '^').map((e) => e.t);
    expect(landed).toHaveLength(5);
    expect(landed).toEqual([...landed].sort((a, b) => a - b));
    expect(new Set(landed).size).toBe(5); // one by one, not all at once
    const land = r.director.log.find((e) => e.seq === 'land' && e.row === 'stop')!;
    expect(land.props.find((p) => p.name === 'anticipation')?.set).toEqual([4]);
    expect(r.state.win).toBe(8);
  });

  it('the big win level has its own sequence (bigWin:<level>), the others fall back to bigWin', async () => {
    const r = rig([BIG]);
    await run(r.loop, r.player.spin());
    expect(runs(r.director, 'big.mega')).toBe(1);
    expect(runs(r.director, 'big')).toBe(0);
  });

  it('idle passes after a round; a spin skips the pass and starts at once', async () => {
    const r = rig([NONE]);
    await run(r.loop, r.player.spin());
    expect(r.player.idling).toBe(true);
    for (let i = 0; i < 150; i++) {
      r.loop.step(1 / 60);
      await new Promise((res) => setTimeout(res, 0));
    }
    expect(runs(r.director, 'idle')).toBeGreaterThanOrEqual(2); // a pass of 1 s, repeated
    const before = r.director.now();
    const p = r.player.spin();
    await run(r.loop, p);
    const spin = r.director.log.filter((e) => e.seq === 'spin' && e.row === '^').at(-1)!;
    expect(spin.t - before).toBeLessThan(20); // within a frame, not after the rest of the idle pass
    expect(r.player.idling).toBe(true);
  });

  it('an idle sequence a spin cannot end is refused', () => {
    const r = rig([NONE]);
    expect(() => new RoundPlayer({ state: r.state, loop: r.loop, source: fixtureSource([NONE]), director: r.director, bindings: { ...BINDINGS, idle: 'landed' } })).toThrow(/^E_SLOT_BINDING: idle sequence "landed" must be \$skip: on/);
  });

  it('a skip press plays quickstop while the reels spin, skip later', async () => {
    const r = rig([EXPAND]);
    const p = r.player.spin();
    r.loop.step(1 / 60);
    await new Promise((res) => setTimeout(res, 0));
    r.player.skip();
    for (let i = 0; i < 600 && r.state.phase !== 'win'; i++) {
      r.loop.step(1 / 60);
      await new Promise((res) => setTimeout(res, 0));
    }
    r.player.skip();
    await run(r.loop, p);
    expect(r.sounds).toEqual(['stop', 'click']);
    expect(r.state.win).toBe(8);
  });
});
