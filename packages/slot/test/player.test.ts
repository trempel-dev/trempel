// The round player on headless reels: the book → bound sequences on the Director, the state around them
// (phases, money, free-spin counters, big win), hooks for the game's own events, skip, loud bindings.
import { describe, expect, it } from 'vitest';
import { Director, loadChoreo, kitActions, type Tweens } from '@trempel/kit';
import { GameLoop } from '@trempel/kit/testing';
import { Tweens as KitTweens } from '@trempel/kit/internal/anim/tweens';
import { RoundPlayer, type Bindings, type Hook } from '../src/player.js';
import { slotActions } from '../src/actions.js';
import { headlessReels } from '../src/view/reels.js';
import { initialSlotState, type SlotState } from '../src/state.js';
import { fixtureSource, type FixtureFile } from '../src/feed/source.js';
import { BINDINGS, CHOREO, FREE, LINES, LOSE, LOSE_GRID, feed, run, step, t } from './helpers.js';

function rig(files: FixtureFile[], o: { bindings?: Bindings; hooks?: Record<string, Hook>; state?: Partial<SlotState>; costs?: Record<string, number> } = {}) {
  const loop = new GameLoop();
  const tweens: Tweens = new KitTweens();
  loop.add((dt) => tweens.update(dt));
  const state = initialSlotState({ balance: 100, bets: [1, 2, 5], bet: 2, ...o.state });
  const reels = headlessReels(loop, LOSE_GRID);
  const phases: string[] = [];
  loop.add(() => phases[phases.length - 1] !== state.phase && phases.push(state.phase), 'ui');
  const director = new Director({
    choreo: loadChoreo({ 'slot.md': CHOREO }),
    loop,
    actions: { ...kitActions({ tweens, target: (n) => (n === 'state' ? state : undefined) }), ...slotActions(() => reels) },
    globals: {
      get landed() {
        return reels.landed;
      },
    },
  });
  const player = new RoundPlayer({ state, loop, source: fixtureSource(files, { walk: 'all' }), director, bindings: o.bindings ?? BINDINGS, hooks: o.hooks, plan: { costs: { spin: 1, ...o.costs } }, onSkip: () => reels.slam() });
  /** Phases seen on frames, and the one after the last frame. */
  const seen = () => (phases[phases.length - 1] === state.phase ? [...phases] : [...phases, state.phase]);
  return { loop, state, reels, player, phases: seen, director };
}

