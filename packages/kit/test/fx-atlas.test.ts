// 2.5: particle frames from an atlas — the atlas data (a prefix, natural order, trim / sourceSize,
// rotated, through Pixi's own Spritesheet too), the frame of a particle by its age (animate: a cycle, a
// ping-pong, a random start — fixed by the seed), the random mode, sheet + atlas → E_FX_CONFIG, the
// emitter sizing frames by their original picture, the table's atlas found by the effects player.

import { describe, expect, it, vi } from 'vitest';
import { Container, Spritesheet, Texture, TextureSource } from 'pixi.js';
import { atlasFrameAt, atlasFrameNames, atlasPrefixes, naturalCompare, parseAtlas } from '../src/fx/atlas.js';
import { ParticleEmitter } from '../src/fx/emitter.js';
import { Fx } from '../src/fx/fx.js';
import { PARTICLES } from '../src/fx/presets.js';
import { ParticleSim } from '../src/fx/sim.js';
import { particleConfig, type ParticleConfig } from '../src/fx/types.js';
import { seededRandom } from '../src/qa/random.js';

/** A TexturePacker hash atlas: 12 frames `coin_1.png … coin_12.png` (64 × 64, the narrow ones trimmed), one rotated, two of another prefix. */
function atlasData(): { frames: Record<string, unknown>; meta: Record<string, unknown> } {
  const frames: Record<string, unknown> = {};
  for (let i = 1; i <= 12; i++) {
    const w = i % 2 ? 64 : 24; // the even ones trimmed to 24 × 64
    frames[`coin_${i}.png`] = {
      frame: { x: (i - 1) * 64, y: 0, w, h: 64 },
      rotated: false,
      trimmed: w < 64,
      spriteSourceSize: { x: (64 - w) / 2, y: 0, w, h: 64 },
      sourceSize: { w: 64, h: 64 },
    };
  }
  // stored turned: the picture is 40 × 20 upright, 20 × 40 of the image
  frames['spark_1.png'] = { frame: { x: 0, y: 64, w: 40, h: 20 }, rotated: true, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: 40, h: 20 }, sourceSize: { w: 40, h: 20 } };
  frames['spark_2.png'] = { frame: { x: 20, y: 64, w: 40, h: 20 }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: 40, h: 20 }, sourceSize: { w: 40, h: 20 } };
  return { frames, meta: { image: 'coin.png', size: { w: 768, h: 128 }, scale: '1' } };
}

async function sheet(): Promise<Spritesheet> {
  const s = new Spritesheet(new Texture({ source: new TextureSource({ width: 768, height: 128 }) }), atlasData() as never);
  await s.parse();
  return s;
}

const coins = (over: Partial<ParticleConfig> = {}): ParticleConfig =>
  particleConfig({ duration: 1, rate: 30, max: 50, lifetime: 2, speed: 0, atlas: { texture: 'coin', prefix: 'coin_' }, ...over });

describe('atlas data', () => {
  it('natural order, the prefix filter, the prefixes with counts', () => {
    const names = Object.keys(atlasData().frames);
    expect(atlasFrameNames(names, 'coin_').slice(0, 4)).toEqual(['coin_1.png', 'coin_2.png', 'coin_3.png', 'coin_4.png']);
    expect(atlasFrameNames(names, 'coin_').at(-1)).toBe('coin_12.png');
    expect(atlasFrameNames(names, 'spark')).toEqual(['spark_1.png', 'spark_2.png']);
    expect(atlasFrameNames(names)).toHaveLength(14);
    expect(naturalCompare('coin_2', 'coin_10')).toBeLessThan(0);
    expect(atlasPrefixes(names)).toEqual([{ prefix: 'coin_', count: 12 }, { prefix: 'spark_', count: 2 }]);
  });

  it('trim / sourceSize and rotated as the atlas has them', () => {
    const f = parseAtlas(atlasData(), 'coin_');
    expect(f).toHaveLength(12);
    expect(f[1]).toMatchObject({ name: 'coin_2.png', trimmed: true, trim: { x: 20, y: 0, w: 24, h: 64 }, source: { w: 64, h: 64 } });
    expect(f[0]).toMatchObject({ trimmed: false, trim: { x: 0, y: 0, w: 64, h: 64 } });
    const [s1] = parseAtlas(atlasData(), 'spark_');
    expect(s1).toMatchObject({ rotated: true, frame: { w: 40, h: 20 }, source: { w: 40, h: 20 } });
    expect(() => parseAtlas({ frames: [] })).toThrow(/^E_FX_ATLAS:/);
  });

  it('Pixi\'s Spritesheet of the same atlas: trimmed frames keep the original box, a rotated one turns', async () => {
    const s = await sheet();
    const t2 = s.textures['coin_2.png'];
    expect([t2.orig.width, t2.orig.height]).toEqual([64, 64]);
    expect([t2.trim!.x, t2.trim!.width]).toEqual([20, 24]);
    const sp = s.textures['spark_1.png'];
    expect(sp.rotate).not.toBe(0);
    expect([sp.orig.width, sp.orig.height]).toEqual([40, 20]);
  });
});

