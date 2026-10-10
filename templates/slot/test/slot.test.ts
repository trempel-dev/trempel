// The template's data holds together: every fixture plans under its config (3×3 slot.json, 5×3
// slot.5x3.json), every letter has a look in every skin that plays it, every binding names a sequence,
// every cue is a sound — and every fixture plays to the end headless through the template's own
// choreography with the money of its feed, the sequences of a slot with lines all played between them.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Director, kitActions, loadChoreo, type Fx } from '@trempel/kit';
import { GameLoop } from '@trempel/kit/testing';
import { Tweens } from '@trempel/kit/internal/anim/tweens';
import { SYNTH_PRESETS } from '@trempel/kit/internal/audio/synth';
import { RoundPlayer, fixtureSource, headlessReels, initialSlotState, planOptions, planRound, slotActions, symbolLooks, type FixtureFile, type SlotConfig } from '@trempel/slot';

const here = (p: string) => new URL(`../${p}`, import.meta.url);
const read = (p: string) => readFileSync(here(p), 'utf8');
type Config = SlotConfig & { skin: string };
const VARIANTS = {
  '3x3': { config: JSON.parse(read('slot.json')) as Config, dir: 'fixtures', skins: ['default', 'fruity-spin'] },
  '5x3': { config: JSON.parse(read('slot.5x3.json')) as Config, dir: 'fixtures/5x3', skins: ['default'] },
};
const files = readdirSync(here('choreo')).filter((f) => f.endsWith('.md') && f !== 'README.md');
const md = Object.fromEntries(files.map((f) => [`choreo/${f}`, read(`choreo/${f}`)]));
const choreo = loadChoreo(md);
const sounds = JSON.parse(read('sounds.json')) as Record<string, unknown>;
const fixturesOf = (dir: string): FixtureFile[] =>
  readdirSync(here(dir))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(read(`${dir}/${f}`)));

/** The sequences a slot with lines plays (TRM-17), besides the free spins'. */
const GENRE = ['spin.start', 'spin.stop', 'reel.stop', 'anticipation', 'wild.expand', 'lines.show', 'lines.cycle', 'win.count', 'bigwin.big', 'bigwin.mega', 'bigwin.epic', 'scatter.hit', 'idle', 'quickstop', 'skip'];
const CHARACTER = ['character.idle', 'character.react.win', 'character.react.wild', 'character.react.bigwin', 'character.react.scatter'];

const pose = () => ({ scale: { x: 1, y: 1 }, rotation: 0 });

/** A headless rig of the template: its config, its choreography; `character` — the skin has the figure. */
function rig(config: Config, f: FixtureFile, character: boolean) {
  const loop = new GameLoop();
  const tweens = new Tweens();
  loop.add((dt) => tweens.update(dt));
  const state = initialSlotState({ balance: 1000, bets: config.bets, bet: 2 });
  const reels = headlessReels(loop, config.initial!);
  const played: string[] = [];
  const nodes: Record<string, object> = character ? { character: pose(), characterBody: pose() } : {};
  const director = new Director({
    choreo,
    loop,
    actions: {
      ...kitActions({ tweens, fx: { burst: () => {} } as unknown as Fx, sound: { play: (c: string) => played.push(c) }, target: (n) => (n === 'state' ? state : nodes[n]) }),
      ...slotActions(() => reels),
      // effects at winFx: a node of every skin (the scene test mounts them); here they only log
      fx: () => {},
    },
    globals: {
      get landed() {
        return reels.landed;
      },
      get landedReels() {
        return reels.landedReels;
      },
      nodes: [...Object.keys(nodes), 'winFx', 'reels', 'lines'],
    },
  });
  const player = new RoundPlayer({ state, loop, source: fixtureSource([f], { walk: 'all' }), director, bindings: config.bindings, plan: planOptions(config), marks: config.marks, tease: config.tease, onSkip: () => reels.slam() });
  return { loop, state, reels, director, player, played, nodes };
}