describe('round player (headless)', () => {
  it('a losing spin: spin → land → idle; the bet charged; the reels show the feed', async () => {
    const r = rig([LOSE]);
    await run(r.loop, r.player.spin());
    expect(r.state).toMatchObject({ balance: 98, win: 0, busy: false, phase: 'idle', round: 'lose' });
    expect(r.reels.grid()).toEqual(LOSE_GRID);
    expect(r.reels.log).toEqual(['spin normal', 'stop']);
    expect(r.phases()).toEqual(['idle', 'spin', 'stop', 'idle']);
    expect(r.player.unhandled).toEqual(['roundEnd']);
  });

  it('a line win: lines drawn one by one, the win counts up, the balance credited', async () => {
    const r = rig([LINES]);
    await run(r.loop, r.player.spin());
    expect(r.reels.log).toContain('lines 0');
    expect(r.state.win).toBe(4); // 200 credits = 2 bets × 2
    expect(r.state.balance).toBe(100 - 2 + 4);
    expect(r.phases()).toEqual(['idle', 'spin', 'stop', 'win', 'idle']);
    const counted = r.director.log.filter((e) => e.seq === 'count' && e.row === 'win');
    expect(counted[0].props).toEqual([{ name: 'win', from: 0, to: 4 }]);
  });

  it('free spins: intro, the counter with a retrigger, outro, big win; the money of the round', async () => {
    const r = rig([FREE]);
    const seen: number[] = [];
    r.loop.add(() => r.state.fsTotal && !seen.includes(r.state.fsTotal) && seen.push(r.state.fsTotal), 'ui');
    await run(r.loop, r.player.spin());
    expect(r.phases()).toEqual(['idle', 'spin', 'stop', 'fsIntro', 'spin', 'stop', 'spin', 'stop', 'win', 'spin', 'stop', 'win', 'fsOutro', 'bigwin', 'idle']);
    expect(seen).toEqual([2, 3]);
    expect(r.state).toMatchObject({ win: 36, balance: 100 - 2 + 36, fsTotal: 0, fsIndex: 0, bigWin: 36, bigWinTier: '', mode: '' });
    expect(r.player.unhandled).toEqual(['hits', 'spinsLeft', 'hits', 'spinsLeft', 'spinsLeft', 'roundEnd']);
  });

  it('skip lands the reels and cuts the presentation short; the outcome is the same', async () => {
    const a = rig([FREE]);
    const full = await run(a.loop, a.player.spin());
    const b = rig([FREE]);
    const p = b.player.spin();
    for (let i = 0; i < 400 && b.state.phase !== 'fsOutro'; i++) {
      b.loop.step(1 / 60);
      await new Promise((r) => setTimeout(r, 0));
      if (i % 20 === 0) b.player.spinOrStop(); // busy → skip
    }
    const fast = await run(b.loop, p);
    expect(b.reels.log).toContain('slam');
    expect(fast + 400 / 60).toBeLessThan(full);
    expect(b.state.balance).toBe(a.state.balance);
  });

  it('turbo plays the turbo constants', async () => {
    const a = rig([LINES]);
    const normal = await run(a.loop, a.player.spin());
    const b = rig([LINES]);
    b.player.toggleTurbo();
    const turbo = await run(b.loop, b.player.spin());
    expect(turbo).toBeLessThan(normal / 2);
    expect(b.reels.log[0]).toBe('spin turbo');
  });

  it("hooks play the game's own events and steps; flags reach them", async () => {
    const f = feed('flags', [step('spin', 0, undefined, { slow: true }), t('frameInit', LOSE_GRID), t('frameStickers', [{ x: 1 }])]);
    const log: string[] = [];
    const r = rig([f], {
      hooks: {
        'step:spin': async (_e, api) => {
          log.push(`step slow=${api.vars.slow}`);
          await api.run('spin');
        },
        frameStickers: (e) => void log.push(`stickers ${JSON.stringify(e.type === 'extra' ? e.transform.value : null)}`),
      },
    });
    await run(r.loop, r.player.spin());
    expect(log).toEqual(['step slow=true', 'stickers [{"x":1}]']);
    expect(r.player.unhandled).toEqual(['roundEnd']);
  });

  it('autoplay, bet steppers, no spin without balance', async () => {
    const r = rig([LOSE], { state: { balance: 7, bets: [1, 2, 5], bet: 2 } });
    r.player.betUp();
    expect(r.state.bet).toBe(5);
    r.player.betDown();
    r.player.betDown();
    r.player.betDown();
    expect(r.state.bet).toBe(1);
    r.player.autoplay(3);
    await run(r.loop, new Promise<void>((done) => r.loop.add(() => !r.state.busy && r.state.auto === 0 && done())));
    expect(r.state.balance).toBe(4);
    r.state.balance = 0.5;
    await r.player.spin();
    expect(r.state.balance).toBe(0.5);
  });

  it('bindings are checked: unknown sequences, an unbound frame or cascade', async () => {
    expect(() => rig([LOSE], { bindings: { ...BINDINGS, lines: 'nope' } })).toThrow(/^E_SLOT_BINDING/);
    const { frame: _f, ...noFrame } = BINDINGS;
    expect(() => rig([LOSE], { bindings: noFrame })).toThrow(/^E_SLOT_BINDING/);
    const casc = feed('c', [
      step('spin', 0),
      t('frameInit', [['A', 'B', 'C'], ['A', 'B', 'C'], ['A', 'B', 'C']]),
      t('win', 100),
      step('cascade', 1),
      t('frameInitDiff', { diff: [{ old: { position: { reel: 0, row: 0 }, symbol: 'A' } }, { new: { position: { reel: 0, row: 0 }, symbol: 'D' } }], snapshot: [['D', 'B', 'C'], ['A', 'B', 'C'], ['A', 'B', 'C']] }),
    ]);
    const r = rig([casc]);
    await expect(run(r.loop, r.player.spin())).rejects.toThrow(/^E_SLOT_BINDING/);
    expect(r.state.busy).toBe(false);
    expect(r.state.balance).toBe(98);
  });

  it('a broken feed fails before the money moves', async () => {
    const r = rig([feed('broken', [step('spin', 3), t('frameInit', LOSE_GRID)])]);
    await expect(run(r.loop, r.player.spin())).rejects.toThrow(/^E_FEED/);
    expect(r.state).toMatchObject({ balance: 100, busy: false, phase: 'idle' });
  });
});
