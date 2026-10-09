// sim-digest.ts — a digest of a ParticleSim run (every particle's state, full precision, a few
// frames): the 2.1 configs must simulate bit for bit the same in later kits (test/particles.test.ts).
import { createHash } from 'node:crypto';
import { ParticleSim } from '../../src/fx/sim.js';
import { PARTICLES } from '../../src/fx/presets.js';
import { particleConfig, type ParticleConfig } from '../../src/fx/types.js';
import { seededRandom } from '../../src/qa/random.js';

/** Configs of the 2.1 model: the presets and a Shuriken-converted one with every module. */
export const OLD_CONFIGS: Record<string, ParticleConfig> = {
  ...PARTICLES,
  shuriken: particleConfig({
    unit: [100, 100], duration: 1, loop: true, prewarm: true, lifetime: [0.4, 1.1], speed: { curves: [[[0, 0.5], [1, 1]], [[0, 1], [1, 2]]], mul: 2 },
    size: [0.1, 0.3], rate: 40, max: 50, gravity: 2, flipRotation: 0.5, rotation: [0, 3], spin: [-2, 2],
    bursts: [{ time: 0.2, count: 6, cycles: 3, interval: 0.1, prob: 0.7 }],
    shape: { type: 'sphere', radius: 0.5, thickness: 0.5, arc: 6.28, scale: [1, 0.5] },
    limitVelocity: { limit: 0.5, dampen: 0.3 },
    sizeOverLifetime: [[0, 0], [0.5, 1], [1, 0]],
    colorOverLifetime: { color: [[0, 1, 0.5, 0], [1, 0, 0, 1]], alpha: [[0, 1], [1, 0]] },
    color: [[1, 0, 0, 1], [0, 1, 1, 0.5]],
    sheet: { tilesX: 2, tilesY: 2, frameOverTime: [[0, 0], [1, 1]], mul: 1, cycles: 2 },
    render: { mode: 'stretch', lengthScale: 2, velocityScale: 0.1 }, tint: [1, 0.9, 0.8, 1],
  }),
  arc: particleConfig({ rate: 30, duration: 0.5, shape: { type: 'circle', radius: 20, thickness: 0.3, arc: 2, scale: [1, 2] }, startDelay: 0.1 }),
};

/** 12 significant digits: a last-bit difference of Math.* between platforms (macOS arm64 vs CI
 *  linux x64) must not fail the digest, a real change of the model still does. */
const q = (_k: string, v: unknown) => (typeof v === 'number' ? Number(v.toPrecision(12)) : v);

export function simDigest(c: ParticleConfig, seed = 11): string {
  const sim = new ParticleSim(c, seededRandom(seed));
  sim.play();
  const h = createHash('sha256');
  for (let f = 0; f < 90; f++) {
    sim.update(f % 7 === 0 ? 1 / 30 : 1 / 60);
    for (const p of sim.particles) h.update(JSON.stringify([p.x, p.y, p.vx, p.vy, p.age, p.life, p.size, p.color, p.rotation, p.spin, p.outSize, p.outColor, p.frame, p.stretch], q));
    h.update('|');
  }
  return h.digest('hex').slice(0, 32);
}