async function settle(loop: GameLoop, p: Promise<unknown>, extra = 0): Promise<void> {
  let done = false;
  let err: unknown;
  p.then(() => (done = true), (e) => ((done = true), (err = e)));
  while (!done && loop.time < 180) {
    loop.step(1 / 60);
    await new Promise((r) => setTimeout(r, 0));
  }
  if (err) throw err;
  expect(done).toBe(true);
  for (let i = 0; i < extra * 60; i++) {
    loop.step(1 / 60);
    await new Promise((r) => setTimeout(r, 0));
  }
}

const seqsOf = (d: Director) => new Set(d.log.filter((e) => e.row === '^').map((e) => e.seq));

describe('slot template data', () => {
  it('fixtures: every one plans under its config; the hand totals are the feed totals', () => {
    expect(fixturesOf('fixtures').map((f) => f.name)).toEqual(['01-lose', '02-line', '03-lines', '04-big', '05-free', '06-buy', '07-wild', '08-wild-x4', '09-mega', '10-epic', '11-tease']);
    expect(fixturesOf('fixtures/5x3').map((f) => f.name)).toEqual(['01-lose', '02-wild', '03-wild-x2', '04-wild-x4', '05-scatter', '06-big']);
    for (const { config, dir } of Object.values(VARIANTS)) {
      for (const f of fixturesOf(dir)) {
        const plan = planRound({ name: f.name, buy: f.buy ?? null, transforms: f.transforms }, planOptions(config));
        expect(plan.roundFinished, f.name).toBe(plan.total);
      }
    }
  });

  it('skins: default and fruity-spin; every letter of the feeds, the reels and the strip has a look in the skins of its grid', () => {
    expect(readdirSync(here('skins')).sort()).toEqual(['default', 'fruity-spin']);
    for (const { config, dir, skins } of Object.values(VARIANTS)) {
      const letters = new Set<string>([...(config.initial ?? []).flat(), ...Object.keys(config.weights ?? {}), ...Object.keys(config.wilds ?? {})]);
      for (const f of fixturesOf(dir)) for (const t of f.transforms) if (t.type === 'frameInit') for (const col of t.value as string[][]) col.forEach((s) => letters.add(s));
      for (const skin of skins) {
        const looks = symbolLooks(JSON.parse(read(`skins/${skin}/symbols.json`)));
        for (const l of letters) expect(looks[l], `${skin}: ${l}`).toBeDefined();
        for (const look of Object.values(looks)) if (look.texture) expect(() => readFileSync(here(`skins/${skin}/${look.texture}`)), look.texture).not.toThrow();
      }
    }
  });

  it('the choreography: the genre sequences and the character hooks exist; bindings name sequences; every cue is a sound', () => {
    for (const s of [...GENRE, ...CHARACTER, 'fs.intro', 'fs.next', 'fs.outro']) expect(choreo.sequences[s], s).toBeDefined();
    for (const { config } of Object.values(VARIANTS)) for (const [key, seq] of Object.entries(config.bindings)) expect(choreo.sequences[seq], `${key} → ${seq}`).toBeDefined();
    const cues = new Set<string>();
    for (const s of Object.values(choreo.sequences)) for (const r of s.rows) if (r.action.startsWith('sound:')) cues.add(r.action.slice(6));
    for (const c of cues) expect(c in sounds || c in SYNTH_PRESETS, `sound:${c}`).toBe(true);
    for (const s of Object.values(sounds)) {
      const synth = (s as { synth?: string }).synth;
      if (synth) expect(synth in SYNTH_PRESETS, synth).toBe(true);
    }
    // the character only behind `has(nodes, 'character')`
    for (const s of Object.values(choreo.sequences)) {
      for (const r of s.rows) if (/^run:character\./.test(r.action)) expect(r.when, `${s.id}:${r.id}`).toBe("has(nodes, 'character')");
    }
  });

  for (const [variant, { config, dir }] of Object.entries(VARIANTS)) {
    it.each(fixturesOf(dir).map((f) => [f.name, f] as const))(`${variant} %s plays headless through the choreography to its money`, async (_n, f) => {
      const r = rig(config, f, true);
      await settle(r.loop, r.player.spin(f.buy ?? null));
      const plan = r.player.plan!;
      const cost = f.buy ? config.costs![f.buy] : 1;
      expect(r.state.win).toBe((plan.total * 2) / 100);
      expect(r.state.balance).toBeCloseTo(1000 - 2 * cost + r.state.win, 6);
      const lastFrame = [...plan.book].reverse().find((e) => e.type === 'frame') as { grid: string[][] };
      expect(r.reels.grid()).toEqual(lastFrame.grid);
      expect(r.player.unhandled.filter((k) => k !== 'roundEnd' && k !== 'multTotal')).toEqual([]);
      expect(r.played).toContain('spin');
      expect(r.played.filter((c) => c === 'land')).toHaveLength(plan.spins.length * config.grid.reels);
      // the character back at rest after the round
      expect(r.nodes.character).toEqual(pose());
    });
  }

  it('between the fixtures every sequence of a slot with lines plays; the lines show ×4; reels land one by one', async () => {
    const seen = new Set<string>();
    const logs: string[] = [];
    for (const { config, dir } of Object.values(VARIANTS)) {
      for (const f of fixturesOf(dir)) {
        const r = rig(config, f, true);
        const p = r.player.spin(f.buy ?? null);
        if (f.name === '04-big' && dir === 'fixtures') {
          // a press while the reels spin (quickstop), another one in the wins (skip)
          for (let i = 0; i < 20; i++) {
            r.loop.step(1 / 60);
            await new Promise((res) => setTimeout(res, 0));
          }
          expect(r.state.phase).toBe('spin');
          r.player.skip();
          for (let i = 0; i < 600 && r.state.phase !== 'win' && r.state.phase !== 'bigwin'; i++) {
            r.loop.step(1 / 60);
            await new Promise((res) => setTimeout(res, 0));
          }
          r.player.skip();
        }
        await settle(r.loop, p, 3); // and a bit of idle after it
        for (const s of seqsOf(r.director)) seen.add(s);
        logs.push(...r.reels.log);
      }
    }
    for (const s of [...GENRE, ...CHARACTER]) expect(seen.has(s), s).toBe(true);
    expect(logs).toContain('lines 0x4');
    expect(logs).toContain('expand 1 V x2');
  }, 60_000);

  it('a skin without the character: the hooks are skipped silently, the round the same', async () => {
    const f = fixturesOf('fixtures').find((x) => x.name === '07-wild')!;
    const r = rig(VARIANTS['3x3'].config, f, false);
    await settle(r.loop, r.player.spin(), 5);
    const seqs = seqsOf(r.director);
    for (const c of CHARACTER) expect(seqs.has(c), c).toBe(false);
    expect(seqs.has('wild.expand')).toBe(true);
    expect(r.state.win).toBe(4);
  });

  it('reels land one by one in normal, a teased reel later; the anticipation plays on the teased reel', async () => {
    const f = fixturesOf('fixtures').find((x) => x.name === '11-tease')!;
    const r = rig(VARIANTS['3x3'].config, f, true);
    await settle(r.loop, r.player.spin());
    const lands = r.director.log.filter((e) => e.seq === 'reel.stop' && e.row === '^').map((e) => e.t);
    expect(lands).toHaveLength(3);
    expect(new Set(lands).size).toBe(3);
    expect(r.director.log.filter((e) => e.seq === 'spin.stop' && e.row === 'tease').map((e) => e.vars.r)).toEqual([2]);
    expect(r.director.log.filter((e) => e.seq === 'anticipation' && e.row === 'frame').map((e) => e.props)).toEqual([[{ name: 'reel', set: 2 }]]);
    expect(r.reels.log).toContain('stop tease 2');
  });
});
