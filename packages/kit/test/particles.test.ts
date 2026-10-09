import { describe, expect, it } from 'vitest';
import { ParticleSim, sampleCurve, sampleMinMax } from '../src/fx/sim.js';
import { particleConfig } from '../src/fx/types.js';
import { PARTICLES } from '../src/fx/presets.js';
import { seededRandom } from '../src/qa/random.js';
import { OLD_CONFIGS, simDigest } from './helpers/sim-digest.js';

describe('particles — simulation without a renderer', () => {
  it('curves and min-max', () => {
    expect(sampleCurve([[0, 0], [1, 10]], 0.5)).toBe(5);
    expect(sampleCurve([], 0.3)).toBe(1);
    const r = seededRandom(3);
    const v = sampleMinMax([2, 4], 0, r);
    expect(v).toBeGreaterThanOrEqual(2);
    expect(v).toBeLessThan(4);
  });

  it('burst emits once, particles move, age and die', () => {
    const sim = new ParticleSim(PARTICLES.burst, seededRandom(7));
    sim.play();
    sim.update(1 / 60);
    expect(sim.count).toBe(24);
    const p = sim.particles[0];
    const x0 = p.x;
    sim.update(0.1);
    expect(p.x).not.toBe(x0);
    for (let i = 0; i < 60; i++) sim.update(1 / 60);
    expect(sim.count).toBe(0);
    expect(sim.alive).toBe(false);
  });

  it('rate emission, max cap, gravity, stop lets particles finish', () => {
    const cfg = particleConfig({ loop: true, duration: 1, rate: 100, max: 30, lifetime: 1, speed: 0, gravity: 100 });
    const sim = new ParticleSim(cfg, seededRandom(1));
    sim.play();
    sim.update(0.1);
    expect(sim.count).toBe(10);
    sim.update(0.5);
    expect(sim.count).toBe(30);
    expect(sim.particles[0].vy).toBeGreaterThan(0);
    sim.stop();
    expect(sim.alive).toBe(true);
    for (let i = 0; i < 70; i++) sim.update(1 / 60);
    expect(sim.count).toBe(0);
  });

  it('a Shuriken-converted config plays: size/colour over lifetime, sheet frames, stretch', () => {
    const cfg = particleConfig({
      key: 'FxHint', feature: 'VFX-2', cls: 'auto', unit: [100, 100],
      duration: 1, loop: false, lifetime: 1, speed: [1, 2], size: { curves: [[[0, 0.5], [1, 0.5]], [[0, 1], [1, 1]]], mul: 2 },
      bursts: [{ time: 0, count: 5, cycles: 2, interval: 0.2, prob: 1 }],
      shape: { type: 'sphere', radius: 1, thickness: 0, arc: 6.28, scale: [1, 1] },
      sizeOverLifetime: [[0, 0], [1, 1]],
      colorOverLifetime: { color: [[0, 1, 0, 0], [1, 0, 0, 1]], alpha: [[0, 1], [1, 0]] },
      sheet: { tilesX: 2, tilesY: 2, frameOverTime: [[0, 0], [1, 1]], mul: 1, cycles: 1 },
      render: { mode: 'stretch', lengthScale: 2, velocityScale: 0 }, texture: 'cfx_glow', blend: 'add',
    });
    const sim = new ParticleSim(cfg, seededRandom(2));
    sim.play();
    sim.update(0.01);
    expect(sim.count).toBe(5);
    sim.update(0.25);
    expect(sim.count).toBe(10);
    const p = sim.particles[0];
    expect(p.size).toBeGreaterThanOrEqual(1);
    expect(p.size).toBeLessThanOrEqual(2);
    expect(p.stretch).toBeCloseTo(2);
    sim.update(0.4);
    expect(p.frame).toBeGreaterThan(0);
    expect(p.outColor[3]).toBeLessThan(1);
    expect(p.outColor[2]).toBeGreaterThan(0);
  });

  it('deterministic with a seeded rng', () => {
    const run = () => {
      const s = new ParticleSim(PARTICLES.confetti, seededRandom(42));
      s.play();
      s.update(0.3);
      return s.particles.map((p) => [p.x, p.y]);
    };
    expect(run()).toEqual(run());
  });
});

