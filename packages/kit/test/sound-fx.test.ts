// Kit 2.1 (TRM-10): sound without the first-tap lag (the context made at boot, synthesis after the
// frame, one preset per task), volume / pitch in the table, quiet clicks under a popup; particle
// trails; the effects table with lazy textures.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Assets, Container, Texture } from 'pixi.js';

// ---- a fake zvuk engine: records what the kit asks of it ------------------------------------------
const engines: FakeEngine[] = [];
class FakeEngine {
  contexts = 0;
  unlocks = 0;
  readonly sounds = new Map<string, unknown>();
  readonly played: { name: string; volume: number; pitch: number }[] = [];
  readonly buses = { sfx: { level: 1, muted: false }, music: { level: 1, muted: false } };
  private ctx: { sampleRate: number; createBuffer: (c: number, n: number) => { getChannelData: () => Float32Array }; suspend: () => Promise<void>; close: () => Promise<void> } | null = null;
  get context() {
    if (!this.ctx) {
      this.contexts++;
      this.ctx = {
        sampleRate: 8000,
        createBuffer: (_c: number, n: number) => {
          const d = new Float32Array(n);
          return { getChannelData: () => d };
        },
        suspend: async () => {},
        close: async () => {},
      };
    }
    return this.ctx;
  }
  unlock() {
    this.unlocks++;
    return Promise.resolve();
  }
  bus(n: 'sfx' | 'music') {
    return this.buses[n];
  }
  hasSound(n: string) {
    return this.sounds.has(n);
  }
  createSound(n: string, buf: unknown) {
    this.sounds.set(n, buf);
  }
  loadSound(n: string, urls: string[]) {
    this.sounds.set(n, urls);
    return Promise.resolve();
  }
  sound(n: string) {
    return { play: (o: { volume: number; pitch: number }) => (this.played.push({ name: n, volume: o.volume, pitch: o.pitch }), { stop() {} }) };
  }
}
vi.mock('@schmooky/zvuk', () => ({ createEngine: () => (engines.push(new FakeEngine()), engines[engines.length - 1]) }));

const { Sound } = await import('../src/audio/sound.js');
const { Popups } = await import('../src/ui/popups.js');
const { Tweens } = await import('../src/anim/tweens.js');
const { ParticleSim } = await import('../src/fx/sim.js');
const { TrailSim, trailOf } = await import('../src/fx/trails.js');
const { ParticleEmitter } = await import('../src/fx/emitter.js');
const { Fx } = await import('../src/fx/fx.js');
const { particleConfig } = await import('../src/fx/types.js');
const { seededRandom } = await import('../src/qa/random.js');