describe('the frame of a particle', () => {
  it('animate: fps frames a second from the start frame, a cycle or a ping-pong', () => {
    expect([0, 1, 2, 3, 4, 5].map((k) => atlasFrameAt(k / 10, 4, 10, 0, false))).toEqual([0, 1, 2, 3, 0, 1]);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((k) => atlasFrameAt(k / 10, 4, 10, 0, true))).toEqual([0, 1, 2, 3, 2, 1, 0, 1]);
    expect(atlasFrameAt(0, 4, 10, 2, false)).toBe(2);
    expect(atlasFrameAt(0, 1, 10, 0, true)).toBe(0);
  });

  it('the sim: frames change with age at fps; a random start puts the particles out of phase (the same with the seed)', () => {
    const run = (cfg: ParticleConfig) => {
      const sim = new ParticleSim(cfg, seededRandom(5));
      sim.frames = 12;
      sim.play();
      sim.update(0.2);
      const at0 = sim.particles.map((p) => p.frame);
      sim.update(1 / 24);
      return { at0, at1: sim.particles.map((p) => p.frame) };
    };
    const a = run(coins());
    expect(new Set(a.at0).size).toBeGreaterThan(2); // out of phase
    expect(a.at1.slice(0, a.at0.length)).toEqual(a.at0.map((f) => (f + 1) % 12)); // one frame on at 24 fps
    expect(run(coins())).toEqual(a); // the seed
    // no random start: the frame is the particle's age only
    const still = new ParticleSim(coins({ atlas: { texture: 'coin', randomStart: false, fps: 10 } }), seededRandom(5));
    still.frames = 12;
    still.play();
    still.update(0.75);
    expect(still.particles.length).toBeGreaterThan(5);
    for (const q of still.particles) expect(q.frame).toBe(Math.floor(q.age * 10 + 1e-6) % 12);
    const ping = new ParticleSim(coins({ atlas: { texture: 'coin', pingpong: true, randomStart: false, fps: 12 } }), seededRandom(1));
    ping.frames = 3;
    ping.play();
    ping.emit(1);
    const p = ping.particles[0];
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      seen.push(p.frame);
      ping.update(1 / 12);
    }
    expect(seen.slice(0, 6)).toEqual([0, 1, 2, 1, 0, 1]);
  });

  it('random: a random frame per particle, still over its life', () => {
    const sim = new ParticleSim(coins({ atlas: { texture: 'coin', mode: 'random' } }), seededRandom(9));
    sim.frames = 12;
    sim.play();
    sim.update(0.5);
    const f0 = sim.particles.map((p) => p.frame);
    expect(new Set(f0).size).toBeGreaterThan(3);
    sim.update(0.5);
    expect(sim.particles.slice(0, f0.length).map((p) => p.frame)).toEqual(f0);
  });

  it('a config without an atlas draws as before; sheet + atlas → E_FX_CONFIG', () => {
    const plain = particleConfig({ duration: 1, rate: 30, speed: [10, 20] });
    const a = new ParticleSim(plain, seededRandom(3));
    const b = new ParticleSim({ ...plain }, seededRandom(3));
    a.play();
    b.play();
    a.update(0.5);
    b.update(0.5);
    expect(a.particles.map((p) => [p.x, p.y, p.frame])).toEqual(b.particles.map((p) => [p.x, p.y, p.frame]));
    const both = coins({ sheet: { tilesX: 2, tilesY: 2, frameOverTime: [[0, 0], [1, 1]], mul: 1, cycles: 1 } });
    expect(() => new ParticleSim(both)).toThrow(/^E_FX_CONFIG:/);
  });
});

describe('the emitter and the player with an atlas', () => {
  it('the emitter: the frames of the atlas, sized by the original picture (trimmed frames do not jump)', async () => {
    const s = await sheet();
    const frames = atlasFrameNames(Object.keys(s.textures), 'coin_').map((n) => s.textures[n]);
    const e = new ParticleEmitter(coins({ size: 32, max: 400, rate: 200 }), frames[0], seededRandom(2), frames);
    e.play();
    e.update(0.3);
    expect(e.sim.frames).toBe(12);
    const parts = (e.view.children[0] as unknown as { particleChildren: { texture: Texture; scaleX: number; scaleY: number }[] }).particleChildren;
    expect(parts.length).toBeGreaterThan(10);
    const textures = new Set(parts.map((p) => p.texture.label));
    expect(textures.size).toBeGreaterThan(3);
    // every frame — full or trimmed — at the same scale: 32 px over the 64 px original
    for (const p of parts) expect([p.scaleX, p.scaleY]).toEqual([0.5, 0.5]);
    const loose = new ParticleEmitter(coins({ size: 32, atlas: { texture: 'coin', keepAspect: false } }), frames[0], seededRandom(2), frames);
    loose.play();
    loose.update(0.2);
    for (const p of (loose.view.children[0] as unknown as { particleChildren: { scaleX: number }[] }).particleChildren) expect(p.scaleX).toBe(0.5);
  });

  it('the player takes the table\'s Spritesheet; without one the preset plays its texture (a warning once)', async () => {
    const s = await sheet();
    const fx = new Fx(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parent = new Container();
    const bare = fx.play('coinFountain', parent);
    expect(bare.emitters[0].sim.frames).toBe(1);
    fx.play('coinBurst', parent);
    fx.play('coinBurst', parent);
    expect(warn.mock.calls.filter((c) => String(c[0]).startsWith('W_FX_ATLAS:'))).toHaveLength(1);
    warn.mockRestore();
    fx.tables({ textures: { coin: s } });
    expect(fx.textureNames()).toEqual(['coin']);
    expect(fx.atlasInfo('coin')!.prefixes[0]).toEqual({ prefix: 'coin_', count: 12 });
    const e = fx.play({ ...PARTICLES.coinFountain, atlas: { texture: 'coin', prefix: 'coin_' } }, parent);
    expect(e.emitters[0].sim.frames).toBe(12);
    expect(() => fx.play(coins({ sheet: { tilesX: 2, tilesY: 1, frameOverTime: [[0, 0]], mul: 1, cycles: 1 } }), parent)).toThrow(/^E_FX_CONFIG:/);
  });
});