describe('particles 2.2 — the Cocos model fields', () => {
  it('a 2.1 config simulates bit for bit as in 2.1 (digests of the 2.1 kit)', () => {
    // Recorded with the 2.1.0 sim (before the 2.2 fields): every particle's state at 12 significant
    // digits (platform-stable), 90 frames.
    expect(Object.fromEntries(Object.entries(OLD_CONFIGS).map(([k, c]) => [k, simDigest(c)]))).toEqual({
      burst: 'cec217839835c22e1b79bda93f822589',
      confetti: '97c8923f1452e2d6389d866c61dc2043',
      sparkle: '6dec42b0c725acc55f4b0fbf62454806',
      smoke: '96a5bc7788fce28045d82cf7121c9e40',
      coins: '013a04c07b0d7a1a7b2c12df6fda4119',
      trail: '2345d85ee940d09f8a199417c6d316a4',
      shuriken: '2dc85bd8cb8aba626d29a5b357364683',
      arc: '57939c08a5fad3de13f115809ee2323a',
    });
  });

  it('box shape, emission angle, gravity x, end size / colour / rotation over the life', () => {
    const c = particleConfig({
      speed: 100, angle: Math.PI / 2, gravityX: 50, lifetime: 1, size: 10, endSize: 30, color: [1, 0, 0, 1], endColor: [0, 0, 1, 0],
      rotation: 0, endRotation: 2, shape: { type: 'box', radius: 0, thickness: 1, arc: 0, scale: [1, 1], box: [10, 4] },
    });
    const sim = new ParticleSim(c, () => 1 - 1e-9);
    sim.emit(1);
    const p = sim.particles[0];
    expect(p.x).toBeCloseTo(10, 6);
    expect(p.y).toBeCloseTo(4, 6);
    expect(p.vx).toBeCloseTo(0, 9);
    expect(p.vy).toBeCloseTo(100, 6); // down
    for (let i = 0; i < 30; i++) sim.update(1 / 60);
    expect(p.vx).toBeCloseTo(25, 6);
    expect(p.outSize).toBeCloseTo(20, 6);
    expect(p.outColor).toEqual([0.5, 0, 0.5, 0.5].map((v) => expect.closeTo(v, 6)));
    expect(p.rotation).toBeCloseTo(1, 6);
    expect(sim.spawned).toBe(1);
    // a box without a size; sizes clamped at 0 with an end size
    const z = new ParticleSim(particleConfig({ shape: { type: 'box', radius: 0, thickness: 1, arc: 0, scale: [1, 1] }, size: -5, endSize: [-3, -3] }), () => 0.5);
    z.emit(1);
    expect([z.particles[0].x, z.particles[0].outSize]).toEqual([0, 0]);
  });

  it('radial and tangential acceleration about the origin (tangential: counter-clockwise on screen)', () => {
    const sim = new ParticleSim(particleConfig({ speed: 0, angle: 0, radialAccel: 10, tangentialAccel: 20, shape: { type: 'box', radius: 0, thickness: 1, arc: 0, scale: [1, 1], box: [5, 0] } }), () => 1);
    sim.emit(1);
    const p = sim.particles[0];
    expect(p.x).toBe(5);
    sim.update(0.1);
    expect(p.vx).toBeCloseTo(1, 9); // radial: right, away
    expect(p.vy).toBeCloseTo(-2, 9); // tangential at the right: up (y down)
    const only = new ParticleSim(particleConfig({ speed: 0, tangentialAccel: 1 }), () => 0.5);
    only.emit(1);
    only.update(0.1);
    expect(only.particles[0].vx).toBe(0); // at the origin: no direction
  });

  it('orbit mode: (cos θ, sin θ)·r from the start point, θ turning, r from start to end; speed / gravity ignored', () => {
    const sim = new ParticleSim(particleConfig({ speed: 999, gravity: 999, lifetime: 2, angle: 0, orbit: { radius: 10, endRadius: 30, speed: Math.PI }, render: { mode: 'stretch', lengthScale: 1, velocityScale: 0.1 } }), () => 0.5);
    sim.emit(1);
    const p = sim.particles[0];
    expect([p.x, p.y]).toEqual([10, 0]);
    sim.update(0.5);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(15, 9); // a quarter turn clockwise on screen, r 10 → 15
    expect(p.vy).toBeGreaterThan(0);
    const keep = new ParticleSim(particleConfig({ orbit: { radius: 7, speed: 0 }, endRotation: 1, lifetime: 1 }), () => 0.5);
    keep.emit(1);
    keep.update(0.5);
    expect(keep.particles[0].x).toBeCloseTo(7, 9);
    expect(keep.particles[0].rotation).toBeCloseTo(0.5, 9);
  });

  it('colour per channel: a draw per channel, clamped; end colour random between two', () => {
    const draws = [0, 1, 1, 0.25];
    let i = 0;
    const sim = new ParticleSim(
      particleConfig({ speed: 0, color: [[0, 0, -1, 0], [1, 1, 3, 1]], colorPerChannel: true }),
      () => draws[i++ % draws.length],
    );
    sim.emit(1);
    // draws (constant speed / lifetime / size draw nothing): r, g, b, a — b: −1 + 1·4 = 3, clamped
    expect(sim.particles[0].color).toEqual([0, 1, 1, 0.25]);
    // one colour + perChannel: copied
    const one = new ParticleSim(particleConfig({ color: [0.1, 0.2, 0.3, 0.4], endColor: [[0, 0, 0, 0], [1, 1, 1, 1]], colorPerChannel: true }), () => 0.75);
    one.emit(1);
    expect(one.particles[0].color).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(one.particles[0].endColor).toEqual([0.75, 0.75, 0.75, 0.75]);
    // the mixed (one factor) end colour
    const mix = new ParticleSim(particleConfig({ endColor: [[0, 0, 0, 0], [1, 1, 1, 1]] }), () => 0.25);
    mix.emit(1);
    expect(mix.particles[0].endColor).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it("whenFull 'wait': the emission clock stops while full (Cocos); 'skip' keeps the schedule and drops what is due", () => {
    const run = (whenFull: 'wait' | 'skip') => {
      const sim = new ParticleSim(particleConfig({ loop: true, duration: 1, rate: 37 / 1.23, max: 37, lifetime: 1.23, speed: 0, whenFull }), () => 0.5);
      sim.play();
      for (let f = 0; f < 300; f++) sim.update(1 / 60);
      return sim.spawned;
    };
    // Cocos' rate = max / life: a particle is due about when the oldest dies (still counted then) —
    // 'wait' delays it and everything after it, 'skip' drops it and stays on schedule.
    expect([run('wait'), run('skip')]).toEqual([148, 150]);
  });
});
