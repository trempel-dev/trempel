import { describe, expect, it } from 'vitest';
import { ParticleSim, sampleCurve, sampleMinMax } from '../src/fx/sim.js';
import { particleConfig } from '../src/fx/types.js';
import { PARTICLES } from '../src/fx/presets.js';
import { seededRandom } from '../src/qa/random.js';

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
