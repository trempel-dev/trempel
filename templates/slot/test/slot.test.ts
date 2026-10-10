// The template's data holds together: every fixture plans under slot.json, every letter has a look in
// every skin, every binding names a sequence of the choreography — and every fixture plays to the end
// headless through the template's own choreography with the money of its feed.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Director, kitActions, loadChoreo, type Fx } from '@trempel/kit';
import { GameLoop } from '@trempel/kit/testing';
import { Tweens } from '@trempel/kit/internal/anim/tweens';
import { RoundPlayer, fixtureSource, headlessReels, initialSlotState, planOptions, planRound, slotActions, symbolLooks, type FixtureFile, type SlotConfig } from '@trempel/slot';

const here = (p: string) => new URL(`../${p}`, import.meta.url);
const read = (p: string) => readFileSync(here(p), 'utf8');
const config = JSON.parse(read('slot.json')) as SlotConfig & { skin: string };
const choreo = loadChoreo({ 'choreo/slot.md': read('choreo/slot.md') });
const fixtures: FixtureFile[] = readdirSync(here('fixtures')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(read(`fixtures/${f}`)));
const skins = readdirSync(here('skins'));
const letters = new Set<string>();
for (const f of fixtures) for (const t of f.transforms) if (t.type === 'frameInit') for (const col of t.value as string[][]) col.forEach((s) => letters.add(s));

describe('slot template data', () => {
  it('fixtures: every one plans under the config; the hand totals are the feed totals', () => {
    expect(fixtures.map((f) => f.name)).toEqual(['01-lose', '02-line', '03-lines', '04-big', '05-free', '06-buy']);
    for (const f of fixtures) {
      const plan = planRound({ name: f.name, buy: f.buy ?? null, transforms: f.transforms }, planOptions(config));
      expect(plan.roundFinished, f.name).toBe(plan.total);
    }
  });

  it('skins: default and fruity-spin; every letter of the feeds, the reels and the strip has a look', () => {
    expect(skins.sort()).toEqual(['default', 'fruity-spin']);
    for (const s of [...(config.initial ?? []).flat(), ...Object.keys(config.weights ?? {})]) letters.add(s);
    for (const skin of skins) {
      const looks = symbolLooks(JSON.parse(read(`skins/${skin}/symbols.json`)));
      for (const l of letters) expect(looks[l], `${skin}: ${l}`).toBeDefined();
      for (const look of Object.values(looks)) if (look.texture) expect(() => readFileSync(here(`skins/${skin}/${look.texture}`)), look.texture).not.toThrow();
    }
  });

  it('bindings name sequences of the choreography', () => {
    for (const [key, seq] of Object.entries(config.bindings)) expect(choreo.sequences[seq], `${key} → ${seq}`).toBeDefined();
  });

  it.each(fixtures.map((f) => [f.name, f] as const))('%s plays headless through the choreography to its money', async (_n, f) => {
    const loop = new GameLoop();
    const tweens = new Tweens();
    loop.add((dt) => tweens.update(dt));
    const state = initialSlotState({ balance: 1000, bets: config.bets, bet: 2 });
    const reels = headlessReels(loop, config.initial!);
    const sounds: string[] = [];
    const director = new Director({
      choreo,
      loop,
      actions: { ...kitActions({ tweens, fx: {} as Fx, sound: { play: (c: string) => sounds.push(c) }, target: (n) => (n === 'state' ? state : undefined) }), ...slotActions(() => reels) },
      globals: {
        get landed() {
          return reels.landed;
        },
      },
    });
    const player = new RoundPlayer({ state, loop, source: fixtureSource([f], { walk: 'all' }), director, bindings: config.bindings, plan: planOptions(config) });
    let done = false;
    let err: unknown;
    player.spin(f.buy ?? null).then(() => (done = true), (e) => ((done = true), (err = e)));
    while (!done && loop.time < 120) {
      loop.step(1 / 60);
      await new Promise((r) => setTimeout(r, 0));
    }
    if (err) throw err;
    expect(done).toBe(true);
    const plan = player.plan!;
    const cost = f.buy ? config.costs![f.buy] : 1;
    expect(state.win).toBe((plan.total * 2) / 100);
    expect(state.balance).toBeCloseTo(1000 - 2 * cost + state.win, 6);
    const lastFrame = [...plan.book].reverse().find((e) => e.type === 'frame') as { grid: string[][] };
    expect(reels.grid()).toEqual(lastFrame.grid);
    expect(player.unhandled.filter((k) => k !== 'roundEnd' && k !== 'multTotal')).toEqual([]);
    expect(sounds).toContain('rise');
  });
});