beforeEach(() => {
  engines.length = 0;
  vi.stubGlobal('AudioContext', class {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A manual "after the frame": the kit's deferred work runs when the test says so. */
function later() {
  const q: (() => void)[] = [];
  return { later: (fn: () => void) => void q.push(fn), run: () => q.splice(0).forEach((f) => f()), q };
}
const tasks = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('sound: no lag on the first gesture', () => {
  it('warm() makes the context (suspended) — no unlock, nothing plays before a gesture', () => {
    const s = new Sound({ sounds: { tap: { synth: 'click' } } });
    s.warm();
    expect(engines).toHaveLength(1);
    expect(engines[0].contexts).toBe(1);
    expect(engines[0].unlocks).toBe(0);
    s.play('tap');
    expect(engines[0].played).toEqual([]);
    expect(s.log).toEqual(['tap']);
  });

  it('the gesture only resumes; synthesis waits for the frame and goes one preset per task', async () => {
    const l = later();
    const s = new Sound({ sounds: { boom: { wave: 'noise', dur: 0.05 }, coin2: 'coin.ogg' }, later: l.later });
    s.unlock();
    const e = engines[0];
    expect(e.unlocks).toBe(1);
    expect(e.sounds.size).toBe(0); // nothing synthesized in the gesture
    expect(l.q).toHaveLength(1);
    l.run();
    await new Promise((r) => setTimeout(r, 0));
    const early = e.sounds.size;
    expect(early).toBeLessThan(5); // one preset per task, not all of them at once
    await tasks();
    expect(s.ready).toBe(true);
    expect(e.sounds.has('boom')).toBe(true);
    expect(e.sounds.has('whoosh')).toBe(true);
    expect(e.sounds.get('coin2')).toEqual(['coin.ogg']);
    s.unlock(); // idempotent: no second load
    expect(l.q).toHaveLength(0);
  });

  it('a preset played before its turn is synthesized right then; table volume / pitch multiply the play options', () => {
    const l = later();
    const s = new Sound({ sounds: { found: { src: { synth: 'pop' }, volume: 0.8, pitch: 1.5 }, plain: { synth: 'hit' } }, later: l.later });
    s.unlock();
    l.run(); // the load starts: presets queued
    s.play('found', { volume: 0.5 });
    s.play('win');
    const e = engines[0];
    expect(e.played).toEqual([
      { name: 'found', volume: 0.4, pitch: 1.5 },
      { name: 'win', volume: 1, pitch: 1 },
    ]);
    expect(s.level('found')).toEqual({ volume: 0.8, pitch: 1.5 });
    expect(s.level('plain')).toEqual({ volume: 1, pitch: 1 });
    expect(() => s.play('nope')).toThrow(/not declared/);
  });

  it('pause / resume / destroy: no unlock before a gesture, nothing after destroy', () => {
    const s = new Sound({});
    s.warm();
    s.resume();
    expect(engines[0].unlocks).toBe(0);
    s.unlock();
    s.suspend();
    s.play('click');
    expect(engines[0].played).toEqual([]);
    s.resume();
    expect(engines[0].unlocks).toBe(2);
    s.destroy();
    s.unlock();
    s.warm();
    expect(engines).toHaveLength(1);
  });

  it('no Web Audio: warm / unlock do nothing', () => {
    vi.unstubAllGlobals();
    const s = new Sound({});
    s.warm();
    s.unlock();
    expect(engines).toHaveLength(0);
  });
});

describe('sound: quiet clicks', () => {
  it('a click is silent when the same event opened / closed a popup; plays otherwise; quietClicks: false — always', async () => {
    const l = later();
    const s = new Sound({ sounds: { tick: { synth: 'click' }, pop: { synth: 'pop' } }, later: l.later });
    s.unlock();
    const e = engines[0];
    s.click('tick');
    await Promise.resolve();
    expect(e.played.map((p) => p.name)).toEqual(['tick']);
    s.click('tick');
    s.popupMark(); // the action of this tap opened a popup
    s.play('pop');
    await Promise.resolve();
    expect(e.played.map((p) => p.name)).toEqual(['tick', 'pop']);
    expect(() => s.click('nope')).toThrow(/not declared/);
    const loud = new Sound({ quietClicks: false, later: l.later });
    loud.unlock();
    loud.click('click');
    loud.popupMark();
    expect(engines[1].played.map((p) => p.name)).toEqual(['click']);
  });

  it('popups: onHideSound on an animated close, not on closeNow / closeAll', async () => {
    const tweens = new Tweens();
    const pp = new Popups(tweens);
    const mk = () => {
      const root = new Container();
      return { root, h: 100, scene: { byId: new Map() } };
    };
    pp.register({ name: 'a', screen: mk() as never, layer: 'default', anim: 'none' });
    pp.register({ name: 'b', screen: mk() as never, layer: 'default', anim: 'none' });
    const log: string[] = [];
    pp.onShowSound = () => log.push('show');
    pp.onHideSound = () => log.push('hide');
    pp.show('a');
    await pp.hide('a');
    pp.show('a');
    pp.closeNow('a');
    pp.show('b');
    pp.closeAll();
    expect(log).toEqual(['show', 'hide', 'show', 'show']);
  });
});

describe('particles: trails', () => {
  const firework = () =>
    particleConfig({
      duration: 0.6, lifetime: 0.5, speed: 20, size: 0.4, max: 70, gravity: 2, unit: [50, 50], blend: 'add',
      bursts: [{ time: 0, count: 10, cycles: 1, interval: 0, prob: 1 }], shape: { type: 'sphere', radius: 0.01, thickness: 0, arc: Math.PI * 2, scale: [1, 1] },
      sizeOverLifetime: [[0, 1], [1, 0]], colorOverLifetime: { color: [[0, 1, 1, 1], [1, 1, 1, 1]], alpha: [[0, 1], [1, 0]] },
      trails: { lifetime: 1, minVertexDistance: 0.2, width: 1, color: [1, 1, 1, 1], blend: 'screen' },
    });

  it('a history per particle: thinner and fainter towards the tail; bounded by lifetime', () => {
    const c = firework();
    const rng = seededRandom(4);
    const sim = new ParticleSim(c, rng);
    const tr = new TrailSim(c, rng);
    sim.play();
    for (let i = 0; i < 12; i++) {
      sim.update(1 / 60);
      tr.update(sim.particles, 1 / 60);
    }
    const p = sim.particles[0];
    const pts = tr.points(p)!;
    expect(pts.length / 2).toBeGreaterThan(3);
    expect(pts.length / 2).toBeLessThanOrEqual(31); // life 0.5 s × lifetime 1 at 60 fps
    const segs: { width: number; alpha: number }[] = [];
    tr.segments([p], (s) => void segs.push({ width: s.width, alpha: s.alpha }));
    expect(segs.length).toBe(pts.length / 2);
    expect(segs[0].width).toBeLessThan(segs[segs.length - 1].width);
    expect(segs[0].alpha).toBeLessThan(segs[segs.length - 1].alpha);
    expect(trailOf(particleConfig({}))).toBe(null);
    expect(trailOf(c)!.ratio).toBe(1);
    expect(() => new TrailSim(particleConfig({}))).toThrow(/without trails/);
  });

  it('ratio: only that share of the particles leaves a trail; a reused particle starts a fresh one', () => {
    const c = { ...firework(), trails: { ratio: 0.3 } };
    const rng = seededRandom(9);
    const sim = new ParticleSim({ ...c, bursts: [{ time: 0, count: 60, cycles: 1, interval: 0, prob: 1 }] }, rng);
    const tr = new TrailSim(c, rng);
    sim.play();
    sim.update(1 / 60);
    tr.update(sim.particles, 1 / 60);
    const on = sim.particles.filter((p) => tr.points(p)).length;
    expect(on).toBeGreaterThan(5);
    expect(on).toBeLessThan(35);
  });

  it('the emitter strokes the trails under its particles (one Graphics, the trail blend, the unit scale)', () => {
    const e = new ParticleEmitter(firework(), Texture.WHITE, seededRandom(2));
    expect(e.trailView).toBeTruthy();
    expect(e.view.children[0]).toBe(e.trailView);
    expect(e.trailView!.blendMode).toBe('screen');
    expect(e.trailView!.scale.x).toBe(50);
    e.play();
    for (let i = 0; i < 6; i++) e.update(1 / 60);
    expect(e.trailView!.context.instructions.length).toBeGreaterThan(0);
    e.destroy();
    const plain = new ParticleEmitter(particleConfig({}), Texture.WHITE);
    expect(plain.trailView).toBe(null);
  });
});

describe('fx: the effects table, lazy textures', () => {
  it('an effect by name; its texture of the table loads at the first play, the effect starts then', async () => {
    const loaded = new Map<string, Texture>();
    vi.spyOn(Assets, 'get').mockImplementation(((url: string) => loaded.get(url)) as never);
    const load = vi.spyOn(Assets, 'load').mockImplementation((async (url: string) => {
      loaded.set(url, Texture.WHITE);
      return Texture.WHITE;
    }) as never);
    const fx = new Fx(null);
    const spark = particleConfig({ texture: 'spark_tex', duration: 0.2, lifetime: 0.3, bursts: [{ time: 0, count: 5, cycles: 1, interval: 0, prob: 1 }] });
    fx.tables({ effects: { spark: [spark, { ...spark, pos: [1, 2], unit: [10, 10] }] }, textures: { spark_tex: '/fx/spark.png' } });
    fx.tables({ textures: (n) => (n === 'other' ? '/fx/other.png' : undefined) });
    expect(fx.names()).toEqual(['spark']);
    const parent = new Container();
    const e = fx.play('spark', parent, 5, 6, { time: 1 });
    expect(e.pending).toBe(true);
    expect(e.alive).toBe(true);
    expect(e.emitters).toHaveLength(0);
    fx.update(0.5); // its time does not run while it loads
    await e.ready;
    expect(load).toHaveBeenCalledOnce();
    expect(e.emitters).toHaveLength(2);
    expect(e.emitters[1].view.position.x).toBe(1); // pos × the root's unit (1)
    expect(parent.children).toContain(e.view);
    // A second play: the texture is in — at once, no load.
    const e2 = fx.play('spark', parent);
    expect(e2.pending).toBe(false);
    expect(load).toHaveBeenCalledOnce();
    for (let i = 0; i < 60; i++) fx.update(1 / 60);
    expect(e.destroyed && e2.destroyed).toBe(true);
    // preload of the whole table; an unknown name
    await fx.preload();
    expect(() => fx.play('nope', parent)).toThrow(/unknown effect "nope".*effects: spark/);
    expect(fx.configs('burst')).toHaveLength(1);
  });

  it('stopped / destroyed while loading; a failed texture leaves the effect empty', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Assets, 'get').mockImplementation((() => undefined) as never);
    vi.spyOn(Assets, 'load').mockImplementation((async () => {
      throw new Error('404');
    }) as never);
    const fx = new Fx(null);
    fx.tables({ textures: { t: '/t.png' } });
    const c = particleConfig({ texture: 't' });
    const a = fx.attach(c, new Container());
    a.stop();
    const b = fx.play(c, new Container());
    b.destroy();
    await Promise.all([a.ready, b.ready]);
    expect(a.pending).toBe(false);
    expect(a.emitters).toHaveLength(0);
    expect(() => fx.texture('t')).toThrow(/is not loaded/);
  });
});
